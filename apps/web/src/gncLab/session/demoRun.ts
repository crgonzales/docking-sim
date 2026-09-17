/**
 * GNC demonstration cases and a deterministic headless runner (F_0.16.0 B0).
 *
 * Every case is a pure function of (config, seed, schedule). Commands are
 * scheduled on integer truth ticks and reach the simulation only through the
 * public `SimLoop` command surface. The runner partitions every advance at
 * scheduled ticks and at FSW window boundaries, so the tick at which a command
 * is applied never depends on how much sim time a caller asks for per call.
 *
 * Truth-privileged data (`RenderState.thruster_duty`, `TruthState`) is exposed
 * for comparison and evidence only; the flight software never sees it.
 */
import {
  CREW_DRAGON_THRUSTERS,
  DRACO_THRUSTER_SPECS,
  FSW_HZ,
  TRUTH_HZ,
  createSimLoop,
  type SimConfig,
  type SimLoop,
  type SimOutcome,
  type TelemetryFrame,
  type TruthState,
} from '@docking/sim-core';

export type GncCaseId = 'NOMINAL' | 'RCS_STUCK_OPEN';

/** Which jet table the case flies. `SYNTHETIC_DRACO` is the sim-core default four-corner layout. */
export type DemoGeometry = 'CREW_DRAGON' | 'SYNTHETIC_DRACO';

export type DemoCommand =
  | { kind: 'INJECT_THRUSTER_STUCK'; thrusterId: string; state: 'OPEN' | 'CLOSED' }
  | { kind: 'ISOLATE_THRUSTER'; thrusterId: string };

export interface ScheduledCommand {
  /** Integer truth tick (100 Hz) at which the command is applied, before the next truth step. */
  tick: number;
  command: DemoCommand;
}

export interface GncCase {
  id: GncCaseId;
  label: string;
  geometry: DemoGeometry;
  config: SimConfig;
  seed: number;
  /** Hard stop for the run, in truth ticks. */
  maxTicks: number;
  schedule: readonly ScheduledCommand[];
  /**
   * What the headless oracle establishes for this case; not a promise about
   * other seeds or timings. `outcome` is optional: absent means no outcome
   * assertion; present means the oracle asserts it, including a genuine `'NONE'`
   * (the run reached `maxTicks` with nothing latched).
   */
  expected: { outcome?: SimOutcome; note: string };
}

/**
 * One FSW window boundary as recorded by the runner.
 *
 * At boundary tick N the simulation first latches the truth duty accumulated
 * over the PRECEDING window (N−10, N], then runs the FSW, whose command applies
 * to the NEXT window (N, N+10]. The two duty vectors below therefore describe
 * adjacent windows, not the same one. Nothing here shifts either of them.
 */
export interface DemoRecord {
  /** Truth tick at which the FSW frame was produced (a multiple of the window length). */
  tick: number;
  t_s: number;
  /** FSW telemetry. `frame.thruster_duty` is the command for the window that starts at `tick`. */
  frame: TelemetryFrame;
  /** Truth-side applied duty for the window that ends at `tick` (`RenderState.thruster_duty`). */
  appliedDuty: Record<string, number>;
}

export interface AppliedCommand {
  tick: number;
  command: DemoCommand;
}

export interface DemoRun {
  readonly gncCase: GncCase;
  /** Current truth tick. */
  readonly tick: number;
  readonly outcome: SimOutcome;
  readonly records: readonly DemoRecord[];
  readonly appliedCommands: readonly AppliedCommand[];
  /**
   * Advance to an absolute truth tick, clamped to `maxTicks`, stopping early
   * once an outcome latches. A target behind the current tick is rejected.
   * Returns the records produced by this call.
   */
  advanceTo(targetTick: number): DemoRecord[];
  /** Advance by a relative number of truth ticks, clamped to `maxTicks`. */
  advance(deltaTicks: number): DemoRecord[];
  /** Run to `maxTicks` or the first latched outcome. */
  advanceToEnd(): DemoRecord[];
  /** Truth-privileged comparison channel. Never feed this to anything the FSW reads. */
  getTruthState(): TruthState;
}

/**
 * The single optional options object of `createDemoRun`. F_0.19 (Monte Carlo)
 * owns `retainRecords` and `onRecord`; F_0.16 B4 owns `createLoop`.
 * Every field is optional and every default reproduces the original behaviour.
 */
export interface DemoRunOptions {
  /** Synchronously create the one loop stepped by this runner (default createSimLoop). */
  createLoop?: (config: SimConfig, seed: number) => SimLoop;
  /**
   * Keep every record in `records` and return them from `advance*` (default
   * true). When false both stay empty; `onRecord` is then the only output
   * channel, so a long run holds no telemetry in memory.
   */
  retainRecords?: boolean;
  /** Called once per record, in tick order, in both modes. */
  onRecord?: (record: DemoRecord) => void;
}

export const TRUTH_TICKS_PER_FSW_WINDOW = TRUTH_HZ / FSW_HZ;

export function ticksToSeconds(tick: number): number {
  return tick / TRUTH_HZ;
}

export function secondsToTicks(t_s: number): number {
  return Math.round(t_s * TRUTH_HZ);
}

/** Seed of the verified headline oracle (`packages/sim-core/src/sim.test.ts`). */
export const DEMO_SEED = 1004;

const HEADLINE_INITIAL_STATE: [number, number, number, number, number, number] = [0, -250, 12, 0, 0.1, 0];

function diagonal(values: number[]): number[][] {
  return values.map((value, row) => values.map((_, column) => (row === column ? value : 0)));
}

/**
 * The verified headline configuration: 250 m behind on V-bar, 12 m cross-track,
 * MPC with a 10-step horizon targeting the docked COM at y = −10.4 m. Sensor
 * noise sigmas are the sim-core defaults unless `noiseless` is requested; the
 * sim-core oracle itself runs noiseless.
 */
export function buildDemoConfig(geometry: DemoGeometry, options: { noiseless?: boolean } = {}): SimConfig {
  const specs = geometry === 'CREW_DRAGON' ? CREW_DRAGON_THRUSTERS : DRACO_THRUSTER_SPECS;
  return {
    thrusters: { specs },
    initial: {
      r_hill_m: [0, -250, 12],
      v_hill_mps: [0, 0.1, 0],
      prop_kg: 24,
      q_BI: [1, 0, 0, 0],
    },
    fsw: {
      controller: 'MPC',
      massModel: { dryMass_kg: 976, initialProp_kg: 24 },
      guidanceConfig: { initialState: [...HEADLINE_INITIAL_STATE] },
      ekfConfig: {
        initialNavPrior: {
          state: [...HEADLINE_INITIAL_STATE],
          covariance: diagonal([10_000, 10_000, 10_000, 10, 10, 10]),
        },
      },
      allocatorConfig: { fswHz: FSW_HZ, truthHz: TRUTH_HZ },
      mpcConfig: {
        horizonSteps: 10,
        maxIterations: 250,
        terminalTarget_hill_m: [0, -10.4, 0],
      },
    },
    ...(options.noiseless
      ? {
          sensors: {
            range_sigma_floor_m: 0,
            range_sigma_scale: 0,
            bearing_sigma_rad: 0,
            gyro_sigma_rps: 0,
            attitude_sigma_rad: 0,
          },
        }
      : {}),
  };
}

/** Geometry the demonstration flies. Chosen by the B0 headless oracle; see `.evidence.local/gnc-study/b0-report.md`. */
export const DEMO_GEOMETRY: DemoGeometry = 'CREW_DRAGON';

/** Upper bound on the headline run: the sim-core oracle steps to 1200 s. */
export const DEMO_MAX_TICKS = secondsToTicks(1200);

export const FAULT_THRUSTER_ID = 'J6';
/** Truth tick at which J6 is latched open in the truth-side jet state map. */
export const FAULT_STUCK_OPEN_TICK = secondsToTicks(300);
/** Truth tick at which the operator isolates J6; nothing in the FSW does this on its own. */
export const FAULT_ISOLATE_TICK = secondsToTicks(340);

export const NOMINAL_CASE: GncCase = {
  id: 'NOMINAL',
  label: 'Nominal MPC approach',
  geometry: DEMO_GEOMETRY,
  config: buildDemoConfig(DEMO_GEOMETRY),
  seed: DEMO_SEED,
  maxTicks: DEMO_MAX_TICKS,
  schedule: [],
  expected: { outcome: 'DOCKED', note: 'Headline configuration with default sensor noise; verified by demoRun.test.ts.' },
};

export const RCS_STUCK_OPEN_CASE: GncCase = {
  id: 'RCS_STUCK_OPEN',
  label: 'RCS J6 stuck open, operator isolation',
  geometry: DEMO_GEOMETRY,
  config: buildDemoConfig(DEMO_GEOMETRY),
  seed: DEMO_SEED,
  maxTicks: DEMO_MAX_TICKS,
  schedule: [
    { tick: FAULT_STUCK_OPEN_TICK, command: { kind: 'INJECT_THRUSTER_STUCK', thrusterId: FAULT_THRUSTER_ID, state: 'OPEN' } },
    { tick: FAULT_ISOLATE_TICK, command: { kind: 'ISOLATE_THRUSTER', thrusterId: FAULT_THRUSTER_ID } },
  ],
  expected: {
    outcome: 'ABORT',
    note: 'Measured result of the scripted 340 s isolation at seed 1004 (passive abort at 359.1 s, '
      + '.evidence.local/gnc-study/b0-report.md §6); not a promise for other isolation times or seeds.',
  },
};

export const DEMO_CASES: readonly GncCase[] = [NOMINAL_CASE, RCS_STUCK_OPEN_CASE];

function validateSchedule(schedule: readonly ScheduledCommand[]): ScheduledCommand[] {
  schedule.forEach((entry) => {
    if (!Number.isInteger(entry.tick) || entry.tick < 0) throw new RangeError('scheduled command ticks must be non-negative integers');
  });
  // Stable sort: commands sharing a tick keep their declaration order.
  return schedule.map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.tick - b.entry.tick || a.index - b.index)
    .map(({ entry }) => ({ tick: entry.tick, command: { ...entry.command } }));
}

function applyCommand(sim: SimLoop, command: DemoCommand): void {
  switch (command.kind) {
    case 'INJECT_THRUSTER_STUCK':
      sim.injectThrusterStuck(command.thrusterId, command.state);
      return;
    case 'ISOLATE_THRUSTER':
      sim.isolateThruster(command.thrusterId);
      return;
  }
}

/** Create a deterministic headless run of one case. */
export function createDemoRun(gncCase: GncCase, options: DemoRunOptions = {}): DemoRun {
  if (!Number.isInteger(gncCase.maxTicks) || gncCase.maxTicks <= 0) throw new RangeError('maxTicks must be a positive integer');
  if ((gncCase.config.initial.t_s ?? 0) !== 0) throw new RangeError('demo cases start at t = 0 so ticks and windows align');
  const retainRecords = options.retainRecords ?? true;
  const onRecord = options.onRecord;
  const sim = (options.createLoop ?? createSimLoop)(gncCase.config, gncCase.seed);
  const pending = validateSchedule(gncCase.schedule);
  const records: DemoRecord[] = [];
  const appliedCommands: AppliedCommand[] = [];
  let tick = 0;
  let outcome: SimOutcome = 'NONE';

  const applyDue = (): void => {
    while (pending.length > 0 && pending[0]!.tick === tick) {
      const next = pending.shift()!;
      applyCommand(sim, next.command);
      appliedCommands.push({ tick, command: { ...next.command } });
    }
  };

  const advanceTo = (targetTick: number): DemoRecord[] => {
    if (!Number.isInteger(targetTick) || targetTick < tick) throw new RangeError('target tick must be an integer at or after the current tick');
    // Hard stop: never integrate past the case's declared bound, even when the
    // caller asks for more. A partial final window produces no FSW frame.
    const cappedTarget = Math.min(targetTick, gncCase.maxTicks);
    const produced: DemoRecord[] = [];
    applyDue();
    while (tick < cappedTarget && outcome === 'NONE') {
      const nextEvent = pending.length > 0 ? pending[0]!.tick : Number.POSITIVE_INFINITY;
      const nextWindow = tick + (TRUTH_TICKS_PER_FSW_WINDOW - (tick % TRUTH_TICKS_PER_FSW_WINDOW));
      const segmentEnd = Math.min(cappedTarget, nextEvent, nextWindow);
      const frames = sim.stepTo(ticksToSeconds(segmentEnd));
      tick = segmentEnd;
      const truthTick = Math.round(sim.getTruthState().t_s * TRUTH_HZ);
      if (truthTick !== tick) throw new Error(`runner tick ${tick} disagrees with truth tick ${truthTick}`);
      // A segment never spans more than one FSW window, so the latched render
      // duty belongs to the frame (if any) this segment produced.
      const appliedDuty = { ...sim.getRenderState().thruster_duty };
      for (const frame of frames) {
        const record: DemoRecord = { tick, t_s: frame.t_s, frame, appliedDuty };
        if (retainRecords) {
          records.push(record);
          produced.push(record);
        }
        onRecord?.(record);
        if (frame.outcome !== 'NONE') outcome = frame.outcome;
      }
      applyDue();
    }
    return produced;
  };

  return {
    gncCase,
    get tick() { return tick; },
    get outcome() { return outcome; },
    records,
    appliedCommands,
    advanceTo,
    advance(deltaTicks) {
      if (!Number.isInteger(deltaTicks) || deltaTicks < 0) throw new RangeError('deltaTicks must be a non-negative integer');
      return advanceTo(tick + deltaTicks);
    },
    advanceToEnd() {
      return advanceTo(gncCase.maxTicks);
    },
    getTruthState() {
      return sim.getTruthState();
    },
  };
}

/** Euclidean distance between two truth positions, for divergence evidence. */
export function truthSeparation_m(a: TruthState, b: TruthState): number {
  return Math.hypot(
    a.r_hill_m[0] - b.r_hill_m[0],
    a.r_hill_m[1] - b.r_hill_m[1],
    a.r_hill_m[2] - b.r_hill_m[2],
  );
}
