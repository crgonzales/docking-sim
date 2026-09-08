import { afterEach, describe, expect, it } from 'vitest';
import { ClampToEdgeWrapping, DataTexture, LinearFilter, LinearMipmapLinearFilter,
  Matrix4, NoColorSpace, RepeatWrapping, RGBAFormat, UnsignedByteType, Vector3 } from 'three';
import { createStructuredWeatherTexture, GLOBAL_WEATHER_MAX_WIDTH, type CoveragePixels } from './libraryCloudWeatherField';
import { directionToECEF, updateWorldToECEF } from './libraryFrame';
import { cloudSphericalUv } from './sky/cloudPlacement';
import { EARTH_CENTER_DISTANCE_M } from './sky/skyConfig';
import { WorldFrame } from './worldFrame';

const textures: DataTexture[] = [];
afterEach(() => textures.splice(0).forEach(texture => texture.dispose()));
function bake(source: CoveragePixels, seed?: number) {
  const texture = createStructuredWeatherTexture(source, seed);
  textures.push(texture);
  return texture;
}
function field(width = 128, value = 255): CoveragePixels {
  return { width, height: width / 2, channels: 1, data: new Uint8Array(width * width / 2).fill(value) };
}
// Bilinear normalized RGBA8 sampling, with the actual texture's wrap/clamp modes.
function sample(texture: DataTexture, u: number, v: number, channel = 0): number {
  const { data, width, height } = texture.image;
  const x = u * width - 0.5, y = v * height - 0.5, ix = Math.floor(x), iy = Math.floor(y);
  const texel = (x: number, y: number) => data[(Math.max(0, Math.min(height - 1, y)) * width
    + ((x % width) + width) % width) * 4 + channel] / 255;
  const fx = x - ix, fy = y - iy;
  return (texel(ix, iy) * (1 - fx) + texel(ix + 1, iy) * fx) * (1 - fy)
    + (texel(ix, iy + 1) * (1 - fx) + texel(ix + 1, iy + 1) * fx) * fy;
}

describe('bounded structured global weather', () => {
  it('keeps a clear field and clear islands exactly empty in all channels', () => {
    const clear = bake(field(128, 0));
    expect(clear.image.data.every(value => value === 0)).toBe(true);
    for (const mip of clear.mipmaps as { data: Uint8Array }[]) expect(mip.data.every(value => value === 0)).toBe(true);
    const source = field();
    for (let y = 15; y < 35; y++) for (let x = 20; x < 50; x++) source.data[y * source.width + x] = 0;
    const texture = bake(source);
    for (let y = 15; y < 35; y++) for (let x = 20; x < 50; x++) {
      const i = ((source.height - 1 - y) * source.width + x) * 4;
      expect(Array.from(texture.image.data.slice(i, i + 4))).toEqual([0, 0, 0, 0]);
    }
    // A filtered sample wholly inside the clear island stays clear, too.
    for (let c = 0; c < 4; c++) expect(sample(texture, 30 / 128, 1 - 25 / 64, c)).toBe(0);
  });

  it('only removes coverage, including polar consolidation and dark input', () => {
    const source = field();
    source.data.forEach((_, i) => { source.data[i] = i % 256; });
    const output = bake(source).image.data;
    for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
      const i = ((source.height - 1 - y) * source.width + x) * 4;
      for (let c = 0; c < 3; c++) expect(output[i + c]).toBeLessThanOrEqual(source.data[y * source.width + x]);
      expect(output[i + 3]).toBe(0);
    }
  });

  it('is deterministic and produces distinct, spatially varying cloud types', () => {
    const source = field(512);
    const first = bake(source, 123).image.data;
    expect(bake(source, 123).image.data).toEqual(first);
    expect(bake(source, 124).image.data).not.toEqual(first);
    const values = [0, 1, 2].map(c => Array.from(first).filter((_, i) => i % 4 === c));
    for (const channel of values) {
      expect(new Set(channel).size).toBeGreaterThan(50);
      expect(channel.reduce((maximum, value) => Math.max(maximum, value), 0)).toBeGreaterThan(180);
    }
    const mean = values.map(channel => channel.reduce((sum, value) => sum + value, 0) / channel.length);
    expect(mean[0]).toBeGreaterThan(mean[2]);
    expect(mean[2]).toBeGreaterThan(mean[1]);
    expect(values[1].filter(value => value < 20).length / values[1].length).toBeGreaterThan(0.1);
    // Fine-scale modulation remains resolved at the chosen bake resolution.
    let adjacentDifference = 0;
    for (let y = 8; y < 248; y++) for (let x = 1; x < 512; x++) {
      adjacentDifference += Math.abs(first[(y * 512 + x) * 4] - first[(y * 512 + x - 1) * 4]);
    }
    expect(adjacentDifference / (240 * 511)).toBeLessThan(30);
  });

  it('filters continuously across the dateline, with one value at each pole', () => {
    const texture = bake(field(512));
    for (let c = 0; c < 3; c++) for (const v of [0, 0.15, 0.5, 0.8, 1]) {
      expect(sample(texture, -1e-8, v, c)).toBeCloseTo(sample(texture, 1e-8, v, c), 5);
      expect(sample(texture, 0.37, v, c)).toBeCloseTo(sample(texture, 1.37, v, c), 12);
    }
    // All mip levels must converge at the poles, including trilinear blends.
    for (const mip of texture.mipmaps as { data: Uint8Array; width: number; height: number }[]) {
      for (const y of [0, mip.height - 1]) for (let c = 0; c < 3; c++) for (let x = 0; x < mip.width; x++) {
        expect(mip.data[(y * mip.width + x) * 4 + c]).toBe(mip.data[y * mip.width * 4 + c]);
      }
    }
  });

  it('preserves north/south, longitude rotation and the existing planet frame through camera rebases', () => {
    const source = field();
    // Northeast quadrant only: an accidental flip/rotation lights a clear quadrant.
    source.data.forEach((_, i) => { source.data[i] = i % 128 >= 64 && i < 128 * 32 ? 255 : 0; });
    const texture = bake(source);
    const direction = new Vector3(1, 1, -1).normalize();
    const earthPoint = direction.clone().multiplyScalar(6371000);
    const worldPoint = earthPoint.clone(); worldPoint.x -= EARTH_CENTER_DISTANCE_M;
    const uv = cloudSphericalUv(...direction.toArray() as [number, number, number]);
    expect(sample(texture, ...uv)).toBeGreaterThan(0);
    expect(sample(texture, uv[0] + 0.5, uv[1])).toBe(0);
    expect(sample(texture, uv[0], 1 - uv[1])).toBe(0);
    const ecef = directionToECEF(earthPoint).normalize();
    expect(Math.atan2(ecef.y, ecef.x) / (2 * Math.PI) + 0.5).toBeCloseTo(uv[0], 14);
    expect(Math.asin(ecef.z) / Math.PI + 0.5).toBeCloseTo(uv[1], 14);
    const frame = new WorldFrame();
    for (const anchor of [[0, 0, 0], [123456, -456789, 987654], earthPoint.toArray()] as [number, number, number][]) {
      frame.setAnchor(anchor);
      const recovered = new Vector3(...frame.toRender(worldPoint.toArray() as [number, number, number]))
        .applyMatrix4(updateWorldToECEF(frame, new Matrix4())).normalize();
      const u = Math.atan2(recovered.y, recovered.x) / (2 * Math.PI) + 0.5;
      const v = Math.asin(recovered.z) / Math.PI + 0.5;
      expect(sample(texture, u, v)).toBeCloseTo(sample(texture, ...uv), 12);
    }
  });

  it('uses filterable RGBA8 data with mipmaps and explicit south-first rows', () => {
    const texture = bake(field());
    expect(texture.format).toBe(RGBAFormat); expect(texture.type).toBe(UnsignedByteType);
    expect(texture.colorSpace).toBe(NoColorSpace); expect(texture.flipY).toBe(false);
    expect(texture.minFilter).toBe(LinearMipmapLinearFilter); expect(texture.magFilter).toBe(LinearFilter);
    expect(texture.generateMipmaps).toBe(false); expect(texture.version).toBeGreaterThan(0);
    const mipmaps = texture.mipmaps as { data: Uint8Array; width: number; height: number }[];
    expect(mipmaps).toHaveLength(8); expect(mipmaps[0].data).toBe(texture.image.data);
    mipmaps.forEach((mip, level) => {
      expect([mip.width, mip.height]).toEqual([Math.max(1, 128 >> level), Math.max(1, 64 >> level)]);
      expect(mip.data.byteLength).toBe(mip.width * mip.height * 4);
    });
    expect(texture.wrapS).toBe(RepeatWrapping); expect(texture.wrapT).toBe(ClampToEdgeWrapping);
    expect(texture.image.data.byteLength).toBe(128 * 64 * 4);
    const gray = field(16), rgba = new Uint8Array(16 * 8 * 4);
    for (let i = 0; i < gray.data.length; i++) rgba[i * 4] = gray.data[i];
    expect(bake({ ...gray, channels: 4, data: rgba }).image.data).toEqual(bake(gray).image.data);
  });

  it('bounds allocation and rejects invalid input before baking', () => {
    expect(GLOBAL_WEATHER_MAX_WIDTH).toBe(1024); // At most 2 MiB before mipmaps.
    for (const source of [{ ...field(), width: 2048, height: 1024 }, { ...field(), height: 1 },
      { ...field(), width: 4.5 }, { ...field(), data: new Uint8Array(1) }]) {
      expect(() => createStructuredWeatherTexture(source)).toThrow('bounded 2:1');
    }
    for (const seed of [-1, 0.5, NaN, Infinity, 0x100000000]) {
      expect(() => createStructuredWeatherTexture(field(), seed)).toThrow('uint32 seed');
    }
  });
});
