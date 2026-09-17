import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scientificPayload } from './aggregate';
import { buildCampaignManifest, evenShardPlan, main, parseArgs, USAGE, type CliIo } from './cli';
import { manifestHash, sha256Hex, type CampaignManifest } from './manifest';
import { parseResultLine } from './results';
import { hostInfo, runOne } from './runPair';
import { createInlineTransport, inlineExecutor } from './worker';
import { buildDemoConfig, DEMO_GEOMETRY, RCS_STUCK_OPEN_CASE } from '../session/demoRun';

const HEX64 = 'e'.repeat(64);
const SOURCE = { commit: 'c'.repeat(40), dirtyFiles: 12, porcelainSha256: HEX64, lockfileSha256: HEX64 };

let dir: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnc-mc-cli-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function io(): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    transport: (manifest, shardId) => createInlineTransport(inlineExecutor(manifest, shardId)),
    provenance: () => SOURCE,
    now: () => '2026-09-15T00:00:00Z',
  };
}

/** A fast campaign manifest (3 s per run) written to disk for the run/aggregate subcommands. */
function writeSmallManifest(bundle: CampaignManifest['bundle'] = { sha256: HEX64, bytes: 1, viteVersion: 'test' }, name = 'small-manifest.json'): { file: string; manifest: CampaignManifest } {
  const host = hostInfo();
  const config = buildDemoConfig(DEMO_GEOMETRY);
  const manifest = buildCampaignManifest({
    campaignId: 'cli-test',
    pairs: { start: 0, end: 2 },
    shards: evenShardPlan(0, 2, 1),
    masterSeed: 7,
    bundle,
    bootstrap: { delivery: 'FILE', entrypointSha256: HEX64 },
    platform: { node: host.node, arch: host.arch, platform: host.platform },
    source: SOURCE,
    createdAt: '2026-09-15T00:00:00Z',
    comparisonInterval: { thrusterId: 'J6', fromTick: 110, toTick: 200 },
  });
  const fast: CampaignManifest = {
    ...manifest,
    cases: {
      NOMINAL: { geometry: DEMO_GEOMETRY, config, maxTicks: 300, schedule: [] },
      RCS_STUCK_OPEN: { geometry: DEMO_GEOMETRY, config, maxTicks: 300, schedule: [{ tick: 100, command: RCS_STUCK_OPEN_CASE.schedule[0]!.command }] },
    },
  };
  const stamped = { ...fast, hash: manifestHash(fast) };
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(stamped));
  return { file, manifest: stamped };
}

/** Built by `pnpm --dir apps/web exec vite build --config vite.mc.config.ts`; see docs/4-unit-tests/TESTING.md. */
const BUNDLE_PATH = fileURLToPath(new URL('../../../dist/gnc-mc/gnc-mc.mjs', import.meta.url));
const bundleExists = fs.existsSync(BUNDLE_PATH);

describe('bundled CLI (requires dist/gnc-mc/gnc-mc.mjs from `pnpm --dir apps/web exec vite build --config vite.mc.config.ts`; skipped when absent)', () => {
  it.skipIf(!bundleExists)('runs two thread workers through the real worker body, matches the direct runner, and verifies its own hash', () => {
    const bytes = fs.readFileSync(BUNDLE_PATH);
    const { file, manifest } = writeSmallManifest({ sha256: sha256Hex(bytes), bytes: bytes.length, viteVersion: 'built' }, 'bundle-manifest.json');
    const out = path.join(dir, 'bundle-shard-00.ndjson');
    const run = spawnSync(process.execPath, [BUNDLE_PATH, 'run', '--manifest', file, '--shard', 'shard-00', '--out', out, '--workers', '2'], { encoding: 'utf8', timeout: 110_000 });
    expect(run.stderr).not.toMatch(/crashed/);
    expect(run.status).toBe(0);
    const stats = JSON.parse(run.stdout) as Record<string, number>;
    expect(stats).toMatchObject({ expected: 4, written: 4, crashes: 0, replacements: 0, workersUsed: 2 });
    expect(stats.elapsedMs).toBeGreaterThan(0);

    const bundled = fs.readFileSync(out, 'utf8').split('\n').filter((line) => line.length > 0).map((line) => {
      const parsed = parseResultLine(line);
      expect(parsed.error).toBeUndefined();
      return parsed.ok!;
    });
    expect(new Set(bundled.map((result) => result.workerId))).toEqual(new Set([0, 1]));
    expect(bundled.every((result) => result.status === 'ok' && result.platformMismatch === false)).toBe(true);
    const direct = (['NOMINAL', 'RCS_STUCK_OPEN'] as const).flatMap((caseId) => [0, 1].map((pairIndex) =>
      runOne({ manifest, pairIndex, caseId, shardId: 'shard-00', workerId: 0, attempt: 1 })));
    expect(new Set(bundled.map(scientificPayload))).toEqual(new Set(direct.map(scientificPayload)));

    const verify = spawnSync(process.execPath, [BUNDLE_PATH, 'verify-bundle', '--manifest', file], { encoding: 'utf8' });
    expect(verify.stdout).toMatch(/manifest hash OK; bundle .* OK/);
    expect(verify.status).toBe(0);
  }, 120_000);
});

describe('manifest subcommand and builder', () => {
  it('builds a valid, hashed manifest from the demo constants with an even shard plan', () => {
    expect(evenShardPlan(0, 10, 3)).toEqual([
      { id: 'shard-00', start: 0, end: 4 }, { id: 'shard-01', start: 4, end: 8 }, { id: 'shard-02', start: 8, end: 10 },
    ]);
    expect(() => evenShardPlan(0, 2, 3)).toThrow(RangeError);
    const manifest = buildCampaignManifest({
      campaignId: 'campaign-001', pairs: { start: 0, end: 1000 }, shards: evenShardPlan(0, 1000, 4), masterSeed: 20260915,
      bundle: { sha256: HEX64, bytes: 400_000, viteVersion: '5.4.0' }, bootstrap: { delivery: 'FILE', entrypointSha256: HEX64 },
      platform: { node: 'v22.12.0', arch: 'x64', platform: 'linux' }, source: SOURCE, createdAt: '2026-09-15T00:00:00Z',
    });
    expect(manifest.hash).toBe(manifestHash(manifest));
    expect(manifest.cases.RCS_STUCK_OPEN.schedule.map((entry) => entry.tick)).toEqual([30_000, 34_000]);
    expect(manifest.cases.NOMINAL.maxTicks).toBe(120_000);
    expect(manifest.comparisonInterval).toEqual({ thrusterId: 'J6', fromTick: 30_010, toTick: 34_000 });
    expect(manifest.shards.length).toBe(4);
  });

  it('writes the manifest file through the CLI with injected provenance and reports its hash', async () => {
    const out = path.join(dir, 'campaign.json');
    const console = io();
    const code = await main([
      'manifest', '--out', out, '--campaign', 'campaign-cli', '--pairs', '0:8', '--shards', '2', '--master-seed', '20260915',
      '--bundle-sha256', HEX64, '--bundle-bytes', '123', '--entrypoint-sha256', HEX64, '--target-node', 'v22.12.0',
      '--target-arch', 'x64', '--target-platform', 'linux', '--interval', 'J6:30010:34000',
    ], console);
    expect(code).toBe(0);
    const written = JSON.parse(fs.readFileSync(out, 'utf8')) as CampaignManifest;
    expect(written.hash).toBe(manifestHash(written));
    expect(written.source).toEqual(SOURCE);
    expect(written.platform).toEqual({ node: 'v22.12.0', arch: 'x64', platform: 'linux' });
    expect(written.shards).toEqual([{ id: 'shard-00', start: 0, end: 4 }, { id: 'shard-01', start: 4, end: 8 }]);
    expect(console.out.join('')).toContain(`hash ${written.hash}`);
  });

  it('prints usage for an unknown subcommand and a clear error for missing flags', async () => {
    const console = io();
    expect(await main(['frobnicate'], console)).toBe(2);
    expect(console.err.join('')).toBe(USAGE);
    const missing = io();
    expect(await main(['manifest', '--out', path.join(dir, 'x.json')], missing)).toBe(1);
    expect(missing.err.join('')).toMatch(/--pairs is required/);
    expect(parseArgs(['run', '--manifest', 'm.json', '--allow-platform-mismatch', '--workers', '3'])).toEqual({
      command: 'run', flags: { manifest: 'm.json', 'allow-platform-mismatch': true, workers: '3' }, rest: [],
    });
  });
});

describe('run, resume, verify-bundle and aggregate subcommands', () => {
  it('runs a shard to NDJSON, resumes without repeating validated successes, and aggregates to FINAL', async () => {
    const { file, manifest } = writeSmallManifest();
    const out = path.join(dir, 'shard-00.ndjson');
    const first = io();
    expect(await main(['run', '--manifest', file, '--shard', 'shard-00', '--out', out, '--workers', '2'], first)).toBe(0);
    const lines = fs.readFileSync(out, 'utf8').split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(parseResultLine(line).error).toBeUndefined();
    expect(JSON.parse(first.out.join(''))).toMatchObject({ shardId: 'shard-00', expected: 4, skipped: 0, written: 4 });

    const resumed = io();
    expect(await main(['run', '--manifest', file, '--shard', 'shard-00', '--out', out], resumed)).toBe(0);
    expect(JSON.parse(resumed.out.join(''))).toMatchObject({ expected: 4, skipped: 4, dispatched: 0, written: 0 });
    expect(fs.readFileSync(out, 'utf8').split('\n').filter((line) => line.length > 0)).toHaveLength(4);

    const aggregated = io();
    expect(await main(['aggregate', '--manifest', file, '--results', out], aggregated)).toBe(0);
    const text = aggregated.out.join('');
    expect(text.startsWith('{')).toBe(true);
    const summary = JSON.parse(text);
    expect(summary.status).toBe('FINAL');
    expect(summary.manifestHash).toBe(manifest.hash);
    expect(summary.paired.completePairs).toBe(2);
  });

  it('refuses an unknown shard, prints blocking reasons first on a provisional aggregate, and exits 3', async () => {
    const { file } = writeSmallManifest();
    const bad = io();
    expect(await main(['run', '--manifest', file, '--shard', 'shard-99', '--out', path.join(dir, 'unused.ndjson')], bad)).toBe(1);
    expect(bad.err.join('')).toMatch(/shard shard-99 is not in the manifest/);

    const partial = path.join(dir, 'partial.ndjson');
    fs.writeFileSync(partial, '{not json\n');
    const console = io();
    expect(await main(['aggregate', '--manifest', file, '--results', partial], console)).toBe(3);
    const text = console.out.join('');
    expect(text.startsWith('BLOCKING: ')).toBe(true);
    expect(text.split('\n')[0]).toMatch(/expected result\(s\) missing/);
    expect(JSON.parse(text.slice(text.indexOf('{'))).status).toBe('PROVISIONAL');
  });

  it('verifies a bundle file and manifest hash, exiting 1 on a mismatch', async () => {
    const bundle = path.join(dir, 'bundle.mjs');
    fs.writeFileSync(bundle, 'export const ok = true;\n');
    const bytes = fs.readFileSync(bundle);
    const host = hostInfo();
    const manifest = buildCampaignManifest({
      campaignId: 'verify', pairs: { start: 0, end: 1 }, shards: evenShardPlan(0, 1, 1), masterSeed: 1,
      bundle: { sha256: sha256Hex(bytes), bytes: bytes.length, viteVersion: 'test' }, bootstrap: { delivery: 'FILE', entrypointSha256: HEX64 },
      platform: { node: host.node, arch: host.arch, platform: host.platform }, source: SOURCE, createdAt: '2026-09-15T00:00:00Z',
    });
    const file = path.join(dir, 'verify-manifest.json');
    fs.writeFileSync(file, JSON.stringify(manifest));
    const good = io();
    expect(await main(['verify-bundle', '--manifest', file, '--bundle', bundle], good)).toBe(0);
    expect(good.out.join('')).toMatch(/manifest hash OK; bundle .* OK/);

    fs.appendFileSync(bundle, ' ');
    const changed = io();
    expect(await main(['verify-bundle', '--manifest', file, '--bundle', bundle], changed)).toBe(1);
    expect(changed.out.join('')).toMatch(/MISMATCH/);
  });
});
