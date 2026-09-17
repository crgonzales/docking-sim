import { describe, expect, it } from 'vitest';
import { aggregate, scientificPayload } from './aggregate';
import { syntheticResult, syntheticSummary, testManifest } from './fixtures';
import { manifestHash, withManifestHash, type CampaignManifest, type McCaseId } from './manifest';
import type { RunResult } from './results';
import { pairSeed } from './seeds';
import type { RunSummary } from './summarize';

const MANIFEST = withManifestHash(testManifest());
const HASH = manifestHash(MANIFEST);

function line(pairIndex: number, caseId: McCaseId, summary: Partial<RunSummary> = {}, overrides: Partial<RunResult> = {}): string {
  return JSON.stringify(syntheticResult({
    manifestHash: HASH,
    pairIndex,
    caseId,
    seed: pairSeed(MANIFEST.seedPolicy.masterSeed, pairIndex),
    shardId: pairIndex < 2 ? 'shard-a' : 'shard-b',
    summary: syntheticSummary(summary),
    ...overrides,
  }));
}

function errorLine(pairIndex: number, caseId: McCaseId, attempt = 1): string {
  return line(pairIndex, caseId, {}, {
    status: 'error', summary: undefined, attempt, error: { class: 'RangeError', message: 'worker crashed' },
  });
}

/** Three complete pairs: nominal always docks; the fault case aborts on pair 1. */
function completeCampaign(): string[] {
  return [
    line(0, 'NOMINAL', { outcomeTick: 68_000, propUsed_kg: 1.9 }),
    line(0, 'RCS_STUCK_OPEN', { outcomeTick: 67_000, propUsed_kg: 2.1, interval: { ...syntheticSummary().interval, appliedFullDutyWindows: 400, peakBodyRate_dps: 5.8 } }),
    line(1, 'NOMINAL', { outcomeTick: 68_200, propUsed_kg: 1.8 }),
    line(1, 'RCS_STUCK_OPEN', { outcome: 'ABORT', outcomeTick: 35_910, propUsed_kg: 3.0, lastDocking: null, interval: { ...syntheticSummary().interval, appliedFullDutyWindows: 400, peakBodyRate_dps: 5.9 } }),
    line(2, 'NOMINAL', { outcomeTick: 68_100, propUsed_kg: 2.0 }),
    line(2, 'RCS_STUCK_OPEN', { outcomeTick: 67_500, propUsed_kg: 2.2, interval: { ...syntheticSummary().interval, complete: false, windows: 250, appliedFullDutyWindows: 250 } }),
  ];
}

describe('aggregate: complete consistent campaign', () => {
  const summary = aggregate(MANIFEST, completeCampaign());

  it('is FINAL with full coverage and no blocking reasons', () => {
    expect(summary.status).toBe('FINAL');
    expect(summary.blocking).toEqual([]);
    expect(summary.manifestHash).toBe(HASH);
    expect(summary.coverage).toEqual({
      expected: 6, ok: 6, errors: 0, missing: 0, duplicates: 0, conflicts: 0,
      foreign: 0, malformed: 0, rejected: 0, platformMismatch: 0, unexpected: 0,
    });
    expect(summary.seedCollisions).toEqual([]);
    expect(summary.ledger).toHaveLength(6);
    expect(summary.platforms).toEqual([{ node: 'v22.12.0', arch: 'x64', platform: 'linux', count: 6, matchesTarget: true }]);
  });

  it('reports per-case outcomes, Wilson intervals on the completed population, and scalar distributions', () => {
    const nominal = summary.perCase.NOMINAL;
    expect(nominal.n).toBe(3);
    expect(nominal.outcomes).toEqual({ DOCKED: 3, ABORT: 0, COLLISION: 0, TIMEOUT: 0 });
    expect(nominal.dockProbability?.p).toBe(1);
    expect(nominal.dockProbability?.wilson95[1]).toBe(1);
    expect(nominal.dockProbability?.wilson95[0]).toBeCloseTo(0.4385, 3);
    const fault = summary.perCase.RCS_STUCK_OPEN;
    expect(fault.outcomes).toEqual({ DOCKED: 2, ABORT: 1, COLLISION: 0, TIMEOUT: 0 });
    expect(fault.dockProbability?.p).toBeCloseTo(2 / 3, 12);
    expect(nominal.scalars.propUsed_kg!.summary).toEqual({ n: 3, min: 1.8, max: 2.0, mean: expect.closeTo(1.9, 12), median: 1.9 });
    expect(nominal.scalars.outcomeTime_s!.summary?.max).toBe(682);
    expect(nominal.scalars.outcomeTime_s!.histogram.max).toBe(1200);
    expect(nominal.scalars.propUsed_kg!.histogram.counts.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('builds the paired outcome tables and comparable-endpoint deltas with excluded counts', () => {
    const paired = summary.paired;
    expect(paired.completePairs).toBe(3);
    expect(paired.incompletePairs).toBe(0);
    expect(paired.outcomeTable.DOCKED.DOCKED).toBe(2);
    expect(paired.outcomeTable.DOCKED.ABORT).toBe(1);
    expect(paired.dockedTable).toEqual({ both: 2, nominalOnly: 1, faultOnly: 0, neither: 0 });
    // Same-outcome-class deltas: pairs 0 and 2 only.
    expect(paired.deltas.outcomeTime_s).toEqual({ n: 2, excluded: 1, summary: { n: 2, min: -10, max: -6, mean: -8, median: -8 } });
    expect(paired.deltas.propUsed_kg!.n).toBe(2);
    expect(paired.deltas.propUsed_kg!.summary?.mean).toBeCloseTo(0.2, 12);
    // Interval deltas: pair 2's fault run is incomplete, so pairs 0 and 1 only.
    expect(paired.deltas['interval.appliedFullDutyWindows']).toEqual({ n: 2, excluded: 1, summary: { n: 2, min: 400, max: 400, mean: 400, median: 400 } });
    expect(paired.deltas['interval.peakBodyRate_dps']!.n).toBe(2);
    expect(paired.deltas['interval.peakBodyRate_dps']!.summary?.min).toBeCloseTo(5.5, 12);
  });
});

describe('aggregate: rejection classes', () => {
  it('rejects malformed, foreign, wrong-seed, wrong-shard, out-of-range, non-finite and interval-mismatch lines with line numbers', () => {
    const lines = [
      ...completeCampaign(),
      '{oops',
      line(0, 'NOMINAL', {}, { manifestHash: 'd'.repeat(64) }),
      line(0, 'NOMINAL', {}, { seed: 1 }),
      line(0, 'NOMINAL', {}, { shardId: 'shard-b' }),
      line(0, 'NOMINAL', {}, { pairIndex: 9, seed: pairSeed(MANIFEST.seedPolicy.masterSeed, 9), shardId: 'shard-b' }),
      line(0, 'NOMINAL').replace('"propUsed_kg":1.9', '"propUsed_kg":1e999'),
      line(0, 'NOMINAL', { interval: { ...syntheticSummary().interval, toTick: 35_000 } }),
      '',
    ];
    const summary = aggregate(MANIFEST, lines);
    expect(summary.status).toBe('FINAL');
    expect(summary.coverage.malformed).toBe(1);
    expect(summary.coverage.foreign).toBe(1);
    expect(summary.coverage.rejected).toBe(5);
    expect(summary.rejected.map((entry) => entry.line)).toEqual([7, 8, 9, 10, 11, 12, 13]);
    expect(summary.rejected.map((entry) => entry.reason)).toEqual([
      expect.stringMatching(/^malformed: invalid JSON/),
      expect.stringMatching(/^foreign/),
      expect.stringMatching(/^seed 1 differs/),
      expect.stringMatching(/^shard shard-b does not own pair 0/),
      expect.stringMatching(/outside \[0, 3\)/),
      expect.stringMatching(/non-finite/),
      expect.stringMatching(/comparison interval/),
    ]);
    expect(summary.coverage.ok).toBe(6);
  });

  it('excludes platform-mismatch lines from the population and groups them separately', () => {
    const lines = completeCampaign();
    lines[0] = line(0, 'NOMINAL', {}, { host: { node: 'v26.7.0', arch: 'arm64', platform: 'darwin', cpuModel: 'Apple' }, platformMismatch: false });
    const summary = aggregate(MANIFEST, lines);
    expect(summary.status).toBe('PROVISIONAL');
    expect(summary.coverage.platformMismatch).toBe(1);
    expect(summary.coverage.missing).toBe(1);
    expect(summary.missingByShard).toEqual({ 'shard-a': [{ pairIndex: 0, caseId: 'NOMINAL' }] });
    expect(summary.platforms).toEqual([
      { node: 'v26.7.0', arch: 'arm64', platform: 'darwin', count: 1, matchesTarget: false },
      { node: 'v22.12.0', arch: 'x64', platform: 'linux', count: 5, matchesTarget: true },
    ]);
    expect(summary.blocking[0]).toMatch(/1 expected result\(s\) missing \(shard-a: 1\)/);
  });

  it('throws for an invalid manifest instead of aggregating against it', () => {
    const invalid: CampaignManifest = { ...MANIFEST, shards: [{ id: 'only', start: 0, end: 2 }] };
    expect(() => aggregate(invalid, [])).toThrow(RangeError);
  });
});

describe('aggregate: identity, retries and conflicts', () => {
  it('collapses identical retries that differ only in attempt, worker, shard diagnostics and wall time', () => {
    const retry = line(1, 'NOMINAL', { outcomeTick: 68_200, propUsed_kg: 1.8 }, { attempt: 2, workerId: 5, wallMs: 99 });
    const summary = aggregate(MANIFEST, [...completeCampaign(), retry]);
    expect(summary.status).toBe('FINAL');
    expect(summary.coverage.duplicates).toBe(1);
    expect(summary.coverage.ok).toBe(6);
    expect(summary.ledger).toHaveLength(7);
    expect(scientificPayload(JSON.parse(retry))).toBe(scientificPayload(JSON.parse(line(1, 'NOMINAL', { outcomeTick: 68_200, propUsed_kg: 1.8 }))));
  });

  it('blocks FINAL on a conflicting successful payload for the same key', () => {
    const conflict = line(1, 'NOMINAL', { outcomeTick: 68_201, propUsed_kg: 1.8 }, { attempt: 2 });
    const summary = aggregate(MANIFEST, [...completeCampaign(), conflict]);
    expect(summary.status).toBe('PROVISIONAL');
    expect(summary.coverage.conflicts).toBe(1);
    expect(summary.conflictKeys).toEqual([{ pairIndex: 1, caseId: 'NOMINAL' }]);
    expect(summary.blocking[0]).toMatch(/conflicting successful results: 1:NOMINAL/);
    // A conflicting key is not counted as resolved, so its pair is incomplete.
    expect(summary.coverage.ok).toBe(5);
    expect(summary.paired.completePairs).toBe(2);
    expect(summary.paired.incompletePairs).toBe(1);
  });

  it('resolves an error with a later validated success while keeping both attempts in the ledger', () => {
    const lines = completeCampaign();
    const success = lines[2]!;
    lines[2] = errorLine(1, 'NOMINAL', 1);
    const summary = aggregate(MANIFEST, [...lines, success.replace('"attempt":1', '"attempt":2')]);
    expect(summary.status).toBe('FINAL');
    expect(summary.coverage.errors).toBe(1);
    expect(summary.coverage.ok).toBe(6);
    expect(summary.failures).toEqual([expect.objectContaining({ pairIndex: 1, caseId: 'NOMINAL', errorClass: 'RangeError', resolved: true })]);
    expect(summary.ledger.filter((entry) => entry.pairIndex === 1 && entry.caseId === 'NOMINAL').map((entry) => entry.status)).toEqual(['error', 'ok']);
    expect(summary.perCase.NOMINAL.n).toBe(3);
  });

  it('keeps an unresolved error out of every denominator and blocks FINAL', () => {
    const lines = completeCampaign();
    lines[3] = errorLine(1, 'RCS_STUCK_OPEN');
    const summary = aggregate(MANIFEST, lines);
    expect(summary.status).toBe('PROVISIONAL');
    expect(summary.blocking).toEqual([
      expect.stringMatching(/unresolved errors: 1:RCS_STUCK_OPEN/),
      expect.stringMatching(/1 expected result\(s\) missing \(shard-a: 1\)/),
    ]);
    expect(summary.perCase.RCS_STUCK_OPEN.n).toBe(2);
    expect(summary.perCase.RCS_STUCK_OPEN.outcomes.ABORT).toBe(0);
    expect(summary.paired.completePairs).toBe(2);
    expect(summary.paired.incompletePairs).toBe(1);
    expect(summary.failures[0]!.resolved).toBe(false);
  });

  it('keeps a seedless error line in the failures ledger instead of rejecting it', () => {
    const seedless = JSON.parse(errorLine(1, 'RCS_STUCK_OPEN')) as Record<string, unknown>;
    delete seedless.seed;
    const lines = completeCampaign();
    lines[3] = JSON.stringify(seedless);
    const summary = aggregate(MANIFEST, lines);
    expect(summary.coverage.rejected).toBe(0);
    expect(summary.coverage.errors).toBe(1);
    expect(summary.failures).toEqual([expect.objectContaining({ pairIndex: 1, caseId: 'RCS_STUCK_OPEN', resolved: false })]);
    expect(summary.status).toBe('PROVISIONAL');
    // A seedless ok line is still rejected by the parser as malformed.
    const okSeedless = JSON.parse(line(1, 'RCS_STUCK_OPEN')) as Record<string, unknown>;
    delete okSeedless.seed;
    expect(aggregate(MANIFEST, [JSON.stringify(okSeedless)]).coverage.malformed).toBe(1);
  });

  it('reports a coverage gap as PROVISIONAL with missing keys per shard and an empty per-case report when nothing is in', () => {
    const partial = aggregate(MANIFEST, completeCampaign().slice(0, 4));
    expect(partial.status).toBe('PROVISIONAL');
    expect(partial.coverage.missing).toBe(2);
    expect(partial.missingByShard).toEqual({ 'shard-b': [{ pairIndex: 2, caseId: 'NOMINAL' }, { pairIndex: 2, caseId: 'RCS_STUCK_OPEN' }] });
    expect(partial.paired.completePairs).toBe(2);
    expect(partial.paired.incompletePairs).toBe(1);

    const empty = aggregate(MANIFEST, []);
    expect(empty.status).toBe('PROVISIONAL');
    expect(empty.perCase.NOMINAL.n).toBe(0);
    expect(empty.perCase.NOMINAL.dockProbability).toBeNull();
    expect(empty.perCase.NOMINAL.scalars.propUsed_kg!.summary).toBeNull();
    expect(empty.paired.deltas.outcomeTime_s).toEqual({ n: 0, excluded: 0, summary: null });
  });
});
