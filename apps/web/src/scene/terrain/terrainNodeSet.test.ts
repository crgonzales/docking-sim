import { describe, expect, it } from 'vitest';
import { SKY_DERIVED } from '../sky/skyConfig';
import { childAddress, nodeAddressKey, type TerrainNodeAddress } from './quadtree';
import {
  capTerrainNodes,
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

  it('enforces the live-patch cap with nearest-first deterministic priority', () => {
    const camera = [SKY_DERIVED.earthRadiusM + 5000, 0, 0] as const;
    const options = {
      projectionScalePx: 1_000_000,
      splitThresholdPx: 0.1,
      maxLevel: 5,
    } as const;
    const uncapped = selectTerrainNodes(camera, options);
    const selected = selectTerrainNodes(camera, {
      ...options,
      maxLivePatches: 10,
    });
    expect(selected).toHaveLength(10);
    expect(new Set(selected.map(nodeAddressKey)).size).toBe(10);
    expect(selected).toEqual(capTerrainNodes(uncapped, camera, 10));
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
