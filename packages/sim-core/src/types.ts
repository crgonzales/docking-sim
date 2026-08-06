/**
 * Core state and interface types. Conventions (authoritative: docs/ARCHI.md):
 * - Hill/LVLH frame: x radial outward, y along-track (+velocity), z = x cross y.
 * - Quaternions: Hamilton convention, scalar-first [w, x, y, z], unit norm.
 *   q_BI rotates vectors from inertial (I) to body (B).
 * - SI units, sim-time seconds.
 */
export type Vec3 = [number, number, number];
/** Scalar-first unit quaternion [w, x, y, z]. */
export type Quat = [number, number, number, number];

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
  attitude_q_BI: Quat | null;
}

/** Commanded on-time per thruster for the next FSW tick, seconds. */
export type ThrusterCommand = Record<string, number>;

/** The single FSW entry point. Pure: sensors in, commands + telemetry out. */
export interface FswTick {
  (sensors: SensorFrame): { thrusters: ThrusterCommand; telemetry: TelemetryFrame };
}

/** What the UI, scenario director, and Monte Carlo harness observe. */
export interface TelemetryFrame {
  t_s: number;
  nav_r_hill_m: Vec3;
  nav_cov_pos_m2: Vec3;
  nees: number | null;
  corridor_err_m: number | null;
  controller: 'PID' | 'LQR' | 'MPC';
  control_mode: 'AUTO' | 'MANUAL';
}
