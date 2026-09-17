/**
 * Incremental run summary for the distributed GNC Monte Carlo (F_0.19.0 B2).
 *
 * A pure fold `DemoRecord → RunSummary` with no retained records: create an
 * accumulator, `push` every FSW-window record in tick order, then `finish`
 * with the terminal facts the records cannot carry (the runner's final tick
 * and the truth-privileged final state). Both demonstration cases produce the
 * same `interval` block over the manifest's comparison interval, which is
 * what makes paired interval deltas field-for-field comparisons.
 */
import type { DockingTelemetry, TelemetryFrame, TruthState, Vec3 } from '@docking/sim-core';
import type { DemoRecord } from '../session/demoRun';
import { TRUTH_TICKS_PER_FSW_WINDOW, type ComparisonInterval } from './manifest';

export type RunOutcome = 'DOCKED' | 'ABORT' | 'COLLISION' | 'TIMEOUT';

/**
 * Ten summed 10 ms truth slices give 0.9999999999999999, so a full window is
 * anything within 1e-12 of 1. A literal `=== 1` would count zero windows.
 */
export const FULL_DUTY_THRESHOLD = 1 - 1e-12;

export function isFullDuty(duty: number | undefined): boolean {
  return duty !== undefined && duty >= FULL_DUTY_THRESHOLD;
}

export interface IntervalSummary {
  fromTick: number;
  toTick: number;
  thrusterId: string;
  /** Records seen with `fromTick <= tick <= toTick`. */
  windows: number;
  /** True when every window boundary of the interval was recorded, i.e. the run did not end inside it. */
  complete: boolean;
  peakBodyRate_dps: number;
  satFrames: number;
  corridorCautionFrames: number;
  corridorViolationFrames: number;
  /** Windows whose truth-applied duty for `thrusterId` was full (privileged). */
  appliedFullDutyWindows: number;
  /** Windows whose FSW-commanded duty for `thrusterId` was full. */
  commandedFullDutyWindows: number;
}

export interface RunSummary {
  outcome: RunOutcome;
  /** Tick of the frame that latched the outcome, or the runner's final tick for TIMEOUT. */
  outcomeTick: number;
  frames: number;
  /** Initial propellant minus the last telemetry `prop_kg` (sim-core publishes the truth tank there). */
  propUsed_kg: number;
  /** Peak of the estimated body rate published in telemetry, not the truth rate. */
  peakBodyRate_dps: number;
  satFrames: number;
  mpcFallbackFrames: number;
  corridorCautionFrames: number;
  corridorViolationFrames: number;
  lastAbortState: TelemetryFrame['abort'];
  /** Docking telemetry of the final frame; null when the final frame carried none. */
  lastDocking: DockingTelemetry | null;
  interval: IntervalSummary;
  /** Truth-privileged final state for evidence and comparison only. */
  truth: { r_hill_m: Vec3; v_hill_mps: Vec3; prop_kg: number };
}

export interface SummaryAccumulatorOptions {
  interval: ComparisonInterval;
  /** Propellant at t = 0, from the case configuration. */
  initialProp_kg: number;
}

export interface RunTerminal {
  /** The runner's truth tick when it stopped (outcome latch or hard cap). */
  finalTick: number;
  truth: TruthState;
}

export interface SummaryAccumulator {
  readonly frames: number;
  push(record: DemoRecord): void;
  finish(terminal: RunTerminal): RunSummary;
}

/** Number of window boundaries in an inclusive, window-aligned interval. */
export function intervalWindowCount(interval: ComparisonInterval): number {
  return (interval.toTick - interval.fromTick) / TRUTH_TICKS_PER_FSW_WINDOW + 1;
}

function validateInterval(interval: ComparisonInterval): void {
  const aligned = (tick: number) => Number.isInteger(tick) && tick > 0 && tick % TRUTH_TICKS_PER_FSW_WINDOW === 0;
  if (!aligned(interval.fromTick) || !aligned(interval.toTick) || interval.fromTick > interval.toTick) {
    throw new RangeError('comparison interval must be window-aligned positive ticks with fromTick <= toTick');
  }
  if (typeof interval.thrusterId !== 'string' || interval.thrusterId.length === 0) throw new RangeError('comparison interval must name a thruster');
}

/** Create a fresh accumulator; one per run, never shared. */
export function createSummaryAccumulator(options: SummaryAccumulatorOptions): SummaryAccumulator {
  validateInterval(options.interval);
  if (!Number.isFinite(options.initialProp_kg) || options.initialProp_kg < 0) throw new RangeError('initialProp_kg must be finite and non-negative');
  const { interval } = options;
  const expectedWindows = intervalWindowCount(interval);

  let frames = 0;
  let lastTick: number | null = null;
  let lastFrame: TelemetryFrame | null = null;
  let latchedOutcome: { outcome: Exclude<RunOutcome, 'TIMEOUT'>; tick: number } | null = null;
  let peakBodyRate_dps = 0;
  let satFrames = 0;
  let mpcFallbackFrames = 0;
  let corridorCautionFrames = 0;
  let corridorViolationFrames = 0;
  const inInterval = {
    windows: 0,
    peakBodyRate_dps: 0,
    satFrames: 0,
    corridorCautionFrames: 0,
    corridorViolationFrames: 0,
    appliedFullDutyWindows: 0,
    commandedFullDutyWindows: 0,
  };
  let finished = false;

  return {
    get frames() { return frames; },
    push(record) {
      if (finished) throw new RangeError('accumulator already finished');
      if (!Number.isInteger(record.tick) || (lastTick !== null && record.tick <= lastTick)) {
        throw new RangeError(`records must arrive in strictly increasing integer tick order (got ${record.tick} after ${lastTick})`);
      }
      if (latchedOutcome !== null) throw new RangeError(`record at tick ${record.tick} arrived after the outcome latched at tick ${latchedOutcome.tick}`);
      const { frame } = record;
      if (!Number.isFinite(frame.body_rate_dps) || !Number.isFinite(frame.prop_kg)) throw new RangeError(`non-finite telemetry at tick ${record.tick}`);
      frames += 1;
      lastTick = record.tick;
      lastFrame = frame;
      peakBodyRate_dps = Math.max(peakBodyRate_dps, frame.body_rate_dps);
      if (frame.sat_flag) satFrames += 1;
      if (frame.mpc_fallback) mpcFallbackFrames += 1;
      if (frame.corridor_level === 'CAUTION') corridorCautionFrames += 1;
      if (frame.corridor_level === 'VIOLATION') corridorViolationFrames += 1;
      if (record.tick >= interval.fromTick && record.tick <= interval.toTick) {
        inInterval.windows += 1;
        inInterval.peakBodyRate_dps = Math.max(inInterval.peakBodyRate_dps, frame.body_rate_dps);
        if (frame.sat_flag) inInterval.satFrames += 1;
        if (frame.corridor_level === 'CAUTION') inInterval.corridorCautionFrames += 1;
        if (frame.corridor_level === 'VIOLATION') inInterval.corridorViolationFrames += 1;
        if (isFullDuty(record.appliedDuty[interval.thrusterId])) inInterval.appliedFullDutyWindows += 1;
        if (isFullDuty(frame.thruster_duty[interval.thrusterId])) inInterval.commandedFullDutyWindows += 1;
      }
      if (frame.outcome !== 'NONE') latchedOutcome = { outcome: frame.outcome, tick: record.tick };
    },
    finish(terminal) {
      if (finished) throw new RangeError('accumulator already finished');
      if (lastFrame === null || lastTick === null) {
        throw new RangeError('a run summary needs at least one FSW record; a run that produced no frame has no telemetry to summarise');
      }
      if (!Number.isInteger(terminal.finalTick) || terminal.finalTick < lastTick) {
        throw new RangeError(`finalTick ${terminal.finalTick} must be an integer at or after the last record tick ${lastTick}`);
      }
      finished = true;
      return {
        outcome: latchedOutcome?.outcome ?? 'TIMEOUT',
        outcomeTick: latchedOutcome?.tick ?? terminal.finalTick,
        frames,
        propUsed_kg: options.initialProp_kg - lastFrame.prop_kg,
        peakBodyRate_dps,
        satFrames,
        mpcFallbackFrames,
        corridorCautionFrames,
        corridorViolationFrames,
        lastAbortState: lastFrame.abort,
        lastDocking: lastFrame.docking === null ? null : { ...lastFrame.docking },
        interval: {
          fromTick: interval.fromTick,
          toTick: interval.toTick,
          thrusterId: interval.thrusterId,
          windows: inInterval.windows,
          complete: inInterval.windows === expectedWindows,
          peakBodyRate_dps: inInterval.peakBodyRate_dps,
          satFrames: inInterval.satFrames,
          corridorCautionFrames: inInterval.corridorCautionFrames,
          corridorViolationFrames: inInterval.corridorViolationFrames,
          appliedFullDutyWindows: inInterval.appliedFullDutyWindows,
          commandedFullDutyWindows: inInterval.commandedFullDutyWindows,
        },
        truth: {
          r_hill_m: [...terminal.truth.r_hill_m],
          v_hill_mps: [...terminal.truth.v_hill_mps],
          prop_kg: terminal.truth.prop_kg,
        },
      };
    },
  };
}

/** Convenience for callers that already hold every record. */
export function summarizeRecords(
  records: readonly DemoRecord[],
  options: SummaryAccumulatorOptions,
  terminal: RunTerminal,
): RunSummary {
  const accumulator = createSummaryAccumulator(options);
  for (const record of records) accumulator.push(record);
  return accumulator.finish(terminal);
}
