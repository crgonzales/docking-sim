import { describe, expect, it } from 'vitest';
import {
  addressFromFaceUv,
  faceUvToDirection,
  nodeAddressKey,
  type TerrainNodeAddress,
} from './quadtree';
import {
  decodeTerrainRgb,
  DEFAULT_TERRAIN_RGB_CODEC,
  detailNoise,
  directionFromLatLon,
  encodeTerrainRgb,
  height,
  heightAboveGround,
  heroWeight,
  residentTileMap,
  sampleResidentTerrain,
  terrainTileFromRgb,
  type HeightField,
  type TerrainTile,
} from './heightField';
import { SKY_DERIVED } from '../sky/skyConfig';

function tile(address: TerrainNodeAddress, values: readonly number[], width = 1, height = 1): TerrainTile {
  return { address, width, height, codec: DEFAULT_TERRAIN_RGB_CODEC, data: new Float32Array(values), byteLength: values.length * 4 };
}

function latLonFromDirection(direction: readonly [number, number, number]): readonly [number, number] {
  // Inverse of the registration-proven directionFromLatLon (lon 0 at +X).
  return [Math.asin(direction[1]), Math.atan2(-direction[2], direction[0])];
}

function constantWorldTiles(value: number): Map<string, TerrainTile> {
  const tiles = new Map<string, TerrainTile>();
  for (const face of [0, 1, 2, 3, 4, 5] as const) {
    const address = { face, level: 0, x: 0, y: 0 };
    tiles.set(nodeAddressKey(address), tile(address, [value]));
  }
  return tiles;
}

describe('terrain height field', () => {
  it('round-trips signed terrain-RGB elevations, including negative values and no-data', () => {
    const metreCodec = { offsetM: -11_000, scaleM: 1 } as const;
    for (const heightM of [-9999.9, -5000, -0.1, 0, 8848.86, 12_345.67]) {
      const encoded = encodeTerrainRgb(heightM);
      expect(decodeTerrainRgb(encoded)).toBeCloseTo(Math.round(heightM * 10) / 10, 10);
    }
    for (const heightM of [-10_999.4, -5000.2, 0.4, 8848.86, 12_345.67]) {
      const encoded = encodeTerrainRgb(heightM, metreCodec);
      expect(decodeTerrainRgb(encoded, metreCodec)).toBe(Math.round(heightM - metreCodec.offsetM) + metreCodec.offsetM);
    }
    expect(encodeTerrainRgb(null)).toEqual([255, 255, 255]);
    expect(decodeTerrainRgb([255, 255, 255])).toBeNull();
    expect(encodeTerrainRgb(null, metreCodec)).toEqual([255, 255, 255]);
    expect(decodeTerrainRgb([255, 255, 255], metreCodec)).toBeNull();
  });

  it('carries a manifest codec into decoded tiles and resident sampling', () => {
    const metreCodec = { offsetM: -11_000, scaleM: 1 } as const;
    const encoded = encodeTerrainRgb(123, metreCodec);
    const rgba = new Uint8Array([encoded[0], encoded[1], encoded[2], 255]);
    const address: TerrainNodeAddress = { face: 0, level: 0, x: 0, y: 0 };
    const decoded = terrainTileFromRgb(address, 1, 1, rgba, metreCodec);
    expect(decoded.codec).toEqual(metreCodec);
    expect(sampleResidentTerrain(0, 0, residentTileMap(new Map([[nodeAddressKey(address), decoded]])), 0)).toBe(123);
  });

  it('bilinearly samples across adjacent face tiles without a boundary jump', () => {
    const left: TerrainNodeAddress = { face: 0, level: 1, x: 0, y: 0 };
    const right: TerrainNodeAddress = { face: 0, level: 1, x: 1, y: 0 };
    const tiles = new Map<string, TerrainTile>([
      [nodeAddressKey(left), tile(left, [0, 10, 0, 10], 2, 2)],
      [nodeAddressKey(right), tile(right, [10, 20, 10, 20], 2, 2)],
    ]);
    const directionBefore = faceUvToDirection(0, 0.5 - 1e-5, 0.25);
    const directionAfter = faceUvToDirection(0, 0.5 + 1e-5, 0.25);
    const [latBefore, lonBefore] = latLonFromDirection(directionBefore);
    const [latAfter, lonAfter] = latLonFromDirection(directionAfter);
    const before = sampleResidentTerrain(latBefore, lonBefore, residentTileMap(tiles), 1);
    const after = sampleResidentTerrain(latAfter, lonAfter, residentTileMap(tiles), 1);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(before!).toBeCloseTo(10, 3);
    expect(after!).toBeCloseTo(10, 3);
    expect(Math.abs(before! - after!)).toBeLessThan(0.01);
  });

  it('falls back to the finest resident ancestor, including no-data pixels', () => {
    const root: TerrainNodeAddress = { face: 0, level: 0, x: 0, y: 0 };
    const child: TerrainNodeAddress = { face: 0, level: 1, x: 0, y: 0 };
    const tiles = new Map<string, TerrainTile>([
      [nodeAddressKey(root), tile(root, [123])],
      [nodeAddressKey(child), tile(child, [Number.NaN])],
    ]);
    const direction = faceUvToDirection(0, 0.25, 0.25);
    const [latRad, lonRad] = latLonFromDirection(direction);
    expect(sampleResidentTerrain(latRad, lonRad, residentTileMap(tiles), 1)).toBe(123);
  });

  it('keeps fractal detail deterministic under the cloud LCG convention', () => {
    const options = {
      seed: 0x12345678,
      octaves: 6,
      baseAmplitudeM: 40,
      baseWavelengthKm: 4,
      lacunarity: 2,
      gain: 0.5,
    } as const;
    const first = detailNoise(0.41, -1.23, options);
    expect(detailNoise(0.41, -1.23, options)).toBe(first);
    expect(detailNoise(0.41, -1.23, { ...options, seed: options.seed + 1 })).not.toBe(first);
  });

  it('replaces, rather than adds to, the base with an absolute hero DEM and feathers continuously', () => {
    const tiles = constantWorldTiles(100);
    const field: HeightField = {
      tiles: residentTileMap(tiles),
      level: 0,
      detail: { baseAmplitudeM: 0 },
      heroRegions: [{
        id: 'test',
        centerLatDeg: 0,
        centerLonDeg: 0,
        radiusKm: 10,
        featherKm: 10,
        sample: () => 300,
      }],
    };
    expect(height(0, 0, field)).toBe(300);
    expect(heroWeight(field.heroRegions![0], 0, 0)).toBe(1);
    expect(heroWeight(field.heroRegions![0], 0, (20 / SKY_DERIVED.earthRadiusM) * 1000)).toBeCloseTo(0, 4);
    const midpointLon = (15 / SKY_DERIVED.earthRadiusM) * 1000;
    expect(heroWeight(field.heroRegions![0], 0, midpointLon)).toBeCloseTo(0.5, 2);
    expect(height(0, midpointLon, field)).toBeCloseTo(200, 1);
  });

  it('reports AGL from the same combined height contract', () => {
    const tiles = constantWorldTiles(100);
    const field: HeightField = { tiles: residentTileMap(tiles), level: 0, detail: { baseAmplitudeM: 0 } };
    const position = directionFromLatLon(0, 0).map((value) => value * (SKY_DERIVED.earthRadiusM + 150)) as [number, number, number];
    expect(heightAboveGround(position, field)).toBeCloseTo(50, 8);
  });
});
