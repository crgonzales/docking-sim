import { createTracedSimLoop, TRUTH_HZ, type SimLoop, type TelemetryFrame, type TraceSource } from '@docking/sim-core';
import type { GncTick } from '../../telemetry/bus';
import { immutable, type TraceRecords } from '../model/tracePaths';
import { createDemoRun, TRUTH_TICKS_PER_FSW_WINDOW, type DemoRun, type GncCase } from './demoRun';
import { createLabRecorder, type LabRecorder } from './labRecorder';

export type SessionState = 'RUNNING' | 'PAUSED' | 'COMPLETE' | 'STOPPED';
export type PlaybackRate = 1 | 4 | 16;
export const MAX_MPC_HORIZON_STEPS = 128;
export interface LabSessionOptions {
  runId: string; epoch: number; poseEpoch: number; paused?: boolean;
  /**
   * One coherent snapshot per runner segment; UI coalesces these independently.
   * The first observer error is rethrown after advanceTo commits its clock and
   * outcome; later segments still run and notify normally up to that target.
   */
  onTick?: (tick: GncTick) => void;
}
export interface LabSession {
  readonly gncCase: GncCase;
  readonly recorder: LabRecorder;
  readonly state: SessionState;
  readonly tick: number;
  snapshot(): GncTick;
  advanceTo(tick: number): void;
  pause(): void;
  resume(): void;
  singleStep(rate: 'TRUTH' | 'FSW'): void;
  dispose(): void;
}

/** Stable config identity, not a cryptographic integrity/signature claim. */
export function configHash(config: GncCase['config']): string {
  const json = JSON.stringify(config, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(json)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

export function createLabSession(input: GncCase, options: LabSessionOptions): LabSession {
  const gncCase = immutable(structuredClone(input));
  const horizon = gncCase.config.fsw.mpcConfig?.horizonSteps ?? 30;
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > MAX_MPC_HORIZON_STEPS) throw new RangeError(`Lab MPC horizon must be 1–${MAX_MPC_HORIZON_STEPS} steps`);
  const recorder = createLabRecorder(gncCase.maxTicks);
  const hash = configHash(gncCase.config);
  let sim: SimLoop | null = null, trace: TraceSource | null = null;
  let records: TraceRecords;
  let frame: TelemetryFrame | null = null;
  let state: SessionState = options.paused ? 'PAUSED' : 'RUNNING';
  let poseEpoch = options.poseEpoch;
  let observerFailure: { error: unknown } | undefined;
  const unsubscribers: (() => void)[] = [];
  const snapshot = (): GncTick => {
    if (!sim || state === 'STOPPED') throw new Error('Lab session is stopped');
    const fsw = records.fsw;
    const plantTick = records.plantTick?.plantTick ?? 0;
    return immutable({
      stamp: { runId: options.runId, epoch: options.epoch, plantTick, plantTime_s: plantTick / TRUTH_HZ,
        fswSequence: fsw?.fswSequence ?? null, samplePlantTick: fsw?.samplePlantTick ?? null,
        sampleTime_s: fsw?.sampleTime_s ?? null, source: 'LIVE', configHash: hash },
      poseEpoch, renderState: sim.getRenderState(), plantTickRecord: records.plantTick,
      plantWindow: records.plantWindow, pendingWindow: records.pendingWindow,
      frame, fswTrace: fsw, previousFsw: records.previousFsw, sampledPlantTick: records.sampledPlantTick,
    });
  };
  // B0 alone owns scheduling. Wrapping the factory result observes completed
  // segments without copying or altering its partitioning/event ordering.
  let stoppedTick = 0;
  let run: DemoRun | null = createDemoRun(gncCase, {
    retainRecords: false,
    createLoop(config, seed) {
      const traced = createTracedSimLoop(config, seed);
      sim = traced.sim; trace = traced.trace;
      records = { fsw: null, previousFsw: null, plantTick: null, sampledPlantTick: null,
        plantWindow: null, pendingWindow: immutable(trace.pendingWindow()) };
      unsubscribers.push(trace.subscribePlantTick(record => {
        records.plantTick = immutable(record); recorder.pushRaw(record);
      }), trace.subscribePlantWindow(record => { records.plantWindow = immutable(record); }),
      trace.subscribeFsw(record => {
        // Two actual samples are needed for B3's delayed edge. No FSW history
        // beyond this pair is retained; horizon length is capped before creation.
        records.previousFsw = records.fsw; records.fsw = immutable(record);
        records.sampledPlantTick = records.plantTick;
      }));
      return { ...sim, stepTo(time) {
        const frames = traced.sim.stepTo(time);
        records.pendingWindow = immutable(traced.trace.pendingWindow());
        if (frames.length) {
          frame = immutable(frames[frames.length - 1]);
          recorder.append(records);
        }
        if (options.onTick) {
          const observation = snapshot();
          // The scheduler must consume these frames even if presentation fails.
          try { options.onTick(observation); }
          catch (error) { observerFailure ??= { error }; }
        }
        return frames;
      } };
    },
  });
  const advanceTo = (tick: number) => {
    if (!run || state === 'STOPPED') throw new Error('Lab session is stopped');
    try {
      run.advanceTo(tick);
      if (run.outcome !== 'NONE' || run.tick === gncCase.maxTicks) state = 'COMPLETE';
      if (observerFailure) throw observerFailure.error;
    } finally { observerFailure = undefined; }
  };
  return {
    gncCase, recorder,
    get state() { return state; },
    get tick() { return run?.tick ?? stoppedTick; },
    snapshot, advanceTo,
    pause() { if (state === 'RUNNING') state = 'PAUSED'; },
    resume() { if (state === 'PAUSED') state = 'RUNNING'; },
    singleStep(rate) {
      if (!run || state === 'STOPPED') throw new Error('Lab session is stopped');
      if (state === 'COMPLETE') return;
      state = 'PAUSED'; poseEpoch += 1;
      advanceTo(run.tick + (rate === 'TRUTH' ? 1 : TRUTH_TICKS_PER_FSW_WINDOW));
    },
    dispose() {
      unsubscribers.splice(0).forEach(unsubscribe => unsubscribe());
      stoppedTick = run?.tick ?? stoppedTick; run = null;
      sim = null; trace = null; frame = null; state = 'STOPPED';
      records.fsw = records.previousFsw = null;
      records.plantTick = records.sampledPlantTick = null; records.plantWindow = null;
      recorder.dispose();
    },
  };
}
