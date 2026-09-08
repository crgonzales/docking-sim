import { describe, expect, it } from 'vitest';
import { buildWaterPatchGeometry, geoidSurfacePosition, isWaterHeight } from './terrainWater';

import { buildPatchGeometry, patchWaterMask } from './terrainWorker';
import { DEFAULT_TERRAIN_RGB_CODEC, directionFromLatLon, type TerrainTile } from './heightField';
import { addressFromDirection, type TerrainNodeAddress } from './quadtree';
import { SKY_DERIVED } from '../sky/skyConfig';

function flatPatch(level: number, heightM: number, address: TerrainNodeAddress = {
  face: 0, level, x: Math.floor(2 ** level / 2), y: Math.floor(2 ** level / 2),
}) {
  const tiles: TerrainTile[] = ([0, 1, 2, 3, 4, 5] as const).map((face) => ({
    address: { face, level: 0, x: 0, y: 0 }, width: 2, height: 2,
    codec: DEFAULT_TERRAIN_RGB_CODEC, data: new Float32Array(4).fill(heightM),
  }));
  return buildPatchGeometry({ type: 'buildPatch',
    address,
    tiles, codec: DEFAULT_TERRAIN_RGB_CODEC, detail: { baseAmplitudeM: 0 }, skirtDepthM: 2,
  });
}

describe('terrain water selection', () => {
  it('selects sea level and below without selecting positive land', () => {
    expect(isWaterHeight(-0.1)).toBe(true);
    expect(isWaterHeight(0)).toBe(true);
    expect(isWaterHeight(0.1)).toBe(false);
  });

  it.each([0, 3, 10])('keeps all zero-height vertices water at level %i despite Float32 radius error', (level) => {
    const patch = flatPatch(level, 0);
    const mask = patchWaterMask(patch);
    expect(mask.length).toBe(patch.vertexCount);
    expect(mask.every((value) => value === 1)).toBe(true); // base AND skirts
    const water = buildWaterPatchGeometry(patch, SKY_DERIVED.earthRadiusM);
    expect(water.hasWater).toBe(true);
    expect(new Float32Array(water.waterMask).every((value) => value === 1)).toBe(true);
    // Ensure the test actually exercises the old sign-reconstruction failure.
    const local = new Float32Array(patch.positions);
    let roundedAboveSeaLevel = 0;
    for (let index = 0; index < patch.baseVertexCount; index++) {
      const radius = Math.hypot(...patch.patchCenterF64.map((center, axis) => center + local[index * 3 + axis]));
      if (radius > SKY_DERIVED.earthRadiusM) roundedAboveSeaLevel++;
    }
    expect(roundedAboveSeaLevel).toBeGreaterThan(0);
  });

  it.each([0, 3, 10])('keeps positive-height land and its below-sea-level skirts dry at level %i', (level) => {
    const patch = flatPatch(level, 0.001);
    expect(patchWaterMask(patch).every((value) => value === 0)).toBe(true);
    const water = buildWaterPatchGeometry(patch, SKY_DERIVED.earthRadiusM);
    expect(water.hasWater).toBe(false);
    expect(new Float32Array(water.waterMask).every((value) => value === 0)).toBe(true);
    expect(new Uint8Array(water.positions)).toEqual(new Uint8Array(patch.positions));
  });

  it.each([0, 3, 10])('preserves zero-height base positions byte-for-byte across faces and at KSC at level %i', (level) => {
    const addresses: TerrainNodeAddress[] = ([0, 1, 2, 3, 4, 5] as const).map((face) => ({
      face, level, x: Math.floor(2 ** level / 2), y: Math.floor(2 ** level / 2),
    }));
    addresses.push(addressFromDirection(directionFromLatLon(28.6 * Math.PI / 180, -80.6 * Math.PI / 180), level));
    for (const address of addresses) {
      const patch = flatPatch(level, 0, address);
      const water = buildWaterPatchGeometry(patch, SKY_DERIVED.earthRadiusM);
      const baseBytes = patch.baseVertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
      expect(new Uint8Array(water.positions, 0, baseBytes)).toEqual(new Uint8Array(patch.positions, 0, baseBytes));
      // Water skirts must collapse onto the exact base edge, never a second
      // projection with a small offset that can create another overlapping strip.
      const baseTriples = new Set();
      const positionBits = new Uint32Array(water.positions);
      const key = (index: number) => [...positionBits.subarray(index * 3, index * 3 + 3)].join(',');
      for (let index = 0; index < patch.baseVertexCount; index++) baseTriples.add(key(index));
      for (let index = patch.baseVertexCount; index < patch.vertexCount; index++) expect(baseTriples.has(key(index))).toBe(true);
    }
  });

  it.each([0, 3, 10])('still lifts negative-height seafloor to the geoid at level %i', (level) => {
    const patch = flatPatch(level, -1000);
    const water = new Float32Array(buildWaterPatchGeometry(patch, SKY_DERIVED.earthRadiusM).positions);
    for (let index = 0; index < patch.baseVertexCount; index++) {
      const radius = Math.hypot(...patch.patchCenterF64.map((center, axis) => center + water[index * 3 + axis]));
      // Earth-sized Float32 RTC grids retain a bounded spatial quantization
      // error; the source -1000m seafloor must not simply have been copied.
      expect(Math.abs(radius - SKY_DERIVED.earthRadiusM)).toBeLessThan(0.3);
    }
  });

  it('rejects missing, wrong-sized, or non-binary masks instead of guessing height signs', () => {
    const patch = flatPatch(3, 0);
    expect(() => buildWaterPatchGeometry({ ...patch, waterMask: undefined! }, SKY_DERIVED.earthRadiusM)).toThrow(/one byte/);
    expect(() => buildWaterPatchGeometry({ ...patch, waterMask: new ArrayBuffer(1) }, SKY_DERIVED.earthRadiusM)).toThrow(/one byte/);
    new Uint8Array(patch.waterMask)[0] = 2;
    expect(() => buildWaterPatchGeometry(patch, SKY_DERIVED.earthRadiusM)).toThrow(/binary/);
  });

  it('rejects malformed water positions instead of reprojecting rounded terrain', () => {
    const patch = flatPatch(3, 0);
    expect(() => buildWaterPatchGeometry({ ...patch, waterPositions: undefined! }, SKY_DERIVED.earthRadiusM)).toThrow(/three floats/);
    expect(() => buildWaterPatchGeometry({ ...patch, waterPositions: new ArrayBuffer(4) }, SKY_DERIVED.earthRadiusM)).toThrow(/three floats/);
    new Float32Array(patch.waterPositions)[0] = NaN;
    expect(() => buildWaterPatchGeometry(patch, SKY_DERIVED.earthRadiusM)).toThrow(/finite/);
  });

  it('places selected vertices exactly on the geoid', () => {
    const surface = geoidSurfacePosition([3, 4, 12], 10);
    expect(Math.hypot(...surface)).toBeCloseTo(10, 12);
    expect(surface[0] / surface[2]).toBeCloseTo(3 / 12, 12);
  });
});
