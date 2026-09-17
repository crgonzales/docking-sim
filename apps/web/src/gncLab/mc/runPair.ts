/**
 * One Monte Carlo work item → one result line (F_0.19.0 B2 part 2).
 *
 * `runOne` builds the case from the manifest, derives the pair seed, runs the
 * B0 runner in streaming mode through the summary accumulator, and returns a
 * `RunResult`. Every throw becomes a `status: 'error'` line; nothing here
 * throws to the caller. Wall time is measured for throughput only and never
 * enters any computed value.
 */
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createDemoRun, type GncCase } from '../session/demoRun';
import { manifestHash, type CampaignManifest, type McCaseId } from './manifest';
import { RESULT_SCHEMA, type RunHost, type RunResult } from './results';
import { pairSeed } from './seeds';
import { createSummaryAccumulator } from './summarize';

export interface RunOneInput {
  manifest: CampaignManifest;
  pairIndex: number;
  caseId: McCaseId;
  shardId: string;
  workerId: number;
  attempt: number;
}

/** The runtime this process is executing on, in the manifest's pinned-field vocabulary. */
export function hostInfo(): RunHost {
  return {
    node: process.version,
    arch: process.arch,
    platform: process.platform,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
  };
}

export function hostMatchesTarget(host: RunHost, target: CampaignManifest['platform']): boolean {
  return host.node === target.node && host.arch === target.arch && host.platform === target.platform;
}

/** A runnable `GncCase` from the manifest's structural case; `McCase` is `GncCase` minus id, label, seed and expected. */
export function caseFromManifest(manifest: CampaignManifest, caseId: McCaseId, seed: number): GncCase {
  const mcCase = manifest.cases[caseId];
  if (mcCase === undefined) throw new RangeError(`manifest has no case ${caseId}`);
  return {
    id: caseId,
    label: `${caseId} (campaign ${manifest.campaignId})`,
    geometry: mcCase.geometry,
    config: mcCase.config,
    seed,
    maxTicks: mcCase.maxTicks,
    schedule: mcCase.schedule.map((entry) => ({ tick: entry.tick, command: { ...entry.command } })),
    expected: { note: 'Monte Carlo campaign run; the outcome is measured, not asserted.' },
  };
}

/**
 * Execute one (pair, case). The caller is expected to have validated the
 * manifest once; this function does not re-validate it per run.
 */
export function runOne(input: RunOneInput): RunResult {
  const { manifest, pairIndex, caseId, shardId, workerId, attempt } = input;
  const host = hostInfo();
  const base = {
    schema: RESULT_SCHEMA,
    manifestHash: manifestHash(manifest),
    pairIndex,
    caseId,
    seed: Number.NaN,
    shardId,
    workerId,
    attempt,
    platformMismatch: !hostMatchesTarget(host, manifest.platform),
    host,
  } as const;
  const started = performance.now();
  try {
    const seed = pairSeed(manifest.seedPolicy.masterSeed, pairIndex);
    const gncCase = caseFromManifest(manifest, caseId, seed);
    const accumulator = createSummaryAccumulator({
      interval: manifest.comparisonInterval,
      initialProp_kg: gncCase.config.initial.prop_kg,
    });
    const run = createDemoRun(gncCase, { retainRecords: false, onRecord: accumulator.push });
    run.advanceToEnd();
    const summary = accumulator.finish({ finalTick: run.tick, truth: run.getTruthState() });
    return { ...base, seed, status: 'ok', wallMs: performance.now() - started, summary };
  } catch (caught) {
    const error = caught instanceof Error
      ? { class: caught.constructor.name, message: caught.message }
      : { class: 'NonError', message: String(caught) };
    let seed = Number.NaN;
    try {
      seed = pairSeed(manifest.seedPolicy.masterSeed, pairIndex);
    } catch {
      // The seed derivation itself failed; leave NaN so the aggregator rejects the line.
    }
    return { ...base, seed, status: 'error', wallMs: performance.now() - started, error };
  }
}
