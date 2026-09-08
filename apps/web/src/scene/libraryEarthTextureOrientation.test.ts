import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { EARTH_KTX_UV_GLSL } from './libraryEarthTextureOrientation';

type Uv = readonly [number, number];
// Execute the exported GLSL arithmetic itself; only the function declaration
// and vec2 constructor need JS equivalents. No renderer or shader compilation.
const mapUv = new Function('vec2', EARTH_KTX_UV_GLSL.replace(
  'vec2 earthMapUv(vec2 uv)', 'function earthMapUv(uv)',
) + '\nreturn earthMapUv;')((x: number, y: number): Uv => [x, y]) as
  (uv: { x: number; y: number }) => Uv;
const mapped = ([x, y]: Uv): Uv => mapUv({ x, y });
const publicUrl = new URL('../../public/', import.meta.url);
const asset = (name: string): Buffer => readFileSync(new URL(`assets/textures/${name}`, publicUrl));
const names = [
  'earth_day_4k.ktx2', 'earth_day_2k.ktx2', 'earth_night_2k.ktx2',
  'earth_spec_2k.ktx2', 'earth_normal_4k.ktx2', 'earth_clouds_4k.ktx2',
] as const;

function keyValues(bytes: Buffer): Map<string, string> {
  expect([...bytes.subarray(0, 12)]).toEqual([171, 75, 84, 88, 32, 50, 48, 187, 13, 10, 26, 10]);
  const offset = bytes.readUInt32LE(56), end = offset + bytes.readUInt32LE(60);
  expect(end).toBeLessThanOrEqual(bytes.length);
  const entries = new Map<string, string>();
  for (let cursor = offset; cursor < end;) {
    const length = bytes.readUInt32LE(cursor);
    const entry = bytes.subarray(cursor + 4, cursor + 4 + length);
    const separator = entry.indexOf(0);
    expect(separator).toBeGreaterThan(0);
    entries.set(entry.subarray(0, separator).toString(), entry.subarray(separator + 1).toString().replace(/\0+$/, ''));
    cursor += 4 + Math.ceil(length / 4) * 4;
  }
  return entries;
}

interface BasisFile {
  getWidth(): number;
  getImageLevelInfo(mip: number, layer: number, face: number): { origWidth: number; origHeight: number };
  startTranscoding(): boolean;
  getImageTranscodedSizeInBytes(mip: number, layer: number, face: number, format: number): number;
  transcodeImage(output: Uint8Array, mip: number, layer: number, face: number,
    format: number, flags: number, channel0: number, channel1: number): boolean;
  close(): void;
  delete(): void;
}
interface BasisModule {
  initializeBasis(): void;
  KTX2File: new (bytes: Uint8Array) => BasisFile;
}

async function bundledTranscoder(): Promise<BasisModule> {
  const script = new URL('basis_transcoder.js', publicUrl);
  // The application's existing Emscripten bundle exposes BASIS. Provide its
  // local wasm bytes explicitly: no network, generated files or new dependency.
  const factory = runInNewContext(readFileSync(script, 'utf8') + '\nBASIS;', {
    require: createRequire(import.meta.url), process,
    __filename: fileURLToPath(script), __dirname: dirname(fileURLToPath(script)),
    console, WebAssembly, TextDecoder, TextEncoder, setTimeout, clearTimeout,
  }) as (options: { wasmBinary: Buffer }) => Promise<BasisModule>;
  const basis = await factory({ wasmBinary: readFileSync(new URL('basis_transcoder.wasm', publicUrl)) });
  basis.initializeBasis();
  return basis;
}

describe('packaged Earth KTX2 orientation', () => {
  it('maps north/south to source rows and preserves longitude, including the seam', () => {
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      expect(mapped([u, 1])).toEqual([u, 0]);
      expect(mapped([u, 0])).toEqual([u, 1]);
      expect(mapped([u, 0.5])).toEqual([u, 0.5]);
    }
    // Geographic 40.5 N, 75 W: source row fraction (90 - latitude) / 180.
    expect(mapped([105 / 360, 0.725])[0]).toBe(105 / 360);
    expect(mapped([105 / 360, 0.725])[1]).toBeCloseTo(49.5 / 180, 14);
  });

  it('pins all six packaged headers: no explicit KTXorientation=rd metadata', () => {
    for (const name of names) {
      const metadata = keyValues(asset(name));
      expect(metadata.get('KTXwriter'), name).toBe('Basis Universal 2.50');
      expect(metadata.has('KTXorientation'), name).toBe(false);
    }
  });

  it('recovers land from both actual day tiers and the water mask at the reported ground footprint', async () => {
    const basis = await bundledTranscoder();
    // Analytic sea-level center-ray hit for flyto=40.5,-75,20000, pitch=-45,
    // yaw=90 and R=6371000: 40.499758118205804 N, 74.76309050582422 W.
    const uv: Uv = [0.29232474859493274, 0.7249986562122545];
    const rgba32 = 13; // Same Basis RGBA32 target as the installed KTX2Loader.
    for (const name of ['earth_day_4k.ktx2', 'earth_day_2k.ktx2', 'earth_spec_2k.ktx2']) {
      const file = new basis.KTX2File(new Uint8Array(asset(name)));
      try {
        expect(file.startTranscoding(), name).toBeTruthy();
        // Decode ONE embedded mip, at most 2 MiB RGBA, never a full 4k image.
        const mip = Math.log2(file.getWidth() / 1024);
        expect(Number.isInteger(mip) && mip >= 0, name).toBe(true);
        const { origWidth: width, origHeight: height } = file.getImageLevelInfo(mip, 0, 0);
        expect([width, height], name).toEqual([1024, 512]);
        const size = file.getImageTranscodedSizeInBytes(mip, 0, 0, rgba32);
        expect(size, name).toBe(1024 * 512 * 4);
        const pixels = new Uint8Array(size);
        expect(file.transcodeImage(pixels, mip, 0, 0, rgba32, 0, -1, -1), name).toBeTruthy();
        const sample = ([u, v]: Uv): number[] => {
          const offset = (Math.floor(v * height) * width + Math.floor(u * width)) * 4;
          return Array.from(pixels.subarray(offset, offset + 3));
        };
        const before = sample(uv), after = sample(mapped(uv));
        if (name === 'earth_spec_2k.ktx2') {
          expect(before[0]).toBeGreaterThan(245); // Southern ocean, incorrectly sampled.
          expect(after[0]).toBeLessThan(16); // Northern land, small coast contribution in mip.
        } else {
          expect(before[2]).toBeGreaterThan(before[0] * 3);
          expect(before[2]).toBeGreaterThan(before[1] * 1.5);
          expect(after[0]).toBeGreaterThan(after[2] * 2);
          expect(after[1]).toBeGreaterThan(after[2] * 1.5);
        }
      } finally {
        file.close();
        file.delete();
      }
    }
  });
});
