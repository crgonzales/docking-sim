/**
 * Result line contract for the distributed GNC Monte Carlo (F_0.19.0 B3).
 *
 * One `RunResult` per NDJSON line. `parseResultLine` is a structural parser
 * that never throws: a line is either a well-formed `RunResult` or a rejection
 * reason. Validation against a manifest (seed, shard, hash, platform) is the
 * aggregator's job, not the parser's.
 */
import { MC_CASE_IDS, type McCaseId } from './manifest';
import type { IntervalSummary, RunOutcome, RunSummary } from './summarize';

export const RESULT_SCHEMA = 'gnc-mc-result/1';

export type RunStatus = 'ok' | 'error';

export interface RunHost {
  node: string;
  arch: string;
  platform: string;
  cpuModel: string;
}

export interface RunError {
  class: string;
  message: string;
}

export interface RunResult {
  schema: typeof RESULT_SCHEMA;
  manifestHash: string;
  pairIndex: number;
  caseId: McCaseId;
  /** Derived pair seed. May be absent only on an error line whose seed could not be derived. */
  seed?: number;
  shardId: string;
  workerId: number;
  attempt: number;
  status: RunStatus;
  error?: RunError;
  platformMismatch: boolean;
  host: RunHost;
  /** Throughput diagnostics only; never part of scientific identity. */
  wallMs: number;
  /** Present exactly when `status === 'ok'`. */
  summary?: RunSummary;
}

export type ParsedResultLine = { ok: RunResult; error?: undefined } | { ok?: undefined; error: string };

const OUTCOMES: readonly RunOutcome[] = ['DOCKED', 'ABORT', 'COLLISION', 'TIMEOUT'];
const ABORT_STATES = ['ARMED', 'BURNING', 'COASTING'] as const;

const SUMMARY_NUMBER_FIELDS = [
  'outcomeTick', 'frames', 'propUsed_kg', 'peakBodyRate_dps', 'satFrames', 'mpcFallbackFrames',
  'corridorCautionFrames', 'corridorViolationFrames',
] as const;
const INTERVAL_NUMBER_FIELDS = [
  'fromTick', 'toTick', 'windows', 'peakBodyRate_dps', 'satFrames', 'corridorCautionFrames',
  'corridorViolationFrames', 'appliedFullDutyWindows', 'commandedFullDutyWindows',
] as const;
const DOCKING_FIELDS = ['closing_mps', 'lateral_m', 'misalign_deg', 'rate_dps'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

function isVec3(value: unknown): boolean {
  return Array.isArray(value) && value.length === 3 && value.every(isNumber);
}

function summaryProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'summary must be an object';
  if (!OUTCOMES.includes(value.outcome as RunOutcome)) return 'summary.outcome must be DOCKED, ABORT, COLLISION or TIMEOUT';
  for (const field of SUMMARY_NUMBER_FIELDS) if (!isNumber(value[field])) return `summary.${field} must be a number`;
  if (!ABORT_STATES.includes(value.lastAbortState as (typeof ABORT_STATES)[number])) return 'summary.lastAbortState must be ARMED, BURNING or COASTING';
  const docking = value.lastDocking;
  if (docking !== null && (!isRecord(docking) || !DOCKING_FIELDS.every((field) => isNumber(docking[field])))) {
    return 'summary.lastDocking must be null or carry four numeric fields';
  }
  const interval = value.interval as Partial<IntervalSummary> | undefined;
  if (!isRecord(interval)) return 'summary.interval must be an object';
  if (typeof interval.thrusterId !== 'string') return 'summary.interval.thrusterId must be a string';
  if (typeof interval.complete !== 'boolean') return 'summary.interval.complete must be a boolean';
  for (const field of INTERVAL_NUMBER_FIELDS) if (!isNumber(interval[field])) return `summary.interval.${field} must be a number`;
  const truth = value.truth;
  if (!isRecord(truth) || !isVec3(truth.r_hill_m) || !isVec3(truth.v_hill_mps) || !isNumber(truth.prop_kg)) {
    return 'summary.truth must carry r_hill_m[3], v_hill_mps[3] and prop_kg';
  }
  return null;
}

/** Structural check of a parsed summary; used by the parser and by callers holding objects. */
export function isRunSummary(value: unknown): value is RunSummary {
  return summaryProblem(value) === null;
}

function resultProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'line must be a JSON object';
  if (value.schema !== RESULT_SCHEMA) return `schema must be ${RESULT_SCHEMA}`;
  if (typeof value.manifestHash !== 'string' || value.manifestHash.length === 0) return 'manifestHash must be a non-empty string';
  if (!Number.isInteger(value.pairIndex) || (value.pairIndex as number) < 0) return 'pairIndex must be a non-negative integer';
  if (!MC_CASE_IDS.includes(value.caseId as McCaseId)) return 'caseId must be NOMINAL or RCS_STUCK_OPEN';
  if (value.status !== 'ok' && value.status !== 'error') return 'status must be ok or error';
  // A seed may be omitted only on an error line (the writer drops a non-finite seed there).
  if (!Number.isInteger(value.seed) && !(value.status === 'error' && value.seed === undefined)) return 'seed must be an integer';
  if (typeof value.shardId !== 'string' || value.shardId.length === 0) return 'shardId must be a non-empty string';
  if (!Number.isInteger(value.workerId)) return 'workerId must be an integer';
  if (!Number.isInteger(value.attempt) || (value.attempt as number) < 1) return 'attempt must be a positive integer';
  if (typeof value.platformMismatch !== 'boolean') return 'platformMismatch must be a boolean';
  const host = value.host;
  if (!isRecord(host) || !(['node', 'arch', 'platform', 'cpuModel'] as const).every((field) => typeof host[field] === 'string')) {
    return 'host must carry node, arch, platform and cpuModel strings';
  }
  if (!isNumber(value.wallMs)) return 'wallMs must be a number';
  if (value.status === 'ok') {
    if (value.error !== undefined) return 'an ok result must not carry an error';
    return summaryProblem(value.summary);
  }
  const error = value.error;
  if (!isRecord(error) || typeof error.class !== 'string' || typeof error.message !== 'string') return 'an error result must carry error.class and error.message';
  if (value.summary !== undefined) return 'an error result must not carry a summary';
  return null;
}

/** Parse one NDJSON line. Never throws. */
export function parseResultLine(text: string): ParsedResultLine {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (caught) {
    return { error: `invalid JSON: ${caught instanceof Error ? caught.message : String(caught)}` };
  }
  const problem = resultProblem(value);
  return problem === null ? { ok: value as RunResult } : { error: problem };
}
