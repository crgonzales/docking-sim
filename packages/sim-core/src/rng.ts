/** Deterministic pseudo-random number generation for sim-core. */

export interface SeededRng {
  /** Uniform sample in [0, 1). */
  next(): number;
  /** Gaussian sample with the supplied mean and standard deviation. */
  gaussian(mean?: number, standardDeviation?: number): number;
  /** Create a deterministic child stream without consuming this stream. */
  substream(label: string): SeededRng;
}

/**
 * Derive a stable, independent-looking seed for a named subsystem stream.
 * The hash is deliberately defined here rather than relying on platform string
 * hashing, so seeded runs remain reproducible in browsers and Node.
 */
export function deriveSeed(master: number, label: string): number {
  let hash = 0x811c9dc5;
  const seed = master >>> 0;
  hash = Math.imul(hash ^ (seed & 0xff), 0x01000193);
  hash = Math.imul(hash ^ ((seed >>> 8) & 0xff), 0x01000193);
  hash = Math.imul(hash ^ ((seed >>> 16) & 0xff), 0x01000193);
  hash = Math.imul(hash ^ ((seed >>> 24) & 0xff), 0x01000193);

  for (let i = 0; i < label.length; i += 1) {
    const code = label.charCodeAt(i);
    hash = Math.imul(hash ^ (code & 0xff), 0x01000193);
    hash = Math.imul(hash ^ (code >>> 8), 0x01000193);
  }

  // Final avalanche (MurmurHash3-style integer mixing).
  let mixed = hash >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x85ebca6b);
  mixed ^= mixed >>> 13;
  mixed = Math.imul(mixed, 0xc2b2ae35);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

/** A mulberry32-class generator with a Box-Muller normal sampler. */
export class Mulberry32Rng implements SeededRng {
  private readonly seed: number;
  private state: number;

  public constructor(seed: number) {
    this.seed = seed >>> 0;
    this.state = this.seed;
  }

  public next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  public gaussian(mean = 0, standardDeviation = 1): number {
    if (standardDeviation < 0 || !Number.isFinite(standardDeviation)) {
      throw new RangeError('standardDeviation must be finite and non-negative');
    }

    // Avoid log(0), while retaining the exact deterministic uniform stream.
    const u1 = Math.max(Number.MIN_VALUE, this.next());
    const u2 = this.next();
    const radius = Math.sqrt(-2 * Math.log(u1));
    return mean + standardDeviation * radius * Math.cos(2 * Math.PI * u2);
  }

  public substream(label: string): SeededRng {
    return new Mulberry32Rng(deriveSeed(this.seed, label));
  }
}

export function createRng(seed: number): SeededRng {
  return new Mulberry32Rng(seed);
}
