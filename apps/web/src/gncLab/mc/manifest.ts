/**
 * Campaign manifest for the distributed GNC Monte Carlo (F_0.19.0 B1).
 *
 * The manifest is the identity of a campaign: every result line carries its
 * hash, and results with another hash are foreign. It is created only on the
 * local machine (source provenance needs the repository), then delivered to
 * remote runners as an immutable file.
 *
 * Package boundary: this module imports only `@docking/sim-core` types and
 * Node built-ins. Case shapes are declared structurally so they stay
 * compatible with `../session/demoRun` without importing it.
 */
import { createHash } from 'node:crypto';
import { FSW_HZ, TRUTH_HZ, type SimConfig } from '@docking/sim-core';
import { PAIR_SEED_DERIVATION, PAIR_SEED_LABEL, scanSeedCollisions } from './seeds';

export const MANIFEST_SCHEMA = 'gnc-mc-manifest/1';

export type McCaseId = 'NOMINAL' | 'RCS_STUCK_OPEN';
export const MC_CASE_IDS: readonly McCaseId[] = ['NOMINAL', 'RCS_STUCK_OPEN'];

export type McGeometry = 'CREW_DRAGON' | 'SYNTHETIC_DRACO';

export type McCommand =
  | { kind: 'INJECT_THRUSTER_STUCK'; thrusterId: string; state: 'OPEN' | 'CLOSED' }
  | { kind: 'ISOLATE_THRUSTER'; thrusterId: string };

export interface McScheduledCommand {
  tick: number;
  command: McCommand;
}

export interface McCase {
  geometry: McGeometry;
  /** Inlined by value so a later edit to the demo constants changes the hash. */
  config: SimConfig;
  maxTicks: number;
  schedule: McScheduledCommand[];
}

/** Inclusive, window-aligned boundary ticks over which BOTH cases accumulate identical interval fields. */
export interface ComparisonInterval {
  thrusterId: string;
  fromTick: number;
  toTick: number;
}

export interface ShardSpec {
  id: string;
  /** Half-open global pair index range `[start, end)`. */
  start: number;
  end: number;
}

export interface CampaignManifest {
  schema: typeof MANIFEST_SCHEMA;
  campaignId: string;
  /** SHA-256 of the canonical JSON with this field absent. Optional until stamped. */
  hash?: string;
  cases: Record<McCaseId, McCase>;
  comparisonInterval: ComparisonInterval;
  seedPolicy: { masterSeed: number; label: typeof PAIR_SEED_LABEL; derivation: typeof PAIR_SEED_DERIVATION };
  pairs: { start: number; end: number };
  shards: ShardSpec[];
  bundle: { sha256: string; bytes: number; viteVersion: string };
  bootstrap: { delivery: 'FILE' | 'PROVIDER_STARTUP_COMMAND'; entrypointSha256: string };
  /** Pinned target runtime; every result line's host must match all three. */
  platform: { node: string; arch: string; platform: string };
  source: { commit: string; dirtyFiles: number; porcelainSha256: string; lockfileSha256: string };
  /** Provenance only; never used in computation. */
  createdAt: string;
}

export interface ManifestIssue {
  path: string;
  message: string;
}

export const TRUTH_TICKS_PER_FSW_WINDOW = TRUTH_HZ / FSW_HZ;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const NODE_VERSION = /^v\d+\.\d+\.\d+$/;
const UINT32_LIMIT = 2 ** 32;

/** SHA-256 hex digest of text or bytes. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function canonicalize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new RangeError(`${path}: non-finite number cannot be canonicalized`);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item, index) => canonicalize(item === undefined ? null : item, `${path}[${index}]`)).join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`)}`).join(',')}}`;
    }
    default:
      throw new RangeError(`${path}: ${typeof value} cannot be canonicalized`);
  }
}

/** Deterministic JSON: sorted object keys, no whitespace, arrays in order, undefined properties omitted. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, '$');
}

/** Hash of the manifest content, ignoring any `hash` field. */
export function manifestHash(manifest: CampaignManifest): string {
  const { hash: _ignored, ...content } = manifest;
  return sha256Hex(canonicalJson(content));
}

/** Return a copy with `hash` stamped. */
export function withManifestHash(manifest: CampaignManifest): CampaignManifest {
  return { ...manifest, hash: manifestHash(manifest) };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function checkShards(manifest: CampaignManifest, issues: ManifestIssue[]): void {
  const { shards, pairs } = manifest;
  if (!Array.isArray(shards) || shards.length === 0) {
    issues.push({ path: 'shards', message: 'at least one shard is required' });
    return;
  }
  const ids = new Set<string>();
  shards.forEach((shard, index) => {
    if (!isNonEmptyString(shard.id)) issues.push({ path: `shards[${index}].id`, message: 'shard id must be a non-empty string' });
    else if (ids.has(shard.id)) issues.push({ path: `shards[${index}].id`, message: `duplicate shard id ${shard.id}` });
    ids.add(shard.id);
    if (!Number.isInteger(shard.start) || !Number.isInteger(shard.end) || shard.start >= shard.end) {
      issues.push({ path: `shards[${index}]`, message: 'shard range must be integers with start < end' });
    }
  });
  if (issues.some((issue) => issue.path.startsWith('shards'))) return;
  const ordered = [...shards].sort((a, b) => a.start - b.start);
  let cursor = pairs.start;
  for (const shard of ordered) {
    if (shard.start < cursor) issues.push({ path: 'shards', message: `overlap: shard ${shard.id} starts at ${shard.start} before ${cursor}` });
    else if (shard.start > cursor) issues.push({ path: 'shards', message: `gap: indices [${cursor}, ${shard.start}) are unassigned before shard ${shard.id}` });
    cursor = Math.max(cursor, shard.end);
  }
  if (cursor < pairs.end) issues.push({ path: 'shards', message: `gap: indices [${cursor}, ${pairs.end}) are unassigned` });
  if (cursor > pairs.end) issues.push({ path: 'shards', message: `overshoot: shards extend to ${cursor} beyond pairs.end ${pairs.end}` });
}

function checkCases(manifest: CampaignManifest, issues: ManifestIssue[]): void {
  for (const caseId of MC_CASE_IDS) {
    const mcCase = manifest.cases?.[caseId];
    if (mcCase === undefined) {
      issues.push({ path: `cases.${caseId}`, message: 'case is missing' });
      continue;
    }
    if (mcCase.geometry !== 'CREW_DRAGON' && mcCase.geometry !== 'SYNTHETIC_DRACO') {
      issues.push({ path: `cases.${caseId}.geometry`, message: 'geometry must be CREW_DRAGON or SYNTHETIC_DRACO' });
    }
    if (!Number.isInteger(mcCase.maxTicks) || mcCase.maxTicks <= 0) {
      issues.push({ path: `cases.${caseId}.maxTicks`, message: 'maxTicks must be a positive integer' });
    }
    if (typeof mcCase.config !== 'object' || mcCase.config === null || mcCase.config.initial === undefined || mcCase.config.fsw === undefined) {
      issues.push({ path: `cases.${caseId}.config`, message: 'config must carry initial and fsw blocks' });
    } else if ((mcCase.config.initial.t_s ?? 0) !== 0) {
      issues.push({ path: `cases.${caseId}.config.initial.t_s`, message: 'cases start at t = 0 so ticks and windows align' });
    }
    (mcCase.schedule ?? []).forEach((entry, index) => {
      if (!Number.isInteger(entry.tick) || entry.tick < 0) {
        issues.push({ path: `cases.${caseId}.schedule[${index}].tick`, message: 'tick must be a non-negative integer' });
      } else if (entry.tick >= mcCase.maxTicks) {
        // A command at exactly maxTicks is applied by the runner after its last
        // truth step, so it can never influence a frame: inert by construction.
        issues.push({ path: `cases.${caseId}.schedule[${index}].tick`, message: `tick ${entry.tick} is not before maxTicks ${mcCase.maxTicks} and could never affect a window` });
      }
      if (!isNonEmptyString(entry.command?.thrusterId)) {
        issues.push({ path: `cases.${caseId}.schedule[${index}].command`, message: 'command must name a thruster' });
      }
      const kind = entry.command?.kind;
      if (kind !== 'INJECT_THRUSTER_STUCK' && kind !== 'ISOLATE_THRUSTER') {
        issues.push({ path: `cases.${caseId}.schedule[${index}].command.kind`, message: 'kind must be INJECT_THRUSTER_STUCK or ISOLATE_THRUSTER' });
      } else if (kind === 'INJECT_THRUSTER_STUCK' && entry.command.state !== 'OPEN' && entry.command.state !== 'CLOSED') {
        issues.push({ path: `cases.${caseId}.schedule[${index}].command.state`, message: 'state must be OPEN or CLOSED' });
      }
    });
  }
}

function checkInterval(manifest: CampaignManifest, issues: ManifestIssue[]): void {
  const interval = manifest.comparisonInterval;
  if (interval === undefined) {
    issues.push({ path: 'comparisonInterval', message: 'comparison interval is required' });
    return;
  }
  if (!isNonEmptyString(interval.thrusterId)) issues.push({ path: 'comparisonInterval.thrusterId', message: 'thrusterId is required' });
  for (const key of ['fromTick', 'toTick'] as const) {
    const tick = interval[key];
    if (!Number.isInteger(tick) || tick <= 0) issues.push({ path: `comparisonInterval.${key}`, message: 'must be a positive integer' });
    else if (tick % TRUTH_TICKS_PER_FSW_WINDOW !== 0) {
      issues.push({ path: `comparisonInterval.${key}`, message: `must be a multiple of the FSW window (${TRUTH_TICKS_PER_FSW_WINDOW} ticks)` });
    }
  }
  if (Number.isInteger(interval.fromTick) && Number.isInteger(interval.toTick) && interval.fromTick > interval.toTick) {
    issues.push({ path: 'comparisonInterval', message: 'fromTick must not exceed toTick' });
  }
  for (const caseId of MC_CASE_IDS) {
    const maxTicks = manifest.cases?.[caseId]?.maxTicks;
    if (Number.isInteger(maxTicks) && Number.isInteger(interval.toTick) && interval.toTick > maxTicks!) {
      issues.push({ path: 'comparisonInterval.toTick', message: `exceeds maxTicks of ${caseId} (${maxTicks})` });
    }
  }
}

/** Every structural rule the runner and aggregator rely on. Empty result means valid. */
export function validateManifest(manifest: CampaignManifest): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  if (manifest.schema !== MANIFEST_SCHEMA) issues.push({ path: 'schema', message: `expected ${MANIFEST_SCHEMA}` });
  if (!isNonEmptyString(manifest.campaignId)) issues.push({ path: 'campaignId', message: 'campaignId must be a non-empty string' });

  const pairs = manifest.pairs;
  const pairsValid = pairs !== undefined && Number.isInteger(pairs.start) && Number.isInteger(pairs.end) && pairs.start >= 0 && pairs.start < pairs.end;
  if (!pairsValid) issues.push({ path: 'pairs', message: 'pairs must be integers with 0 <= start < end' });

  checkCases(manifest, issues);
  checkInterval(manifest, issues);
  if (pairsValid) checkShards(manifest, issues);

  const policy = manifest.seedPolicy;
  if (policy === undefined) issues.push({ path: 'seedPolicy', message: 'seed policy is required' });
  else {
    if (policy.label !== PAIR_SEED_LABEL) issues.push({ path: 'seedPolicy.label', message: `label must be ${PAIR_SEED_LABEL}` });
    if (policy.derivation !== PAIR_SEED_DERIVATION) issues.push({ path: 'seedPolicy.derivation', message: `derivation must be ${PAIR_SEED_DERIVATION}` });
    const seedValid = Number.isInteger(policy.masterSeed) && policy.masterSeed >= 0 && policy.masterSeed < UINT32_LIMIT;
    if (!seedValid) issues.push({ path: 'seedPolicy.masterSeed', message: 'masterSeed must be an integer in [0, 2^32)' });
    else if (pairsValid) {
      for (const collision of scanSeedCollisions(policy.masterSeed, pairs.start, pairs.end)) {
        issues.push({ path: 'seedPolicy.masterSeed', message: `seed collision ${collision.seed} at pair indices ${collision.pairIndices.join(', ')}; choose another master seed` });
      }
    }
  }

  if (!SHA256_HEX.test(manifest.bundle?.sha256 ?? '')) issues.push({ path: 'bundle.sha256', message: 'must be a 64-character lowercase hex SHA-256' });
  if (!Number.isInteger(manifest.bundle?.bytes) || manifest.bundle.bytes <= 0) issues.push({ path: 'bundle.bytes', message: 'must be a positive integer' });
  if (!isNonEmptyString(manifest.bundle?.viteVersion)) issues.push({ path: 'bundle.viteVersion', message: 'must be a non-empty string' });

  const delivery = manifest.bootstrap?.delivery;
  if (delivery !== 'FILE' && delivery !== 'PROVIDER_STARTUP_COMMAND') issues.push({ path: 'bootstrap.delivery', message: 'must be FILE or PROVIDER_STARTUP_COMMAND' });
  if (!SHA256_HEX.test(manifest.bootstrap?.entrypointSha256 ?? '')) issues.push({ path: 'bootstrap.entrypointSha256', message: 'must be a 64-character lowercase hex SHA-256' });

  if (!NODE_VERSION.test(manifest.platform?.node ?? '')) issues.push({ path: 'platform.node', message: 'must be a full Node version such as v22.12.0' });
  if (!isNonEmptyString(manifest.platform?.arch)) issues.push({ path: 'platform.arch', message: 'must be a non-empty string' });
  if (!isNonEmptyString(manifest.platform?.platform)) issues.push({ path: 'platform.platform', message: 'must be a non-empty string' });

  if (!GIT_SHA.test(manifest.source?.commit ?? '')) issues.push({ path: 'source.commit', message: 'must be a 40-character git SHA' });
  if (!Number.isInteger(manifest.source?.dirtyFiles) || manifest.source.dirtyFiles < 0) issues.push({ path: 'source.dirtyFiles', message: 'must be a non-negative integer' });
  for (const key of ['porcelainSha256', 'lockfileSha256'] as const) {
    if (!SHA256_HEX.test(manifest.source?.[key] ?? '')) issues.push({ path: `source.${key}`, message: 'must be a 64-character lowercase hex SHA-256' });
  }
  if (!isNonEmptyString(manifest.createdAt)) issues.push({ path: 'createdAt', message: 'must be a non-empty string' });

  if (manifest.hash !== undefined && issues.length === 0 && manifest.hash !== manifestHash(manifest)) {
    issues.push({ path: 'hash', message: 'hash does not match the manifest content' });
  }
  return issues;
}

/** Throw a `RangeError` listing every issue when the manifest is invalid. */
export function assertValidManifest(manifest: CampaignManifest): void {
  const issues = validateManifest(manifest);
  if (issues.length > 0) {
    throw new RangeError(`invalid manifest: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
  }
}
