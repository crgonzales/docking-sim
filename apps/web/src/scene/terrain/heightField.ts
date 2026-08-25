import {
  kmToMeters,
  SKY_CONFIG,
  SKY_DERIVED,
} from '../sky/skyConfig';
import {
  addressFromDirection,
  directionToFaceUv,
  nodeAddressKey,
  nodeUvBounds,
  parentAddress,
  type TerrainNodeAddress,
  type Vec3,
} from './quadtree';

export type TerrainRgb = readonly [number, number, number];

export interface TerrainRgbCodec {
  readonly offsetM: number;
  readonly scaleM: number;
}

export const DEFAULT_TERRAIN_RGB_CODEC: TerrainRgbCodec = Object.freeze({ offsetM: -10_000, scaleM: 0.1 });

/** The all-white RGB triplet is outside the useful elevation range and is reserved for no-data. */
export const TERRAIN_RGB_NO_DATA: TerrainRgb = [255, 255, 255];
export const TERRAIN_NO_DATA_HEIGHT: null = null;

export interface TerrainTile {
  readonly address: TerrainNodeAddress;
  readonly width: number;
  readonly height: number;
  readonly codec: TerrainRgbCodec;
  /** Decoded metres. NaN entries are the reserved terrain-RGB no-data value. */
  readonly data: Float32Array;
  readonly byteLength?: number;
}

export interface ResidentTileSet {
  get(address: TerrainNodeAddress): TerrainTile | undefined;
}

export interface DetailNoiseOptions {
  readonly seed: number;
  readonly octaves: number;
  readonly baseAmplitudeM: number;
  readonly baseWavelengthKm: number;
  readonly lacunarity: number;
  readonly gain: number;
}

export interface HeroRegionConfig {
  readonly id: string;
  readonly centerLatDeg: number;
  readonly centerLonDeg: number;
  readonly radiusKm: number;
  readonly featherKm: number;
  /** The DEM is injected by the resident tile owner; this module never fetches. */
  readonly sample: (latRad: number, lonRad: number) => number | null;
  readonly manifestUrl?: string;
}

export interface HeightField {
  readonly tiles: ResidentTileSet;
  readonly level: number;
  readonly detail?: Partial<DetailNoiseOptions>;
  readonly heroRegions?: readonly HeroRegionConfig[];
}

const UINT32_RANGE = 4294967296;
const TAU = Math.PI * 2;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function wrapLongitude(lonRad: number): number {
  return ((lonRad + Math.PI) % TAU + TAU) % TAU - Math.PI;
}

function validateRgbChannel(channel: number): void {
  if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
    throw new Error(`Terrain-RGB channel must be an integer from 0 to 255, received ${channel}`);
  }
}

function isNoDataRgb(rgb: TerrainRgb): boolean {
  return rgb[0] === TERRAIN_RGB_NO_DATA[0]
    && rgb[1] === TERRAIN_RGB_NO_DATA[1]
    && rgb[2] === TERRAIN_RGB_NO_DATA[2];
}

export function validateTerrainRgbCodec(codec: TerrainRgbCodec): void {
  if (codec === null || typeof codec !== 'object') throw new Error('Terrain-RGB codec must be an object');
  if (!Number.isFinite(codec.offsetM)) throw new Error(`Terrain-RGB codec offset must be finite, received ${codec.offsetM}`);
  if (!Number.isFinite(codec.scaleM) || codec.scaleM <= 0) throw new Error(`Terrain-RGB codec scale must be positive, received ${codec.scaleM}`);
}

export function decodeTerrainRgb(
  rgb: TerrainRgb,
  codec: TerrainRgbCodec = DEFAULT_TERRAIN_RGB_CODEC,
): number | null {
  validateTerrainRgbCodec(codec);
  validateRgbChannel(rgb[0]);
  validateRgbChannel(rgb[1]);
  validateRgbChannel(rgb[2]);
  if (isNoDataRgb(rgb)) return TERRAIN_NO_DATA_HEIGHT;
  return codec.offsetM + (rgb[0] * 65_536 + rgb[1] * 256 + rgb[2]) * codec.scaleM;
}

export function encodeTerrainRgb(
  heightM: number | null,
  codec: TerrainRgbCodec = DEFAULT_TERRAIN_RGB_CODEC,
): TerrainRgb {
  validateTerrainRgbCodec(codec);
  if (heightM === null) return TERRAIN_RGB_NO_DATA;
  if (!Number.isFinite(heightM)) throw new Error('Terrain elevation must be finite or null');
  // Keep the reserved all-white triplet unavailable to valid elevations.
  const encoded = clamp(Math.round((heightM - codec.offsetM) / codec.scaleM), 0, 16_777_214);
  return [
    Math.floor(encoded / 65_536),
    Math.floor((encoded % 65_536) / 256),
    encoded % 256,
  ];
}

export function terrainTileFromRgb(
  address: TerrainNodeAddress,
  width: number,
  height: number,
  rgba: Uint8Array,
  codec: TerrainRgbCodec = DEFAULT_TERRAIN_RGB_CODEC,
): TerrainTile {
  validateTerrainRgbCodec(codec);
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new Error('Terrain tile dimensions must be positive integers');
  }
  if (rgba.length !== width * height * 4) throw new Error('Terrain RGBA data has an unexpected length');
  const data = new Float32Array(width * height);
  for (let index = 0; index < data.length; index += 1) {
    const offset = index * 4;
    const decoded = decodeTerrainRgb([rgba[offset], rgba[offset + 1], rgba[offset + 2]], codec);
    data[index] = decoded === null ? Number.NaN : decoded;
  }
  return { address, width, height, codec, data, byteLength: data.byteLength };
}

export function directionFromLatLon(latRad: number, lonRad: number): Vec3 {
  if (!Number.isFinite(latRad) || latRad < -Math.PI / 2 || latRad > Math.PI / 2) {
    throw new Error(`Latitude must be in [-π/2, π/2], received ${latRad}`);
  }
  if (!Number.isFinite(lonRad)) throw new Error('Longitude must be finite');
  const latitudeCosine = Math.cos(latRad);
  const longitude = wrapLongitude(lonRad);
  const longitudeCosine = Math.cos(longitude);
  const longitudeSine = Math.sin(longitude);
  // Registration: the equirect rasters put their WEST edge (180W) at
  // texture u=0, and SphereGeometry maps u=0 to the -X meridian — so the
  // dateline is at -X and longitude ZERO is at +X, with z = -sin(lon).
  // (Proven by ground truth: the previous -x/+z version read Everest at the
  // Gulf of Mexico — +180 degrees of longitude off the visible textures.)
  return [latitudeCosine * longitudeCosine, Math.sin(latRad), -latitudeCosine * longitudeSine];
}

function tileSample(tile: TerrainTile, latRad: number, lonRad: number): number | null {
  const direction = directionFromLatLon(latRad, lonRad);
  const faceUv = directionToFaceUv(direction);
  if (faceUv.face !== tile.address.face) return null;
  const bounds = nodeUvBounds(tile.address);
  const u = clamp((faceUv.u - bounds.uMin) / (bounds.uMax - bounds.uMin), 0, 1);
  const v = clamp((faceUv.v - bounds.vMin) / (bounds.vMax - bounds.vMin), 0, 1);
  const x = u * (tile.width - 1);
  const y = v * (tile.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, tile.width - 1);
  const y1 = Math.min(y0 + 1, tile.height - 1);
  const tx = x - x0;
  const ty = y - y0;
  const at = (ix: number, iy: number): number | null => {
    const value = tile.data[iy * tile.width + ix];
    return Number.isFinite(value) ? value : null;
  };
  const topLeft = at(x0, y0);
  const topRight = at(x1, y0);
  const bottomLeft = at(x0, y1);
  const bottomRight = at(x1, y1);
  if (topLeft === null || topRight === null || bottomLeft === null || bottomRight === null) return null;
  const top = topLeft * (1 - tx) + topRight * tx;
  const bottom = bottomLeft * (1 - tx) + bottomRight * tx;
  return top * (1 - ty) + bottom * ty;
}

export function sampleResidentTerrain(
  latRad: number,
  lonRad: number,
  tiles: ResidentTileSet,
  level: number,
): number | null {
  const direction = directionFromLatLon(latRad, lonRad);
  let address: TerrainNodeAddress | null = addressFromDirection(direction, level);
  while (address !== null) {
    const tile = tiles.get(address);
    if (tile !== undefined) {
      const sample = tileSample(tile, latRad, lonRad);
      if (sample !== null) return sample;
    }
    address = parentAddress(address);
  }
  return null;
}

function terrainRandom(state: { value: number }): number {
  state.value = (1_664_525 * state.value + 1_013_904_223) >>> 0;
  return state.value / UINT32_RANGE;
}

function hashLattice(seed: number, x: number, y: number): number {
  let state = seed >>> 0;
  state = (state ^ Math.imul(x | 0, 0x9e3779b1)) >>> 0;
  state = (state ^ Math.imul(y | 0, 0x85ebca6b)) >>> 0;
  return terrainRandom({ value: state });
}

function valueNoise(latRad: number, lonRad: number, frequency: number, seed: number): number {
  const period = Math.max(1, Math.round(frequency));
  const x = ((wrapLongitude(lonRad) + Math.PI) / TAU) * period;
  const y = clamp((latRad + Math.PI / 2) / Math.PI, 0, 1) * period;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const x1 = (x0 + 1) % period;
  const y1 = Math.min(y0 + 1, period);
  const top = hashLattice(seed, x0, y0) * (1 - tx) + hashLattice(seed, x1, y0) * tx;
  const bottom = hashLattice(seed, x0, y1) * (1 - tx) + hashLattice(seed, x1, y1) * tx;
  return (top * (1 - ty) + bottom * ty) * 2 - 1;
}

function detailOptions(options: Partial<DetailNoiseOptions> = {}): DetailNoiseOptions {
  const defaults = SKY_CONFIG.terrain.detail;
  return {
    seed: options.seed ?? defaults.seed,
    octaves: options.octaves ?? defaults.octaves,
    baseAmplitudeM: options.baseAmplitudeM ?? defaults.baseAmplitudeM,
    baseWavelengthKm: options.baseWavelengthKm ?? defaults.baseWavelengthKm,
    lacunarity: options.lacunarity ?? defaults.lacunarity,
    gain: options.gain ?? defaults.gain,
  };
}

export function detailNoise(
  latRad: number,
  lonRad: number,
  options: Partial<DetailNoiseOptions> = {},
): number {
  const resolved = detailOptions(options);
  if (!Number.isSafeInteger(resolved.octaves) || resolved.octaves < 1) throw new Error('Detail octaves must be positive');
  if (!Number.isFinite(resolved.baseAmplitudeM) || resolved.baseAmplitudeM < 0) throw new Error('Detail amplitude must be non-negative');
  if (!Number.isFinite(resolved.baseWavelengthKm) || resolved.baseWavelengthKm <= 0) throw new Error('Detail wavelength must be positive');
  if (!Number.isFinite(resolved.lacunarity) || resolved.lacunarity <= 1) throw new Error('Detail lacunarity must be greater than one');
  if (!Number.isFinite(resolved.gain) || resolved.gain < 0 || resolved.gain > 1) throw new Error('Detail gain must be in [0, 1]');
  const baseFrequency = Math.max(1, Math.round((TAU * SKY_CONFIG.earthRadiusKm) / resolved.baseWavelengthKm));
  let frequency = baseFrequency;
  let amplitude = resolved.baseAmplitudeM;
  let total = 0;
  let amplitudeTotal = 0;
  for (let octave = 0; octave < resolved.octaves; octave += 1) {
    total += valueNoise(latRad, lonRad, frequency, (resolved.seed + octave * 0x6d2b79f5) >>> 0) * amplitude;
    amplitudeTotal += amplitude;
    frequency *= resolved.lacunarity;
    amplitude *= resolved.gain;
  }
  return amplitudeTotal === 0 ? 0 : total / amplitudeTotal;
}

function baseSlopeMask(
  latRad: number,
  lonRad: number,
  baseHeightM: number,
  field: HeightField,
): number {
  const sampleDistanceRad = (SKY_CONFIG.terrain.detail.slopeSampleKm * Math.PI) / (180 * (SKY_CONFIG.earthRadiusKm * Math.PI / 180));
  const east = sampleResidentTerrain(latRad, lonRad + sampleDistanceRad, field.tiles, field.level);
  const west = sampleResidentTerrain(latRad, lonRad - sampleDistanceRad, field.tiles, field.level);
  const north = sampleResidentTerrain(clamp(latRad + sampleDistanceRad, -Math.PI / 2, Math.PI / 2), lonRad, field.tiles, field.level);
  const south = sampleResidentTerrain(clamp(latRad - sampleDistanceRad, -Math.PI / 2, Math.PI / 2), lonRad, field.tiles, field.level);
  if (east === null || west === null || north === null || south === null) return baseHeightM > 0 ? 1 : 0;
  const gradient = Math.hypot((east - west) / 2, (north - south) / 2)
    / Math.max(kmToMeters(SKY_CONFIG.terrain.detail.slopeSampleKm), 1);
  const land = smoothstep(0, SKY_CONFIG.terrain.detail.landMaskHeightM, baseHeightM);
  return land * (0.35 + 0.65 * clamp(gradient * 25, 0, 1));
}

export function heroWeight(region: HeroRegionConfig, latRad: number, lonRad: number): number {
  const centerLat = region.centerLatDeg * Math.PI / 180;
  const centerLon = region.centerLonDeg * Math.PI / 180;
  const deltaLat = latRad - centerLat;
  const deltaLon = wrapLongitude(lonRad - centerLon);
  const haversine = Math.sin(deltaLat / 2) ** 2
    + Math.cos(centerLat) * Math.cos(latRad) * Math.sin(deltaLon / 2) ** 2;
  const distanceKm = SKY_CONFIG.earthRadiusKm * 2 * Math.asin(Math.sqrt(clamp(haversine, 0, 1)));
  if (distanceKm <= region.radiusKm) return 1;
  if (region.featherKm <= 0 || distanceKm >= region.radiusKm + region.featherKm) return 0;
  return 1 - smoothstep(region.radiusKm, region.radiusKm + region.featherKm, distanceKm);
}

export function height(latRad: number, lonRad: number, field: HeightField): number | null {
  const rasterHeight = sampleResidentTerrain(latRad, lonRad, field.tiles, field.level);
  if (rasterHeight === null) return null;
  const detail = detailNoise(latRad, lonRad, field.detail);
  const detailMask = baseSlopeMask(latRad, lonRad, rasterHeight, field);
  const baseHeightM = rasterHeight + detail * detailMask;
  let result = baseHeightM;
  for (const region of field.heroRegions ?? []) {
    const weight = heroWeight(region, latRad, lonRad);
    if (weight === 0) continue;
    const heroHeightM = region.sample(latRad, lonRad);
    if (heroHeightM !== null && Number.isFinite(heroHeightM)) result = result * (1 - weight) + heroHeightM * weight;
  }
  return result;
}

export function heightAboveGround(
  positionM: Vec3,
  field: HeightField,
  planetRadiusM = SKY_DERIVED.earthRadiusM,
): number | null {
  const radius = Math.hypot(positionM[0], positionM[1], positionM[2]);
  if (!Number.isFinite(radius) || radius === 0) throw new Error('AGL position must have a non-zero finite radius');
  const latRad = Math.asin(clamp(positionM[1] / radius, -1, 1));
  // Inverse of directionFromLatLon (lon 0 at +X): lon = atan2(-z, x).
  const lonRad = Math.atan2(-positionM[2], positionM[0]);
  const groundHeightM = height(latRad, lonRad, field);
  return groundHeightM === null ? null : radius - planetRadiusM - groundHeightM;
}

export function residentTileMap(tiles: ReadonlyMap<string, TerrainTile>): ResidentTileSet {
  return { get: (address) => tiles.get(nodeAddressKey(address)) };
}
