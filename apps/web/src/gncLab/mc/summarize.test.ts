import { describe, expect, it } from 'vitest';
import type { TelemetryFrame, TruthState } from '@docking/sim-core';
import type { DemoRecord } from '../session/demoRun';
import {
  createSummaryAccumulator,
  FULL_DUTY_THRESHOLD,
  intervalWindowCount,
  isFullDuty,
  summarizeRecords,
  type RunSummary,
} from './summarize';

const INTERVAL = { thrusterId: 'J6', fromTick: 20, toTick: 40 };
const INITIAL_PROP_KG = 24;
const TRUTH: TruthState = { t_s: 1, r_hill_m: [1, -2, 3], v_hill_mps: [0.1, 0.2, 0.3], q_BI: [1, 0, 0, 0], w_body_rps: [0, 0, 0], prop_kg: 23.5 };

function frame(overrides: Partial<TelemetryFrame> = {}): TelemetryFrame {
  return {
    t_s: 0,
    nav_r_hill_m: [0, -100, 0],
    nav_cov_pos_m2: [1, 1, 1],
    nees: null,
    corridor_err_m: 0,
    range_m: 100,
    body_rate_dps: 0.1,
    controller: 'MPC',
    mpc_fallback: false,
    outcome: 'NONE',
    abort: 'ARMED',
    control_mode: 'AUTO',
    manual_authority: 'LOW',
    nav_source: 'PRIMARY',
    guidance_frozen: false,
    corridor_level: 'NOMINAL',
    prop_kg: 24,
    thruster_duty: { J1: 0, J6: 0 },
    sat_flag: false,
    q_BH_est: [1, 0, 0, 0],
    body_rate_dps_est: [0, 0, 0],
    att_sigma_deg: 0.01,
    manual_sub_mode: null,
    docking: null,
    att_nees: null,
    ...overrides,
  };
}

function record(tick: number, overrides: Partial<TelemetryFrame> = {}, appliedDuty: Record<string, number> = { J1: 0, J6: 0 }): DemoRecord {
  return { tick, t_s: tick / 100, frame: frame({ t_s: tick / 100, ...overrides }), appliedDuty };
}

function windows(ticks: number[], build: (tick: number) => DemoRecord = (tick) => record(tick)): DemoRecord[] {
  return ticks.map(build);
}

function summarize(records: DemoRecord[], finalTick = records.at(-1)!.tick): RunSummary {
  return summarizeRecords(records, { interval: INTERVAL, initialProp_kg: INITIAL_PROP_KG }, { finalTick, truth: TRUTH });
}

describe('full duty rule', () => {
  it('counts ten summed 10 ms slices as full and anything clearly short as not', () => {
    expect(FULL_DUTY_THRESHOLD).toBe(1 - 1e-12);
    expect(isFullDuty(1)).toBe(true);
    expect(isFullDuty(0.9999999999999999)).toBe(true);
    expect(isFullDuty(0.9999999)).toBe(false);
    expect(isFullDuty(0.6)).toBe(false);
    expect(isFullDuty(undefined)).toBe(false);
  });
});

describe('comparison interval accumulation', () => {
  it('reports every window of a fully covered interval and marks it complete', () => {
    const summary = summarize(windows([10, 20, 30, 40, 50, 60]));
    expect(intervalWindowCount(INTERVAL)).toBe(3);
    expect(summary.interval).toEqual({
      fromTick: 20, toTick: 40, thrusterId: 'J6',
      windows: 3, complete: true,
      peakBodyRate_dps: 0.1, satFrames: 0, corridorCautionFrames: 0, corridorViolationFrames: 0,
      appliedFullDutyWindows: 0, commandedFullDutyWindows: 0,
    });
  });

  it('marks the interval incomplete when the run ends inside it', () => {
    const summary = summarize(windows([10, 20, 30], (tick) => record(tick, tick === 30 ? { outcome: 'ABORT' } : {})));
    expect(summary.interval.windows).toBe(2);
    expect(summary.interval.complete).toBe(false);
    expect(summary.outcome).toBe('ABORT');
    expect(summary.outcomeTick).toBe(30);
  });

  it('counts applied and commanded full-duty windows for the interval thruster only, with the 1e-12 rule', () => {
    const records = [
      record(10, { thruster_duty: { J1: 1, J6: 1 } }, { J1: 1, J6: 1 }),                                  // before the interval: ignored
      record(20, { thruster_duty: { J1: 0, J6: 0.9999999999999999 } }, { J1: 1, J6: 0.9999999999999999 }), // full by the rule
      record(30, { thruster_duty: { J1: 1, J6: 0.9999999 } }, { J1: 1, J6: 0.9999999 }),                  // not full
      record(40, { thruster_duty: { J1: 0, J6: 1 } }, { J1: 0, J6: 0.6 }),                                // commanded full, applied not
      record(50, { thruster_duty: { J1: 0, J6: 1 } }, { J1: 0, J6: 1 }),                                  // after the interval: ignored
    ];
    const summary = summarize(records);
    expect(summary.interval.windows).toBe(3);
    expect(summary.interval.complete).toBe(true);
    expect(summary.interval.appliedFullDutyWindows).toBe(1);
    expect(summary.interval.commandedFullDutyWindows).toBe(2);
  });

  it('accumulates interval-local peak, saturation and corridor counts separately from the whole run', () => {
    const records = [
      record(10, { body_rate_dps: 9, sat_flag: true, corridor_level: 'VIOLATION' }),
      record(20, { body_rate_dps: 2, sat_flag: true, corridor_level: 'CAUTION' }),
      record(30, { body_rate_dps: 5, corridor_level: 'CAUTION' }),
      record(40, { body_rate_dps: 1, corridor_level: 'VIOLATION' }),
      record(50, { body_rate_dps: 7, sat_flag: true, mpc_fallback: true }),
    ];
    const summary = summarize(records);
    expect(summary.peakBodyRate_dps).toBe(9);
    expect(summary.satFrames).toBe(3);
    expect(summary.mpcFallbackFrames).toBe(1);
    expect(summary.corridorCautionFrames).toBe(2);
    expect(summary.corridorViolationFrames).toBe(2);
    expect(summary.interval.peakBodyRate_dps).toBe(5);
    expect(summary.interval.satFrames).toBe(1);
    expect(summary.interval.corridorCautionFrames).toBe(2);
    expect(summary.interval.corridorViolationFrames).toBe(1);
  });

  it('produces the identical interval shape for a run with no fault and no full-duty windows', () => {
    const faulted = summarize(windows([10, 20, 30, 40, 50], (tick) => record(tick, {}, { J1: 0, J6: 1 })));
    const nominal = summarize(windows([10, 20, 30, 40, 50]));
    expect(Object.keys(nominal.interval)).toEqual(Object.keys(faulted.interval));
    expect(Object.keys(nominal)).toEqual(Object.keys(faulted));
    expect(nominal.interval.appliedFullDutyWindows).toBe(0);
    expect(faulted.interval.appliedFullDutyWindows).toBe(3);
    expect(nominal.interval.complete).toBe(true);
  });
});

describe('run-level fields', () => {
  it('takes propellant used from the initial minus the last telemetry tank, and last-value fields from the final frame', () => {
    const docking = { closing_mps: 0.05, lateral_m: 0.01, misalign_deg: 0.2, rate_dps: 0.05 };
    const records = [
      record(10, { prop_kg: 23.9, abort: 'ARMED', docking: null }),
      record(20, { prop_kg: 23.5, abort: 'BURNING', docking: { ...docking, closing_mps: 0.9 } }),
      record(30, { prop_kg: 23.1, abort: 'COASTING', docking, outcome: 'DOCKED' }),
    ];
    const summary = summarize(records, 30);
    expect(summary.propUsed_kg).toBeCloseTo(0.9, 12);
    expect(summary.lastAbortState).toBe('COASTING');
    expect(summary.lastDocking).toEqual(docking);
    expect(summary.outcome).toBe('DOCKED');
    expect(summary.outcomeTick).toBe(30);
    expect(summary.frames).toBe(3);
    expect(summary.truth).toEqual({ r_hill_m: [1, -2, 3], v_hill_mps: [0.1, 0.2, 0.3], prop_kg: 23.5 });
  });

  it('reports TIMEOUT at the runner final tick when no outcome latched, including a non-aligned cap', () => {
    const summary = summarize(windows([10, 20, 30]), 35);
    expect(summary.outcome).toBe('TIMEOUT');
    expect(summary.outcomeTick).toBe(35);
    expect(summary.lastDocking).toBeNull();
  });

  it('is incremental: pushing one record at a time equals the batch fold', () => {
    const records = windows([10, 20, 30, 40, 50], (tick) => record(tick, { body_rate_dps: tick / 10, prop_kg: 24 - tick / 1000 }, { J1: 0, J6: tick >= 30 ? 1 : 0 }));
    const accumulator = createSummaryAccumulator({ interval: INTERVAL, initialProp_kg: INITIAL_PROP_KG });
    for (const entry of records) accumulator.push(entry);
    expect(accumulator.frames).toBe(5);
    expect(accumulator.finish({ finalTick: 50, truth: TRUTH })).toEqual(summarize(records, 50));
  });
});

describe('accumulator misuse', () => {
  it('throws a clear error for an empty run rather than inventing a summary', () => {
    const accumulator = createSummaryAccumulator({ interval: INTERVAL, initialProp_kg: INITIAL_PROP_KG });
    expect(() => accumulator.finish({ finalTick: 5, truth: TRUTH })).toThrow(/at least one FSW record/);
  });

  it('rejects out-of-order ticks, records after the outcome latch, a final tick before the last record, and reuse after finish', () => {
    const accumulator = createSummaryAccumulator({ interval: INTERVAL, initialProp_kg: INITIAL_PROP_KG });
    accumulator.push(record(10));
    expect(() => accumulator.push(record(10))).toThrow(RangeError);
    expect(() => accumulator.push(record(5))).toThrow(RangeError);
    accumulator.push(record(20, { outcome: 'COLLISION' }));
    expect(() => accumulator.push(record(30))).toThrow(/after the outcome latched/);
    expect(() => accumulator.finish({ finalTick: 15, truth: TRUTH })).toThrow(RangeError);
    const summary = accumulator.finish({ finalTick: 20, truth: TRUTH });
    expect(summary.outcome).toBe('COLLISION');
    expect(() => accumulator.push(record(30))).toThrow(/already finished/);
    expect(() => accumulator.finish({ finalTick: 20, truth: TRUTH })).toThrow(/already finished/);
  });

  it('rejects a misaligned or reversed interval and a negative initial propellant', () => {
    expect(() => createSummaryAccumulator({ interval: { thrusterId: 'J6', fromTick: 25, toTick: 40 }, initialProp_kg: 24 })).toThrow(RangeError);
    expect(() => createSummaryAccumulator({ interval: { thrusterId: 'J6', fromTick: 40, toTick: 20 }, initialProp_kg: 24 })).toThrow(RangeError);
    expect(() => createSummaryAccumulator({ interval: { thrusterId: '', fromTick: 20, toTick: 40 }, initialProp_kg: 24 })).toThrow(RangeError);
    expect(() => createSummaryAccumulator({ interval: INTERVAL, initialProp_kg: -1 })).toThrow(RangeError);
  });
});
