import { describe, expect, it } from 'vitest';
import { aggregate, scientificPayload } from './aggregate';
import { assertValidManifest, withManifestHash, type CampaignManifest } from './manifest';
import { caseFromManifest, hostInfo, runOne } from './runPair';
import { testManifest } from './fixtures';
import { pairSeed } from './seeds';
import { createSummaryAccumulator } from './summarize';
import {
  buildDemoConfig,
  createDemoRun,
  DEMO_GEOMETRY,
  FAULT_STUCK_OPEN_TICK,
  NOMINAL_CASE,
  RCS_STUCK_OPEN_CASE,
  type DemoRecord,
} from '../session/demoRun';

const LONG_RUN_TIMEOUT_MS = 120_000;
const PLAN_INTERVAL = { thrusterId: 'J6', fromTick: 30_010, toTick: 34_000 };

/** A one-pair campaign on the real demo configuration, pinned to this host so its lines can be FINAL. */
function campaignManifest(overrides: Partial<CampaignManifest> = {}): CampaignManifest {
  const base = testManifest();
  const config = buildDemoConfig(DEMO_GEOMETRY);
  const host = hostInfo();
  return withManifestHash({
    ...base,
    cases: {
      NOMINAL: { geometry: DEMO_GEOMETRY, config, maxTicks: NOMINAL_CASE.maxTicks, schedule: [] },
      RCS_STUCK_OPEN: { geometry: DEMO_GEOMETRY, config, maxTicks: RCS_STUCK_OPEN_CASE.maxTicks, schedule: [...RCS_STUCK_OPEN_CASE.schedule] },
    },
    comparisonInterval: PLAN_INTERVAL,
    pairs: { start: 0, end: 1 },
    shards: [{ id: 'shard-a', start: 0, end: 1 }],
    platform: { node: host.node, arch: host.arch, platform: host.platform },
    ...overrides,
  });
}

function stripDiagnostics(result: ReturnType<typeof runOne>) {
  const { wallMs: _wall, ...rest } = result;
  return rest;
}

describe('runOne', () => {
  it('is seeded-repeatable: the same pair twice gives an identical scientific payload and result', () => {
    const manifest = campaignManifest();
    assertValidManifest(manifest);
    const first = runOne({ manifest, pairIndex: 0, caseId: 'NOMINAL', shardId: 'shard-a', workerId: 0, attempt: 1 });
    const second = runOne({ manifest, pairIndex: 0, caseId: 'NOMINAL', shardId: 'shard-a', workerId: 1, attempt: 2 });
    expect(first.status).toBe('ok');
    expect(first.seed).toBe(pairSeed(manifest.seedPolicy.masterSeed, 0));
    expect(first.platformMismatch).toBe(false);
    expect(first.host).toEqual(hostInfo());
    expect(scientificPayload(first)).toBe(scientificPayload(second));
    expect(stripDiagnostics(first)).toEqual({ ...stripDiagnostics(second), workerId: 0, attempt: 1 });
    expect(first.wallMs).toBeGreaterThan(0);
    expect(first.summary?.interval).toMatchObject(PLAN_INTERVAL);
    console.log(`runOne NOMINAL pair 0 seed ${first.seed}: outcome ${first.summary?.outcome} at tick ${first.summary?.outcomeTick}, wall ${first.wallMs.toFixed(0)} ms`);
  }, LONG_RUN_TIMEOUT_MS);

  it('reports TIMEOUT on a tiny hard cap and an error line, not a throw, when no frame is produced', () => {
    const tiny = campaignManifest({
      cases: {
        NOMINAL: { geometry: DEMO_GEOMETRY, config: buildDemoConfig(DEMO_GEOMETRY), maxTicks: 500, schedule: [] },
        RCS_STUCK_OPEN: { geometry: DEMO_GEOMETRY, config: buildDemoConfig(DEMO_GEOMETRY), maxTicks: 500, schedule: [] },
      },
      comparisonInterval: { thrusterId: 'J6', fromTick: 10, toTick: 20 },
    });
    assertValidManifest(tiny);
    const result = runOne({ manifest: tiny, pairIndex: 0, caseId: 'NOMINAL', shardId: 'shard-a', workerId: 0, attempt: 1 });
    expect(result.status).toBe('ok');
    expect(result.summary?.outcome).toBe('TIMEOUT');
    expect(result.summary?.outcomeTick).toBe(500);
    expect(result.summary?.frames).toBe(50);
    expect(result.summary?.interval.complete).toBe(true);

    // maxTicks 5 produces no FSW frame: the accumulator's empty-run throw becomes an error line.
    const frameless = { ...tiny, cases: { ...tiny.cases, NOMINAL: { ...tiny.cases.NOMINAL, maxTicks: 5 } } };
    const failed = runOne({ manifest: frameless, pairIndex: 0, caseId: 'NOMINAL', shardId: 'shard-a', workerId: 0, attempt: 1 });
    expect(failed.status).toBe('error');
    expect(failed.summary).toBeUndefined();
    expect(failed.error).toEqual({ class: 'RangeError', message: expect.stringContaining('at least one FSW record') });
    expect(failed.seed).toBe(pairSeed(tiny.seedPolicy.masterSeed, 0));
  }, LONG_RUN_TIMEOUT_MS);

  it('builds a runnable case from the manifest with no outcome assertion', () => {
    const manifest = campaignManifest();
    const gncCase = caseFromManifest(manifest, 'RCS_STUCK_OPEN', 1004);
    expect(gncCase.id).toBe('RCS_STUCK_OPEN');
    expect(gncCase.seed).toBe(1004);
    expect(gncCase.schedule).toEqual(RCS_STUCK_OPEN_CASE.schedule);
    expect(gncCase.expected.outcome).toBeUndefined();
    expect(gncCase.config).toBe(manifest.cases.RCS_STUCK_OPEN.config);
  });
});

describe('plan B2 acceptance oracle on the seed-1004 reference pair', () => {
  // The manifest can only carry derived seeds, so the reference oracle runs the
  // demo cases directly with their pinned seed 1004 through the same streaming
  // path runOne uses (createDemoRun + createSummaryAccumulator).
  it('counts 400 applied-full-duty J6 windows for the fault case and 0 for nominal, with identical pre-fault records', () => {
    const preFault: Record<string, string[]> = { NOMINAL: [], RCS_STUCK_OPEN: [] };
    const summaries = [NOMINAL_CASE, RCS_STUCK_OPEN_CASE].map((gncCase) => {
      const accumulator = createSummaryAccumulator({ interval: PLAN_INTERVAL, initialProp_kg: gncCase.config.initial.prop_kg });
      const started = performance.now();
      const run = createDemoRun(gncCase, {
        retainRecords: false,
        onRecord: (record: DemoRecord) => {
          if (record.tick < FAULT_STUCK_OPEN_TICK) preFault[gncCase.id]!.push(JSON.stringify(record));
          accumulator.push(record);
        },
      });
      run.advanceToEnd();
      const summary = accumulator.finish({ finalTick: run.tick, truth: run.getTruthState() });
      console.log(`${gncCase.id} seed ${gncCase.seed}: outcome ${summary.outcome} at tick ${summary.outcomeTick}, applied full-duty J6 windows ${summary.interval.appliedFullDutyWindows}, commanded ${summary.interval.commandedFullDutyWindows}, wall ${(performance.now() - started).toFixed(0)} ms`);
      return summary;
    });
    const [nominal, fault] = summaries as [typeof summaries[0], typeof summaries[0]];

    expect(preFault.NOMINAL!.length).toBe(2_999);
    expect(preFault.RCS_STUCK_OPEN).toEqual(preFault.NOMINAL);

    expect(fault.interval.windows).toBe(400);
    expect(fault.interval.complete).toBe(true);
    expect(fault.interval.appliedFullDutyWindows).toBe(400);
    expect(fault.interval.commandedFullDutyWindows).toBe(0);
    expect(nominal.interval.windows).toBe(400);
    expect(nominal.interval.complete).toBe(true);
    expect(nominal.interval.appliedFullDutyWindows).toBe(0);
    expect(nominal.interval.commandedFullDutyWindows).toBe(0);
    expect(fault.interval.peakBodyRate_dps).toBeGreaterThan(nominal.interval.peakBodyRate_dps);

    expect(nominal.outcome).toBe(NOMINAL_CASE.expected.outcome);
    expect(fault.outcome).toBe(RCS_STUCK_OPEN_CASE.expected.outcome);
  }, LONG_RUN_TIMEOUT_MS);
});

describe('runOne lines through aggregate', () => {
  it('yields a FINAL summary for a complete one-pair manifest', () => {
    const manifest = campaignManifest();
    assertValidManifest(manifest);
    const lines = (['NOMINAL', 'RCS_STUCK_OPEN'] as const).map((caseId) => JSON.stringify(
      runOne({ manifest, pairIndex: 0, caseId, shardId: 'shard-a', workerId: 0, attempt: 1 }),
    ));
    const summary = aggregate(manifest, lines);
    expect(summary.blocking).toEqual([]);
    expect(summary.status).toBe('FINAL');
    expect(summary.coverage).toMatchObject({ expected: 2, ok: 2, errors: 0, missing: 0, duplicates: 0, conflicts: 0, platformMismatch: 0 });
    expect(summary.paired.completePairs).toBe(1);
    expect(summary.paired.incompletePairs).toBe(0);
    const host = hostInfo();
    expect(summary.platforms).toEqual([{ node: host.node, arch: host.arch, platform: host.platform, count: 2, matchesTarget: true }]);
    expect(summary.perCase.NOMINAL.n).toBe(1);
    expect(summary.perCase.RCS_STUCK_OPEN.n).toBe(1);
    console.log(`aggregate one-pair: NOMINAL ${JSON.stringify(summary.perCase.NOMINAL.outcomes)} RCS ${JSON.stringify(summary.perCase.RCS_STUCK_OPEN.outcomes)} dockedTable ${JSON.stringify(summary.paired.dockedTable)}`);
  }, LONG_RUN_TIMEOUT_MS);
});
