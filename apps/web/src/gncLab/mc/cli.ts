/**
 * Command-line entry for the distributed GNC Monte Carlo (F_0.19.0 B4).
 *
 * Subcommands: manifest (local only), verify-bundle, run, aggregate. The same
 * file is the worker body: when loaded by `createThreadTransport` with
 * `workerData.role === WORKER_ROLE` it serves work items instead of parsing
 * arguments. B5 bundles this entry into `dist/gnc-mc/gnc-mc.mjs`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { aggregate } from './aggregate';
import {
  assertValidManifest, manifestHash, sha256Hex, validateManifest, withManifestHash,
  type CampaignManifest, type ComparisonInterval, type ShardSpec,
} from './manifest';
import { hostInfo, runOne } from './runPair';
import { PAIR_SEED_DERIVATION, PAIR_SEED_LABEL } from './seeds';
import {
  createThreadTransport, DEFAULT_MAX_REPLACEMENTS, DEFAULT_WORKERS, PoolExhaustedError, runShard, WORKER_ROLE,
  type WorkerRequest, type WorkerResponse, type WorkerTransport,
} from './worker';
import { FAULT_THRUSTER_ID, NOMINAL_CASE, RCS_STUCK_OPEN_CASE } from '../session/demoRun';

export const USAGE = `gnc-mc <subcommand> [options]

  manifest       --out <file> --campaign <id> --pairs <start:end> (--shards <n> | --shard-plan <id:start:end,...>)
                 --master-seed <int> --bundle-sha256 <hex> --bundle-bytes <int> --entrypoint-sha256 <hex>
                 [--delivery FILE|PROVIDER_STARTUP_COMMAND] [--target-node vX.Y.Z --target-arch <arch> --target-platform <os>]
                 [--interval <thrusterId:fromTick:toTick>] [--vite-version <v>] [--repo <dir>]
                 Local only: records git commit, dirty-file count and lockfile hash from --repo (default cwd).
  verify-bundle  --manifest <file> [--bundle <file>]   (default: the running script) exit 0 on match, 1 on mismatch
  run            --manifest <file> --shard <id> [--out <file>] [--workers <n>] [--max-replacements <n>] [--allow-platform-mismatch]
                 Appends one NDJSON line per run to --out (default <shard>.ndjson); resumes by skipping validated successes.
  aggregate      --manifest <file> --results <file> [<file> ...]   prints BLOCKING lines first, then the summary JSON;
                 exit 0 when FINAL, 3 when PROVISIONAL

Flag parsing: the token after a bare flag is read as its value, so give the boolean
--allow-platform-mismatch last or directly before another --flag, never before a value.
`;

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Transport factory for `run`; default is the thread transport on the running script. */
  transport?: (manifest: CampaignManifest, shardId: string) => WorkerTransport;
  /** Provenance collector for `manifest`; default shells out to git. */
  provenance?: (repoRoot: string) => CampaignManifest['source'];
  /** Clock for `manifest.createdAt`; provenance only. */
  now?: () => string;
}

export interface ManifestBuildInput {
  campaignId: string;
  pairs: { start: number; end: number };
  shards: ShardSpec[];
  masterSeed: number;
  bundle: CampaignManifest['bundle'];
  bootstrap: CampaignManifest['bootstrap'];
  platform: CampaignManifest['platform'];
  source: CampaignManifest['source'];
  createdAt: string;
  comparisonInterval?: ComparisonInterval;
}

export const DEFAULT_COMPARISON_INTERVAL: ComparisonInterval = { thrusterId: FAULT_THRUSTER_ID, fromTick: 30_010, toTick: 34_000 };

/** Pure manifest builder from the demo constants; the CLI adds provenance and writes it. */
export function buildCampaignManifest(input: ManifestBuildInput): CampaignManifest {
  const manifest: CampaignManifest = {
    schema: 'gnc-mc-manifest/1',
    campaignId: input.campaignId,
    cases: {
      NOMINAL: { geometry: NOMINAL_CASE.geometry, config: NOMINAL_CASE.config, maxTicks: NOMINAL_CASE.maxTicks, schedule: [] },
      RCS_STUCK_OPEN: {
        geometry: RCS_STUCK_OPEN_CASE.geometry, config: RCS_STUCK_OPEN_CASE.config, maxTicks: RCS_STUCK_OPEN_CASE.maxTicks,
        schedule: RCS_STUCK_OPEN_CASE.schedule.map((entry) => ({ tick: entry.tick, command: { ...entry.command } })),
      },
    },
    comparisonInterval: input.comparisonInterval ?? DEFAULT_COMPARISON_INTERVAL,
    seedPolicy: { masterSeed: input.masterSeed, label: PAIR_SEED_LABEL, derivation: PAIR_SEED_DERIVATION },
    pairs: input.pairs,
    shards: input.shards,
    bundle: input.bundle,
    bootstrap: input.bootstrap,
    platform: input.platform,
    source: input.source,
    createdAt: input.createdAt,
  };
  assertValidManifest(manifest);
  return withManifestHash(manifest);
}

/** Split `[start, end)` into `count` contiguous shards named shard-00, shard-01, … */
export function evenShardPlan(start: number, end: number, count: number): ShardSpec[] {
  if (!Number.isInteger(count) || count < 1 || count > end - start) throw new RangeError('shard count must be between 1 and the pair count');
  const size = Math.ceil((end - start) / count);
  const shards: ShardSpec[] = [];
  for (let index = 0, cursor = start; cursor < end; index += 1, cursor += size) {
    shards.push({ id: `shard-${String(index).padStart(2, '0')}`, start: cursor, end: Math.min(end, cursor + size) });
  }
  return shards;
}

/** Git and lockfile provenance; runs only where the repository exists. */
export function collectProvenance(repoRoot: string): CampaignManifest['source'] {
  const git = (...args: string[]) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  const porcelain = git('status', '--porcelain');
  const dirtyFiles = porcelain.split('\n').filter((line) => line.length > 0).length;
  const lockfile = fs.readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'));
  return {
    commit: git('rev-parse', 'HEAD').trim(),
    dirtyFiles,
    porcelainSha256: sha256Hex(porcelain),
    lockfileSha256: sha256Hex(lockfile),
  };
}

export function parseArgs(argv: readonly string[]): { command: string | undefined; flags: Record<string, string | true>; rest: string[] } {
  const [command, ...tokens] = argv;
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  let lastKey: string | null = null;
  for (const token of tokens) {
    if (token.startsWith('--')) {
      lastKey = token.slice(2);
      flags[lastKey] = true;
    } else if (lastKey !== null && flags[lastKey] === true) {
      flags[lastKey] = token;
    } else if (lastKey === 'results') {
      rest.push(token);
    } else {
      rest.push(token);
    }
  }
  return { command, flags, rest };
}

function required(flags: Record<string, string | true>, key: string): string {
  const value = flags[key];
  if (typeof value !== 'string') throw new RangeError(`--${key} is required`);
  return value;
}

function integer(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new RangeError(`--${key} must be an integer`);
  return parsed;
}

function parseInterval(text: string): ComparisonInterval {
  const [thrusterId, from, to] = text.split(':');
  return { thrusterId: thrusterId ?? '', fromTick: integer(from ?? '', 'interval'), toTick: integer(to ?? '', 'interval') };
}

function readManifest(file: string): CampaignManifest {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as CampaignManifest;
  const issues = validateManifest(manifest);
  if (issues.length > 0) throw new RangeError(`invalid manifest ${file}: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
  return manifest;
}

function commandManifest(flags: Record<string, string | true>, io: CliIo): number {
  const [start, end] = required(flags, 'pairs').split(':').map((part) => integer(part, 'pairs')) as [number, number];
  const shards = typeof flags['shard-plan'] === 'string'
    ? flags['shard-plan'].split(',').map((spec) => {
      const [id, s, e] = spec.split(':');
      return { id: id ?? '', start: integer(s ?? '', 'shard-plan'), end: integer(e ?? '', 'shard-plan') };
    })
    : evenShardPlan(start, end, integer(required(flags, 'shards'), 'shards'));
  const host = hostInfo();
  const intervalFlag = flags.interval;
  const interval = typeof intervalFlag === 'string' ? parseInterval(intervalFlag) : undefined;
  const repoRoot = typeof flags.repo === 'string' ? flags.repo : process.cwd();
  const manifest = buildCampaignManifest({
    campaignId: required(flags, 'campaign'),
    pairs: { start, end },
    shards,
    masterSeed: integer(required(flags, 'master-seed'), 'master-seed'),
    bundle: { sha256: required(flags, 'bundle-sha256'), bytes: integer(required(flags, 'bundle-bytes'), 'bundle-bytes'), viteVersion: typeof flags['vite-version'] === 'string' ? flags['vite-version'] : 'unrecorded' },
    bootstrap: { delivery: (typeof flags.delivery === 'string' ? flags.delivery : 'FILE') as CampaignManifest['bootstrap']['delivery'], entrypointSha256: required(flags, 'entrypoint-sha256') },
    platform: {
      node: typeof flags['target-node'] === 'string' ? flags['target-node'] : host.node,
      arch: typeof flags['target-arch'] === 'string' ? flags['target-arch'] : host.arch,
      platform: typeof flags['target-platform'] === 'string' ? flags['target-platform'] : host.platform,
    },
    source: (io.provenance ?? collectProvenance)(repoRoot),
    createdAt: (io.now ?? (() => new Date().toISOString()))(),
    ...(interval === undefined ? {} : { comparisonInterval: interval }),
  });
  const out = required(flags, 'out');
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  io.stdout(`wrote ${out} hash ${manifest.hash} pairs [${start}, ${end}) shards ${shards.length}\n`);
  return 0;
}

function commandVerifyBundle(flags: Record<string, string | true>, io: CliIo): number {
  const manifest = readManifest(required(flags, 'manifest'));
  const bundlePath = typeof flags.bundle === 'string' ? flags.bundle : process.argv[1] ?? '';
  const bytes = fs.readFileSync(bundlePath);
  const actual = sha256Hex(bytes);
  const hashOk = manifest.hash === manifestHash(manifest);
  const bundleOk = actual === manifest.bundle.sha256 && bytes.length === manifest.bundle.bytes;
  io.stdout(`manifest hash ${hashOk ? 'OK' : 'MISMATCH'}; bundle ${bundlePath} sha256 ${actual} (${bytes.length} bytes) ${bundleOk ? 'OK' : 'MISMATCH'}\n`);
  return hashOk && bundleOk ? 0 : 1;
}

async function commandRun(flags: Record<string, string | true>, io: CliIo): Promise<number> {
  const manifestFile = required(flags, 'manifest');
  const manifest = readManifest(manifestFile);
  const shardId = required(flags, 'shard');
  const out = typeof flags.out === 'string' ? flags.out : `${shardId}.ndjson`;
  const existingLines = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n') : [];
  const fd = fs.openSync(out, 'a');
  const started = performance.now();
  try {
    const stats = await runShard({
      manifest,
      shardId,
      workers: typeof flags.workers === 'string' ? integer(flags.workers, 'workers') : DEFAULT_WORKERS,
      maxReplacements: typeof flags['max-replacements'] === 'string' ? integer(flags['max-replacements'], 'max-replacements') : DEFAULT_MAX_REPLACEMENTS,
      allowPlatformMismatch: flags['allow-platform-mismatch'] === true,
      existingLines,
      sink: (line) => { fs.writeSync(fd, line); },
      log: (message) => io.stderr(`${message}\n`),
      transport: (io.transport ?? ((m, s) => createThreadTransport(new URL(import.meta.url), m, s)))(manifest, shardId),
    });
    // elapsedMs is wall-clock diagnostics for benchmarking only; nothing computed depends on it.
    io.stdout(`${JSON.stringify({ ...stats, elapsedMs: Math.round(performance.now() - started) })}\n`);
    return 0;
  } catch (caught) {
    if (caught instanceof PoolExhaustedError) {
      io.stderr(`${caught.message}\n${JSON.stringify(caught.stats)}\n`);
      return 1;
    }
    throw caught;
  } finally {
    fs.closeSync(fd);
  }
}

function commandAggregate(flags: Record<string, string | true>, rest: string[], io: CliIo): number {
  const manifest = readManifest(required(flags, 'manifest'));
  const files = [required(flags, 'results'), ...rest];
  const lines = files.flatMap((file) => fs.readFileSync(file, 'utf8').split('\n'));
  const summary = aggregate(manifest, lines);
  for (const reason of summary.blocking) io.stdout(`BLOCKING: ${reason}\n`);
  io.stdout(`${JSON.stringify(summary, null, 2)}\n`);
  return summary.status === 'FINAL' ? 0 : 3;
}

/** Dispatch a CLI invocation; returns the process exit code. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const { command, flags, rest } = parseArgs(argv);
  try {
    switch (command) {
      case 'manifest': return commandManifest(flags, io);
      case 'verify-bundle': return commandVerifyBundle(flags, io);
      case 'run': return await commandRun(flags, io);
      case 'aggregate': return commandAggregate(flags, rest, io);
      default:
        io.stderr(USAGE);
        return 2;
    }
  } catch (caught) {
    io.stderr(`${caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)}\n`);
    return 1;
  }
}

/** Worker body: serve work items for the manifest and shard handed over in workerData. */
export function serveWorker(): void {
  const data = workerData as { role: string; workerId: number; manifest: CampaignManifest; shardId: string };
  parentPort!.on('message', (message: WorkerRequest) => {
    if (message.type !== 'run') return;
    const result = runOne({
      manifest: data.manifest, pairIndex: message.item.pairIndex, caseId: message.item.caseId,
      shardId: data.shardId, workerId: data.workerId, attempt: message.item.attempt,
    });
    parentPort!.postMessage({ type: 'result', result } satisfies WorkerResponse);
  });
}

const workerRole = (workerData as { role?: string } | null)?.role;
if (!isMainThread && workerRole === WORKER_ROLE) {
  serveWorker();
} else if (isMainThread && process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const io: CliIo = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) };
  main(process.argv.slice(2), io).then((code) => { process.exitCode = code; });
}
