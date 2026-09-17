/**
 * Shard ownership and coverage for the distributed GNC Monte Carlo (F_0.19.0 B3).
 * Pure functions over the manifest; the manifest's shard plan is the only
 * source of ownership.
 */
import { MC_CASE_IDS, type CampaignManifest, type McCaseId, type ShardSpec } from './manifest';

export interface ResultKey {
  pairIndex: number;
  caseId: McCaseId;
}

export interface ExpectedKey extends ResultKey {
  shardId: string;
}

export interface ShardOverlap {
  a: string;
  b: string;
  /** Half-open index range claimed by both shards. */
  start: number;
  end: number;
}

export interface Coverage {
  expected: number;
  /** Expected keys that were seen. */
  seen: number;
  missing: number;
  missingByShard: Record<string, ResultKey[]>;
  /** Seen keys outside the expected set. */
  unexpected: ResultKey[];
}

/** Stable string identity of a key, used for maps and sets. */
export function keyId(key: ResultKey): string {
  return `${key.pairIndex}:${key.caseId}`;
}

/** The shard owning a pair index, or null when no shard covers it. */
export function shardOf(manifest: CampaignManifest, pairIndex: number): ShardSpec | null {
  return manifest.shards.find((shard) => pairIndex >= shard.start && pairIndex < shard.end) ?? null;
}

/** Every pairwise overlap between shard ranges; empty for a valid manifest. */
export function shardOverlaps(shards: readonly ShardSpec[]): ShardOverlap[] {
  const overlaps: ShardOverlap[] = [];
  for (let i = 0; i < shards.length; i += 1) {
    for (let j = i + 1; j < shards.length; j += 1) {
      const a = shards[i]!;
      const b = shards[j]!;
      const start = Math.max(a.start, b.start);
      const end = Math.min(a.end, b.end);
      if (start < end) overlaps.push({ a: a.id, b: b.id, start, end });
    }
  }
  return overlaps;
}

/** Every (pairIndex, caseId) the campaign must produce, ordered by pair then case, with its owning shard. */
export function expectedKeys(manifest: CampaignManifest): ExpectedKey[] {
  const keys: ExpectedKey[] = [];
  for (let pairIndex = manifest.pairs.start; pairIndex < manifest.pairs.end; pairIndex += 1) {
    const shard = shardOf(manifest, pairIndex);
    if (shard === null) throw new RangeError(`pair index ${pairIndex} is not owned by any shard`);
    for (const caseId of MC_CASE_IDS) keys.push({ pairIndex, caseId, shardId: shard.id });
  }
  return keys;
}

/** Compare the expected set with the keys actually seen (valid successes). */
export function coverage(expected: readonly ExpectedKey[], seen: Iterable<ResultKey>): Coverage {
  const expectedIds = new Map(expected.map((key) => [keyId(key), key]));
  const seenIds = new Set<string>();
  const unexpected: ResultKey[] = [];
  for (const key of seen) {
    const id = keyId(key);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    if (!expectedIds.has(id)) unexpected.push({ pairIndex: key.pairIndex, caseId: key.caseId });
  }
  const missingByShard: Record<string, ResultKey[]> = {};
  let missing = 0;
  let seenCount = 0;
  for (const key of expected) {
    if (seenIds.has(keyId(key))) {
      seenCount += 1;
      continue;
    }
    missing += 1;
    (missingByShard[key.shardId] ??= []).push({ pairIndex: key.pairIndex, caseId: key.caseId });
  }
  return { expected: expected.length, seen: seenCount, missing, missingByShard, unexpected };
}
