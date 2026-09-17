/**
 * Per-pair seed derivation for the distributed GNC Monte Carlo (F_0.19.0 B1).
 *
 * Seeds come from sim-core's own `deriveSeed`, with the same label pattern the
 * scenario Monte Carlo uses (`run-<i>` there, `pair-<i>` here). Both cases of a
 * pair share the derived seed; that is a rule of the runner, not an option.
 *
 * `deriveSeed` maps into 32 bits, so distinct indices may collide. No claim of
 * uniqueness is made: the scan below reports collisions, and identity is the
 * pair index, never the seed.
 */
import { deriveSeed } from '@docking/sim-core';

/** Label template recorded in the manifest's seed policy. */
export const PAIR_SEED_LABEL = 'pair-${index}';
/** Derivation recorded in the manifest's seed policy. */
export const PAIR_SEED_DERIVATION = 'deriveSeed';

const UINT32_LIMIT = 2 ** 32;

export interface SeedCollision {
  seed: number;
  /** Ascending pair indices that derive the same seed. */
  pairIndices: number[];
}

function validateMasterSeed(masterSeed: number): void {
  if (!Number.isInteger(masterSeed) || masterSeed < 0 || masterSeed >= UINT32_LIMIT) {
    throw new RangeError('masterSeed must be an integer in [0, 2^32)');
  }
}

function validateIndex(globalIndex: number, name = 'globalIndex'): void {
  if (!Number.isInteger(globalIndex) || globalIndex < 0) throw new RangeError(`${name} must be a non-negative integer`);
}

/** The exact `deriveSeed` label for a global pair index. */
export function pairSeedLabel(globalIndex: number): string {
  validateIndex(globalIndex);
  return `pair-${globalIndex}`;
}

/** Seed shared by both cases of pair `globalIndex`. */
export function pairSeed(masterSeed: number, globalIndex: number): number {
  validateMasterSeed(masterSeed);
  return deriveSeed(masterSeed, pairSeedLabel(globalIndex));
}

/** Group any repeated seeds among explicit (pairIndex, seed) entries. */
export function findSeedCollisions(entries: readonly { pairIndex: number; seed: number }[]): SeedCollision[] {
  const byS = new Map<number, number[]>();
  for (const entry of entries) {
    validateIndex(entry.pairIndex, 'pairIndex');
    if (!Number.isInteger(entry.seed)) throw new RangeError('seed must be an integer');
    const indices = byS.get(entry.seed);
    if (indices === undefined) byS.set(entry.seed, [entry.pairIndex]);
    else indices.push(entry.pairIndex);
  }
  return [...byS.entries()]
    .filter(([, indices]) => indices.length > 1)
    .map(([seed, indices]) => ({ seed, pairIndices: [...indices].sort((a, b) => a - b) }))
    .sort((a, b) => a.pairIndices[0]! - b.pairIndices[0]!);
}

/** Derive every seed in the half-open index range `[start, end)` and report collisions. */
export function scanSeedCollisions(masterSeed: number, start: number, end: number): SeedCollision[] {
  validateMasterSeed(masterSeed);
  validateIndex(start, 'start');
  if (!Number.isInteger(end) || end < start) throw new RangeError('end must be an integer at or after start');
  const entries: { pairIndex: number; seed: number }[] = [];
  for (let pairIndex = start; pairIndex < end; pairIndex += 1) {
    entries.push({ pairIndex, seed: pairSeed(masterSeed, pairIndex) });
  }
  return findSeedCollisions(entries);
}
