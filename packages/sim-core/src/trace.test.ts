import { describe, expect, it } from 'vitest';
import { conjugateQuaternion, hillToBody, rotateVector } from './attitude.js';
import { CREW_DRAGON_THRUSTERS } from './crewDragon.js';
import { createFsw } from './fsw.js';
import { createSimLoop, createTracedSimLoop, type SimConfig } from './sim.js';
import type { FswTraceRecord, PlantTickRecord, PlantWindowRecord } from './trace.js';
import type { Vec3 } from './types.js';

const INITIAL_STATE: [number, number, number, number, number, number] = [0, -250, 12, 0, 0.1, 0];
const WINDOW_S = 0.1;
const TICK_S = 0.01;

function diagonal(values: number[]): number[][] {
  return values.map((value, row) => values.map((_, column) => (row === column ? value : 0)));
}

/** Crew Dragon geometry with default sensor noise: the demonstration's own configuration. */
function config(): SimConfig {
  return {
    thrusters: { specs: CREW_DRAGON_THRUSTERS },
    initial: { r_hill_m: [0, -250, 12], v_hill_mps: [0, 0.1, 0], prop_kg: 24, q_BI: [1, 0, 0, 0] },
    fsw: {
      controller: 'LQR',
      massModel: { dryMass_kg: 976, initialProp_kg: 24 },
      guidanceConfig: { initialState: [...INITIAL_STATE] },
      ekfConfig: {
        initialNavPrior: { state: [...INITIAL_STATE], covariance: diagonal([10_000, 10_000, 10_000, 10, 10, 10]) },
      },
      allocatorConfig: { fswHz: 10, truthHz: 100, specs: CREW_DRAGON_THRUSTERS },
    },
  };
}

/** The sim.test.ts docking configuration: contact inside the capture envelope within the first window. */
function dockingConfig(): SimConfig {
  const base = config();
  return {
    ...base,
    initial: { ...base.initial, r_hill_m: [0, -10.44, 0], v_hill_mps: [0, 0.05, 0] },
    fsw: {
      ...base.fsw,
      guidanceConfig: { initialState: [0, -10.44, 0, 0, 0.05, 0] },
      ekfConfig: {
        initialNavPrior: { state: [0, -10.44, 0, 0, 0.05, 0], covariance: diagonal([10_000, 10_000, 10_000, 10, 10, 10]) },
      },
    },
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function collect(seed = 1004, setup?: (sim: ReturnType<typeof createTracedSimLoop>['sim']) => void) {
  const { sim, trace } = createTracedSimLoop(config(), seed);
  const fsw: FswTraceRecord[] = [];
  const ticks: PlantTickRecord[] = [];
  const windows: PlantWindowRecord[] = [];
  const order: string[] = [];
  trace.subscribeFsw((record) => { fsw.push(record); order.push(`F${record.fswSequence}`); });
  trace.subscribePlantTick((record) => { ticks.push(record); order.push(`T${record.plantTick}`); });
  trace.subscribePlantWindow((record) => { windows.push(record); order.push(`W${record.windowIndex}`); });
  setup?.(sim);
  return { sim, trace, fsw, ticks, windows, order };
}

describe('createTracedSimLoop', () => {
  it('leaves the untraced loop bit-identical and does not perturb the traced run', () => {
    const untraced = createSimLoop(config(), 1004);
    const traced = createTracedSimLoop(config(), 1004);
    const untracedFrames = untraced.stepTo(30);
    const tracedFrames = traced.sim.stepTo(30);
    expect(tracedFrames).toHaveLength(300);
    expect(tracedFrames).toEqual(untracedFrames);
    expect(traced.sim.getTruthState()).toEqual(untraced.getTruthState());
    expect(traced.sim.getRenderState()).toEqual(untraced.getRenderState());
  }, 60_000);

  it('enumerates construction, truth-only advance, the first boundary and later windows', () => {
    const { sim, trace, fsw, ticks, windows, order } = collect();

    // Construction: no truth tick has run, so nothing is fabricated for tick 0.
    expect(trace.latestPlantTick()).toBeNull();
    expect(trace.latestFsw()).toBeNull();
    expect(trace.latestPlantWindow()).toBeNull();
    expect(trace.pendingWindow()).toMatchObject({ windowIndex: 1, slicesIntegrated: 0, bounds_tick: [0, 0], sourceFswSequence: null, docked: false });
    expect(sim.getRenderState().t_s).toBe(0);

    // Truth-only advance to tick 3: three tick records, a three-slice pending window, still no FSW.
    expect(sim.stepTo(0.03)).toEqual([]);
    expect(ticks.map((record) => record.plantTick)).toEqual([1, 2, 3]);
    expect(trace.latestPlantTick()!.plantTick).toBe(3);
    expect(trace.pendingWindow()).toMatchObject({ windowIndex: 1, slicesIntegrated: 3, bounds_tick: [0, 3] });
    expect(trace.latestFsw()).toBeNull();
    expect(trace.latestPlantWindow()).toBeNull();

    // First boundary: window 1 is the bootstrap window (no command existed) and flushes before FSW ordinal 1 runs.
    const frames = sim.stepTo(0.1);
    expect(frames).toHaveLength(1);
    expect(order).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'W1', 'F1']);
    expect(windows[0]).toMatchObject({
      windowIndex: 1, bounds_tick: [0, 10], sourceFswSequence: null, sourceSamplePlantTick: null, slicesIntegrated: 10, docked: false,
    });
    expect(windows[0]!.bounds_s[0]).toBe(0);
    expect(windows[0]!.bounds_s[1]).toBeCloseTo(0.1, 12);
    expect(fsw[0]).toMatchObject({ fswSequence: 1, samplePlantTick: 10, commandInterval_tick: [10, 20] });
    expect(fsw[0]!.sampleTime_s).toBeCloseTo(0.1, 12);
    expect(trace.pendingWindow()).toMatchObject({ windowIndex: 2, slicesIntegrated: 0, bounds_tick: [10, 10], sourceFswSequence: 1 });

    // Tick 17: the plant clock runs ahead of the held FSW sample.
    expect(sim.stepTo(0.17)).toEqual([]);
    expect(trace.latestPlantTick()!.plantTick).toBe(17);
    expect(trace.pendingWindow()).toMatchObject({ windowIndex: 2, slicesIntegrated: 7, bounds_tick: [10, 17] });
    expect(trace.latestFsw()!.fswSequence).toBe(1);
    expect(trace.latestPlantWindow()!.windowIndex).toBe(1);

    // Later windows name the FSW ordinal whose command they executed.
    sim.stepTo(0.3);
    expect(windows.map((record) => [record.windowIndex, record.sourceFswSequence, record.sourceSamplePlantTick]))
      .toEqual([[1, null, null], [2, 1, 10], [3, 2, 20]]);
    expect(fsw.map((record) => record.fswSequence)).toEqual([1, 2, 3]);
    expect(ticks).toHaveLength(30);
    for (const record of ticks) expect(record.t_s).toBeCloseTo(record.plantTick * TICK_S, 12);
  });

  it('agrees with telemetry: window active time is the render duty and FSW on-times are the commanded duty', () => {
    const { sim, trace, fsw } = collect();
    for (let boundary = 1; boundary <= 50; boundary += 1) {
      const frame = sim.stepTo(boundary * WINDOW_S).at(-1)!;
      const window = trace.latestPlantWindow()!;
      const render = sim.getRenderState().thruster_duty;
      for (const spec of CREW_DRAGON_THRUSTERS) {
        expect(window.activeTime_s[spec.id]! / WINDOW_S).toBeCloseTo(render[spec.id]!, 12);
        expect(fsw.at(-1)!.allocation.onTimes[spec.id] ?? 0).toBeCloseTo(frame.thruster_duty[spec.id]! * WINDOW_S, 12);
      }
      expect(window.bounds_tick[1]).toBe(boundary * 10);
      expect(fsw.at(-1)!.samplePlantTick).toBe(boundary * 10);
    }
  });

  it('integrates every slice into the window, preserving sub-window pulses whose last slice is off', () => {
    const { sim, ticks, windows } = collect();
    sim.stepTo(30);
    expect(windows).toHaveLength(300);
    let shortPulses = 0;
    for (const window of windows) {
      const slices = ticks.filter((record) => record.plantTick > window.bounds_tick[0] && record.plantTick <= window.bounds_tick[1]);
      expect(slices).toHaveLength(10);
      for (const spec of CREW_DRAGON_THRUSTERS) {
        const integrated = sum(slices.map((record) => record.slice.activeOnTime_s[spec.id] ?? 0));
        expect(window.activeTime_s[spec.id]).toBeCloseTo(integrated, 12);
        const active = window.activeTime_s[spec.id]!;
        if (active > 0 && active < WINDOW_S - 1e-9 && (slices[9]!.slice.activeOnTime_s[spec.id] ?? 0) === 0) shortPulses += 1;
      }
      expect(window.propellantUsed_kg).toBeCloseTo(sum(slices.map((record) => record.slice.propellantUsed_kg)), 15);
    }
    // The LQR approach commands 20–90 ms pulses constantly; a boundary sample would have missed all of them.
    expect(shortPulses).toBeGreaterThan(0);
  }, 60_000);

  it('records a stuck-open jet as a full window the FSW never commanded, and a mid-window isolation as a partial one', () => {
    const { sim, fsw, windows } = collect(1004, (loop) => loop.injectThrusterStuck('J6', 'OPEN'));
    sim.stepTo(0.2);
    // Window 1 is the bootstrap window: no command, yet J6 delivered the whole window.
    expect(windows[0]!.activeTime_s.J6).toBeCloseTo(WINDOW_S, 12);
    expect(windows[0]!.sourceFswSequence).toBeNull();
    // Window 2 executed FSW ordinal 1. The FSW cannot know the jet is stuck, so
    // it may command J6 a short pulse — but never the full window it delivered.
    const commandedJ6_s = fsw[0]!.allocation.onTimes.J6 ?? 0;
    expect(commandedJ6_s).toBeLessThan(WINDOW_S);
    expect(windows[1]!.activeTime_s.J6).toBeCloseTo(WINDOW_S, 12);
    expect(windows[1]!.activeTime_s.J6).toBeGreaterThan(commandedJ6_s);
    expect(windows[1]!.sourceFswSequence).toBe(1);

    // Isolate at tick 22: slices 21–22 fired, slices 23–30 did not, and the window keeps the 20 ms.
    sim.stepTo(0.22);
    sim.isolateThruster('J6');
    sim.stepTo(0.3);
    expect(windows[2]!.activeTime_s.J6).toBeCloseTo(2 * TICK_S, 12);
    expect(sim.getRenderState().thruster_duty.J6).toBeCloseTo(0.2, 12);
    sim.stepTo(0.4);
    expect(windows[3]!.activeTime_s.J6).toBe(0);
  });

  it('flushes the window after the tenth slice and resets the accumulators only after the flush', () => {
    const { sim, trace, windows } = collect(1004, (loop) => loop.injectThrusterStuck('J1', 'OPEN'));
    sim.stepTo(0.09);
    expect(trace.pendingWindow().slicesIntegrated).toBe(9);
    expect(trace.pendingWindow().activeTime_s.J1).toBeCloseTo(9 * TICK_S, 12);
    expect(windows).toHaveLength(0);
    sim.stepTo(0.1);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.slicesIntegrated).toBe(10);
    expect(windows[0]!.activeTime_s.J1).toBeCloseTo(WINDOW_S, 12);
    const pending = trace.pendingWindow();
    expect(pending.slicesIntegrated).toBe(0);
    expect(pending.activeTime_s.J1).toBe(0);
    expect(pending.impulse_hill_Ns).toEqual([0, 0, 0]);
    expect(pending.propellantUsed_kg).toBe(0);
    // The flushed record is detached from the accumulators that were reset.
    expect(trace.latestPlantWindow()!.activeTime_s.J1).toBeCloseTo(WINDOW_S, 12);
  });

  it('reports a Hill impulse equal to the truth momentum change attributable to thrust', () => {
    // Bootstrap window, one stuck-open jet: the only thrust in ticks 1–10 is J1,
    // so the momentum change relative to an identical coasting run is J1's impulse.
    const thrusting = createTracedSimLoop(config(), 1004);
    const ticks: PlantTickRecord[] = [];
    thrusting.trace.subscribePlantTick((record) => ticks.push(record));
    thrusting.sim.injectThrusterStuck('J1', 'OPEN');
    const coasting = createSimLoop(config(), 1004);
    const before = thrusting.sim.getTruthState();
    thrusting.sim.stepTo(0.1);
    coasting.stepTo(0.1);
    const window = thrusting.trace.latestPlantWindow()!;
    const thrust = thrusting.sim.getTruthState();
    const coast = coasting.getTruthState();
    const mass_kg = 976 + before.prop_kg;
    const momentumChange_Ns = [0, 1, 2].map((axis) =>
      mass_kg * ((thrust.v_hill_mps[axis]! - before.v_hill_mps[axis]!) - (coast.v_hill_mps[axis]! - before.v_hill_mps[axis]!)));
    const expectedMagnitude_Ns = 25 * WINDOW_S;
    expect(Math.hypot(...window.impulse_hill_Ns)).toBeCloseTo(expectedMagnitude_Ns, 6);
    const residual_Ns = Math.hypot(...[0, 1, 2].map((axis) => window.impulse_hill_Ns[axis]! - momentumChange_Ns[axis]!));
    expect(residual_Ns).toBeLessThan(1e-3 * expectedMagnitude_Ns);
    // eslint-disable-next-line no-console
    console.log(`Hill impulse ${window.impulse_hill_Ns.map((value) => value.toFixed(6)).join(', ')} N·s; momentum-change residual ${residual_Ns.toExponential(3)} N·s`);

    // Per-slice framing: the body impulse is J1's direction summed per slice,
    // and the Hill impulse rotates each slice by the attitude it was applied
    // at — the pre-step truth of that tick — which is what makes it exact even
    // though J1's torque rotates the body within the window.
    const j1 = CREW_DRAGON_THRUSTERS.find((spec) => spec.id === 'J1')!;
    const sliceImpulse_body = j1.direction_body.map((value) => value * 25 * TICK_S) as Vec3;
    const expectedHill: Vec3 = [0, 0, 0];
    for (let slice = 1; slice <= 10; slice += 1) {
      const pre = slice === 1 ? before : ticks[slice - 2]!.truth;
      const rotated = rotateVector(conjugateQuaternion(hillToBody(pre.q_BI, pre.t_s)), sliceImpulse_body);
      for (let axis = 0; axis < 3; axis += 1) expectedHill[axis]! += rotated[axis]!;
    }
    const identityHill = rotateVector(conjugateQuaternion(hillToBody([1, 0, 0, 0], 0)), j1.direction_body.map((value) => value * expectedMagnitude_Ns) as Vec3);
    for (let axis = 0; axis < 3; axis += 1) {
      expect(window.impulse_body_Ns[axis]).toBeCloseTo(j1.direction_body[axis]! * expectedMagnitude_Ns, 9);
      expect(window.impulse_hill_Ns[axis]).toBeCloseTo(expectedHill[axis]!, 9);
    }
    // The in-window rotation is real: a single-attitude rotation would be off.
    expect(Math.hypot(...[0, 1, 2].map((axis) => identityHill[axis]! - window.impulse_hill_Ns[axis]!))).toBeGreaterThan(1e-5);
    expect(window.propellantUsed_kg).toBeCloseTo(before.prop_kg - thrust.prop_kg, 9);
  });

  it('replays the recorded sensor stream through a bare FSW and reproduces every record', () => {
    const { sim, fsw } = collect();
    const frames = sim.stepTo(20);
    expect(fsw).toHaveLength(200);

    const replayed: FswTraceRecord[] = [];
    const bare = createFsw({
      ...config().fsw,
      allocatorConfig: { fswHz: 10, truthHz: 100, specs: CREW_DRAGON_THRUSTERS },
      onTrace: (record) => replayed.push(record),
    });
    const replayedThrusters = fsw.map((record) => bare(record.sensor).thrusters);
    expect(replayed).toEqual(fsw);
    replayedThrusters.forEach((thrusters, index) => expect(thrusters).toEqual(fsw[index]!.allocation.onTimes));
    frames.forEach((frame, index) => expect(frame.t_s).toBeCloseTo(fsw[index]!.sampleTime_s, 12));
  }, 60_000);

  it('keeps tracing through the docked latch with explicit zero slices and zero windows', () => {
    const { sim, trace, fsw, ticks, windows } = collect(1001, () => undefined);
    const dockedSim = createTracedSimLoop(dockingConfig(), 1001);
    const dockedTicks: PlantTickRecord[] = [];
    const dockedWindows: PlantWindowRecord[] = [];
    const dockedFsw: FswTraceRecord[] = [];
    dockedSim.trace.subscribePlantTick((record) => dockedTicks.push(record));
    dockedSim.trace.subscribePlantWindow((record) => dockedWindows.push(record));
    dockedSim.trace.subscribeFsw((record) => dockedFsw.push(record));
    void sim; void trace; void fsw; void ticks; void windows;

    const first = dockedSim.sim.stepTo(0.1);
    expect(first.at(-1)!.outcome).toBe('DOCKED');
    const latchTick = dockedTicks.find((record) => record.outcome === 'DOCKED')!.plantTick;
    expect(latchTick).toBeLessThanOrEqual(10);
    // A jet stuck open after docking would fire on every tick if applyThrusterCommand
    // were still called; the docked path skips it, so the slice stays exactly zero.
    dockedSim.sim.injectThrusterStuck('J1', 'OPEN');
    const frames = dockedSim.sim.stepTo(0.4);
    expect(frames.map((frame) => frame.outcome)).toEqual(['DOCKED', 'DOCKED', 'DOCKED']);
    const postDock = dockedTicks.filter((record) => record.plantTick > 10);
    expect(postDock).toHaveLength(30);
    for (const record of postDock) {
      expect(record.docked).toBe(true);
      expect(record.jetStates.J1).toBe('stuck_open');
      expect(Object.values(record.slice.activeOnTime_s).every((value) => value === 0)).toBe(true);
      expect(Object.values(record.slice.onTimes_s).every((value) => value === 0)).toBe(true);
      expect(record.slice.force_body_N).toEqual([0, 0, 0]);
      expect(record.slice.torque_body_Nm).toEqual([0, 0, 0]);
      expect(record.slice.propellantUsed_kg).toBe(0);
      expect(record.truth.v_hill_mps).toEqual([0, 0, 0]);
    }
    const postDockWindows = dockedWindows.filter((record) => record.windowIndex > 1);
    expect(postDockWindows.map((record) => [record.windowIndex, record.sourceFswSequence, record.docked]))
      .toEqual([[2, 1, true], [3, 2, true], [4, 3, true]]);
    for (const window of postDockWindows) {
      expect(Object.values(window.activeTime_s).every((value) => value === 0)).toBe(true);
      expect(window.impulse_hill_Ns).toEqual([0, 0, 0]);
      expect(window.angularImpulse_body_Nms).toEqual([0, 0, 0]);
      expect(window.propellantUsed_kg).toBe(0);
      expect(window.slicesIntegrated).toBe(10);
    }
    expect(dockedFsw.map((record) => record.fswSequence)).toEqual([1, 2, 3, 4]);
    const render = dockedSim.sim.getRenderState().thruster_duty;
    expect(Object.values(render).every((value) => value === 0)).toBe(true);
    expect(dockedSim.trace.pendingWindow().slicesIntegrated).toBe(0);
  });

  it('isolates every observer and getter from a mutating observer, including later window provenance', () => {
    // Reference run: one benign observer per source.
    const reference = collect();
    // Run under test: a mutating observer subscribed FIRST on every source, then a benign one.
    const { sim, trace } = createTracedSimLoop(config(), 1004);
    const observedFsw: FswTraceRecord[] = [];
    const observedTicks: PlantTickRecord[] = [];
    const observedWindows: PlantWindowRecord[] = [];
    trace.subscribeFsw((record) => {
      record.fswSequence = -1;
      record.samplePlantTick = -1;
      for (const id of Object.keys(record.allocation.onTimes)) record.allocation.onTimes[id] = 99;
      record.sensor.gyro_rps[0] = 99;
    });
    trace.subscribePlantTick((record) => {
      record.plantTick = -1;
      for (const id of Object.keys(record.slice.activeOnTime_s)) record.slice.activeOnTime_s[id] = 99;
      record.slice.force_body_N[1] = 99;
      record.truth.r_hill_m[1] = 99;
    });
    trace.subscribePlantWindow((record) => {
      record.windowIndex = -1;
      record.sourceFswSequence = 77;
      record.sourceSamplePlantTick = 77;
      for (const id of Object.keys(record.activeTime_s)) record.activeTime_s[id] = 99;
      record.impulse_hill_Ns[0] = 99;
    });
    trace.subscribeFsw((record) => observedFsw.push(record));
    trace.subscribePlantTick((record) => observedTicks.push(record));
    trace.subscribePlantWindow((record) => observedWindows.push(record));

    for (let boundary = 1; boundary <= 5; boundary += 1) {
      sim.stepTo(boundary * WINDOW_S);
      reference.sim.stepTo(boundary * WINDOW_S);
      // (b) latest*() are unaffected by the mutator and return fresh clones each call.
      expect(trace.latestFsw()).toEqual(reference.trace.latestFsw());
      expect(trace.latestPlantTick()).toEqual(reference.trace.latestPlantTick());
      expect(trace.latestPlantWindow()).toEqual(reference.trace.latestPlantWindow());
      const leaked = trace.latestFsw()!;
      leaked.fswSequence = -5;
      leaked.allocation.onTimes.J1 = 5;
      expect(trace.latestFsw()!.fswSequence).toBe(boundary);
      expect(trace.latestFsw()!.allocation.onTimes.J1).toBe(reference.trace.latestFsw()!.allocation.onTimes.J1);
      const leakedWindow = trace.latestPlantWindow()!;
      leakedWindow.sourceFswSequence = -5;
      expect(trace.latestPlantWindow()!.sourceFswSequence).toBe(boundary === 1 ? null : boundary - 1);
      const leakedPending = trace.pendingWindow();
      leakedPending.activeTime_s.J1 = 5;
      expect(trace.pendingWindow().activeTime_s.J1).toBe(0);
    }

    // (a) The benign observer received exactly what the reference observer received.
    expect(observedFsw).toEqual(reference.fsw);
    expect(observedTicks).toEqual(reference.ticks);
    expect(observedWindows).toEqual(reference.windows);
    // (c) Window provenance derives from the private snapshot, not the mutated record.
    expect(observedWindows.map((record) => [record.windowIndex, record.sourceFswSequence, record.sourceSamplePlantTick]))
      .toEqual([[1, null, null], [2, 1, 10], [3, 2, 20], [4, 3, 30], [5, 4, 40]]);
    // (d) Window accumulation is untouched: active time still matches the render duty and the slice sums.
    for (const window of observedWindows) {
      const slices = observedTicks.filter((record) => record.plantTick > window.bounds_tick[0] && record.plantTick <= window.bounds_tick[1]);
      expect(slices).toHaveLength(10);
      for (const spec of CREW_DRAGON_THRUSTERS) {
        expect(window.activeTime_s[spec.id]).toBeCloseTo(sum(slices.map((record) => record.slice.activeOnTime_s[spec.id] ?? 0)), 12);
      }
    }
    expect(sim.getRenderState()).toEqual(reference.sim.getRenderState());
    expect(sim.getTruthState()).toEqual(reference.sim.getTruthState());
  });

  it('records the applied velocity bias on the tick it takes effect and detaches records from live state', () => {
    const { sim, ticks } = collect();
    sim.injectVelocityBias([0.01, 0, 0]);
    sim.stepTo(0.02);
    expect(ticks[0]!.velocityBiasApplied_mps).toEqual([0.01, 0, 0]);
    expect(ticks[1]!.velocityBiasApplied_mps).toBeNull();
    const snapshot = ticks[1]!.truth.r_hill_m[1];
    ticks[1]!.truth.r_hill_m[1] = 999;
    ticks[1]!.slice.force_body_N[0] = 999;
    expect(sim.getTruthState().r_hill_m[1]).not.toBe(999);
    sim.stepTo(0.1);
    expect(ticks[1]!.truth.r_hill_m[1]).toBe(999);
    expect(snapshot).not.toBe(999);
  });
});
