/**
 * Trace records for the GNC demonstration (F_0.16.0 B1/B2). Types only, plus a
 * bounded ring helper. Contract: docs/6-memo/gnc-lab-simulink.md §3.1–§3.3.
 *
 * Two clocks with different units, never mixed:
 * - `fswSequence` is the FSW ordinal (1 for the first FSW run, at plant tick 10).
 * - `samplePlantTick` / `plantTick` are truth-tick counts (100 Hz).
 *
 * The FSW-side record is assembled inside fsw.ts from sensor-derived locals
 * only; the plant-side records are assembled by sim.ts (B2) and are the only
 * source of privileged truth and of delivered actuation.
 */
import type { ThrusterAllocation } from './allocator.js';
import type { ManualAuthority, ManualRateReference } from './control.js';
import type { NavDiag } from './ekf.js';
import type { GuidanceReference } from './guidance.js';
import type { AttDiag } from './mekf.js';
import type { AbortState, CorridorMonitorResult } from './monitors.js';
import type { MpcStepResult } from './mpc.js';
import type { SimOutcome } from './sim.js';
import type { ThrusterId, ThrusterState } from './thrusters.js';
import type {
  ControlMode,
  ManualCommand,
  ManualSubMode,
  NavSource,
  Quat,
  SensorFrame,
  TruthState,
  Vec3,
} from './types.js';

/** Which arm of the FSW mode branch produced this tick's command. */
export type FswBranch = 'ABORT_BURN' | 'ABORT_COAST' | 'AUTO' | 'MANUAL_RATE' | 'MANUAL_PULSE';

/** One FSW tick (10 Hz). Built inside fsw.ts from sensor-derived data only. */
export interface FswTraceRecord {
  /** FSW ordinal, 1-based: 1 is the first FSW run, at plant tick 10. */
  fswSequence: number;
  /** Plant tick at which this sample was taken: round(sensor.t_s × truthHz). */
  samplePlantTick: number;
  /** Equals `sensor.t_s`. */
  sampleTime_s: number;
  dt_s: number;
  /** Truth ticks this command governs, as the half-open interval (start, end]. */
  commandInterval_tick: [number, number];
  /** Exactly what the FSW received. MEASUREMENT. */
  sensor: SensorFrame;
  /** ESTIMATE: attitude filter. */
  mekf: AttDiag;
  q_BH: Quat;
  omega_est_body_rps: Vec3;
  /** REFERENCE. `generated` is the unfrozen profile; `reference` is what control used. */
  guidance: { reference: GuidanceReference; frozen: boolean; generated: GuidanceReference };
  /** Previous command's specific force, rotated into Hill, as fed to the EKF. */
  feedforward_specificForce_hill_mps2: Vec3;
  /** ESTIMATE: translational filter. */
  nav: NavDiag;
  corridor: CorridorMonitorResult;
  abort: { state: AbortState; targetVelocity_hill_mps: Vec3; elapsed_s: number };
  mode: {
    control: ControlMode;
    manualSub: ManualSubMode | null;
    controller: 'PID' | 'LQR' | 'MPC';
    authority: ManualAuthority;
    navSource: NavSource;
    branch: FswBranch;
  };
  manual: {
    command: ManualCommand;
    rateReference: ManualRateReference | null;
    forceClamped: boolean;
    forceLimit_N: number;
  };
  mpc: { result: MpcStepResult | null; fallback: boolean; unavailable: boolean };
  /** COMMAND: what the controller demanded. */
  command: { force_hill_N: Vec3; force_body_N: Vec3; torque_body_Nm: Vec3 };
  /** ALLOCATED: the allocator's own model-predicted outcome. Never DELIVERED. */
  allocation: ThrusterAllocation;
  propEstimate_kg: number;
}

/** One 10 ms actuation slice as the plant integrated it. */
export interface PlantSlice {
  onTimes_s: Record<ThrusterId, number>;
  activeOnTime_s: Record<ThrusterId, number>;
  force_body_N: Vec3;
  torque_body_Nm: Vec3;
  specificForce_body_mps2: Vec3;
  propellantUsed_kg: number;
}

/** One completed truth tick (100 Hz). TRUTH-privileged; never reaches the FSW. */
export interface PlantTickRecord {
  /** The tick just completed, 1-based. */
  plantTick: number;
  t_s: number;
  truth: TruthState;
  /** True on the docked early-return path; the slice is then an explicit all-zero record. */
  docked: boolean;
  slice: PlantSlice;
  jetStates: Record<ThrusterId, ThrusterState>;
  outcome: SimOutcome;
  velocityBiasApplied_mps: Vec3 | null;
}

/** One FSW window integrated over all ten slices (10 Hz). The only DELIVERED source. */
export interface PlantWindowRecord {
  /** 1-based window index k; integrates plant ticks 10(k−1)+1 … 10k. */
  windowIndex: number;
  bounds_tick: [number, number];
  bounds_s: [number, number];
  /** FSW ordinal whose held on-times this window executed; null for the bootstrap window 1. */
  sourceFswSequence: number | null;
  sourceSamplePlantTick: number | null;
  /** True when every slice was a docked zero slice. */
  docked: boolean;
  activeTime_s: Record<ThrusterId, number>;
  /** Σ slice.force_body_N × dt, body axes summed per slice (approximate under rotation). */
  impulse_body_Ns: Vec3;
  /** Σ rotate(q_HB(slice), slice.force_body_N × dt) — exact Hill frame. */
  impulse_hill_Ns: Vec3;
  /** Σ slice.torque_body_Nm × dt, body axes summed per slice. */
  angularImpulse_body_Nms: Vec3;
  propellantUsed_kg: number;
  slicesIntegrated: number;
}

/** A window still accumulating: 0–9 slices, `bounds_tick[1]` is the current plant tick. */
export type PendingWindow = PlantWindowRecord;

export interface TraceSink {
  onFsw?: (record: FswTraceRecord) => void;
  onPlantTick?: (record: PlantTickRecord) => void;
  onPlantWindow?: (record: PlantWindowRecord) => void;
}

/** Read-only trace access returned by `createTracedSimLoop` (B2). No mutators. */
export interface TraceSource {
  subscribeFsw(fn: (record: FswTraceRecord) => void): () => void;
  subscribePlantTick(fn: (record: PlantTickRecord) => void): () => void;
  subscribePlantWindow(fn: (record: PlantWindowRecord) => void): () => void;
  /** Null until plant tick 10 (fswSequence 1). */
  latestFsw(): FswTraceRecord | null;
  /** Null until the first truth tick completes. */
  latestPlantTick(): PlantTickRecord | null;
  /** Null until the first flush at plant tick 10. */
  latestPlantWindow(): PlantWindowRecord | null;
  /** Read-only view of the accumulators; 0 slices at construction. */
  pendingWindow(): PendingWindow;
}

export interface TraceRing<T> {
  readonly capacity: number;
  readonly size: number;
  push(item: T): void;
  latest(): T | null;
  /** Oldest to newest. */
  toArray(): T[];
  clear(): void;
}

/** Fixed-capacity ring that drops the oldest item on overflow. */
export function createTraceRing<T>(capacity: number): TraceRing<T> {
  if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError('trace ring capacity must be a positive integer');
  const slots = new Array<T | undefined>(capacity);
  let start = 0;
  let size = 0;
  return {
    capacity,
    get size() { return size; },
    push(item) {
      slots[(start + size) % capacity] = item;
      if (size < capacity) size += 1;
      else start = (start + 1) % capacity;
    },
    latest() {
      return size === 0 ? null : slots[(start + size - 1) % capacity]!;
    },
    toArray() {
      return Array.from({ length: size }, (_, index) => slots[(start + index) % capacity]!);
    },
    clear() {
      slots.fill(undefined);
      start = 0;
      size = 0;
    },
  };
}
