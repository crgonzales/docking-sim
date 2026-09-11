import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RepeatWrapping } from 'three';
import { createAirfieldSurfaceTextures } from './airfieldSurfaceTextures';

type SurfaceMip = { data: Uint8Array; width: number; height: number };

describe('airfield surface texture resources', () => {
  it('creates deterministic complete mip chains within the fixed memory budget', () => {
    const first = createAirfieldSurfaceTextures(), second = createAirfieldSurfaceTextures();
    let bytes = 0;
    for (const kind of ['asphalt', 'concrete', 'infield'] as const) {
      for (const channel of ['color', 'normalRoughness'] as const) {
        const a = first[kind][channel], b = second[kind][channel];
        const aMips = a.mipmaps as SurfaceMip[], bMips = b.mipmaps as SurfaceMip[];
        expect(a.wrapS).toBe(RepeatWrapping);
        expect(a.wrapT).toBe(RepeatWrapping);
        expect(aMips.map((mip) => mip.width)).toEqual([256, 128, 64, 32, 16, 8, 4, 2, 1]);
        for (let level = 0; level < aMips.length; level++) {
          const x = aMips[level], y = bMips[level];
          expect(x.data.length).toBe(x.width * x.height * 4);
          bytes += x.data.byteLength;
          const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
          expect(digest(x.data)).toBe(digest(y.data));
          if (channel === 'normalRoughness') {
            let maxNormalError = 0, minZ = 1, minRoughness = 1;
            for (let offset = 0; offset < x.data.length; offset += 4) {
              const normal = [x.data[offset], x.data[offset + 1], x.data[offset + 2]].map((v) => v / 127.5 - 1);
              maxNormalError = Math.max(maxNormalError, Math.abs(Math.hypot(...normal) - 1));
              minZ = Math.min(minZ, normal[2]);
              minRoughness = Math.min(minRoughness, x.data[offset + 3] / 255);
            }
            expect(maxNormalError).toBeLessThan(0.012);
            expect(minZ).toBeGreaterThan(0.9);
            expect(minRoughness).toBeGreaterThan(0.75);
          }
        }
      }
    }
    expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    first.dispose(); second.dispose();
  });

  it('changes filtering without regenerating textures, then releases all six handles', () => {
    const resource = createAirfieldSurfaceTextures();
    const maps = [resource.asphalt, resource.concrete, resource.infield].flatMap((set) => [set.color, set.normalRoughness]);
    const images = maps.map((map) => map.image);
    resource.setAnisotropy(16, 8);
    expect(maps.every((map) => map.anisotropy === 8)).toBe(true);
    resource.setAnisotropy(-1, NaN);
    expect(maps.every((map) => map.anisotropy === 1)).toBe(true);
    maps.forEach((map, index) => expect(map.image).toBe(images[index]));
    let disposed = 0;
    maps.forEach((map) => map.addEventListener('dispose', () => disposed++));
    resource.dispose();
    expect(disposed).toBe(6);
  });
});
