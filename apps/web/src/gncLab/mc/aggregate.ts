/**
 * Aggregator for the distributed GNC Monte Carlo (F_0.19.0 B3).
 *
 * Pure function over a validated manifest and NDJSON result lines. It refuses
 * to guess: every line is validated against the manifest before it can join
 * the population, identical retries collapse, conflicting successes block,
 * infrastructure errors live in their own ledger and never enter an outcome
 * denominator, and the summary is FINAL only when nothing blocks it.
 */
import { TRUTH_HZ } from '@docking/sim-core';
import { assertValidManifest, canonicalJson, manifestHash, MC_CASE_IDS, type CampaignManifest, type McCaseId } from './manifest';
import { parseResultLine, type RunHost, type RunResult } from './results';
import { pairSeed, scanSeedCollisions, type SeedCollision } from './seeds';
import { coverage, expectedKeys, keyId, shardOf, type Coverage, type ResultKey } from './shard';
import { histogram, scalarSummary, wilsonInterval, type Histogram, type ScalarSummary } from './stats';
import type { IntervalSummary, RunOutcome, RunSummary } from './summarize';

export const AGGREGATE_SCHEMA = 'gnc-mc-summary/1';
export const OUTCOMES: readonly RunOutcome[] = ['DOCKED', 'ABORT', 'COLLISION', 'TIMEOUT'];

const INTERVAL_DELTA_FIELDS = [
  'peakBodyRate_dps', 'satFrames', 'corridorCautionFrames', 'corridorViolationFrames',
  'appliedFullDutyWindows', 'commandedFullDutyWindows',
] as const satisfies readonly (keyof IntervalSummary)[];

export interface RejectedLine {
  line: number;
  reason: string;
}

export interface LedgerEntry {
  line: number;
  pairIndex: number;
  caseId: McCaseId;
  shardId: string;
  workerId: number;
  attempt: number;
  status: 'ok' | 'error';
  wallMs: number;
  errorClass?: string;
}

export interface FailureEntry extends LedgerEntry {
  status: 'error';
  errorClass: string;
  message: string;
  /** True once a validated success for the same key exists. */
  resolved: boolean;
}

export interface ScalarReport {
  summary: ScalarSummary | null;
  histogram: Histogram;
}

export interface CaseReport {
  n: number;
  outcomes: Record<RunOutcome, number>;
  dockProbability: { p: number; wilson95: [number, number] } | null;
  scalars: Record<string, ScalarReport>;
}

export interface DeltaReport {
  /** Pairs included. */
  n: number;
  /** Complete pairs excluded because their endpoints were not comparable. */
  excluded: number;
  /** RCS_STUCK_OPEN minus NOMINAL. */
  summary: ScalarSummary | null;
}

export interface AggregateSummary {
  schema: typeof AGGREGATE_SCHEMA;
  manifestHash: string;
  status: 'FINAL' | 'PROVISIONAL';
  blocking: string[];
  coverage: {
    expected: number; ok: number; errors: number; missing: number; duplicates: number; conflicts: number;
    foreign: number; malformed: number; rejected: number; platformMismatch: number; unexpected: number;
  };
  missingByShard: Record<string, ResultKey[]>;
  rejected: RejectedLine[];
  failures: FailureEntry[];
  ledger: LedgerEntry[];
  conflictKeys: ResultKey[];
  seedCollisions: SeedCollision[];
  perCase: Record<McCaseId, CaseReport>;
  paired: {
    completePairs: number;
    incompletePairs: number;
    outcomeTable: Record<RunOutcome, Record<RunOutcome, number>>;
    dockedTable: { both: number; nominalOnly: number; faultOnly: number; neither: number };
    deltas: Record<string, DeltaReport>;
  };
  platforms: { node: string; arch: string; platform: string; count: number; matchesTarget: boolean }[];
}

interface KeyState {
  key: ResultKey;
  success: { payload: string; result: RunResult } | null;
  conflict: boolean;
  errors: FailureEntry[];
}

/** The fields that decide whether two successful lines are the same result. */
export function scientificPayload(result: RunResult): string {
  return canonicalJson({
    manifestHash: result.manifestHash,
    pairIndex: result.pairIndex,
    caseId: result.caseId,
    seed: result.seed,
    summary: result.summary,
  });
}

function hostMatches(host: RunHost, target: CampaignManifest['platform']): boolean {
  return host.node === target.node && host.arch === target.arch && host.platform === target.platform;
}

function allFinite(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(allFinite);
  if (typeof value === 'object' && value !== null) return Object.values(value).every(allFinite);
  return true;
}

/** Why a parsed, non-foreign line cannot join the population; null when it can. */
function validationProblem(manifest: CampaignManifest, result: RunResult): string | null {
  if (result.pairIndex < manifest.pairs.start || result.pairIndex >= manifest.pairs.end) {
    return `pair index ${result.pairIndex} is outside [${manifest.pairs.start}, ${manifest.pairs.end})`;
  }
  const owner = shardOf(manifest, result.pairIndex);
  if (owner === null || owner.id !== result.shardId) return `shard ${result.shardId} does not own pair ${result.pairIndex}`;
  const expectedSeed = pairSeed(manifest.seedPolicy.masterSeed, result.pairIndex);
  // An error line may omit its seed when derivation itself failed; it still belongs in the failures ledger.
  const seedless = result.status === 'error' && result.seed === undefined;
  if (!seedless && result.seed !== expectedSeed) return `seed ${result.seed} differs from the manifest derivation ${expectedSeed}`;
  if (result.summary !== undefined) {
    if (!allFinite(result.summary)) return 'summary carries a non-finite number';
    const interval = manifest.comparisonInterval;
    const reported = result.summary.interval;
    if (reported.fromTick !== interval.fromTick || reported.toTick !== interval.toTick || reported.thrusterId !== interval.thrusterId) {
      return 'summary.interval does not match the manifest comparison interval';
    }
  }
  return null;
}

function scalarReport(values: number[], spec: { min: number; max: number; bins: number }): ScalarReport {
  return { summary: scalarSummary(values), histogram: histogram(values, spec) };
}

function caseReport(summaries: RunSummary[], outcomeTimeMax_s: number): CaseReport {
  const outcomes = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<RunOutcome, number>;
  for (const summary of summaries) outcomes[summary.outcome] += 1;
  const n = summaries.length;
  const docked = outcomes.DOCKED;
  const wilson = n > 0 ? wilsonInterval(docked, n) : null;
  return {
    n,
    outcomes,
    dockProbability: wilson === null ? null : { p: wilson.p, wilson95: [wilson.lower, wilson.upper] },
    scalars: {
      propUsed_kg: scalarReport(summaries.map((s) => s.propUsed_kg), { min: 0, max: 24, bins: 24 }),
      outcomeTime_s: scalarReport(summaries.map((s) => s.outcomeTick / TRUTH_HZ), { min: 0, max: outcomeTimeMax_s, bins: 24 }),
      peakBodyRate_dps: scalarReport(summaries.map((s) => s.peakBodyRate_dps), { min: 0, max: 10, bins: 20 }),
      satFrames: scalarReport(summaries.map((s) => s.satFrames), { min: 0, max: 100, bins: 20 }),
    },
  };
}

function delta(values: number[], completePairs: number): DeltaReport {
  return { n: values.length, excluded: completePairs - values.length, summary: scalarSummary(values) };
}

/** Aggregate NDJSON result lines against a manifest. Throws only for an invalid manifest. */
export function aggregate(manifest: CampaignManifest, lines: readonly string[]): AggregateSummary {
  assertValidManifest(manifest);
  const hash = manifestHash(manifest);
  const expected = expectedKeys(manifest);
  const expectedIds = new Set(expected.map(keyId));
  const states = new Map<string, KeyState>();
  const rejected: RejectedLine[] = [];
  const ledger: LedgerEntry[] = [];
  const failures: FailureEntry[] = [];
  const platforms = new Map<string, AggregateSummary['platforms'][number]>();
  const counts = { foreign: 0, malformed: 0, rejected: 0, platformMismatch: 0, duplicates: 0, conflicts: 0, unexpected: 0 };

  lines.forEach((text, index) => {
    const line = index + 1;
    if (text.trim().length === 0) return;
    const parsed = parseResultLine(text);
    if (parsed.ok === undefined) {
      counts.malformed += 1;
      rejected.push({ line, reason: `malformed: ${parsed.error}` });
      return;
    }
    const result = parsed.ok;
    if (result.manifestHash !== hash) {
      counts.foreign += 1;
      rejected.push({ line, reason: `foreign: manifest hash ${result.manifestHash} is not ${hash}` });
      return;
    }
    const platformKey = `${result.host.node}|${result.host.arch}|${result.host.platform}`;
    const group = platforms.get(platformKey) ?? {
      node: result.host.node, arch: result.host.arch, platform: result.host.platform, count: 0, matchesTarget: hostMatches(result.host, manifest.platform),
    };
    group.count += 1;
    platforms.set(platformKey, group);
    if (!group.matchesTarget) {
      counts.platformMismatch += 1;
      rejected.push({ line, reason: `platform mismatch: ${platformKey} is not the pinned target` });
      return;
    }
    const problem = validationProblem(manifest, result);
    if (problem !== null) {
      counts.rejected += 1;
      rejected.push({ line, reason: problem });
      return;
    }
    const key: ResultKey = { pairIndex: result.pairIndex, caseId: result.caseId };
    const id = keyId(key);
    if (!expectedIds.has(id)) {
      counts.unexpected += 1;
      rejected.push({ line, reason: `unexpected key ${id}` });
      return;
    }
    const entry: LedgerEntry = {
      line, pairIndex: result.pairIndex, caseId: result.caseId, shardId: result.shardId, workerId: result.workerId,
      attempt: result.attempt, status: result.status, wallMs: result.wallMs,
      ...(result.error === undefined ? {} : { errorClass: result.error.class }),
    };
    ledger.push(entry);
    const state = states.get(id) ?? { key, success: null, conflict: false, errors: [] };
    states.set(id, state);
    if (result.status === 'error') {
      const failure: FailureEntry = { ...entry, status: 'error', errorClass: result.error!.class, message: result.error!.message, resolved: false };
      state.errors.push(failure);
      failures.push(failure);
      return;
    }
    const payload = scientificPayload(result);
    if (state.success === null) {
      state.success = { payload, result };
    } else if (state.success.payload === payload) {
      counts.duplicates += 1;
    } else {
      counts.conflicts += 1;
      state.conflict = true;
    }
  });

  const resolved = new Map<string, RunResult>();
  const conflictKeys: ResultKey[] = [];
  for (const state of states.values()) {
    if (state.conflict) {
      conflictKeys.push(state.key);
      continue;
    }
    if (state.success !== null) {
      resolved.set(keyId(state.key), state.success.result);
      for (const failure of state.errors) failure.resolved = true;
    }
  }
  const cov: Coverage = coverage(expected, [...resolved.values()].map((result) => ({ pairIndex: result.pairIndex, caseId: result.caseId })));
  const unresolvedErrors = failures.filter((failure) => !failure.resolved);

  const blocking: string[] = [];
  if (conflictKeys.length > 0) blocking.push(`${conflictKeys.length} key(s) have conflicting successful results: ${conflictKeys.map(keyId).join(', ')}`);
  const unresolvedKeys = [...new Set(unresolvedErrors.map((failure) => keyId(failure)))];
  if (unresolvedKeys.length > 0) blocking.push(`${unresolvedKeys.length} key(s) have unresolved errors: ${unresolvedKeys.join(', ')}`);
  if (cov.missing > 0) {
    const perShard = Object.entries(cov.missingByShard).map(([shardId, keys]) => `${shardId}: ${keys.length}`).join(', ');
    blocking.push(`${cov.missing} expected result(s) missing (${perShard})`);
  }

  const maxTicks = Math.max(...MC_CASE_IDS.map((caseId) => manifest.cases[caseId].maxTicks));
  const byCase = Object.fromEntries(MC_CASE_IDS.map((caseId) => [caseId, [] as RunSummary[]])) as Record<McCaseId, RunSummary[]>;
  for (const result of resolved.values()) byCase[result.caseId].push(result.summary!);
  const perCase = Object.fromEntries(MC_CASE_IDS.map((caseId) => [caseId, caseReport(byCase[caseId], maxTicks / TRUTH_HZ)])) as Record<McCaseId, CaseReport>;

  const outcomeTable = Object.fromEntries(OUTCOMES.map((a) => [a, Object.fromEntries(OUTCOMES.map((b) => [b, 0]))])) as Record<RunOutcome, Record<RunOutcome, number>>;
  const dockedTable = { both: 0, nominalOnly: 0, faultOnly: 0, neither: 0 };
  const deltaValues: Record<string, number[]> = { outcomeTime_s: [], propUsed_kg: [] };
  for (const field of INTERVAL_DELTA_FIELDS) deltaValues[`interval.${field}`] = [];
  let completePairs = 0;
  let incompletePairs = 0;
  for (let pairIndex = manifest.pairs.start; pairIndex < manifest.pairs.end; pairIndex += 1) {
    const nominal = resolved.get(keyId({ pairIndex, caseId: 'NOMINAL' }))?.summary;
    const fault = resolved.get(keyId({ pairIndex, caseId: 'RCS_STUCK_OPEN' }))?.summary;
    if (nominal === undefined || fault === undefined) {
      incompletePairs += 1;
      continue;
    }
    completePairs += 1;
    outcomeTable[nominal.outcome][fault.outcome] += 1;
    const nominalDocked = nominal.outcome === 'DOCKED';
    const faultDocked = fault.outcome === 'DOCKED';
    if (nominalDocked && faultDocked) dockedTable.both += 1;
    else if (nominalDocked) dockedTable.nominalOnly += 1;
    else if (faultDocked) dockedTable.faultOnly += 1;
    else dockedTable.neither += 1;
    if (nominal.outcome === fault.outcome) {
      deltaValues.outcomeTime_s!.push((fault.outcomeTick - nominal.outcomeTick) / TRUTH_HZ);
      deltaValues.propUsed_kg!.push(fault.propUsed_kg - nominal.propUsed_kg);
    }
    if (nominal.interval.complete && fault.interval.complete) {
      for (const field of INTERVAL_DELTA_FIELDS) deltaValues[`interval.${field}`]!.push(fault.interval[field] - nominal.interval[field]);
    }
  }
  const deltas = Object.fromEntries(Object.entries(deltaValues).map(([name, values]) => [name, delta(values, completePairs)]));

  return {
    schema: AGGREGATE_SCHEMA,
    manifestHash: hash,
    status: blocking.length === 0 ? 'FINAL' : 'PROVISIONAL',
    blocking,
    coverage: {
      expected: cov.expected,
      ok: resolved.size,
      errors: failures.length,
      missing: cov.missing,
      duplicates: counts.duplicates,
      conflicts: counts.conflicts,
      foreign: counts.foreign,
      malformed: counts.malformed,
      rejected: counts.rejected,
      platformMismatch: counts.platformMismatch,
      unexpected: counts.unexpected,
    },
    missingByShard: cov.missingByShard,
    rejected,
    failures,
    ledger,
    conflictKeys,
    seedCollisions: scanSeedCollisions(manifest.seedPolicy.masterSeed, manifest.pairs.start, manifest.pairs.end),
    perCase,
    paired: { completePairs, incompletePairs, outcomeTable, dockedTable, deltas },
    platforms: [...platforms.values()],
  };
}
