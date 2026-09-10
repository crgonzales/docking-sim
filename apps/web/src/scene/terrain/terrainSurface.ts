import {
  Data3DTexture, DataUtils, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, NoColorSpace,
  RepeatWrapping, RGBAFormat, Uniform, Vector3,
} from 'three';

import { SKY_CONFIG } from '../sky/skyConfig';
import terrainSurfaceSource from './terrainSurface.glsl?raw';
import { TERRAIN_SURFACE_DOMAIN_GLSL, TERRAIN_SURFACE_GRADIENT_GLSL, terrainSurfacePhases } from './terrainSurfacePhase';

export const TERRAIN_SURFACE_GLSL = terrainSurfaceSource.replace('/* TERRAIN_SURFACE_DOMAINS */', TERRAIN_SURFACE_DOMAIN_GLSL + '\n' + TERRAIN_SURFACE_GRADIENT_GLSL);
export const TERRAIN_SURFACE_NOISE_SIZE = 32;
export const TERRAIN_SURFACE_NOISE_CHANNELS = 4;
export const TERRAIN_SURFACE_NOISE_MIP_LEVELS = 6;
/** Four RGBA16F bands, including 32³ through 1³ mip levels. */
export const TERRAIN_SURFACE_NOISE_BYTES = 1_198_368;

const UINT32_MAX = 0xffff_ffff;
const NOISE_LATTICE_SIZE = 8;

function uint32(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new RangeError(`${label} must be a uint32`);
  }
  return value >>> 0;
}

function nextRandom(state: { value: number }): number {
  let value = state.value;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.value = value >>> 0;
  return state.value / UINT32_MAX;
}

interface AxisSample {
  readonly low: number;
  readonly high: number;
  readonly blend: number;
}

function smoother(value: number): number {
  return value * value * value * (value * (value * 6 - 15) + 10);
}

function axisSamples(size: number): readonly AxisSample[] {
  return Array.from({ length: size }, (_unused, coordinate) => {
    const latticeCoordinate = (coordinate + 0.5) / size * NOISE_LATTICE_SIZE;
    const low = Math.floor(latticeCoordinate);
    return {
      low,
      high: (low + 1) % NOISE_LATTICE_SIZE,
      blend: smoother(latticeCoordinate - low),
    };
  });
}

function mix(a: number, b: number, amount: number): number {
  return a + (b - a) * amount;
}

/** Pure, deterministic, periodic RGBA8 volume data; X is the fastest axis. */
export function generateTerrainSurfaceNoise(
  seed = SKY_CONFIG.terrain.detail.seed,
): Uint8Array<ArrayBuffer> {
  const resolvedSeed = uint32(seed, 'Terrain surface noise seed');
  const size = TERRAIN_SURFACE_NOISE_SIZE;
  const data = new Uint8Array(size ** 3 * TERRAIN_SURFACE_NOISE_CHANNELS);
  const lattice = new Float32Array(NOISE_LATTICE_SIZE ** 3 * TERRAIN_SURFACE_NOISE_CHANNELS);
  // Xorshift's zero state is absorbing, including when the seed cancels the salt.
  const random = { value: ((resolvedSeed ^ 0xa341_316c) >>> 0) || 1 };
  for (let index = 0; index < lattice.length; index += 1) lattice[index] = nextRandom(random);
  const axis = axisSamples(size);
  const latticeOffset = (x: number, y: number, z: number, channel: number): number =>
    ((z * NOISE_LATTICE_SIZE + y) * NOISE_LATTICE_SIZE + x) *
      TERRAIN_SURFACE_NOISE_CHANNELS + channel;
  let offset = 0;
  for (let z = 0; z < size; z += 1) {
    const sz = axis[z]!;
    for (let y = 0; y < size; y += 1) {
      const sy = axis[y]!;
      for (let x = 0; x < size; x += 1) {
        const sx = axis[x]!;
        for (let channel = 0; channel < TERRAIN_SURFACE_NOISE_CHANNELS; channel += 1) {
          const x00 = mix(
            lattice[latticeOffset(sx.low, sy.low, sz.low, channel)]!,
            lattice[latticeOffset(sx.high, sy.low, sz.low, channel)]!, sx.blend);
          const x10 = mix(
            lattice[latticeOffset(sx.low, sy.high, sz.low, channel)]!,
            lattice[latticeOffset(sx.high, sy.high, sz.low, channel)]!, sx.blend);
          const x01 = mix(
            lattice[latticeOffset(sx.low, sy.low, sz.high, channel)]!,
            lattice[latticeOffset(sx.high, sy.low, sz.high, channel)]!, sx.blend);
          const x11 = mix(
            lattice[latticeOffset(sx.low, sy.high, sz.high, channel)]!,
            lattice[latticeOffset(sx.high, sy.high, sz.high, channel)]!, sx.blend);
          const value = mix(mix(x00, x10, sy.blend), mix(x01, x11, sy.blend), sz.blend);
          data[offset + channel] = Math.round(Math.min(1, Math.max(0, value)) * 255);
        }
        offset += TERRAIN_SURFACE_NOISE_CHANNELS;
      }
    }
  }
  return data;
}

/** Bake slopes over a fixed lattice interval; never differentiate filtered GPU
 * samples at a screen-pixel interval, which amplifies interpolation quantization. */
export function generateTerrainSurfaceBands(seed = SKY_CONFIG.terrain.detail.seed): Uint16Array<ArrayBuffer>[] {
  const noise = generateTerrainSurfaceNoise(seed);
  const size = TERRAIN_SURFACE_NOISE_SIZE;
  const at = (x: number, y: number, z: number, band: number) =>
    noise[((((z + size) % size) * size + (y + size) % size) * size + (x + size) % size) * 4 + band]!;
  return Array.from({ length: 4 }, (_, band) => {
    const data = new Uint16Array(size ** 3 * 4);
    for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const offset = ((z * size + y) * size + x) * 4;
      const scale = size / NOISE_LATTICE_SIZE / 255;
      data[offset] = DataUtils.toHalfFloat((at(x + 1, y, z, band) - at(x - 1, y, z, band)) * scale);
      data[offset + 1] = DataUtils.toHalfFloat((at(x, y + 1, z, band) - at(x, y - 1, z, band)) * scale);
      data[offset + 2] = DataUtils.toHalfFloat((at(x, y, z + 1, band) - at(x, y, z - 1, band)) * scale);
      data[offset + 3] = DataUtils.toHalfFloat(at(x, y, z, band) * 2 / 255 - 1);
    }
    return data;
  });
}

export interface TerrainSurfaceNoiseResource {
  readonly texture: Data3DTexture;
  readonly bands: readonly Data3DTexture[];
  /** Exact GPU allocation including generated mip levels. */
  readonly bytes: number;
  dispose(): void;
}

/** One shared owner for four height/slope bands; never allocate per patch. */
export function createTerrainSurfaceNoise(seed = SKY_CONFIG.terrain.detail.seed): TerrainSurfaceNoiseResource {
  const size = TERRAIN_SURFACE_NOISE_SIZE;
  const bands = generateTerrainSurfaceBands(seed).map((data, band) => {
    const texture = new Data3DTexture(data, size, size, size);
    texture.name = `terrain-surface-band-${seed}-${band}`;
    texture.format = RGBAFormat;
    texture.internalFormat = 'RGBA16F';
    texture.type = HalfFloatType;
    texture.colorSpace = NoColorSpace;
    texture.wrapS = texture.wrapT = texture.wrapR = RepeatWrapping;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = true;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    return texture;
  });
  let disposed = false;
  return Object.freeze({
    texture: bands[0]!, bands, bytes: TERRAIN_SURFACE_NOISE_BYTES,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const texture of bands) {
        texture.dispose();
        texture.image.data = new Uint8Array(0);
      }
    },
  });
}

export interface TerrainSurfaceUniformOptions {
  readonly patchCenterM?: readonly [number, number, number];
  readonly enabled?: boolean;
  readonly detailStrength?: number;
  /** Planet-relative camera position in the same world axes as shader input. */
  readonly cameraPositionM?: readonly [number, number, number];
}

export interface TerrainSurfaceUniforms {
  readonly terrainSurfaceNoiseTexture: Uniform<Data3DTexture>;
  readonly terrainSurfaceBand1: Uniform<Data3DTexture>;
  readonly terrainSurfaceBand2: Uniform<Data3DTexture>;
  readonly terrainSurfaceBand3: Uniform<Data3DTexture>;
  readonly terrainSurfaceNoisePhase: Uniform<Vector3[]>;
  readonly terrainSurfacePlanetRadiusM: Uniform<number>;
  readonly terrainSurfaceCameraPositionM: Uniform<Vector3>;
  readonly terrainSurfaceEnabled: Uniform<number>;
  readonly terrainSurfaceDetailStrength: Uniform<number>;
}

export function createTerrainSurfaceUniforms(
  resource: TerrainSurfaceNoiseResource,
  planetRadiusM: number,
  options: TerrainSurfaceUniformOptions = {},
): TerrainSurfaceUniforms {
  const detailStrength = options.detailStrength ?? 1;
  if (!(planetRadiusM > 0) || !Number.isFinite(planetRadiusM)) {
    throw new RangeError('Terrain surface planetRadiusM must be positive and finite');
  }
  if (detailStrength < 0 || !Number.isFinite(detailStrength)) {
    throw new RangeError('Terrain surface detailStrength must be non-negative and finite');
  }
  const camera = options.cameraPositionM ?? [0, 0, 0];
  if (camera.some(value => !Number.isFinite(value))) {
    throw new RangeError('Terrain surface cameraPositionM must be finite');
  }
  return {
    terrainSurfaceNoiseTexture: new Uniform(resource.texture),
    terrainSurfaceBand1: new Uniform(resource.bands[1]!),
    terrainSurfaceBand2: new Uniform(resource.bands[2]!),
    terrainSurfaceBand3: new Uniform(resource.bands[3]!),
    terrainSurfaceNoisePhase: new Uniform(terrainSurfacePhases(options.patchCenterM ?? [0, 0, 0])),
    terrainSurfacePlanetRadiusM: new Uniform(planetRadiusM),
    terrainSurfaceCameraPositionM: new Uniform(new Vector3(...camera)),
    terrainSurfaceEnabled: new Uniform(options.enabled === false ? 0 : 1),
    terrainSurfaceDetailStrength: new Uniform(detailStrength),
  };
}
