import { describe, expect, it } from 'vitest';
import type { SimConfig } from '@docking/sim-core';
import {
  assertValidManifest,
  canonicalJson,
  manifestHash,
  MANIFEST_SCHEMA,
  sha256Hex,
  validateManifest,
  withManifestHash,
  type CampaignManifest,
  type McCase,
} from './manifest';
import { PAIR_SEED_DERIVATION, PAIR_SEED_LABEL } from './seeds';

const HEX64 = 'a'.repeat(64);
const GIT40 = 'b'.repeat(40);

function minimalConfig(): SimConfig {
  return {
    initial: { r_hill_m: [0, -250, 12], v_hill_mps: [0, 0.1, 0], prop_kg: 24 },
    fsw: { controller: 'MPC', massModel: { dryMass_kg: 976, initialProp_kg: 24 } },
  };
}

function mcCase(schedule: McCase['schedule'] = []): McCase {
  return { geometry: 'CREW_DRAGON', config: minimalConfig(), maxTicks: 120_000, schedule };
}

function fixture(): CampaignManifest {
  return {
    schema: MANIFEST_SCHEMA,
    campaignId: 'campaign-001',
    cases: {
      NOMINAL: mcCase(),
      RCS_STUCK_OPEN: mcCase([
        { tick: 30_000, command: { kind: 'INJECT_THRUSTER_STUCK', thrusterId: 'J6', state: 'OPEN' } },
        { tick: 34_000, command: { kind: 'ISOLATE_THRUSTER', thrusterId: 'J6' } },
      ]),
    },
    comparisonInterval: { thrusterId: 'J6', fromTick: 30_010, toTick: 34_000 },
    seedPolicy: { masterSeed: 20260915, label: PAIR_SEED_LABEL, derivation: PAIR_SEED_DERIVATION },
    pairs: { start: 0, end: 100 },
    shards: [
      { id: 'shard-a', start: 0, end: 40 },
      { id: 'shard-b', start: 40, end: 100 },
    ],
    bundle: { sha256: HEX64, bytes: 500_000, viteVersion: '5.4.0' },
    bootstrap: { delivery: 'FILE', entrypointSha256: HEX64 },
    platform: { node: 'v22.12.0', arch: 'x64', platform: 'linux' },
    source: { commit: GIT40, dirtyFiles: 3, porcelainSha256: HEX64, lockfileSha256: HEX64 },
    createdAt: '2026-09-15T00:00:00Z',
  };
}

/** Deep copy with every object's keys inserted in reverse order. */
function reversedKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => reversedKeys(item)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).reverse()) {
      out[key] = reversedKeys((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  return value;
}

function issuePaths(manifest: CampaignManifest): string[] {
  return validateManifest(manifest).map((issue) => issue.path);
}

describe('canonical JSON and manifest hash', () => {
  it('is stable across object key order, nested', () => {
    const original = fixture();
    const shuffled = reversedKeys(original);
    expect(Object.keys(shuffled)).not.toEqual(Object.keys(original));
    expect(canonicalJson(shuffled)).toBe(canonicalJson(original));
    expect(manifestHash(shuffled)).toBe(manifestHash(original));
    expect(manifestHash(original)).toBe(sha256Hex(canonicalJson(original)));
  });

  it('ignores the hash field itself and changes with any content change', () => {
    const original = fixture();
    const stamped = withManifestHash(original);
    expect(stamped.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifestHash(stamped)).toBe(manifestHash(original));
    expect(manifestHash({ ...original, hash: 'anything' })).toBe(manifestHash(original));
    const changed = fixture();
    changed.seedPolicy.masterSeed += 1;
    expect(manifestHash(changed)).not.toBe(manifestHash(original));
    const reordered = fixture();
    reordered.shards.reverse();
    expect(manifestHash(reordered)).not.toBe(manifestHash(original));
  });

  it('omits undefined properties and rejects non-finite numbers', () => {
    expect(canonicalJson({ b: 1, a: undefined })).toBe('{"b":1}');
    expect(canonicalJson([1, 'x', null, { z: true, y: [2] }])).toBe('[1,"x",null,{"y":[2],"z":true}]');
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(RangeError);
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});

describe('manifest validation', () => {
  it('accepts the fixture, stamped or unstamped, and detects a tampered hash', () => {
    expect(validateManifest(fixture())).toEqual([]);
    const stamped = withManifestHash(fixture());
    expect(validateManifest(stamped)).toEqual([]);
    expect(() => assertValidManifest(stamped)).not.toThrow();
    const tampered = { ...stamped, campaignId: 'campaign-002' };
    expect(issuePaths(tampered)).toEqual(['hash']);
    expect(() => assertValidManifest(tampered)).toThrow(RangeError);
  });

  it('rejects shard plans with gaps, overlaps, overshoot or duplicate ids', () => {
    const gap = fixture();
    gap.shards = [{ id: 'a', start: 0, end: 30 }, { id: 'b', start: 40, end: 100 }];
    expect(validateManifest(gap).map((issue) => issue.message)).toEqual([expect.stringContaining('gap')]);

    const overlap = fixture();
    overlap.shards = [{ id: 'a', start: 0, end: 50 }, { id: 'b', start: 40, end: 100 }];
    expect(validateManifest(overlap).map((issue) => issue.message)).toEqual([expect.stringContaining('overlap')]);

    const tail = fixture();
    tail.shards = [{ id: 'a', start: 0, end: 90 }];
    expect(validateManifest(tail).map((issue) => issue.message)).toEqual([expect.stringContaining('gap')]);

    const overshoot = fixture();
    overshoot.shards = [{ id: 'a', start: 0, end: 120 }];
    expect(validateManifest(overshoot).map((issue) => issue.message)).toEqual([expect.stringContaining('overshoot')]);

    const duplicate = fixture();
    duplicate.shards = [{ id: 'a', start: 0, end: 40 }, { id: 'a', start: 40, end: 100 }];
    expect(issuePaths(duplicate)).toEqual(['shards[1].id']);

    const unordered = fixture();
    unordered.shards = [{ id: 'b', start: 40, end: 100 }, { id: 'a', start: 0, end: 40 }];
    expect(validateManifest(unordered)).toEqual([]);
  });

  it('requires both cases, a window-aligned comparison interval inside every cap, and applicable schedules', () => {
    const missing = fixture();
    delete (missing.cases as Partial<CampaignManifest['cases']>).RCS_STUCK_OPEN;
    expect(issuePaths(missing)).toEqual(['cases.RCS_STUCK_OPEN']);

    const misaligned = fixture();
    misaligned.comparisonInterval = { thrusterId: 'J6', fromTick: 30_005, toTick: 34_000 };
    expect(issuePaths(misaligned)).toEqual(['comparisonInterval.fromTick']);

    const reversed = fixture();
    reversed.comparisonInterval = { thrusterId: 'J6', fromTick: 34_000, toTick: 30_010 };
    expect(issuePaths(reversed)).toEqual(['comparisonInterval']);

    const beyondCap = fixture();
    beyondCap.cases.NOMINAL.maxTicks = 33_000;
    expect(issuePaths(beyondCap)).toEqual(['comparisonInterval.toTick']);

    const lateCommand = fixture();
    lateCommand.cases.RCS_STUCK_OPEN.maxTicks = 32_000;
    expect(issuePaths(lateCommand)).toEqual(['cases.RCS_STUCK_OPEN.schedule[1].tick', 'comparisonInterval.toTick']);

    // Review Minor 2: a command at exactly maxTicks is inert, so it is rejected too.
    const atCap = fixture();
    atCap.cases.RCS_STUCK_OPEN.maxTicks = 34_000;
    expect(issuePaths(atCap)).toEqual(['cases.RCS_STUCK_OPEN.schedule[1].tick']);
    atCap.cases.RCS_STUCK_OPEN.maxTicks = 34_010;
    expect(validateManifest(atCap)).toEqual([]);

    const offset = fixture();
    offset.cases.NOMINAL.config = { ...minimalConfig(), initial: { ...minimalConfig().initial, t_s: 5 } };
    expect(issuePaths(offset)).toEqual(['cases.NOMINAL.config.initial.t_s']);
  });

  it('rejects a misspelled command kind or stuck state as a hand-edited manifest would carry', () => {
    const badKind = fixture();
    badKind.cases.RCS_STUCK_OPEN.schedule = [
      { tick: 30_000, command: { kind: 'INJECT_THRUSTER_STUK' as 'INJECT_THRUSTER_STUCK', thrusterId: 'J6', state: 'OPEN' } },
    ];
    expect(issuePaths(badKind)).toEqual(['cases.RCS_STUCK_OPEN.schedule[0].command.kind']);

    const badState = fixture();
    badState.cases.RCS_STUCK_OPEN.schedule = [
      { tick: 30_000, command: { kind: 'INJECT_THRUSTER_STUCK', thrusterId: 'J6', state: 'AJAR' as 'OPEN' } },
    ];
    expect(issuePaths(badState)).toEqual(['cases.RCS_STUCK_OPEN.schedule[0].command.state']);

    const isolate = fixture();
    isolate.cases.RCS_STUCK_OPEN.schedule = [{ tick: 34_000, command: { kind: 'ISOLATE_THRUSTER', thrusterId: 'J6' } }];
    expect(validateManifest(isolate)).toEqual([]);
  });

  it('pins the seed policy, bundle, bootstrap, platform and provenance formats', () => {
    const policy = fixture();
    policy.seedPolicy = { ...policy.seedPolicy, label: 'run-${index}' as typeof PAIR_SEED_LABEL };
    expect(issuePaths(policy)).toEqual(['seedPolicy.label']);

    const seed = fixture();
    seed.seedPolicy.masterSeed = 2 ** 32;
    expect(issuePaths(seed)).toEqual(['seedPolicy.masterSeed']);

    const bundle = fixture();
    bundle.bundle = { sha256: 'ABC', bytes: 0, viteVersion: '' };
    expect(issuePaths(bundle)).toEqual(['bundle.sha256', 'bundle.bytes', 'bundle.viteVersion']);

    const bootstrap = fixture();
    bootstrap.bootstrap = { delivery: 'EMAIL' as 'FILE', entrypointSha256: 'nope' };
    expect(issuePaths(bootstrap)).toEqual(['bootstrap.delivery', 'bootstrap.entrypointSha256']);

    const platform = fixture();
    platform.platform = { node: '22', arch: '', platform: '' };
    expect(issuePaths(platform)).toEqual(['platform.node', 'platform.arch', 'platform.platform']);

    const source = fixture();
    source.source = { commit: 'HEAD', dirtyFiles: -1, porcelainSha256: '', lockfileSha256: '' };
    expect(issuePaths(source)).toEqual(['source.commit', 'source.dirtyFiles', 'source.porcelainSha256', 'source.lockfileSha256']);

    const pairs = fixture();
    pairs.pairs = { start: 10, end: 10 };
    expect(issuePaths(pairs)).toContain('pairs');
    expect(issuePaths(pairs)).not.toContain('shards');
  });
});
