/**
 * Local worker pool for one shard of the distributed GNC Monte Carlo (F_0.19.0 B4).
 *
 * The controller (`runShard`) is pure over a `WorkerTransport`: the thread
 * transport wraps `node:worker_threads` and is used by the bundled CLI (the
 * bundle is its own worker script); the inline transport executes work items
 * in-process and is what tests drive, because a raw Node worker thread cannot
 * load these extensionless TypeScript imports before B5 builds the bundle.
 *
 * No timers, sleeps or wall-clock pacing exist anywhere in this module: the
 * only asynchrony is message delivery from workers.
 */
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { aggregate } from './aggregate';
import { assertValidManifest, type CampaignManifest, type McCaseId } from './manifest';
import { type RunResult } from './results';
import { hostInfo, hostMatchesTarget, runOne } from './runPair';
import { expectedKeys, keyId, type ExpectedKey } from './shard';

export const DEFAULT_WORKERS = 2;
export const DEFAULT_MAX_REPLACEMENTS = 3;

export interface WorkItem {
  pairIndex: number;
  caseId: McCaseId;
  attempt: number;
}

export interface WorkerEvents {
  onResult(result: RunResult): void;
  /** The worker died (threw, crashed or exited) before returning a result. */
  onCrash(error: Error): void;
}

export interface WorkerHandle {
  send(item: WorkItem): void;
  terminate(): void;
}

export interface WorkerTransport {
  spawn(workerId: number, events: WorkerEvents): WorkerHandle;
}

/** Messages exchanged with a thread worker; the worker body lives in cli.ts. */
export type WorkerRequest = { type: 'run'; item: WorkItem };
export type WorkerResponse = { type: 'result'; result: RunResult };
export const WORKER_ROLE = 'gnc-mc-worker';

export interface ShardRunOptions {
  manifest: CampaignManifest;
  shardId: string;
  /** Requested workers; clamped to `os.availableParallelism()`. Default 2. */
  workers?: number;
  allowPlatformMismatch?: boolean;
  /** Crashed workers replaced at most this many times before the run fails. Default 3. */
  maxReplacements?: number;
  /** Previously written lines of this shard's output; validated successes are skipped. */
  existingLines?: readonly string[];
  /** Receives each serialized result line, immediately, in completion order. */
  sink: (line: string) => void;
  log?: (message: string) => void;
  transport: WorkerTransport;
}

export interface ShardRunStats {
  shardId: string;
  workersRequested: number;
  workersUsed: number;
  expected: number;
  skipped: number;
  dispatched: number;
  written: number;
  crashes: number;
  replacements: number;
}

export class PoolExhaustedError extends Error {
  constructor(message: string, public readonly stats: ShardRunStats) {
    super(message);
    this.name = 'PoolExhaustedError';
  }
}

/** Serialize one result line. A non-finite seed is dropped on error lines (review B2b Minor 1). */
export function serializeResultLine(result: RunResult): string {
  if (result.seed !== undefined && !Number.isFinite(result.seed)) {
    if (result.status !== 'error') throw new RangeError('an ok result must carry a finite seed');
    const { seed: _seed, ...rest } = result;
    return `${JSON.stringify(rest)}\n`;
  }
  return `${JSON.stringify(result)}\n`;
}

/** Keys of this shard whose validated success already exists in `lines`, plus the attempt count per key. */
export function resumeState(manifest: CampaignManifest, shardId: string, lines: readonly string[]): { done: Set<string>; attempts: Map<string, number> } {
  const summary = aggregate(manifest, lines);
  const missing = new Set((summary.missingByShard[shardId] ?? []).map(keyId));
  const done = new Set<string>();
  for (const key of expectedKeys(manifest)) {
    if (key.shardId === shardId && !missing.has(keyId(key))) done.add(keyId(key));
  }
  const attempts = new Map<string, number>();
  for (const entry of summary.ledger) {
    const id = keyId(entry);
    attempts.set(id, (attempts.get(id) ?? 0) + 1);
  }
  return { done, attempts };
}

/** In-process transport: runs items synchronously on a microtask; a throw is reported as a crash. */
export function createInlineTransport(execute: (item: WorkItem, workerId: number) => RunResult = (item, workerId) => {
  throw new Error(`inline transport needs a bound executor (item ${item.pairIndex}:${item.caseId}, worker ${workerId})`);
}): WorkerTransport {
  return {
    spawn(workerId, events) {
      let alive = true;
      return {
        send(item) {
          queueMicrotask(() => {
            if (!alive) return;
            try {
              events.onResult(execute(item, workerId));
            } catch (caught) {
              alive = false;
              events.onCrash(caught instanceof Error ? caught : new Error(String(caught)));
            }
          });
        },
        terminate() { alive = false; },
      };
    },
  };
}

/** Bind the real executor for a manifest and shard. */
export function inlineExecutor(manifest: CampaignManifest, shardId: string): (item: WorkItem, workerId: number) => RunResult {
  return (item, workerId) => runOne({ manifest, pairIndex: item.pairIndex, caseId: item.caseId, shardId, workerId, attempt: item.attempt });
}

/** `node:worker_threads` transport; `scriptUrl` must run the worker body when `workerData.role === WORKER_ROLE`. */
export function createThreadTransport(scriptUrl: URL | string, manifest: CampaignManifest, shardId: string): WorkerTransport {
  return {
    spawn(workerId, events) {
      const worker = new Worker(scriptUrl, { workerData: { role: WORKER_ROLE, workerId, manifest, shardId } });
      let settled = false;
      let terminated = false;
      let busy = false;
      worker.on('message', (message: WorkerResponse) => {
        if (message.type !== 'result') return;
        busy = false;
        events.onResult(message.result);
      });
      worker.on('error', (error: unknown) => {
        if (settled) return;
        settled = true;
        events.onCrash(error instanceof Error ? error : new Error(String(error)));
      });
      worker.on('exit', (code) => {
        // Any exit the controller did not ask for is a crash, whatever the code:
        // a clean exit while an item is in flight would otherwise hang the pool.
        if (settled || terminated) return;
        settled = true;
        events.onCrash(new Error(`worker ${workerId} exited with code ${code} ${busy ? 'while an item was in flight' : 'while idle'}`));
      });
      return {
        send(item) {
          busy = true;
          worker.postMessage({ type: 'run', item } satisfies WorkerRequest);
        },
        terminate() {
          terminated = true;
          settled = true;
          void worker.terminate();
        },
      };
    },
  };
}

/** Run every outstanding (pair, case) of one shard through the pool. Resolves with stats; rejects on exhausted replacements. */
export function runShard(options: ShardRunOptions): Promise<ShardRunStats> {
  const { manifest, shardId, sink, transport } = options;
  const log = options.log ?? (() => {});
  assertValidManifest(manifest);
  if (!manifest.shards.some((shard) => shard.id === shardId)) throw new RangeError(`shard ${shardId} is not in the manifest`);
  const host = hostInfo();
  if (!hostMatchesTarget(host, manifest.platform) && !options.allowPlatformMismatch) {
    throw new RangeError(`host ${host.node}/${host.arch}/${host.platform} does not match the manifest target ${manifest.platform.node}/${manifest.platform.arch}/${manifest.platform.platform}; pass allowPlatformMismatch to run diagnostics only`);
  }
  const workersRequested = options.workers ?? DEFAULT_WORKERS;
  if (!Number.isInteger(workersRequested) || workersRequested < 1) throw new RangeError('workers must be a positive integer');
  const maxReplacements = options.maxReplacements ?? DEFAULT_MAX_REPLACEMENTS;
  if (!Number.isInteger(maxReplacements) || maxReplacements < 0) throw new RangeError('maxReplacements must be a non-negative integer');

  const { done, attempts } = resumeState(manifest, shardId, options.existingLines ?? []);
  const shardKeys: ExpectedKey[] = expectedKeys(manifest).filter((key) => key.shardId === shardId);
  const queue: WorkItem[] = shardKeys
    .filter((key) => !done.has(keyId(key)))
    .map((key) => ({ pairIndex: key.pairIndex, caseId: key.caseId, attempt: (attempts.get(keyId(key)) ?? 0) + 1 }));
  const stats: ShardRunStats = {
    shardId, workersRequested, workersUsed: 0, expected: shardKeys.length, skipped: shardKeys.length - queue.length,
    dispatched: 0, written: 0, crashes: 0, replacements: 0,
  };
  const workersUsed = Math.max(1, Math.min(workersRequested, os.availableParallelism(), queue.length));
  stats.workersUsed = queue.length === 0 ? 0 : workersUsed;
  log(`shard ${shardId}: ${stats.expected} expected, ${stats.skipped} already done, ${queue.length} to run on ${stats.workersUsed} worker(s)`);
  if (queue.length === 0) return Promise.resolve(stats);

  return new Promise<ShardRunStats>((resolve, reject) => {
    const handles = new Map<number, WorkerHandle>();
    const inFlight = new Map<number, WorkItem>();
    let nextWorkerId = 0;
    let finished = false;

    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      for (const handle of handles.values()) handle.terminate();
      if (error) reject(error);
      else resolve(stats);
    };

    const dispatch = (workerId: number): void => {
      const item = queue.shift();
      if (item === undefined) {
        handles.get(workerId)?.terminate();
        handles.delete(workerId);
        inFlight.delete(workerId);
        if (inFlight.size === 0) finish();
        return;
      }
      inFlight.set(workerId, item);
      stats.dispatched += 1;
      handles.get(workerId)!.send(item);
    };

    const spawn = (): void => {
      const workerId = nextWorkerId;
      nextWorkerId += 1;
      const handle = transport.spawn(workerId, {
        onResult(result) {
          if (finished) return;
          sink(serializeResultLine(result));
          stats.written += 1;
          dispatch(workerId);
        },
        onCrash(error) {
          if (finished) return;
          const item = inFlight.get(workerId);
          stats.crashes += 1;
          handles.delete(workerId);
          inFlight.delete(workerId);
          log(`worker ${workerId} crashed on ${item === undefined ? 'no item' : `${item.pairIndex}:${item.caseId} attempt ${item.attempt}`}: ${error.constructor.name}: ${error.message}`);
          if (item !== undefined) queue.unshift({ ...item, attempt: item.attempt + 1 });
          if (stats.replacements >= maxReplacements) {
            finish(new PoolExhaustedError(`worker replacement limit ${maxReplacements} exhausted after ${stats.crashes} crash(es)`, stats));
            return;
          }
          stats.replacements += 1;
          spawn();
        },
      });
      handles.set(workerId, handle);
      dispatch(workerId);
    };

    for (let count = 0; count < workersUsed; count += 1) spawn();
  });
}
