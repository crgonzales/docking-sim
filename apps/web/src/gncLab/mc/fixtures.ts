/**
 * Synthetic fixtures shared by the Monte Carlo test files (F_0.19.0 B5, review Minor 2).
 * A non-test module so that importing it never re-registers another file's suites.
 * Nothing here runs a simulation.
 */
import type { SimConfig } from '@docking/sim-core';
import { MANIFEST_SCHEMA, type CampaignManifest } from './manifest';
import { RESULT_SCHEMA, type RunResult } from './results';
import { PAIR_SEED_DERIVATION, PAIR_SEED_LABEL } from './seeds';
import type { RunSummary } from './summarize';

export const HEX64 = 'a'.repeat(64);

export function syntheticSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    outcome: 'DOCKED',
    outcomeTick: 68_210,
    frames: 6_821,
    propUsed_kg: 1.9,
    peakBodyRate_dps: 0.36,
    satFrames: 0,
    mpcFallbackFrames: 0,
    corridorCautionFrames: 0,
    corridorViolationFrames: 0,
    lastAbortState: 'ARMED',
    lastDocking: { closing_mps: 0.04, lateral_m: 0.004, misalign_deg: 0.3, rate_dps: 0.07 },
    interval: {
      fromTick: 30_010, toTick: 34_000, thrusterId: 'J6', windows: 400, complete: true,
      peakBodyRate_dps: 0.3, satFrames: 0, corridorCautionFrames: 0, corridorViolationFrames: 0,
      appliedFullDutyWindows: 0, commandedFullDutyWindows: 0,
    },
    truth: { r_hill_m: [0, -10.4, 0], v_hill_mps: [0, 0, 0], prop_kg: 22.1 },
    ...overrides,
  };
}

export function syntheticResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    schema: RESULT_SCHEMA,
    manifestHash: 'c'.repeat(64),
    pairIndex: 0,
    caseId: 'NOMINAL',
    seed: 12345,
    shardId: 'shard-a',
    workerId: 0,
    attempt: 1,
    status: 'ok',
    platformMismatch: false,
    host: { node: 'v22.12.0', arch: 'x64', platform: 'linux', cpuModel: 'synthetic' },
    wallMs: 1800,
    summary: syntheticSummary(),
    ...overrides,
  };
}

/** Three pairs over two shards with a minimal (not runnable) configuration. */
export function testManifest(overrides: Partial<CampaignManifest> = {}): CampaignManifest {
  const config: SimConfig = {
    initial: { r_hill_m: [0, -250, 12], v_hill_mps: [0, 0.1, 0], prop_kg: 24 },
    fsw: { controller: 'MPC', massModel: { dryMass_kg: 976, initialProp_kg: 24 } },
  };
  return {
    schema: MANIFEST_SCHEMA,
    campaignId: 'campaign-test',
    cases: {
      NOMINAL: { geometry: 'CREW_DRAGON', config, maxTicks: 120_000, schedule: [] },
      RCS_STUCK_OPEN: {
        geometry: 'CREW_DRAGON', config, maxTicks: 120_000,
        schedule: [
          { tick: 30_000, command: { kind: 'INJECT_THRUSTER_STUCK', thrusterId: 'J6', state: 'OPEN' } },
          { tick: 34_000, command: { kind: 'ISOLATE_THRUSTER', thrusterId: 'J6' } },
        ],
      },
    },
    comparisonInterval: { thrusterId: 'J6', fromTick: 30_010, toTick: 34_000 },
    seedPolicy: { masterSeed: 20260915, label: PAIR_SEED_LABEL, derivation: PAIR_SEED_DERIVATION },
    pairs: { start: 0, end: 3 },
    shards: [{ id: 'shard-a', start: 0, end: 2 }, { id: 'shard-b', start: 2, end: 3 }],
    bundle: { sha256: HEX64, bytes: 500_000, viteVersion: '5.4.0' },
    bootstrap: { delivery: 'FILE', entrypointSha256: HEX64 },
    platform: { node: 'v22.12.0', arch: 'x64', platform: 'linux' },
    source: { commit: 'b'.repeat(40), dirtyFiles: 0, porcelainSha256: HEX64, lockfileSha256: HEX64 },
    createdAt: '2026-09-15T00:00:00Z',
    ...overrides,
  };
}
