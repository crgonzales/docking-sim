/**
 * Core state and interface types. Conventions (authoritative: docs/ARCHI.md):
 * - Hill/LVLH frame: x radial outward, y along-track (+velocity), z = x cross y.
 * - Quaternions: Hamilton convention, scalar-first [w, x, y, z], unit norm.
 *   q_BI rotates vectors from inertial (I) to body (B).
 * - SI units, sim-time seconds.
 */
import type { NavDiag } from './ekf.js';
import type { AttDiag } from './mekf.js';
import type { AbortState } from './monitors.js';

export type { NavDiag } from './ekf.js';
export type { AttDiag } from './mekf.js';
export type Vec3 = [number, number, number];
/** Scalar-first unit quaternion [w, x, y, z]. */
export type Quat = [number, number, number, number];

export type ControlMode = 'AUTO' | 'MANUAL';
export type ManualSubMode = 'RATE' | 'PULSE';

export interface ManualCommand {
  translation: Vec3;
  rotation: Vec3;
}

/** Truth-privileged pose channel for rendering, separate from navigation telemetry. */
export interface RenderState {
  t_s: number;
  r_hill_m: Vec3;
  v_hill_mps: Vec3;
  /** q_BH rotates Hill vectors into body axes. */
  q_BH: Quat;
}

export interface DockingTelemetry {
  closing_mps: number;
  lateral_m: number;
  misalign_deg: number;
  rate_dps: number;
}

/** Truth state of the chaser relative to the target (Hill frame + attitude). */
export interface TruthState {
  t_s: number;
  r_hill_m: Vec3;
  v_hill_mps: Vec3;
  q_BI: Quat;
  w_body_rps: Vec3;
  prop_kg: number;
}

/** One sensor sample as seen by flight software. FSW never sees TruthState. */
export interface SensorFrame {
  t_s: number;
  range_m: number | null;
  bearing_body_rad: [number, number] | null;
  gyro_rps: Vec3;
  /** Star-tracker quaternion, rotating inertial-frame vectors into body axes. */
  star_tracker_q_BI?: Quat | null;
  /** @deprecated Use star_tracker_q_BI. */
  attitude_q_BI?: Quat | null;
}

/** Commanded on-time per thruster for the next FSW tick, seconds. */
export type ThrusterCommand = Record<string, number>;

/** The single FSW entry point. Pure: sensors in, commands + telemetry out. */
export interface FswTick {
  (sensors: SensorFrame): { thrusters: ThrusterCommand; telemetry: TelemetryFrame; nav_diag: NavDiag; att_diag: AttDiag; abort: boolean; abort_state: AbortState };
  setController(controller: 'PID' | 'LQR' | 'MPC'): void;
  setJetAvailability(id: string, available: boolean): void;
  setControlMode(mode: ControlMode): void;
  setManualSubMode(mode: ManualSubMode): void;
  setManualCommand(command: ManualCommand): void;
  commandAbort(): void;
}

/** What the UI, scenario director, and Monte Carlo harness observe. */
export interface TelemetryFrame {
  t_s: number;
  nav_r_hill_m: Vec3;
  nav_cov_pos_m2: Vec3;
  nees: number | null;
  corridor_err_m: number | null;
  controller: 'PID' | 'LQR' | 'MPC';
  mpc_fallback: boolean;
  outcome: 'NONE' | 'DOCKED' | 'COLLISION' | 'ABORT';
  abort: AbortState;
  control_mode: 'AUTO' | 'MANUAL';
  prop_kg: number;
  thruster_duty: Record<string, number>;
  sat_flag: boolean;
  q_BH_est: Quat;
  body_rate_dps_est: Vec3;
  att_sigma_deg: number;
  manual_sub_mode: ManualSubMode | null;
  docking: DockingTelemetry | null;
  att_nees: number | null;
}
