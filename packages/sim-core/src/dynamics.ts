import { MU_EARTH_M3_S2, R_EARTH_M, TRUTH_HZ } from './constants.js';
import type { Quat, TruthState, Vec3 } from './types.js';

/** Circular target-orbit radius used by the Phase 2 truth model. */
export const ORBIT_RADIUS_M = R_EARTH_M + 400_000;
/** Mean motion of the circular target orbit, in rad/s. */
export const MEAN_MOTION_RAD_S = Math.sqrt(MU_EARTH_M3_S2 / ORBIT_RADIUS_M ** 3);
export const DEFAULT_TRUTH_DT_S = 1 / TRUTH_HZ;

export type SpecificForce = Vec3 | ((t_s: number, r_hill_m: Vec3, v_hill_mps: Vec3) => Vec3);

export interface TruthStepOptions {
  dt_s?: number;
  meanMotionRadS?: number;
  externalSpecificForce_hill_mps2?: SpecificForce;
  propellantRate_kg_s?: number;
}

export interface TruthDynamics {
  readonly dt_s: number;
  readonly meanMotionRadS: number;
  step(state: TruthState, options?: Omit<TruthStepOptions, 'dt_s' | 'meanMotionRadS'>): TruthState;
}

interface Derivative {
  rDot: Vec3;
  vDot: Vec3;
}

function forceAt(
  force: SpecificForce | undefined,
  t_s: number,
  r_hill_m: Vec3,
  v_hill_mps: Vec3,
): Vec3 {
  return typeof force === 'function' ? force(t_s, r_hill_m, v_hill_mps) : (force ?? [0, 0, 0]);
}

/** CW translational ODE with an additive external specific force in Hill axes. */
export function cwDerivative(
  t_s: number,
  r_hill_m: Vec3,
  v_hill_mps: Vec3,
  meanMotionRadS = MEAN_MOTION_RAD_S,
  externalSpecificForce_hill_mps2?: SpecificForce,
): Derivative {
  const [x, , z] = r_hill_m;
  const [vx, vy, vz] = v_hill_mps;
  const [fx, fy, fz] = forceAt(
    externalSpecificForce_hill_mps2,
    t_s,
    r_hill_m,
    v_hill_mps,
  );
  const n2 = meanMotionRadS * meanMotionRadS;

  return {
    rDot: [...v_hill_mps],
    vDot: [3 * n2 * x + 2 * meanMotionRadS * vy + fx,
      -2 * meanMotionRadS * vx + fy,
      -n2 * z + fz],
  };
}

function addScaled(a: Vec3, b: Vec3, scale: number): Vec3 {
  return [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
}

function rk4TranslationalStep(
  state: TruthState,
  dt_s: number,
  meanMotionRadS: number,
  externalSpecificForce_hill_mps2?: SpecificForce,
): { r_hill_m: Vec3; v_hill_mps: Vec3 } {
  const k1 = cwDerivative(state.t_s, state.r_hill_m, state.v_hill_mps, meanMotionRadS, externalSpecificForce_hill_mps2);
  const r2 = addScaled(state.r_hill_m, k1.rDot, dt_s / 2);
  const v2 = addScaled(state.v_hill_mps, k1.vDot, dt_s / 2);
  const k2 = cwDerivative(state.t_s + dt_s / 2, r2, v2, meanMotionRadS, externalSpecificForce_hill_mps2);
  const r3 = addScaled(state.r_hill_m, k2.rDot, dt_s / 2);
  const v3 = addScaled(state.v_hill_mps, k2.vDot, dt_s / 2);
  const k3 = cwDerivative(state.t_s + dt_s / 2, r3, v3, meanMotionRadS, externalSpecificForce_hill_mps2);
  const r4 = addScaled(state.r_hill_m, k3.rDot, dt_s);
  const v4 = addScaled(state.v_hill_mps, k3.vDot, dt_s);
  const k4 = cwDerivative(state.t_s + dt_s, r4, v4, meanMotionRadS, externalSpecificForce_hill_mps2);

  const weightedR: Vec3 = [
    (k1.rDot[0] + 2 * k2.rDot[0] + 2 * k3.rDot[0] + k4.rDot[0]) / 6,
    (k1.rDot[1] + 2 * k2.rDot[1] + 2 * k3.rDot[1] + k4.rDot[1]) / 6,
    (k1.rDot[2] + 2 * k2.rDot[2] + 2 * k3.rDot[2] + k4.rDot[2]) / 6,
  ];
  const weightedV: Vec3 = [
    (k1.vDot[0] + 2 * k2.vDot[0] + 2 * k3.vDot[0] + k4.vDot[0]) / 6,
    (k1.vDot[1] + 2 * k2.vDot[1] + 2 * k3.vDot[1] + k4.vDot[1]) / 6,
    (k1.vDot[2] + 2 * k2.vDot[2] + 2 * k3.vDot[2] + k4.vDot[2]) / 6,
  ];
  return {
    r_hill_m: addScaled(state.r_hill_m, weightedR, dt_s),
    v_hill_mps: addScaled(state.v_hill_mps, weightedV, dt_s),
  };
}

function normalizeQuaternion(q: Quat): Quat {
  const norm = Math.hypot(q[0], q[1], q[2], q[3]);
  if (norm === 0) return [1, 0, 0, 0];
  return [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm];
}

/**
 * Propagate the complete truth state by one fixed integration step.
 * q_BI is an inertial-to-body quaternion, hence its kinematic derivative uses
 * the negative body-frame angular rate. The quaternion is advanced exactly for
 * the constant rate and renormalized every tick.
 */
export function stepTruth(state: TruthState, options: TruthStepOptions = {}): TruthState {
  const dt_s = options.dt_s ?? DEFAULT_TRUTH_DT_S;
  const meanMotionRadS = options.meanMotionRadS ?? MEAN_MOTION_RAD_S;
  if (!(dt_s > 0) || !Number.isFinite(dt_s)) throw new RangeError('dt_s must be finite and positive');

  const translation = rk4TranslationalStep(
    state,
    dt_s,
    meanMotionRadS,
    options.externalSpecificForce_hill_mps2,
  );
  const halfAngle = meanMotionRadS * dt_s / 2;
  const c = Math.cos(halfAngle);
  const s = Math.sin(halfAngle);
  const [qw, qx, qy, qz] = state.q_BI;
  // q_next = exp(-omega*dt/2) ⊗ q for q_BI (I -> B).
  const qNext: Quat = normalizeQuaternion([
    c * qw + s * qz,
    c * qx + s * qy,
    c * qy - s * qx,
    c * qz - s * qw,
  ]);
  const propellantRate = Math.max(0, options.propellantRate_kg_s ?? 0);

  return {
    t_s: state.t_s + dt_s,
    r_hill_m: translation.r_hill_m,
    v_hill_mps: translation.v_hill_mps,
    q_BI: qNext,
    w_body_rps: [0, 0, meanMotionRadS],
    prop_kg: Math.max(0, state.prop_kg - propellantRate * dt_s),
  };
}

export function createTruthDynamics(options: TruthStepOptions = {}): TruthDynamics {
  const dt_s = options.dt_s ?? DEFAULT_TRUTH_DT_S;
  const meanMotionRadS = options.meanMotionRadS ?? MEAN_MOTION_RAD_S;
  return {
    dt_s,
    meanMotionRadS,
    step: (state, stepOptions = {}) => stepTruth(state, {
      ...options,
      ...stepOptions,
      dt_s,
      meanMotionRadS,
    }),
  };
}
