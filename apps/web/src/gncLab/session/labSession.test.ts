import { describe, expect, it, vi } from 'vitest';
import { EXPORT_COLUMNS } from '../model/ports';
import type { GncTick } from '../../telemetry/bus';
import { createLabSession, configHash, MAX_MPC_HORIZON_STEPS } from './labSession';
import { NOMINAL_CASE, type GncCase } from './demoRun';
import * as demo from './demoRun';

const identity = { runId: 'test', epoch: 1, poseEpoch: 1 };
const shortCase: GncCase = { ...NOMINAL_CASE, maxTicks: 103, schedule: [
  { tick: 0, command: { kind: 'INJECT_THRUSTER_STUCK', thrusterId: 'J6', state: 'CLOSED' } },
  { tick: 14, command: { kind: 'INJECT_THRUSTER_STUCK', thrusterId: 'J6', state: 'OPEN' } },
  { tick: 25, command: { kind: 'ISOLATE_THRUSTER', thrusterId: 'J6' } },
] };
function coherent(tick: GncTick) {
  const { stamp } = tick;
  expect(tick.renderState.t_s).toBeCloseTo(stamp.plantTime_s, 10);
  expect(tick.plantTickRecord?.plantTick ?? 0).toBe(stamp.plantTick);
  expect(tick.pendingWindow.slicesIntegrated).toBe(stamp.plantTick % 10);
  if (tick.fswTrace) {
    expect(stamp.plantTick - stamp.samplePlantTick!).toBeGreaterThanOrEqual(0);
    expect(stamp.plantTick - stamp.samplePlantTick!).toBeLessThan(10);
    expect(tick.frame!.t_s).toBe(tick.fswTrace.sensor.t_s);
    expect(tick.sampledPlantTick!.plantTick).toBe(stamp.samplePlantTick);
    expect(tick.plantWindow!.sourceFswSequence).toBe(stamp.fswSequence === 1 ? null : stamp.fswSequence! - 1);
  } else {
    expect(tick.frame).toBeNull(); expect(stamp.fswSequence).toBeNull();
    expect(tick.sampledPlantTick).toBeNull();
  }
}

describe('B4 lab session', () => {
  it('keeps startup, both single-step clocks, sensor-boundary and previous-command samples honest', () => {
    const observations: GncTick[] = [];
    const session = createLabSession({ ...NOMINAL_CASE, maxTicks: 100 }, { ...identity, onTick: t => observations.push(t) });
    const start = session.snapshot(); coherent(start);
    expect(start.stamp).toMatchObject({ plantTick: 0, plantTime_s: 0, samplePlantTick: null, source: 'LIVE' });
    expect(start.plantTickRecord).toBeNull(); expect(start.plantWindow).toBeNull();
    expect(start.pendingWindow.slicesIntegrated).toBe(0); expect(session.recorder.length).toBe(0);
    session.singleStep('TRUTH'); expect(session.tick).toBe(1);
    session.singleStep('FSW'); expect(session.tick).toBe(11);
    let tick = session.snapshot(); coherent(tick);
    expect(tick.poseEpoch).toBe(3); expect(tick.stamp.samplePlantTick).toBe(10);
    expect(tick.previousFsw).toBeNull(); expect(session.state).toBe('PAUSED');
    session.singleStep('FSW'); tick = session.snapshot(); coherent(tick);
    expect(session.tick).toBe(21); expect(tick.stamp.fswSequence).toBe(2);
    expect(tick.previousFsw!.fswSequence).toBe(1);
    expect(tick.sampledPlantTick!.plantTick).toBe(20);
    expect(tick.previousFsw).toBe(observations.find(t => t.stamp.plantTick === 10)!.fswTrace);
    expect(tick.sampledPlantTick).toBe(observations.find(t => t.stamp.plantTick === 20)!.plantTickRecord);
    observations.forEach(coherent);
    expect(observations.map(t => t.stamp.plantTick)).toEqual([1, 10, 11, 20, 21]);
    expect(session.recorder.length).toBe(2);
    expect(Reflect.set(tick.fswTrace!.allocation.onTimes, 'J6', 99)).toBe(false);
    session.resume(); expect(session.state).toBe('RUNNING'); session.pause();
    expect(session.state).toBe('PAUSED'); session.dispose();
    expect(session.state).toBe('STOPPED'); expect(session.recorder.rawLength).toBe(0);
    expect(() => session.advanceTo(30)).toThrow('stopped'); expect(() => session.snapshot()).toThrow('stopped');
  });

  it('records identical real signals at 1x/4x/16x and truth/irregular chunking with off-boundary events', () => {
    const results = [10, 40, 160, 1, 7].map(chunk => {
      const observations: GncTick[] = [];
      const session = createLabSession(shortCase, { ...identity, onTick: t => observations.push(t) });
      while (session.state !== 'COMPLETE') session.advanceTo(session.tick + chunk);
      observations.forEach(coherent);
      const data = EXPORT_COLUMNS.map(c => session.recorder.column(c.id));
      expect(session.tick).toBe(103); expect(session.recorder.length).toBe(10);
      expect(session.snapshot().pendingWindow.slicesIntegrated).toBe(3);
      const delivered = session.recorder.column('plant.thrusters/out/activeTime/J6');
      expect(delivered[0]).toBe(0); expect(delivered[1]).toBeCloseTo(0.06, 12);
      expect(delivered[2]).toBeCloseTo(0.05, 12); expect(delivered[3]).toBe(0);
      const result = { data, truth: session.snapshot().plantTickRecord!.truth, frame: session.snapshot().frame };
      const before = session.tick; session.advanceTo(1000); expect(session.tick).toBe(before);
      session.dispose(); return result;
    });
    results.slice(1).forEach(result => expect(result).toEqual(results[0]));
  });

  it('emits once per actual runner segment and reproduces a fresh seeded run', () => {
    const stamps: number[] = [];
    const first = createLabSession(shortCase, { ...identity, onTick: t => stamps.push(t.stamp.plantTick) });
    first.advanceTo(31);
    expect(stamps).toEqual([10, 14, 20, 25, 30, 31]);
    const expected = first.snapshot(); first.dispose();
    const retry = createLabSession(shortCase, { ...identity, epoch: 2, poseEpoch: 2 });
    retry.advanceTo(31);
    expect(retry.snapshot().plantTickRecord).toEqual(expected.plantTickRecord);
    expect(retry.snapshot().fswTrace).toEqual(expected.fswTrace);
    expect(retry.snapshot().stamp.configHash).toBe(expected.stamp.configHash);
    expect(() => retry.advanceTo(1)).toThrow(); expect(() => retry.advanceTo(31.5)).toThrow();
    retry.dispose();
  });

  it('commits clocks and rows before propagating an observer error, then permits truth stepping', () => {
    const gncCase = { ...NOMINAL_CASE, maxTicks: 30 };
    const baseline = createLabSession(gncCase, identity);
    const observations: number[] = [];
    const failure = new Error('observer failed');
    const session = createLabSession(gncCase, { ...identity, onTick(tick) {
      observations.push(tick.stamp.plantTick);
      if (observations.length === 1) throw failure;
    } });
    try {
      expect(() => session.advanceTo(20)).toThrow(failure);
      baseline.advanceTo(20);
      expect(session.tick).toBe(20);
      expect(session.snapshot()).toEqual(baseline.snapshot());
      expect(session.recorder.length).toBe(2);
      session.singleStep('TRUTH'); baseline.singleStep('TRUTH');
      expect(session.tick).toBe(21); expect(session.state).toBe('PAUSED');
      expect(session.snapshot()).toEqual(baseline.snapshot());
      expect(observations).toEqual([10, 20, 21]);
      EXPORT_COLUMNS.forEach(column => expect(session.recorder.column(column.id)).toEqual(baseline.recorder.column(column.id)));
    } finally { session.dispose(); baseline.dispose(); }
  });

  it('preserves the terminal boundary and final row when the terminal observer throws', () => {
    const gncCase: GncCase = { ...NOMINAL_CASE, maxTicks: 500, config: {
      ...NOMINAL_CASE.config,
      initial: { ...NOMINAL_CASE.config.initial, r_hill_m: [0, -10.44, 0], v_hill_mps: [0, 0.05, 0] },
    } };
    const baseline = createLabSession(gncCase, identity);
    const failure = new Error('terminal observer failed');
    const observer = vi.fn((tick: GncTick) => { if (tick.frame?.outcome === 'DOCKED') throw failure; });
    const session = createLabSession(gncCase, { ...identity, onTick: observer });
    try {
      baseline.advanceTo(500);
      expect(baseline.tick).toBe(10); expect(baseline.snapshot().frame!.outcome).toBe('DOCKED');
      expect(() => session.advanceTo(500)).toThrow(failure);
      expect(session.state).toBe('COMPLETE'); expect(session.tick).toBe(10);
      expect(session.snapshot()).toEqual(baseline.snapshot());
      session.advanceTo(500); session.singleStep('TRUTH');
      expect(session.tick).toBe(10); expect(session.recorder.length).toBe(1);
      expect(observer).toHaveBeenCalledTimes(1);
      EXPORT_COLUMNS.forEach(column => expect(session.recorder.column(column.id)).toEqual(baseline.recorder.column(column.id)));
    } finally { session.dispose(); baseline.dispose(); }
  });

  it('caps raw history and MPC size and refuses oversized recording before starting', () => {
    const session = createLabSession({ ...NOMINAL_CASE, maxTicks: 250 }, identity);
    session.advanceTo(250);
    expect(session.recorder.rawLength).toBe(200);
    expect(session.recorder.rawTicks()[0].plantTick).toBe(51);
    const copy = session.recorder.rawTicks(); copy[0].truth.prop_kg = -1;
    expect(session.recorder.rawTicks()[0].truth.prop_kg).toBeGreaterThan(0);
    expect(session.snapshot().fswTrace!.mpc.result!.predictedStates.length).toBe(10);
    session.dispose();
    expect(() => createLabSession({ ...NOMINAL_CASE, maxTicks: 1_000_000 }, identity)).toThrow('limit');
    expect(() => createLabSession({ ...NOMINAL_CASE, config: { ...NOMINAL_CASE.config,
      fsw: { ...NOMINAL_CASE.config.fsw, mpcConfig: { horizonSteps: MAX_MPC_HORIZON_STEPS + 1 } } } }, identity)).toThrow('horizon');
    expect(configHash({ ...NOMINAL_CASE.config, initial: { ...NOMINAL_CASE.config.initial, prop_kg: 23 } })).not.toBe(configHash(NOMINAL_CASE.config));
    expect(configHash(Object.fromEntries(Object.entries(NOMINAL_CASE.config).reverse()) as GncCase['config'])).toBe(configHash(NOMINAL_CASE.config));
  });

  it('completes the real default nominal case without truncation or duplicate DemoRecord history', () => {
    const factory = vi.spyOn(demo, 'createDemoRun');
    const session = createLabSession(NOMINAL_CASE, identity);
    session.advanceTo(NOMINAL_CASE.maxTicks);
    expect(session.state).toBe('COMPLETE'); expect(session.snapshot().frame!.outcome).toBe('DOCKED');
    expect(session.recorder.capacity).toEqual({ rows: 12001, columns: 192, bytes: 18433536 });
    expect(session.recorder.length).toBe(session.tick / 10);
    expect(session.recorder.column('time_s').at(-1)).toBeCloseTo(session.tick / 100, 8);
    expect(session.recorder.rawLength).toBe(200);
    // Observe the actual runner, not merely the session's public shape.
    expect(factory.mock.results[0].value.records).toHaveLength(0);
    session.dispose(); factory.mockRestore();
  }, 60_000);
});
