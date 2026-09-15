import { describe, expect, it } from 'vitest';
import { cloudSphericalUv } from '../sky/cloudSphericalUv';
import {
  addressFromDirection,
  addressFromFaceUv,
  childAddress,
  decideLod,
  directionToFaceUv,
  faceUvToDirection,
  neighborAddress,
  nodeCenterDirection,
  nodeCenterFaceUv,
  nodeUvBounds,
  parentAddress,
  skirtMetadata,
  TERRAIN_EDGES,
  type CubeFace,
  type TerrainEdge,
  type TerrainNodeAddress,
  type Vec3,
} from './quadtree';

const FACES: readonly CubeFace[] = [0, 1, 2, 3, 4, 5];
const EDGE_VALUES: readonly [number, number, number, number, number] = [0.1, 0.25, 0.5, 0.75, 0.9];

function expectVectorClose(actual: readonly number[], expected: readonly number[], digits = 10): void {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
  expect(actual[2]).toBeCloseTo(expected[2], digits);
}

function faceEdgeUv(edge: TerrainEdge, along: number): readonly [number, number] {
  switch (edge) {
    case 'north': return [along, 1];
    case 'east': return [1, along];
    case 'south': return [along, 0];
    case 'west': return [0, along];
  }
}

function cornerCell(address: TerrainNodeAddress, u: 0 | 1, v: 0 | 1): TerrainNodeAddress {
  const count = 2 ** address.level;
  return { ...address, x: u === 0 ? 0 : count - 1, y: v === 0 ? 0 : count - 1 };
}

function cornerDirectionsForFace(face: CubeFace): readonly Vec3[] {
  return [
    faceUvToDirection(face, 0, 0),
    faceUvToDirection(face, 1, 0),
    faceUvToDirection(face, 0, 1),
    faceUvToDirection(face, 1, 1),
  ];
}

describe('cube-sphere quadtree math', () => {
  it('round-trips node addressing through face UVs and parent/child links', () => {
    for (const face of FACES) {
      for (let level = 0; level <= 4; level += 1) {
        const count = 2 ** level;
        for (let y = 0; y < count; y += 1) {
          for (let x = 0; x < count; x += 1) {
            const address = { face, level, x, y } as TerrainNodeAddress;
            const [u, v] = nodeCenterFaceUv(address);
            expect(addressFromFaceUv(face, u, v, level)).toEqual(address);
            expect(addressFromDirection(nodeCenterDirection(address), level)).toEqual(address);

            if (level > 0) {
              const parent = parentAddress(address);
              expect(parent).not.toBeNull();
              expect(childAddress(parent!, (x % 2) as 0 | 1, (y % 2) as 0 | 1)).toEqual(address);
            }
          }
        }
      }
    }
  });

  it('uses the existing equirectangular registration at face centres', () => {
    const expectedUv: readonly [number, number][] = [
      [0.5, 0.5],
      [0, 0.5],
      [0.5, 1],
      [0.5, 0],
      [0.25, 0.5],
      [0.75, 0.5],
    ];

    for (const face of FACES) {
      const direction = faceUvToDirection(face, 0.5, 0.5);
      const [u, v] = cloudSphericalUv(...direction);
      expect(u).toBeCloseTo(expectedUv[face][0], 10);
      expect(v).toBeCloseTo(expectedUv[face][1], 10);
      expect(Math.hypot(...direction)).toBeCloseTo(1, 12);
    }
  });

  it('round-trips representative spherified face UVs through directions', () => {
    for (const face of FACES) {
      for (const u of [0.03, 0.22, 0.5, 0.78, 0.97]) {
        for (const v of [0.04, 0.31, 0.5, 0.69, 0.96]) {
          const direction = faceUvToDirection(face, u, v);
          const roundTrip = directionToFaceUv(direction);
          expect(roundTrip.face).toBe(face);
          expect(roundTrip.u).toBeCloseTo(u, 8);
          expect(roundTrip.v).toBeCloseTo(v, 8);
        }
      }
    }
  });

  it('keeps LOD decisions deterministic and applies split/merge hysteresis', () => {
    const root: TerrainNodeAddress = { face: 0, level: 0, x: 0, y: 0 };
    const child: TerrainNodeAddress = { face: 0, level: 1, x: 0, y: 0 };
    const nearCamera = [SKY_EARTH_RADIUS_M + 1000, 0, 0] as const;
    const farCamera = [SKY_EARTH_RADIUS_M + 1_000_000_000_000, 0, 0] as const;
    const options = { projectionScalePx: 1000, splitThresholdPx: 2, maxLevel: 8 } as const;

    const nearDecision = decideLod(root, nearCamera, options);
    expect(nearDecision).toEqual(decideLod(root, nearCamera, options));
    expect(nearDecision.action).toBe('split');

    const farDecision = decideLod(child, farCamera, options);
    expect(farDecision).toEqual(decideLod(child, farCamera, options));
    expect(farDecision.action).toBe('merge');

    const exactThreshold = decideLod(root, nearCamera, {
      ...options,
      splitThresholdPx: nearDecision.screenSpaceErrorPx,
      mergeThresholdPx: nearDecision.screenSpaceErrorPx,
    });
    expect(exactThreshold.action).toBe('keep');
  });

  it('returns a skirt record for every edge with the configured physical depth', () => {
    const address: TerrainNodeAddress = { face: 4, level: 2, x: 0, y: 3 };
    const skirts = skirtMetadata(address);
    expect(skirts.map((skirt) => skirt.edge)).toEqual(TERRAIN_EDGES);
    expect(skirts.every((skirt) => skirt.depthM === 2)).toBe(true);
    expect(skirts.every((skirt) => skirt.neighbor.level === address.level)).toBe(true);
  });

  it('finds reciprocal neighbours across all twelve cube edges', () => {
    const level = 3;
    const count = 2 ** level;
    for (const face of FACES) {
      for (const edge of TERRAIN_EDGES) {
        const varying = edge === 'north' || edge === 'south' ? 'x' : 'y';
        for (let index = 0; index < count; index += 1) {
          const address: TerrainNodeAddress = {
            face,
            level,
            x: varying === 'x' ? index : edge === 'east' ? count - 1 : 0,
            y: varying === 'y' ? index : edge === 'north' ? count - 1 : 0,
          };
          const neighbor = neighborAddress(address, edge);
          expect(neighbor.face).not.toBe(face);
          const reciprocalEdges = TERRAIN_EDGES.filter((candidate) => {
            const back = neighborAddress(neighbor, candidate);
            return JSON.stringify(back) === JSON.stringify(address);
          });
          expect(reciprocalEdges).toHaveLength(1);
        }
      }
    }
  });

  it('keeps direction continuous along every directed face seam', () => {
    for (const face of FACES) {
      for (const edge of TERRAIN_EDGES) {
        for (const along of EDGE_VALUES) {
          const direction = faceUvToDirection(face, ...faceEdgeUv(edge, along));
          let closest = Number.POSITIVE_INFINITY;
          for (const otherFace of FACES) {
            if (otherFace === face) continue;
            for (const otherEdge of TERRAIN_EDGES) {
              for (const otherAlong of [along, 1 - along]) {
                const otherDirection = faceUvToDirection(otherFace, ...faceEdgeUv(otherEdge, otherAlong));
                const distance = 1 - direction[0] * otherDirection[0]
                  - direction[1] * otherDirection[1]
                  - direction[2] * otherDirection[2];
                closest = Math.min(closest, distance);
              }
            }
          }
          expect(closest).toBeLessThan(1e-12);
        }
      }
    }
  });

  it('has exactly three coincident face corners at each of the eight cube corners', () => {
    const corners = new Map<string, number[][]>();
    for (const face of FACES) {
      for (const direction of cornerDirectionsForFace(face)) {
        const key = direction.map((value) => (value < 0 ? '-' : '+')).join('');
        const entries = corners.get(key) ?? [];
        entries.push([...direction]);
        corners.set(key, entries);
      }
    }

    expect(corners.size).toBe(8);
    for (const entries of corners.values()) {
      expect(entries).toHaveLength(3);
      for (const direction of entries.slice(1)) expectVectorClose(direction, entries[0], 10);
    }
  });

  it('keeps corner-adjacent seam neighbours on the other two corner faces', () => {
    const level = 2;
    for (const face of FACES) {
      for (const u of [0, 1] as const) {
        for (const v of [0, 1] as const) {
          const address = cornerCell({ face, level, x: 0, y: 0 }, u, v);
          const cornerDirection = faceUvToDirection(face, u, v);
          const horizontalEdge: TerrainEdge = u === 0 ? 'west' : 'east';
          const verticalEdge: TerrainEdge = v === 0 ? 'south' : 'north';
          const horizontalNeighbor = neighborAddress(address, horizontalEdge);
          const verticalNeighbor = neighborAddress(address, verticalEdge);
          expect(horizontalNeighbor.face).not.toBe(verticalNeighbor.face);
          for (const neighbor of [horizontalNeighbor, verticalNeighbor]) {
            const bounds = nodeUvBounds(neighbor);
            const cornersOfNeighbor = [
              faceUvToDirection(neighbor.face, bounds.uMin, bounds.vMin),
              faceUvToDirection(neighbor.face, bounds.uMax, bounds.vMin),
              faceUvToDirection(neighbor.face, bounds.uMin, bounds.vMax),
              faceUvToDirection(neighbor.face, bounds.uMax, bounds.vMax),
            ];
            const closest = Math.min(...cornersOfNeighbor.map((candidate) => 1 - candidate[0] * cornerDirection[0]
              - candidate[1] * cornerDirection[1]
              - candidate[2] * cornerDirection[2]));
            expect(closest).toBeLessThan(1e-12);
          }
        }
      }
    }
  });
});

const SKY_EARTH_RADIUS_M = 6_371_000;
