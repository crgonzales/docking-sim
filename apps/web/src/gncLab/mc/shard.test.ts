import { describe, expect, it } from 'vitest';
import { testManifest } from './fixtures';
import { coverage, expectedKeys, keyId, shardOf, shardOverlaps } from './shard';

describe('expected keys and ownership', () => {
  it('enumerates every (pair, case) in pair-then-case order with its owning shard', () => {
    const keys = expectedKeys(testManifest());
    expect(keys).toEqual([
      { pairIndex: 0, caseId: 'NOMINAL', shardId: 'shard-a' },
      { pairIndex: 0, caseId: 'RCS_STUCK_OPEN', shardId: 'shard-a' },
      { pairIndex: 1, caseId: 'NOMINAL', shardId: 'shard-a' },
      { pairIndex: 1, caseId: 'RCS_STUCK_OPEN', shardId: 'shard-a' },
      { pairIndex: 2, caseId: 'NOMINAL', shardId: 'shard-b' },
      { pairIndex: 2, caseId: 'RCS_STUCK_OPEN', shardId: 'shard-b' },
    ]);
    expect(keyId(keys[3]!)).toBe('1:RCS_STUCK_OPEN');
  });

  it('looks up the owning shard and rejects unowned indices', () => {
    const manifest = testManifest();
    expect(shardOf(manifest, 1)?.id).toBe('shard-a');
    expect(shardOf(manifest, 2)?.id).toBe('shard-b');
    expect(shardOf(manifest, 3)).toBeNull();
    const unowned = testManifest({ shards: [{ id: 'shard-a', start: 0, end: 2 }] });
    expect(() => expectedKeys(unowned)).toThrow(/not owned by any shard/);
  });

  it('detects pairwise shard overlaps', () => {
    expect(shardOverlaps(testManifest().shards)).toEqual([]);
    expect(shardOverlaps([{ id: 'a', start: 0, end: 5 }, { id: 'b', start: 3, end: 8 }, { id: 'c', start: 8, end: 9 }]))
      .toEqual([{ a: 'a', b: 'b', start: 3, end: 5 }]);
  });
});

describe('coverage', () => {
  it('reports missing keys per shard, unexpected keys, and ignores repeated sightings', () => {
    const expected = expectedKeys(testManifest());
    const result = coverage(expected, [
      { pairIndex: 0, caseId: 'NOMINAL' },
      { pairIndex: 0, caseId: 'RCS_STUCK_OPEN' },
      { pairIndex: 0, caseId: 'RCS_STUCK_OPEN' },
      { pairIndex: 2, caseId: 'NOMINAL' },
      { pairIndex: 7, caseId: 'NOMINAL' },
    ]);
    expect(result.expected).toBe(6);
    expect(result.seen).toBe(3);
    expect(result.missing).toBe(3);
    expect(result.missingByShard).toEqual({
      'shard-a': [{ pairIndex: 1, caseId: 'NOMINAL' }, { pairIndex: 1, caseId: 'RCS_STUCK_OPEN' }],
      'shard-b': [{ pairIndex: 2, caseId: 'RCS_STUCK_OPEN' }],
    });
    expect(result.unexpected).toEqual([{ pairIndex: 7, caseId: 'NOMINAL' }]);
  });

  it('is complete when every expected key was seen', () => {
    const expected = expectedKeys(testManifest());
    const result = coverage(expected, expected);
    expect(result.missing).toBe(0);
    expect(result.missingByShard).toEqual({});
    expect(result.unexpected).toEqual([]);
  });
});
