import { ClampToEdgeWrapping, DataTexture, LinearFilter, LinearMipmapLinearFilter,
  NoColorSpace, RepeatWrapping, RGBAFormat, UnsignedByteType } from 'three';

export const GLOBAL_WEATHER_MAX_WIDTH = 1024;
export const GLOBAL_WEATHER_SEED = 0x6e624eb7;
export interface CoveragePixels {
  /** Encoded coverage bytes, north row first, red used for RGBA input. */
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  channels: 1 | 4;
}

const smooth = (x: number) => x * x * (3 - 2 * x);
function hash(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1442695041) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// Smooth Cartesian value noise on the unit sphere: no longitude seam or
// latitude-dependent UV stretching. Only modulates existing coverage.
function noise(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = smooth(x - ix), fy = smooth(y - iy), fz = smooth(z - iz);
  let value = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    value += hash(ix + dx, iy + dy, iz + dz, seed)
      * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
  }
  return value;
}

// A pole is one point. Reduction to the ring minimum preserves clear texels.
// Apply at every mip level: ordinary GPU mip generation breaks this invariant.
function collapsePoles(output: Uint8Array, width: number, height: number): void {
  for (const pole of [0, height - 1]) for (let c = 0; c < 3; c++) {
    let minimum = 255;
    for (let x = 0; x < width; x++) minimum = Math.min(minimum, output[(pole * width + x) * 4 + c]);
    for (let d = 0; d < Math.min(3, height / 2); d++) {
      const y = pole === 0 ? d : height - 1 - d, blend = smooth(d / 3);
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4 + c;
        output[i] = Math.round(Math.min(output[i], minimum) * (1 - blend) + output[i] * blend);
      }
    }
  }
}

/** One bounded bake, caller owns the result. R: broken low deck, G: sparse
 * taller formations, B: stretched cirrus, A: unused/clear. RGB never exceeds
 * its source coverage envelope. Not a meteorological cloud-type inference. */
export function createStructuredWeatherTexture(source: CoveragePixels, seed = GLOBAL_WEATHER_SEED): DataTexture {
  const { width, height, data, channels } = source;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 4 || height < 2
    || width !== height * 2 || width > GLOBAL_WEATHER_MAX_WIDTH
    || (channels !== 1 && channels !== 4) || data.length !== width * height * channels
    || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error('Structured weather requires bounded 2:1 coverage bytes and a uint32 seed');
  }
  const output = new Uint8Array(width * height * 4);
  const longitude = new Float64Array(width * 2);
  for (let x = 0; x < width; x++) {
    const phi = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
    longitude[x * 2] = Math.cos(phi); longitude[x * 2 + 1] = Math.sin(phi);
  }
  for (let y = 0; y < height; y++) {
    const theta = (0.5 - (y + 0.5) / height) * Math.PI;
    const radius = Math.cos(theta), z = Math.sin(theta);
    for (let x = 0; x < width; x++) {
      const coverage = data[(y * width + x) * channels] / 255;
      if (coverage === 0) continue;
      const nx = radius * longitude[x * 2], ny = radius * longitude[x * 2 + 1];
      // ~200–700 km structure supplements Takram's existing metre-space 3D shape.
      const formation = noise(nx * 20, ny * 20, z * 20, seed);
      const breakup = noise(nx * 72, ny * 72, z * 72, seed ^ 0x9e3779b9);
      const wisps = noise(nx * 12 + z * 18, ny * 12, z * 96, seed ^ 0x85ebca6b);
      const tall = smooth(Math.max(0, Math.min(1, (formation - 0.38) / 0.42)));
      const broken = smooth(Math.max(0, Math.min(1, (breakup - 0.18) / 0.64)));
      // Typed-array uploads are south-first; do not rely on UNPACK_FLIP_Y_WEBGL.
      const i = ((height - 1 - y) * width + x) * 4;
      output[i] = Math.round(255 * coverage * (0.55 + 0.45 * broken) * (1 - 0.3 * tall));
      output[i + 1] = Math.round(255 * coverage * coverage * tall * (0.65 + 0.35 * broken));
      output[i + 2] = Math.round(255 * coverage * (0.25 + 0.75 * smooth(wisps)) * (1 - 0.35 * tall));
    }
  }
  collapsePoles(output, width, height);
  const mipmaps = [{ data: output, width, height }];
  let previous = mipmaps[0];
  while (previous.width > 1 || previous.height > 1) {
    const w = Math.max(1, Math.floor(previous.width / 2)), h = Math.max(1, Math.floor(previous.height / 2));
    const pixels = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * previous.width / w), x1 = Math.floor((x + 1) * previous.width / w);
      const y0 = Math.floor(y * previous.height / h), y1 = Math.floor((y + 1) * previous.height / h);
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) sum += previous.data[(sy * previous.width + sx) * 4 + c];
        pixels[(y * w + x) * 4 + c] = Math.round(sum / ((x1 - x0) * (y1 - y0)));
      }
    }
    collapsePoles(pixels, w, h);
    previous = { data: pixels, width: w, height: h }; mipmaps.push(previous);
  }
  const texture = new DataTexture(output, width, height, RGBAFormat, UnsignedByteType);
  texture.name = `global-weather-structured-${seed}`;
  texture.colorSpace = NoColorSpace;
  texture.wrapS = RepeatWrapping; texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = LinearMipmapLinearFilter; texture.magFilter = LinearFilter;
  texture.mipmaps = mipmaps; // Three's DataTexture manual chain includes level zero.
  texture.generateMipmaps = false; texture.needsUpdate = true;
  return texture;
}
