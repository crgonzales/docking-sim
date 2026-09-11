import {
  Color, DataTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace,
  RepeatWrapping, RGBAFormat, SRGBColorSpace, UnsignedByteType,
} from 'three';

const TEXTURE_SIZE = 256;
type SurfaceKind = 'asphalt' | 'concrete' | 'infield';

interface SurfaceProfile {
  readonly seed: number;
  readonly tileSizeM: number;
  readonly color: string;
  readonly colorVariation: number;
  readonly roughness: number;
  readonly roughnessVariation: number;
  readonly reliefM: number;
}

const PROFILES: Record<SurfaceKind, SurfaceProfile> = {
  asphalt: {
    seed: 0x41535048, tileSizeM: 0.75, color: '#454b4c', colorVariation: 0.55,
    roughness: 0.92, roughnessVariation: 0.045, reliefM: 0.0012,
  },
  concrete: {
    seed: 0x434f4e43, tileSizeM: 1.5, color: '#96968e', colorVariation: 0.22,
    roughness: 0.87, roughnessVariation: 0.035, reliefM: 0.0007,
  },
  infield: {
    seed: 0x534f494c, tileSizeM: 6, color: '#536047', colorVariation: 0.24,
    roughness: 0.98, roughnessVariation: 0.018, reliefM: 0.005,
  },
};

export interface AirfieldSurfaceMapSet {
  readonly color: DataTexture;
  /** Linear tangent normal in RGB, perceptual roughness in A. */
  readonly normalRoughness: DataTexture;
  readonly tileSizeM: number;
}

export interface AirfieldSurfaceTextures {
  readonly asphalt: AirfieldSurfaceMapSet;
  readonly concrete: AirfieldSurfaceMapSet;
  readonly infield: AirfieldSurfaceMapSet;
  setAnisotropy(requested: number, hardwareMaximum: number): void;
  dispose(): void;
}

function wrap(value: number, period: number): number {
  return ((value % period) + period) % period;
}

function lattice(x: number, y: number, period: number, seed: number): number {
  let hash = seed ^ Math.imul(wrap(x, period), 0x1f123bb5) ^ Math.imul(wrap(y, period), 0x5f356495);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 0xffffffff * 2 - 1;
}

/** Integer lattice periods make both the height field and its slopes tileable. */
function periodicNoise(u: number, v: number, period: number, seed: number): number {
  const x = u * period, y = v * period;
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = lattice(ix, iy, period, seed), b = lattice(ix + 1, iy, period, seed);
  const c = lattice(ix, iy + 1, period, seed), d = lattice(ix + 1, iy + 1, period, seed);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

function byte(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 255);
}

function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

const SRGB_TO_LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const value = i / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
});

/** Explicit complete mip chains: color averages in linear light, normals are
 * renormalized after averaging, and roughness retains its mean squared value. */
function mipmaps(base: Uint8Array<ArrayBuffer>, color: boolean) {
  const levels = [{ data: base, width: TEXTURE_SIZE, height: TEXTURE_SIZE }];
  while (levels[levels.length - 1].width > 1) {
    const previous = levels[levels.length - 1];
    const size = previous.width / 2;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const source = ((2 * y + dy) * previous.width + 2 * x + dx) * 4;
        const pixels = previous.data;
        r += color ? SRGB_TO_LINEAR[pixels[source]] : pixels[source] / 127.5 - 1;
        g += color ? SRGB_TO_LINEAR[pixels[source + 1]] : pixels[source + 1] / 127.5 - 1;
        b += color ? SRGB_TO_LINEAR[pixels[source + 2]] : pixels[source + 2] / 127.5 - 1;
        a += (pixels[source + 3] / 255) ** 2;
      }
      const target = (y * size + x) * 4;
      if (color) {
        data[target] = byte(linearToSrgb(r / 4));
        data[target + 1] = byte(linearToSrgb(g / 4));
        data[target + 2] = byte(linearToSrgb(b / 4));
        data[target + 3] = 255;
      } else {
        const length = Math.hypot(r, g, b) || 1;
        data[target] = byte(r / length * 0.5 + 0.5);
        data[target + 1] = byte(g / length * 0.5 + 0.5);
        data[target + 2] = byte(b / length * 0.5 + 0.5);
        data[target + 3] = byte(Math.sqrt(a / 4));
      }
    }
    levels.push({ data, width: size, height: size });
  }
  return levels;
}

function texture(data: Uint8Array<ArrayBuffer>, name: string, color: boolean): DataTexture {
  const result = new DataTexture(data, TEXTURE_SIZE, TEXTURE_SIZE, RGBAFormat, UnsignedByteType);
  result.name = name;
  result.colorSpace = color ? SRGBColorSpace : NoColorSpace;
  result.wrapS = result.wrapT = RepeatWrapping;
  result.magFilter = LinearFilter;
  result.minFilter = LinearMipmapLinearFilter;
  result.generateMipmaps = false;
  result.mipmaps = mipmaps(data, color);
  result.needsUpdate = true;
  return result;
}

function createMapSet(kind: SurfaceKind): AirfieldSurfaceMapSet {
  const profile = PROFILES[kind];
  const baseColor = new Color(profile.color);
  const colors = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  const detail = new Uint8Array(colors.length);
  const heights = new Float32Array(TEXTURE_SIZE * TEXTURE_SIZE);
  for (let y = 0; y < TEXTURE_SIZE; y++) for (let x = 0; x < TEXTURE_SIZE; x++) {
    const u = (x + 0.5) / TEXTURE_SIZE, v = (y + 0.5) / TEXTURE_SIZE;
    const coarse = periodicNoise(u, v, 8, profile.seed);
    const aggregate = periodicNoise(u, v, 48, profile.seed + 1);
    const fine = periodicNoise(u, v, 128, profile.seed + 2);
    // Pavement aggregate is millimetres/centimetres across, not broad cloudy
    // stains. A small uncorrelated grain sharpens the baked texture; the same
    // explicit mip chain integrates it away as it becomes smaller than a pixel.
    const grain = lattice(x, y, TEXTURE_SIZE, profile.seed + 3);
    const pattern = kind === 'infield'
      ? 0.25 * coarse + 0.5 * aggregate + 0.25 * fine
      : 0.05 * coarse + 0.2 * aggregate + 0.45 * fine + 0.3 * grain;
    const variation = 1 + profile.colorVariation * pattern;
    const index = y * TEXTURE_SIZE + x, offset = index * 4;
    colors[offset] = byte(linearToSrgb(baseColor.r * variation));
    colors[offset + 1] = byte(linearToSrgb(baseColor.g * variation));
    colors[offset + 2] = byte(linearToSrgb(baseColor.b * variation));
    colors[offset + 3] = 255;
    detail[offset + 3] = byte(Math.min(0.995,
      profile.roughness + profile.roughnessVariation * (0.8 * aggregate + 0.2 * fine)));
    heights[index] = profile.reliefM * (0.3 * coarse + 0.5 * aggregate + 0.2 * fine);
  }
  const texelSizeM = profile.tileSizeM / TEXTURE_SIZE;
  for (let y = 0; y < TEXTURE_SIZE; y++) for (let x = 0; x < TEXTURE_SIZE; x++) {
    const dx = (heights[y * TEXTURE_SIZE + wrap(x + 1, TEXTURE_SIZE)]
      - heights[y * TEXTURE_SIZE + wrap(x - 1, TEXTURE_SIZE)]) / (2 * texelSizeM);
    const dy = (heights[wrap(y + 1, TEXTURE_SIZE) * TEXTURE_SIZE + x]
      - heights[wrap(y - 1, TEXTURE_SIZE) * TEXTURE_SIZE + x]) / (2 * texelSizeM);
    const length = Math.hypot(dx, dy, 1), offset = (y * TEXTURE_SIZE + x) * 4;
    detail[offset] = byte(-dx / length * 0.5 + 0.5);
    detail[offset + 1] = byte(-dy / length * 0.5 + 0.5);
    detail[offset + 2] = byte(1 / length * 0.5 + 0.5);
  }
  return {
    color: texture(colors, `airfield-${kind}-color`, true),
    normalRoughness: texture(detail, `airfield-${kind}-normal-roughness`, false),
    tileSizeM: profile.tileSizeM,
  };
}

/** One shared set per mounted airfield: six 256² RGBA8 textures, ~2 MiB with
 * mips. No assets, global GPU cache, or texture generation in the frame loop. */
export function createAirfieldSurfaceTextures(): AirfieldSurfaceTextures {
  const asphalt = createMapSet('asphalt');
  const concrete = createMapSet('concrete');
  const infield = createMapSet('infield');
  const owned = [asphalt, concrete, infield].flatMap((set) => [set.color, set.normalRoughness]);
  return {
    asphalt, concrete, infield,
    setAnisotropy(requested, hardwareMaximum) {
      const maximum = Number.isFinite(hardwareMaximum) ? Math.max(1, Math.floor(hardwareMaximum)) : 1;
      const anisotropy = Math.max(1, Math.min(maximum, Number.isFinite(requested) ? Math.floor(requested) : 8));
      for (const map of owned) {
        if (map.anisotropy === anisotropy) continue;
        map.anisotropy = anisotropy;
        map.needsUpdate = true;
      }
    },
    dispose() {
      owned.forEach((map) => map.dispose());
    },
  };
}
