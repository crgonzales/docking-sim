import type { FlightControls, FlightState } from '@docking/sim-core';

export type FlightExerciseId = 'TURN_RIGHT' | 'CLIMB' | 'DESCENT' | 'CLOUD_CLIMB' | 'LOW_DESCENT';
export type FlightExercisePhase = 'IDLE' | 'RUNNING' | 'COMPLETED' | 'STOPPED' | 'CANCELLED' | 'TERMINAL';

export interface FlightExerciseSnapshot {
  id: FlightExerciseId | null;
  phase: FlightExercisePhase;
  elapsed_s: number;
  duration_s: number;
  progress: number;
  terminalStatus?: FlightState['status'];
}

interface FlightExerciseDefinition {
  id: FlightExerciseId;
  label: string;
  description: string;
  duration_s: number;
  sample: (time_s: number, baseline: FlightControls) => FlightControls;
}

export const FLIGHT_EXERCISES: readonly FlightExerciseDefinition[] = [
  {
    id: 'TURN_RIGHT', label: 'Turn right', description: 'Bank and hold a short right-hand turn.', duration_s: 6,
    sample: (time_s, baseline) => ({ ...baseline, roll: phaseHold(time_s, 0.7, 0.8, 3.7, 4.7), yaw: phaseHold(time_s, 0.18, 0.7, 3.9, 4.8), pitch: 0.08 }),
  },
  {
    id: 'CLIMB', label: 'Climb', description: 'Raise the nose briefly, then settle back to trim.', duration_s: 5,
    sample: (time_s, baseline) => ({ ...baseline, pitch: phaseHold(time_s, 0.34, 0.7, 3.4, 4.6), throttle: baseline.throttle + phaseHold(time_s, 0.06, 0.7, 3.2, 4.6) }),
  },
  {
    id: 'DESCENT', label: 'Descent', description: 'Lower the nose briefly, then settle back to trim.', duration_s: 5,
    sample: (time_s, baseline) => ({ ...baseline, pitch: phaseHold(time_s, -0.3, 0.7, 3.4, 4.6), throttle: baseline.throttle + phaseHold(time_s, -0.04, 0.7, 3.2, 4.6) }),
  },
  {
    id: 'CLOUD_CLIMB', label: 'Cloud climb', description: 'Sustained climb through cloud altitude.', duration_s: 75,
    sample: (time_s, baseline) => ({ ...baseline, pitch: phaseHold(time_s, 0.22, 1, 5, 7), throttle: 0.4 }),
  },
  {
    id: 'LOW_DESCENT', label: 'Low descent', description: 'Sustained descent toward the sea; contact stops the run.', duration_s: 50,
    sample: (time_s, baseline) => ({ ...baseline, pitch: -0.04 + phaseHold(time_s, -0.14, 1, 5, 7), throttle: 0.08 }),
  },
];

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));
const smoothstep = (value: number) => value * value * (3 - 2 * value);

function phaseHold(time_s: number, value: number, rampIn_s: number, holdUntil_s: number, rampOutUntil_s: number): number {
  if (time_s <= 0) return 0;
  if (time_s < rampIn_s) return value * smoothstep(time_s / rampIn_s);
  if (time_s <= holdUntil_s) return value;
  if (time_s < rampOutUntil_s) return value * (1 - smoothstep((time_s - holdUntil_s) / (rampOutUntil_s - holdUntil_s)));
  return 0;
}

function definitionFor(id: FlightExerciseId): FlightExerciseDefinition {
  const definition = FLIGHT_EXERCISES.find((candidate) => candidate.id === id);
  if (!definition) throw new RangeError(`unknown flight exercise: ${id}`);
  return definition;
}

export function flightExerciseLabel(id: FlightExerciseId): string {
  return definitionFor(id).label;
}

export function idleFlightExercise(): FlightExerciseSnapshot {
  return { id: null, phase: 'IDLE', elapsed_s: 0, duration_s: 0, progress: 0 };
}

/** Fixed-step scripted controls. It never changes flight state or physical input ownership. */
export class FlightExerciseRun {
  readonly definition: FlightExerciseDefinition;
  private elapsed = 0;

  constructor(id: FlightExerciseId, private readonly baseline: FlightControls) {
    this.definition = definitionFor(id);
  }

  sample(): FlightControls {
    const controls = this.definition.sample(this.elapsed, this.baseline);
    return {
      ...controls,
      pitch: clamp(controls.pitch, -1, 1), roll: clamp(controls.roll, -1, 1), yaw: clamp(controls.yaw, -1, 1),
      throttle: clamp(controls.throttle, 0, 1), trim: clamp(controls.trim, -1, 1),
    };
  }

  advance(dt_s: number): void {
    if (!Number.isFinite(dt_s) || dt_s < 0) throw new RangeError('exercise step must be finite and nonnegative');
    this.elapsed = Math.min(this.definition.duration_s, this.elapsed + dt_s);
    if (this.definition.duration_s - this.elapsed < 1e-9) this.elapsed = this.definition.duration_s;
  }

  get complete(): boolean { return this.elapsed >= this.definition.duration_s; }

  snapshot(phase: Exclude<FlightExercisePhase, 'IDLE'> = 'RUNNING', terminalStatus?: FlightState['status']): FlightExerciseSnapshot {
    return {
      id: this.definition.id, phase, elapsed_s: this.elapsed, duration_s: this.definition.duration_s,
      progress: this.elapsed / this.definition.duration_s, ...(terminalStatus ? { terminalStatus } : {}),
    };
  }
}
