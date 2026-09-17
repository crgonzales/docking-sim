import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scientificPayload } from './aggregate';
import { syntheticResult, testManifest } from './fixtures';
import { withManifestHash, type CampaignManifest } from './manifest';
import { parseResultLine, type RunResult } from './results';
import { hostInfo } from './runPair';
import {
  createInlineTransport, createThreadTransport, DEFAULT_WORKERS, inlineExecutor, PoolExhaustedError, resumeState, runShard,
  serializeResultLine, type WorkerTransport, type WorkItem,
} from './worker';
import { buildDemoConfig, DEMO_GEOMETRY, RCS_STUCK_OPEN_CASE } from '../session/demoRun';

/** Four pairs, two shards, 3 s of sim time per run so the whole suite stays fast. */
function smallManifest(overrides: Partial<CampaignManifest> = {}): CampaignManifest {
  const host = hostInfo();
  const config = buildDemoConfig(DEMO_GEOMETRY);
  return withManifestHash({
    ...testManifest(),
    cases: {
      NOMINAL: { geometry: DEMO_GEOMETRY, config, maxTicks: 300, schedule: [] },
      RCS_STUCK_OPEN: { geometry: DEMO_GEOMETRY, config, maxTicks: 300, schedule: [{ tick: 100, command: RCS_STUCK_OPEN_CASE.schedule[0]!.command }] },
    },
    comparisonInterval: { thrusterId: 'J6', fromTick: 110, toTick: 200 },
    pairs: { start: 0, end: 4 },
    shards: [{ id: 'shard-a', start: 0, end: 3 }, { id: 'shard-b', start: 3, end: 4 }],
    platform: { node: host.node, arch: host.arch, platform: host.platform },
    ...overrides,
  });
}

function collect(): { lines: string[]; sink: (line: string) => void; results: () => RunResult[] } {
  const lines: string[] = [];
  return {
    lines,
    sink: (line) => lines.push(line),
    results: () => lines.map((line) => {
      expect(line.endsWith('\n')).toBe(true);
      const parsed = parseResultLine(line);
      expect(parsed.error).toBeUndefined();
      return parsed.ok!;
    }),
  };
}

function spyTransport(inner: WorkerTransport): WorkerTransport & { spawned: number[] } {
  const spawned: number[] = [];
  return {
    spawned,
    spawn(workerId, events) {
      spawned.push(workerId);
      return inner.spawn(workerId, events);
    },
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('runShard', () => {
  it('produces the same scientific payloads on two workers as serially, one line per key, in shard order for serial', async () => {
    const manifest = smallManifest();
    const serial = collect();
    const serialStats = await runShard({ manifest, shardId: 'shard-a', workers: 1, sink: serial.sink, transport: createInlineTransport(inlineExecutor(manifest, 'shard-a')) });
    const parallel = collect();
    const parallelStats = await runShard({ manifest, shardId: 'shard-a', workers: 2, sink: parallel.sink, transport: createInlineTransport(inlineExecutor(manifest, 'shard-a')) });

    expect(serialStats).toMatchObject({ expected: 6, skipped: 0, dispatched: 6, written: 6, crashes: 0, replacements: 0, workersUsed: 1 });
    expect(parallelStats).toMatchObject({ expected: 6, skipped: 0, dispatched: 6, written: 6, crashes: 0, replacements: 0, workersUsed: 2 });
    const serialResults = serial.results();
    const parallelResults = parallel.results();
    expect(serialResults.map((r) => `${r.pairIndex}:${r.caseId}`)).toEqual(['0:NOMINAL', '0:RCS_STUCK_OPEN', '1:NOMINAL', '1:RCS_STUCK_OPEN', '2:NOMINAL', '2:RCS_STUCK_OPEN']);
    expect(new Set(parallelResults.map(scientificPayload))).toEqual(new Set(serialResults.map(scientificPayload)));
    expect(parallelResults.every((r) => r.status === 'ok' && r.attempt === 1 && r.summary?.outcome === 'TIMEOUT')).toBe(true);
    expect(new Set(parallelResults.map((r) => r.workerId))).toEqual(new Set([0, 1]));
  });

  it('defaults to two workers and clamps requests to the host parallelism and the queue length', async () => {
    const manifest = smallManifest();
    const defaulted = spyTransport(createInlineTransport(inlineExecutor(manifest, 'shard-a')));
    const stats = await runShard({ manifest, shardId: 'shard-a', sink: () => {}, transport: defaulted });
    expect(DEFAULT_WORKERS).toBe(2);
    expect(stats.workersRequested).toBe(2);
    expect(defaulted.spawned).toEqual([0, 1]);

    const clamped = spyTransport(createInlineTransport(inlineExecutor(manifest, 'shard-b')));
    const clampedStats = await runShard({ manifest, shardId: 'shard-b', workers: 1_000, sink: () => {}, transport: clamped });
    expect(clampedStats.workersRequested).toBe(1_000);
    expect(clampedStats.workersUsed).toBe(Math.min(2, os.availableParallelism()));
    expect(clamped.spawned.length).toBe(clampedStats.workersUsed);
  });

  it('completes under fake timers without advancing time: nothing in the pool sleeps', async () => {
    vi.useFakeTimers();
    const manifest = smallManifest();
    const out = collect();
    const stats = await runShard({ manifest, shardId: 'shard-b', workers: 2, sink: out.sink, transport: createInlineTransport(inlineExecutor(manifest, 'shard-b')) });
    expect(stats.written).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('quarantines a crashed worker, replaces it, and re-dispatches the item with the next attempt', async () => {
    const manifest = smallManifest();
    const real = inlineExecutor(manifest, 'shard-a');
    let crashes = 0;
    const flaky = (item: WorkItem, workerId: number): RunResult => {
      if (item.pairIndex === 1 && item.caseId === 'RCS_STUCK_OPEN' && item.attempt === 1) {
        crashes += 1;
        throw new Error('simulated worker crash');
      }
      return real(item, workerId);
    };
    const transport = spyTransport(createInlineTransport(flaky));
    const out = collect();
    const log: string[] = [];
    const stats = await runShard({ manifest, shardId: 'shard-a', workers: 2, sink: out.sink, transport, log: (m) => log.push(m) });
    expect(crashes).toBe(1);
    expect(stats).toMatchObject({ dispatched: 7, written: 6, crashes: 1, replacements: 1 });
    expect(transport.spawned).toEqual([0, 1, 2]);
    const retried = out.results().find((r) => r.pairIndex === 1 && r.caseId === 'RCS_STUCK_OPEN')!;
    expect(retried.attempt).toBe(2);
    expect(retried.status).toBe('ok');
    expect(log.some((m) => /crashed on 1:RCS_STUCK_OPEN attempt 1: Error: simulated worker crash/.test(m))).toBe(true);
  });

  it('fails with PoolExhaustedError after the replacement budget and keeps the lines written so far', async () => {
    const manifest = smallManifest();
    const real = inlineExecutor(manifest, 'shard-a');
    const alwaysCrash = (item: WorkItem, workerId: number): RunResult => {
      if (item.pairIndex === 0 && item.caseId === 'RCS_STUCK_OPEN') throw new TypeError('poison item');
      return real(item, workerId);
    };
    const out = collect();
    const promise = runShard({ manifest, shardId: 'shard-a', workers: 1, maxReplacements: 2, sink: out.sink, transport: createInlineTransport(alwaysCrash) });
    await expect(promise).rejects.toBeInstanceOf(PoolExhaustedError);
    await promise.catch((error: PoolExhaustedError) => {
      expect(error.stats).toMatchObject({ crashes: 3, replacements: 2, written: 1 });
    });
    expect(out.results().map((r) => `${r.pairIndex}:${r.caseId}`)).toEqual(['0:NOMINAL']);
  });

  it('refuses a host that does not match the pinned platform unless mismatch is explicitly allowed', async () => {
    const manifest = smallManifest({ platform: { node: 'v0.0.1', arch: 'mips', platform: 'plan9' } });
    expect(() => runShard({ manifest, shardId: 'shard-b', sink: () => {}, transport: createInlineTransport(inlineExecutor(manifest, 'shard-b')) }))
      .toThrow(/does not match the manifest target v0\.0\.1\/mips\/plan9/);
    const out = collect();
    await runShard({ manifest, shardId: 'shard-b', allowPlatformMismatch: true, sink: out.sink, transport: createInlineTransport(inlineExecutor(manifest, 'shard-b')) });
    expect(out.results().every((r) => r.platformMismatch === true)).toBe(true);
  });

  it('refuses a shard id that is not in the manifest and an invalid manifest', () => {
    const manifest = smallManifest();
    expect(() => runShard({ manifest, shardId: 'shard-z', sink: () => {}, transport: createInlineTransport() })).toThrow(/shard shard-z is not in the manifest/);
    const broken = { ...manifest, shards: [{ id: 'shard-a', start: 0, end: 2 }] };
    expect(() => runShard({ manifest: broken, shardId: 'shard-a', sink: () => {}, transport: createInlineTransport() })).toThrow(RangeError);
  });

  it('resumes by skipping keys with a validated success and re-attempts keys that only have an error line', async () => {
    const manifest = smallManifest();
    const first = collect();
    await runShard({ manifest, shardId: 'shard-a', workers: 1, sink: first.sink, transport: createInlineTransport(inlineExecutor(manifest, 'shard-a')) });
    const kept = first.lines.slice(0, 3);
    const errorLine = serializeResultLine({
      ...first.results()[3]!, status: 'error', summary: undefined, error: { class: 'Error', message: 'earlier crash' },
    });
    const foreign = serializeResultLine({ ...first.results()[4]!, manifestHash: 'f'.repeat(64) });
    const existing = [...kept, errorLine, foreign, ''];
    const state = resumeState(manifest, 'shard-a', existing);
    expect([...state.done].sort()).toEqual(['0:NOMINAL', '0:RCS_STUCK_OPEN', '1:NOMINAL']);
    expect(state.attempts.get('1:RCS_STUCK_OPEN')).toBe(1);

    const second = collect();
    const stats = await runShard({ manifest, shardId: 'shard-a', workers: 2, existingLines: existing, sink: second.sink, transport: createInlineTransport(inlineExecutor(manifest, 'shard-a')) });
    expect(stats).toMatchObject({ expected: 6, skipped: 3, dispatched: 3, written: 3 });
    const rerun = second.results();
    expect(rerun.map((r) => `${r.pairIndex}:${r.caseId}`).sort()).toEqual(['1:RCS_STUCK_OPEN', '2:NOMINAL', '2:RCS_STUCK_OPEN']);
    expect(rerun.find((r) => r.pairIndex === 1)!.attempt).toBe(2);
    expect(rerun.find((r) => r.pairIndex === 2 && r.caseId === 'NOMINAL')!.attempt).toBe(1);
  });
});

describe('thread transport', () => {
  // Real worker_threads against tiny scripts that speak the wire protocol; the
  // bundled CLI (B5 cli.test.ts) is the end-to-end exercise with the real body.
  function scriptUrl(name: string, body: string): URL {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnc-mc-thread-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    return pathToFileURL(file);
  }

  it('reports a clean exit while an item is in flight as a crash (review B4 Minor 1)', async () => {
    const script = scriptUrl('exit-clean.mjs', `import { parentPort } from 'node:worker_threads';\nparentPort.on('message', () => { process.exit(0); });\n`);
    const manifest = smallManifest();
    const crash = new Promise<Error>((resolve) => {
      const handle = createThreadTransport(script, manifest, 'shard-a').spawn(7, {
        onResult: () => { throw new Error('unexpected result'); },
        onCrash: resolve,
      });
      handle.send({ pairIndex: 0, caseId: 'NOMINAL', attempt: 1 });
    });
    const error = await crash;
    expect(error.message).toMatch(/worker 7 exited with code 0 while an item was in flight/);
  });

  it('delivers results from a worker and stays silent after terminate()', async () => {
    const script = scriptUrl('echo.mjs', [
      "import { parentPort, workerData } from 'node:worker_threads';",
      "parentPort.on('message', (message) => { parentPort.postMessage({ type: 'result', result: { echoed: message.item, shardId: workerData.shardId, role: workerData.role } }); });",
      '',
    ].join('\n'));
    const manifest = smallManifest();
    const crashes: Error[] = [];
    const transport = createThreadTransport(script, manifest, 'shard-b');
    const result = await new Promise<unknown>((resolve) => {
      const handle = transport.spawn(3, {
        onResult: (value) => { resolve(value); handle.terminate(); },
        onCrash: (error) => crashes.push(error),
      });
      handle.send({ pairIndex: 3, caseId: 'RCS_STUCK_OPEN', attempt: 2 });
    });
    expect(result).toEqual({ echoed: { pairIndex: 3, caseId: 'RCS_STUCK_OPEN', attempt: 2 }, shardId: 'shard-b', role: 'gnc-mc-worker' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(crashes).toEqual([]);
  });
});

describe('serializeResultLine', () => {
  it('writes one JSON line and omits a non-finite seed only on error lines', () => {
    const ok = syntheticResult();
    expect(serializeResultLine(ok)).toBe(`${JSON.stringify(ok)}\n`);
    const failed = syntheticResult({ status: 'error', summary: undefined, seed: Number.NaN, error: { class: 'RangeError', message: 'bad master seed' } });
    const line = serializeResultLine(failed);
    expect(line).not.toContain('"seed"');
    expect(parseResultLine(line).ok?.status).toBe('error');
    expect(() => serializeResultLine({ ...ok, seed: Number.NaN })).toThrow(/finite seed/);
  });
});
