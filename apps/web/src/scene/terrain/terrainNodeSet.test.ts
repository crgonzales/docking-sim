import { describe, expect, it } from 'vitest';
import { SKY_DERIVED } from '../sky/skyConfig';
import { childAddress, nodeAddressKey, type TerrainNodeAddress } from './quadtree';
import {
  terrainResidencyKeys,
  isTerrainCoverageReady,
  mergeCompleteSiblings,
  rootTerrainNodes,
  retiredTerrainNodeKeys,
  selectTerrainNodes,
  swapCompleteSiblings,
} from './terrainNodeSet';

describe('terrain live node policy', () => {
  it('is deterministic for a fixed camera path', () => {
    const path = [
      [SKY_DERIVED.earthRadiusM + 5000, 0, 0] as const,
      [SKY_DERIVED.earthRadiusM + 5000, 3000, -2000] as const,
      [SKY_DERIVED.earthRadiusM + 5000, 0, 0] as const,
    ];
    const first = path.map((camera) => selectTerrainNodes(camera, {
      projectionScalePx: 900,
      splitThresholdPx: 2,
      maxLevel: 2,
    }).map(nodeAddressKey));
    const second = path.map((camera) => selectTerrainNodes(camera, {
      projectionScalePx: 900,
      splitThresholdPx: 2,
      maxLevel: 2,
    }).map(nodeAddressKey));
    expect(second).toEqual(first);
  });

  it('charges all four children and the retained parent before splitting', () => {
    const camera = [SKY_DERIVED.earthRadiusM + 5000, 0, 0] as const;
    const selected = selectTerrainNodes(camera, { projectionScalePx: 900, maxLivePatches: 10 });
    expect(selected).toHaveLength(9); // Six roots, one replaced by four children.
    expect(terrainResidencyKeys(selected).size).toBe(10);
    expect(() => selectTerrainNodes(camera, { maxLivePatches: 5 })).toThrow(/six roots/);
  });

  it.each([50, 3000, 20000, 70000, 100000, 120000])('bounds CPU work and preserves full coverage at %i metres', (altitude) => {
    const lat = 28.6 * Math.PI / 180;
    const lon = -80.6 * Math.PI / 180;
    const radius = SKY_DERIVED.earthRadiusM + altitude;
    const camera = [Math.cos(lat) * Math.cos(lon) * radius, Math.sin(lat) * radius, -Math.cos(lat) * Math.sin(lon) * radius] as const;
    const statistics = { evaluatedNodes: 0, splits: 0, residentNodes: 0 };
    // Intentionally allow depth 30: the operation bound must come from the
    // residency budget, not from a conveniently shallow maxLevel or timings.
    const leaves = selectTerrainNodes(camera, {
      projectionScalePx: 360 / Math.tan(Math.PI / 8), maxLevel: 30,
      maxLivePatches: 300, statistics,
    });
    expect(statistics.evaluatedNodes).toBeLessThanOrEqual(300);
    expect(statistics.residentNodes).toBe(terrainResidencyKeys(leaves).size);
    expect(statistics.residentNodes).toBeLessThanOrEqual(300);
    const keys = new Set(leaves.map(nodeAddressKey));
    expect(keys.size).toBe(leaves.length);
    for (const root of rootTerrainNodes()) {
      // Each cube-face cell contributes 4^-level of the face's area.
      const faceLeaves = leaves.filter((leaf) => leaf.face === root.face);
      expect(faceLeaves.reduce((area, leaf) => area + 4 ** -leaf.level, 0)).toBeCloseTo(1, 12);
      for (const leaf of faceLeaves) {
        for (const other of faceLeaves) {
          if (other.level >= leaf.level) continue;
          const shift = leaf.level - other.level;
          expect((leaf.x >> shift) === other.x && (leaf.y >> shift) === other.y).toBe(false);
        }
      }
    }
  });

  it('announces coverage only for ready, non-overlapping leaves spanning all six faces', () => {
    const roots = rootTerrainNodes();
    const ready = terrainResidencyKeys(roots);
    expect(isTerrainCoverageReady(roots, ready)).toBe(true);
    expect(isTerrainCoverageReady(roots.slice(0, 5), ready)).toBe(false);
    expect(isTerrainCoverageReady(roots, new Set([...ready].slice(0, 5)))).toBe(false);
    const child = childAddress(roots[0], 0, 0);
    ready.add(nodeAddressKey(child));
    expect(isTerrainCoverageReady([...roots, child], ready)).toBe(false);
    const quarter = [child, childAddress(roots[0], 1, 0), childAddress(roots[0], 0, 1), childAddress(roots[0], 1, 1)];
    const split = [...roots.slice(1), ...quarter];
    expect(isTerrainCoverageReady(split, terrainResidencyKeys(split))).toBe(true);
  });

  it('coarsens across multiple levels after a camera jump without needing new parents', () => {
    const leaves: TerrainNodeAddress[] = [];
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) leaves.push({ face: 0, level: 2, x, y });
    const root = rootTerrainNodes()[0];
    const ready = terrainResidencyKeys(leaves);
    const intermediate = mergeCompleteSiblings(leaves, [root], ready);
    expect(intermediate).toHaveLength(4);
    expect(mergeCompleteSiblings(intermediate, [root], ready)).toEqual([root]);
  });

  it('holds the parent until every requested sibling is ready', () => {
    const parent: TerrainNodeAddress = { face: 0, level: 0, x: 0, y: 0 };
    const children = [
      childAddress(parent, 0, 0),
      childAddress(parent, 1, 0),
      childAddress(parent, 0, 1),
      childAddress(parent, 1, 1),
    ];
    const desired = children;
    const threeReady = new Set(children.slice(0, 3).map(nodeAddressKey));
    expect(swapCompleteSiblings([parent], desired, threeReady)).toEqual([parent]);
    const allReady = new Set(children.map(nodeAddressKey));
    expect(swapCompleteSiblings([parent], desired, allReady).map(nodeAddressKey))
      .toEqual(children.map(nodeAddressKey).sort());
  });

  it('reports exactly the patches that must be disposed after a swap', () => {
    const parent: TerrainNodeAddress = { face: 2, level: 1, x: 0, y: 1 };
    const children = [
      childAddress(parent, 0, 0),
      childAddress(parent, 1, 0),
      childAddress(parent, 0, 1),
      childAddress(parent, 1, 1),
    ];
    expect(retiredTerrainNodeKeys([parent], children)).toEqual([nodeAddressKey(parent)]);
    expect(retiredTerrainNodeKeys(children, [parent])).toEqual(children.map(nodeAddressKey).sort());
  });
});
