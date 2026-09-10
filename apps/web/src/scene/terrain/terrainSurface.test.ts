import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping,
  RGBAFormat, HalfFloatType, DataUtils,
} from 'three';

import {
  createTerrainSurfaceNoise,
  createTerrainSurfaceUniforms,
  generateTerrainSurfaceNoise,
  generateTerrainSurfaceBands,
  TERRAIN_SURFACE_GLSL,
  TERRAIN_SURFACE_NOISE_BYTES,
  TERRAIN_SURFACE_NOISE_CHANNELS,
  TERRAIN_SURFACE_NOISE_MIP_LEVELS,
  TERRAIN_SURFACE_NOISE_SIZE,
  type TerrainSurfaceNoiseResource,
} from './terrainSurface';

const resources: TerrainSurfaceNoiseResource[] = [];
const own = (resource: TerrainSurfaceNoiseResource): TerrainSurfaceNoiseResource => {
  resources.push(resource);
  return resource;
};
afterEach(() => resources.splice(0).forEach(resource => resource.dispose()));

describe('terrain surface material noise', () => {
  it('is byte-deterministic for one seed and varies for another', () => {
    const first = generateTerrainSurfaceNoise(0x1234_5678);
    const repeated = generateTerrainSurfaceNoise(0x1234_5678);
    const changed = generateTerrainSurfaceNoise(0x1234_5679);
    expect(first).toEqual(repeated);
    expect(changed).not.toEqual(first);
  });

  it.each([7, 0, 0xa341_316c])('fills every channel with non-degenerate variation for seed %i', seed => {
    const data = generateTerrainSurfaceNoise(seed);
    expect(data).toHaveLength(TERRAIN_SURFACE_NOISE_SIZE ** 3 * TERRAIN_SURFACE_NOISE_CHANNELS);
    for (let channel = 0; channel < TERRAIN_SURFACE_NOISE_CHANNELS; channel += 1) {
      const values = data.filter((_value, index) => index % TERRAIN_SURFACE_NOISE_CHANNELS === channel);
      const minimum = Math.min(...values);
      const maximum = Math.max(...values);
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      expect(minimum).toBeGreaterThanOrEqual(0);
      expect(maximum).toBeLessThanOrEqual(255);
      expect(maximum - minimum).toBeGreaterThan(80);
      expect(mean).toBeGreaterThan(80);
      expect(mean).toBeLessThan(175);
    }
  });

  it('creates four mipmapped height/slope bands inside the stated budget', () => {
    const resource = own(createTerrainSurfaceNoise(17));
    const { texture } = resource;
    expect(texture.image.width).toBe(32);
    expect(texture.image.height).toBe(32);
    expect(texture.image.depth).toBe(32);
    expect(resource.bands).toHaveLength(4);
    expect(texture.image.data.byteLength).toBe(32 ** 3 * 4 * 2);
    expect(texture.format).toBe(RGBAFormat);
    expect(texture.type).toBe(HalfFloatType);
    expect(texture.internalFormat).toBe('RGBA16F');
    expect(texture.colorSpace).toBe(NoColorSpace);
    expect(texture.wrapS).toBe(RepeatWrapping);
    expect(texture.wrapT).toBe(RepeatWrapping);
    expect(texture.wrapR).toBe(RepeatWrapping);
    expect(texture.minFilter).toBe(LinearMipmapLinearFilter);
    expect(texture.magFilter).toBe(LinearFilter);
    expect(texture.generateMipmaps).toBe(true);
    expect(TERRAIN_SURFACE_NOISE_MIP_LEVELS).toBe(6);
    expect(resource.bytes).toBe(TERRAIN_SURFACE_NOISE_BYTES);
    expect(resource.bytes).toBe(1_198_368);
    expect(resource.bytes).toBeLessThan(2 * 1024 ** 2);
  });

  it('disposes GPU ownership and retained upload bytes idempotently', () => {
    const resource = own(createTerrainSurfaceNoise(23));
    const disposals = resource.bands.map(texture => vi.spyOn(texture, 'dispose'));
    resource.dispose();
    resource.dispose();
    disposals.forEach(dispose => expect(dispose).toHaveBeenCalledOnce());
    resource.bands.forEach(texture => expect(texture.image.data.byteLength).toBe(0));
  });

  it('bakes finite periodic slopes from the same seeded height field', () => {
    const heights = generateTerrainSurfaceNoise(29);
    const bands = generateTerrainSurfaceBands(29);
    const at = (x: number, y: number, z: number, b: number) => heights[(((z + 32) % 32 * 32 + (y + 32) % 32) * 32 + (x + 32) % 32) * 4 + b]! * 2 / 255 - 1;
    for (const [x, y, z] of [[0, 0, 0], [31, 31, 31], [12, 8, 20]]) for (let b = 0; b < 4; b++) {
      const offset = ((z * 32 + y) * 32 + x) * 4;
      const values = Array.from(bands[b]!.slice(offset, offset + 4), DataUtils.fromHalfFloat);
      const expected = [(at(x + 1, y, z, b) - at(x - 1, y, z, b)) * 2,
        (at(x, y + 1, z, b) - at(x, y - 1, z, b)) * 2,
        (at(x, y, z + 1, b) - at(x, y, z - 1, b)) * 2, at(x, y, z, b)];
      values.forEach((v, i) => expect(Math.abs(v - expected[i]!)).toBeLessThan(0.002));
    }
  });

  it('provides the complete opt-in uniform contract', () => {
    const resource = own(createTerrainSurfaceNoise(29));
    const uniforms = createTerrainSurfaceUniforms(resource, 6_371_000, {
      enabled: false,
      detailStrength: 0.6,
      cameraPositionM: [6_371_050, 20, -30],
      patchCenterM: [6_370_000, 1000, -2000],
    });
    expect(uniforms.terrainSurfaceNoiseTexture.value).toBe(resource.texture);
    expect(uniforms.terrainSurfaceNoisePhase.value).toHaveLength(4);
    expect(uniforms.terrainSurfaceNoisePhase.value.every(phase =>
      phase.toArray().every(value => value >= 0 && value < 1))).toBe(true);
    expect(uniforms.terrainSurfacePlanetRadiusM.value).toBe(6_371_000);
    expect(uniforms.terrainSurfaceCameraPositionM.value.toArray()).toEqual([6_371_050, 20, -30]);
    expect(uniforms.terrainSurfaceEnabled.value).toBe(0);
    expect(uniforms.terrainSurfaceDetailStrength.value).toBe(0.6);
  });

  it('exports a four-sample filtered material and matching derivative normal contract', () => {
    expect(TERRAIN_SURFACE_GLSL.match(/textureGrad\s*\(/g)).toHaveLength(1);
    expect(TERRAIN_SURFACE_GLSL).toContain('1000.0');
    expect(TERRAIN_SURFACE_GLSL).toContain('150.0');
    expect(TERRAIN_SURFACE_GLSL).toContain('24.0');
    expect(TERRAIN_SURFACE_GLSL).toContain('3.0');
    expect(TERRAIN_SURFACE_GLSL).toContain('terrainSurfaceAlbedo(');
    expect(TERRAIN_SURFACE_GLSL).toContain('terrainSurfaceNormal(');
    expect(TERRAIN_SURFACE_GLSL).toContain('gradient - normal * dot(normal, gradient)');
    expect(TERRAIN_SURFACE_GLSL).not.toContain('dFdx(heightM)');
    expect(TERRAIN_SURFACE_GLSL).toContain('smoothstep(30000.0, 70000.0, cameraDistanceM)');
    const executable = TERRAIN_SURFACE_GLSL.replace(/\/\/.*$/gm, '');
    expect(executable).not.toMatch(/sun(Direction|Dir)|shadow|irradiance/i);
  });
});
