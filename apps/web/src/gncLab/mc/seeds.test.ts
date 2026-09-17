import { describe, expect, it } from 'vitest';
import { deriveSeed } from '@docking/sim-core';
import {
  findSeedCollisions,
  PAIR_SEED_DERIVATION,
  PAIR_SEED_LABEL,
  pairSeed,
  pairSeedLabel,
  scanSeedCollisions,
} from './seeds';

const MASTER = 20260915;

describe('pair seeds', () => {
  it('derive exactly deriveSeed(master, "pair-<i>") from the existing sim-core RNG', () => {
    for (const index of [0, 1, 7, 999, 123456]) {
      expect(pairSeedLabel(index)).toBe(`pair-${index}`);
      expect(pairSeed(MASTER, index)).toBe(deriveSeed(MASTER, `pair-${index}`));
    }
    expect(PAIR_SEED_LABEL).toBe('pair-${index}');
    expect(PAIR_SEED_DERIVATION).toBe('deriveSeed');
  });

  it('are unsigned 32-bit integers that depend on the master seed', () => {
    const seed = pairSeed(MASTER, 3);
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(2 ** 32);
    expect(pairSeed(MASTER + 1, 3)).not.toBe(seed);
  });

  it('reject non-integer, negative or out-of-range inputs', () => {
    expect(() => pairSeed(-1, 0)).toThrow(RangeError);
    expect(() => pairSeed(2 ** 32, 0)).toThrow(RangeError);
    expect(() => pairSeed(1.5, 0)).toThrow(RangeError);
    expect(() => pairSeed(MASTER, -1)).toThrow(RangeError);
    expect(() => pairSeed(MASTER, 2.5)).toThrow(RangeError);
    expect(() => scanSeedCollisions(MASTER, 5, 4)).toThrow(RangeError);
  });
});

describe('seed collision scan', () => {
  it('finds a planted duplicate and lists its pair indices in ascending order', () => {
    const collisions = findSeedCollisions([
      { pairIndex: 9, seed: 42 },
      { pairIndex: 2, seed: 7 },
      { pairIndex: 4, seed: 42 },
      { pairIndex: 6, seed: 11 },
    ]);
    expect(collisions).toEqual([{ seed: 42, pairIndices: [4, 9] }]);
  });

  it('reports nothing when every seed is distinct', () => {
    expect(findSeedCollisions([{ pairIndex: 0, seed: 1 }, { pairIndex: 1, seed: 2 }])).toEqual([]);
  });

  it('scans a half-open index range with the real derivation', () => {
    const scanned = scanSeedCollisions(MASTER, 0, 1000);
    // Whatever the outcome, it must agree with an explicit derivation of the same range.
    const explicit = findSeedCollisions(Array.from({ length: 1000 }, (_, pairIndex) => ({ pairIndex, seed: pairSeed(MASTER, pairIndex) })));
    expect(scanned).toEqual(explicit);
    expect(scanSeedCollisions(MASTER, 10, 10)).toEqual([]);
  });
});
