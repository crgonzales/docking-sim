import { describe, expect, it } from 'vitest';
import { CREW_DRAGON_THRUSTERS, createSimLoop } from '@docking/sim-core';
import { createSummaryAccumulator, summarizeRecords } from '../mc/summarize';
import {
  createDemoRun,
  DEMO_CASES,
  FAULT_ISOLATE_TICK,
  FAULT_STUCK_OPEN_TICK,
  FAULT_THRUSTER_ID,
  NOMINAL_CASE,
  RCS_STUCK_OPEN_CASE,
  TRUTH_TICKS_PER_FSW_WINDOW,
  truthSeparation_m,
  type DemoRecord,
  type GncCase,
  type ScheduledCommand,
} from './demoRun';

const LONG_RUN_TIMEOUT_MS = 120_000;

it('uses createLoop exactly once synchronously and preserves retained/streaming defaults', () => {
  const gncCase = { ...NOMINAL_CASE, maxTicks: 35 };
  const baseline = createDemoRun(gncCase); baseline.advanceToEnd();
  for (const retainRecords of [undefined, false]) {
    const steps: number[] = [], streamed: DemoRecord[] = [];
    let calls = 0;
    const run = createDemoRun(gncCase, {
      retainRecords, onRecord: record => streamed.push(record),
      createLoop(config, seed) {
        calls += 1; expect(config).toBe(gncCase.config); expect(seed).toBe(gncCase.seed);
        const loop = createSimLoop(config, seed);
        return { ...loop, stepTo(t) { steps.push(t); return loop.stepTo(t); } };
      },
    });
    expect(calls).toBe(1); expect(steps).toEqual([]);
    const produced = run.advanceToEnd();
    expect(calls).toBe(1); expect(steps).toEqual([0.1, 0.2, 0.3, 0.35]);
    expect(streamed).toEqual(baseline.records);
    expect(run.records).toEqual(retainRecords === false ? [] : baseline.records);
    expect(produced).toEqual(run.records);
    expect(run.getTruthState()).toEqual(baseline.getTruthState());
  }
});

function serializeRecords(records: readonly DemoRecord[]): string {
  return JSON.stringify(records);
}

function faultCaseWithSchedule(schedule: ScheduledCommand[], maxTicks = RCS_STUCK_OPEN_CASE.maxTicks): GncCase {
  return { ...RCS_STUCK_OPEN_CASE, schedule, maxTicks };
}

describe('GNC demo cases', () => {
  it('share one configuration, seed and geometry and differ only by schedule', () => {
    expect(DEMO_CASES.map((gncCase) => gncCase.id)).toEqual(['NOMINAL', 'RCS_STUCK_OPEN']);
    expect(RCS_STUCK_OPEN_CASE.seed).toBe(NOMINAL_CASE.seed);
    expect(RCS_STUCK_OPEN_CASE.config).toEqual(NOMINAL_CASE.config);
    expect(NOMINAL_CASE.schedule).toEqual([]);
    for (const gncCase of DEMO_CASES) {
      expect(gncCase.geometry).toBe('CREW_DRAGON');
      expect(gncCase.config.thrusters?.specs).toBe(CREW_DRAGON_THRUSTERS);
    }
    expect(FAULT_ISOLATE_TICK).toBeGreaterThan(FAULT_STUCK_OPEN_TICK);
  });

  it('NOMINAL reaches DOCKED on Crew Dragon geometry and reproduces exactly from seed', () => {
    const first = createDemoRun(NOMINAL_CASE);
    first.advanceToEnd();
    expect(first.outcome).toBe('DOCKED');
    expect(first.tick).toBeLessThanOrEqual(NOMINAL_CASE.maxTicks);
    expect(first.records.at(-1)!.frame.outcome).toBe('DOCKED');
    // Docking latches truth to the station port with zero relative velocity.
    expect(first.getTruthState().v_hill_mps).toEqual([0, 0, 0]);
    expect(first.records.every((record) => record.frame.corridor_level === 'NOMINAL')).toBe(true);

    const second = createDemoRun(NOMINAL_CASE);
    second.advanceToEnd();
    expect(second.tick).toBe(first.tick);
    expect(serializeRecords(second.records)).toBe(serializeRecords(first.records));
    expect(second.getTruthState()).toEqual(first.getTruthState());
  }, LONG_RUN_TIMEOUT_MS);

  it('RCS_STUCK_OPEN diverges from NOMINAL only after the fault tick, fires J6 uncommanded, and isolation removes it', () => {
    const nominal = createDemoRun(NOMINAL_CASE);
    const faulted = createDemoRun(RCS_STUCK_OPEN_CASE);

    // Identical until the injection tick: the schedule has no effect before it fires.
    nominal.advanceTo(FAULT_STUCK_OPEN_TICK);
    faulted.advanceTo(FAULT_STUCK_OPEN_TICK);
    expect(faulted.appliedCommands).toEqual([
      { tick: FAULT_STUCK_OPEN_TICK, command: { kind: 'INJECT_THRUSTER_STUCK', thrusterId: FAULT_THRUSTER_ID, state: 'OPEN' } },
    ]);
    expect(serializeRecords(faulted.records)).toBe(serializeRecords(nominal.records));
    expect(truthSeparation_m(nominal.getTruthState(), faulted.getTruthState())).toBe(0);

    // Fault active: truth fires J6 every window while the FSW never commanded a full window.
    nominal.advanceTo(FAULT_ISOLATE_TICK);
    faulted.advanceTo(FAULT_ISOLATE_TICK);
    expect(faulted.outcome).toBe('NONE');
    const faultedWindows = faulted.records.filter((record) => record.tick > FAULT_STUCK_OPEN_TICK);
    const nominalWindows = nominal.records.filter((record) => record.tick > FAULT_STUCK_OPEN_TICK);
    expect(faultedWindows.length).toBe(nominalWindows.length);
    expect(faultedWindows.length).toBeGreaterThan(0);
    for (const record of faultedWindows) {
      // Ten 10 ms truth slices accumulate to 1 within float round-off.
      expect(record.appliedDuty[FAULT_THRUSTER_ID]).toBeCloseTo(1, 12);
      expect(record.frame.thruster_duty[FAULT_THRUSTER_ID]).toBeLessThan(1);
    }
    const lastFaulted = faultedWindows.at(-1)!;
    const lastNominal = nominalWindows.at(-1)!;
    expect(truthSeparation_m(nominal.getTruthState(), faulted.getTruthState())).toBeGreaterThan(1);
    expect(lastFaulted.frame.prop_kg).toBeLessThan(lastNominal.frame.prop_kg);
    const peakRate = (records: DemoRecord[]) => Math.max(...records.map((record) => record.frame.body_rate_dps));
    expect(peakRate(faultedWindows)).toBeGreaterThan(peakRate(nominalWindows));

    // Operator isolation: J6 leaves both the applied and the commanded duty, and the allocation changes.
    faulted.advanceTo(FAULT_ISOLATE_TICK + 40 * TRUTH_TICKS_PER_FSW_WINDOW);
    expect(faulted.appliedCommands.at(-1)).toEqual({
      tick: FAULT_ISOLATE_TICK,
      command: { kind: 'ISOLATE_THRUSTER', thrusterId: FAULT_THRUSTER_ID },
    });
    const postIsolation = faulted.records.filter((record) => record.tick > FAULT_ISOLATE_TICK);
    expect(postIsolation.length).toBeGreaterThan(0);
    for (const record of postIsolation) {
      expect(record.appliedDuty[FAULT_THRUSTER_ID]).toBe(0);
      expect(record.frame.thruster_duty[FAULT_THRUSTER_ID]).toBe(0);
    }
    expect(postIsolation[0]!.frame.thruster_duty).not.toEqual(lastFaulted.frame.thruster_duty);
    expect(Object.entries(postIsolation[0]!.frame.thruster_duty)
      .some(([id, duty]) => id !== FAULT_THRUSTER_ID && duty > 0)).toBe(true);

    // B0a: the scripted case ends in the measured passive ABORT after isolation
    // and before the hard cap; the exact time lives in the evidence report.
    faulted.advanceToEnd();
    expect(faulted.outcome).toBe(RCS_STUCK_OPEN_CASE.expected.outcome);
    expect(faulted.outcome).toBe('ABORT');
    expect(faulted.tick).toBeGreaterThan(FAULT_ISOLATE_TICK);
    expect(faulted.tick).toBeLessThan(RCS_STUCK_OPEN_CASE.maxTicks);
  }, LONG_RUN_TIMEOUT_MS);
});

describe('demo run scheduling', () => {
  it('applies commands on their exact truth tick regardless of window alignment or same-tick order', () => {
    const stuckTick = 1234;
    const isolateTick = 2345;
    const run = createDemoRun(faultCaseWithSchedule([
      { tick: isolateTick, command: { kind: 'ISOLATE_THRUSTER', thrusterId: 'J6' } },
      { tick: stuckTick, command: { kind: 'INJECT_THRUSTER_STUCK', thrusterId: 'J6', state: 'OPEN' } },
      { tick: stuckTick, command: { kind: 'INJECT_THRUSTER_STUCK', thrusterId: 'J1', state: 'OPEN' } },
    ], 3000));
    run.advanceToEnd();
    expect(run.appliedCommands.map((entry) => entry.tick)).toEqual([stuckTick, stuckTick, isolateTick]);
    expect(run.appliedCommands.map((entry) => entry.command.kind)).toEqual([
      'INJECT_THRUSTER_STUCK', 'INJECT_THRUSTER_STUCK', 'ISOLATE_THRUSTER',
    ]);
    expect(run.appliedCommands.map((entry) => entry.command.thrusterId)).toEqual(['J6', 'J1', 'J6']);

    const dutyAt = (tick: number) => run.records.find((record) => record.tick === tick)!.appliedDuty.J6!;
    // Stuck at tick 1234: six of the ten truth ticks in the window ending at 1240 fire.
    expect(dutyAt(1230)).toBeLessThan(1);
    expect(dutyAt(1240)).toBeCloseTo(0.6, 12);
    expect(dutyAt(1250)).toBeCloseTo(1, 12);
    // Isolated at tick 2345: five of the ten truth ticks in the window ending at 2350 fire.
    expect(dutyAt(2340)).toBeCloseTo(1, 12);
    expect(dutyAt(2350)).toBeCloseTo(0.5, 12);
    expect(dutyAt(2360)).toBe(0);
    expect(run.records.every((record) => record.tick % TRUTH_TICKS_PER_FSW_WINDOW === 0)).toBe(true);
    expect(run.records.every((record) => Math.abs(record.t_s - record.tick / 100) < 1e-6)).toBe(true);
  });

  it('produces identical events and records at 1x, 4x and 16x window chunking', () => {
    const endTick = FAULT_ISOLATE_TICK + 10 * TRUTH_TICKS_PER_FSW_WINDOW;
    const outputs = [1, 4, 16].map((windowsPerCall) => {
      const run = createDemoRun(RCS_STUCK_OPEN_CASE);
      while (run.tick < endTick && run.outcome === 'NONE') {
        run.advanceTo(Math.min(endTick, run.tick + windowsPerCall * TRUTH_TICKS_PER_FSW_WINDOW));
      }
      return {
        tick: run.tick,
        commands: JSON.stringify(run.appliedCommands),
        records: serializeRecords(run.records),
        truth: JSON.stringify(run.getTruthState()),
      };
    });
    expect(outputs[0]!.tick).toBe(endTick);
    expect(JSON.parse(outputs[0]!.commands).map((entry: { tick: number }) => entry.tick))
      .toEqual([FAULT_STUCK_OPEN_TICK, FAULT_ISOLATE_TICK]);
    for (const output of outputs.slice(1)) expect(output).toEqual(outputs[0]);
  }, LONG_RUN_TIMEOUT_MS);

  it('records the preceding window as applied duty and the next window as commanded duty at aligned command ticks', () => {
    const stuckTick = 1230;
    const isolateTick = 2340;
    const run = createDemoRun(faultCaseWithSchedule([
      { tick: stuckTick, command: { kind: 'INJECT_THRUSTER_STUCK', thrusterId: 'J6', state: 'OPEN' } },
      { tick: isolateTick, command: { kind: 'ISOLATE_THRUSTER', thrusterId: 'J6' } },
    ], 2400));
    run.advanceToEnd();
    const recordAt = (tick: number) => run.records.find((record) => record.tick === tick)!;
    // The boundary record at the injection tick is produced before the injection
    // takes effect; its applied duty covers ticks 1220–1230, which were nominal.
    expect(recordAt(stuckTick).appliedDuty.J6).toBeLessThan(1);
    expect(recordAt(stuckTick + TRUTH_TICKS_PER_FSW_WINDOW).appliedDuty.J6).toBeCloseTo(1, 12);
    // Likewise the boundary record at the isolation tick still shows the
    // stuck window 2330–2340; the window after it shows the isolated jet.
    expect(recordAt(isolateTick).appliedDuty.J6).toBeCloseTo(1, 12);
    expect(recordAt(isolateTick + TRUTH_TICKS_PER_FSW_WINDOW).appliedDuty.J6).toBe(0);
    expect(recordAt(isolateTick + TRUTH_TICKS_PER_FSW_WINDOW).frame.thruster_duty.J6).toBe(0);
  });

  it('never integrates past a non-window-aligned hard cap, even on a large advance', () => {
    const maxTicks = 1235;
    const run = createDemoRun(faultCaseWithSchedule([], maxTicks));
    const produced = run.advanceTo(1_000_000);
    expect(run.tick).toBe(maxTicks);
    expect(run.outcome).toBe('NONE');
    expect(produced.length).toBe(123);
    expect(run.records.at(-1)!.tick).toBe(1230);
    expect(Math.round(run.getTruthState().t_s * 100)).toBe(maxTicks);
    // At the cap the run is exhausted but not terminal: further advances are no-ops.
    expect(run.advance(50)).toEqual([]);
    expect(run.advanceToEnd()).toEqual([]);
    expect(run.tick).toBe(maxTicks);
    expect(() => run.advanceTo(maxTicks - 1)).toThrow(RangeError);

    const relative = createDemoRun(faultCaseWithSchedule([], maxTicks));
    relative.advance(5_000);
    expect(relative.tick).toBe(maxTicks);
    expect(relative.records.length).toBe(123);
  });

  it('streams records through onRecord without retaining them, producing the same summary as retained mode', () => {
    const gncCase = faultCaseWithSchedule([...RCS_STUCK_OPEN_CASE.schedule], 5_000);
    const options = { interval: { thrusterId: FAULT_THRUSTER_ID, fromTick: 1_000, toTick: 3_000 }, initialProp_kg: 24 };

    const retained = createDemoRun(gncCase);
    retained.advanceToEnd();
    expect(retained.records.length).toBe(500);
    const retainedSummary = summarizeRecords(retained.records, options, { finalTick: retained.tick, truth: retained.getTruthState() });

    const streamed: DemoRecord[] = [];
    const accumulator = createSummaryAccumulator(options);
    const streaming = createDemoRun(gncCase, {
      retainRecords: false,
      onRecord: (record) => {
        streamed.push(record);
        accumulator.push(record);
      },
    });
    const produced = streaming.advanceToEnd();
    expect(produced).toEqual([]);
    expect(streaming.records).toEqual([]);
    expect(streaming.tick).toBe(retained.tick);
    expect(streamed.length).toBe(500);
    expect(serializeRecords(streamed)).toBe(serializeRecords(retained.records));
    expect(accumulator.finish({ finalTick: streaming.tick, truth: streaming.getTruthState() })).toEqual(retainedSummary);

    // Default retained mode also invokes the callback and keeps its return values.
    const both: number[] = [];
    const defaulted = createDemoRun(gncCase, { onRecord: (record) => both.push(record.tick) });
    expect(defaulted.advance(30).length).toBe(3);
    expect(defaulted.records.length).toBe(3);
    expect(both).toEqual([10, 20, 30]);
  });

  it('applies tick-zero commands before the first step, stops at an outcome, and rejects rewinding', () => {
    const run = createDemoRun(faultCaseWithSchedule([
      { tick: 0, command: { kind: 'ISOLATE_THRUSTER', thrusterId: 'J6' } },
    ], 200));
    const first = run.advance(TRUTH_TICKS_PER_FSW_WINDOW);
    expect(run.appliedCommands).toEqual([{ tick: 0, command: { kind: 'ISOLATE_THRUSTER', thrusterId: 'J6' } }]);
    expect(first).toHaveLength(1);
    expect(first[0]!.frame.thruster_duty.J6).toBe(0);
    expect(() => run.advanceTo(0)).toThrow(RangeError);
    expect(() => run.advanceTo(15.5)).toThrow(RangeError);

    const docked = createDemoRun({
      ...NOMINAL_CASE,
      config: {
        ...NOMINAL_CASE.config,
        initial: { ...NOMINAL_CASE.config.initial, r_hill_m: [0, -10.44, 0], v_hill_mps: [0, 0.05, 0] },
      },
      maxTicks: 500,
    });
    docked.advanceToEnd();
    expect(docked.outcome).toBe('DOCKED');
    expect(docked.tick).toBeLessThan(500);
    expect(docked.records.at(-1)!.frame.outcome).toBe('DOCKED');
    expect(docked.advanceToEnd()).toEqual([]);
    expect(docked.tick).toBeLessThan(500);
  });
});
