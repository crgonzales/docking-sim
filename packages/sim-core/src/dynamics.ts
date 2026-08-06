import { MU_EARTH_M3_S2, R_EARTH_M, TRUTH_HZ } from './constants.js';
import {
  bodyToHill,
  multiplyQuaternion,
  normalizeQuaternion,
  rotateVector,
} from './attitude.js';
import type { Quat, TruthState, Vec3 } from './types.js';

/** Circular target-orbit radius used by the truth model. */
export const ORBIT_RADIUS_M = R_EARTH_M + 400_000;
/** Mean motion of the circular target orbit, in rad/s. */
export const MEAN_MOTION_RAD_S = Math.sqrt(MU_EARTH_M3_S2 / ORBIT_RADIUS_M ** 3);
export const DEFAULT_TRUTH_DT_S = 1 / TRUTH_HZ;

/** Diagonal body-frame inertia tensor `[Ixx, Iyy, Izz]` in kg·m². */
export type InertiaTensor = Vec3;
export const DEFAULT_INERTIA_KG_M2: InertiaTensor = [600, 400, 600];

/** Body-frame specific force, either constant for the step or state-dependent. */
export type SpecificForce = Vec3 | ((t_s: number, r_hill_m: Vec3, v_hill_mps: Vec3) => Vec3);

export interface TruthStepOptions {
  dt_s?: number;
  meanMotionRadS?: number;
  /** Specific force expressed in body axes; it is rotated body→Hill internally. */
  externalSpecificForce_body_mps2?: SpecificForce;
  /** @deprecated Compatibility alias; this value is also interpreted as body-frame. */
  externalSpecificForce_hill_mps2?: SpecificForce;
  /** Body-frame applied torque in N·m. */
  torque_body_Nm?: Vec3;
  /** Diagonal body inertia `[Ixx, Iyy, Izz]` in kg·m². */
  inertia_kg_m2?: InertiaTensor;
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
  qDot: Quat;
  wDot: Vec3;
}

function addScaled(a: Vec3, b: Vec3, scale: number): Vec3 {
  return [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
}

function addScaledQuat(a: Quat, b: Quat, scale: number): Quat {
  return [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale, a[3] + b[3] * scale];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function forceAt(
  force: SpecificForce | undefined,
  t_s: number,
  r_hill_m: Vec3,
  v_hill_mps: Vec3,
): Vec3 {
  return typeof force === 'function' ? force(t_s, r_hill_m, v_hill_mps) : (force ?? [0, 0, 0]);
}

function validateInertia(inertia: InertiaTensor): void {
  if (inertia.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new RangeError('inertia tensor diagonal must be finite and positive');
  }
}

function validateTorque(torque: Vec3): void {
  if (torque.some((value) => !Number.isFinite(value))) throw new RangeError('torque must be finite');
}

function quaternionDerivative(q_BI: Quat, w_body_rps: Vec3): Quat {
  // q_BI maps inertial→body, so q̇_BI = 1/2·(-ω_body)⊗q_BI.
  return multiplyQuaternion([0, -w_body_rps[0], -w_body_rps[1], -w_body_rps[2]], q_BI)
    .map((value) => value / 2) as Quat;
}

function rotationalDerivative(
  w_body_rps: Vec3,
  torque_body_Nm: Vec3,
  inertia_kg_m2: InertiaTensor,
): Vec3 {
  const angularMomentum_body: Vec3 = [
    inertia_kg_m2[0] * w_body_rps[0],
    inertia_kg_m2[1] * w_body_rps[1],
    inertia_kg_m2[2] * w_body_rps[2],
  ];
  const gyroscopicTerm = cross(w_body_rps, angularMomentum_body);
  return [
    (torque_body_Nm[0] - gyroscopicTerm[0]) / inertia_kg_m2[0],
    (torque_body_Nm[1] - gyroscopicTerm[1]) / inertia_kg_m2[1],
    (torque_body_Nm[2] - gyroscopicTerm[2]) / inertia_kg_m2[2],
  ];
}

function derivativeAt(
  t_s: number,
  r_hill_m: Vec3,
  v_hill_mps: Vec3,
  q_BI: Quat,
  w_body_rps: Vec3,
  meanMotionRadS: number,
  externalSpecificForce_body_mps2: SpecificForce | undefined,
  torque_body_Nm: Vec3,
  inertia_kg_m2: InertiaTensor,
): Derivative {
  const force_body_mps2 = forceAt(externalSpecificForce_body_mps2, t_s, r_hill_m, v_hill_mps);
  const force_hill_mps2 = bodyToHill(q_BI, t_s, meanMotionRadS);
  const force_hill = rotateVector(force_hill_mps2, force_body_mps2);
  const [x, , z] = r_hill_m;
  const [vx, vy] = v_hill_mps;
  const n2 = meanMotionRadS * meanMotionRadS;
  return {
    rDot: [...v_hill_mps],
    vDot: [
      3 * n2 * x + 2 * meanMotionRadS * vy + force_hill[0],
      -2 * meanMotionRadS * vx + force_hill[1],
      -n2 * z + force_hill[2],
    ],
    qDot: quaternionDerivative(q_BI, w_body_rps),
    wDot: rotationalDerivative(w_body_rps, torque_body_Nm, inertia_kg_m2),
  };
}

function rk4TruthStep(
  state: TruthState,
  dt_s: number,
  meanMotionRadS: number,
  externalSpecificForce_body_mps2: SpecificForce | undefined,
  torque_body_Nm: Vec3,
  inertia_kg_m2: InertiaTensor,
): { r_hill_m: Vec3; v_hill_mps: Vec3; q_BI: Quat; w_body_rps: Vec3 } {
  const k1 = derivativeAt(
    state.t_s, state.r_hill_m, state.v_hill_mps, state.q_BI, state.w_body_rps,
    meanMotionRadS, externalSpecificForce_body_mps2, torque_body_Nm, inertia_kg_m2,
  );
  const r2 = addScaled(state.r_hill_m, k1.rDot, dt_s / 2);
  const v2 = addScaled(state.v_hill_mps, k1.vDot, dt_s / 2);
  const q2 = addScaledQuat(state.q_BI, k1.qDot, dt_s / 2);
  const w2 = addScaled(state.w_body_rps, k1.wDot, dt_s / 2);
  const k2 = derivativeAt(
    state.t_s + dt_s / 2, r2, v2, q2, w2,
    meanMotionRadS, externalSpecificForce_body_mps2, torque_body_Nm, inertia_kg_m2,
  );
  const r3 = addScaled(state.r_hill_m, k2.rDot, dt_s / 2);
  const v3 = addScaled(state.v_hill_mps, k2.vDot, dt_s / 2);
  const q3 = addScaledQuat(state.q_BI, k2.qDot, dt_s / 2);
  const w3 = addScaled(state.w_body_rps, k2.wDot, dt_s / 2);
  const k3 = derivativeAt(
    state.t_s + dt_s / 2, r3, v3, q3, w3,
    meanMotionRadS, externalSpecificForce_body_mps2, torque_body_Nm, inertia_kg_m2,
  );
  const r4 = addScaled(state.r_hill_m, k3.rDot, dt_s);
  const v4 = addScaled(state.v_hill_mps, k3.vDot, dt_s);
  const q4 = addScaledQuat(state.q_BI, k3.qDot, dt_s);
  const w4 = addScaled(state.w_body_rps, k3.wDot, dt_s);
  const k4 = derivativeAt(
    state.t_s + dt_s, r4, v4, q4, w4,
    meanMotionRadS, externalSpecificForce_body_mps2, torque_body_Nm, inertia_kg_m2,
  );

  const weighted = (first: Vec3, second: Vec3, third: Vec3, fourth: Vec3): Vec3 => [
    (first[0] + 2 * second[0] + 2 * third[0] + fourth[0]) / 6,
    (first[1] + 2 * second[1] + 2 * third[1] + fourth[1]) / 6,
    (first[2] + 2 * second[2] + 2 * third[2] + fourth[2]) / 6,
  ];
  const weightedR = weighted(k1.rDot, k2.rDot, k3.rDot, k4.rDot);
  const weightedV = weighted(k1.vDot, k2.vDot, k3.vDot, k4.vDot);
  const weightedW = weighted(k1.wDot, k2.wDot, k3.wDot, k4.wDot);
  const weightedQ: Quat = [
    (k1.qDot[0] + 2 * k2.qDot[0] + 2 * k3.qDot[0] + k4.qDot[0]) / 6,
    (k1.qDot[1] + 2 * k2.qDot[1] + 2 * k3.qDot[1] + k4.qDot[1]) / 6,
    (k1.qDot[2] + 2 * k2.qDot[2] + 2 * k3.qDot[2] + k4.qDot[2]) / 6,
    (k1.qDot[3] + 2 * k2.qDot[3] + 2 * k3.qDot[3] + k4.qDot[3]) / 6,
  ];
  return {
    r_hill_m: addScaled(state.r_hill_m, weightedR, dt_s),
    v_hill_mps: addScaled(state.v_hill_mps, weightedV, dt_s),
    q_BI: normalizeQuaternion(addScaledQuat(state.q_BI, weightedQ, dt_s)),
    w_body_rps: addScaled(state.w_body_rps, weightedW, dt_s),
  };
}

/** CW translational ODE with an additive specific force already expressed in Hill axes. */
export function cwDerivative(
  t_s: number,
  r_hill_m: Vec3,
  v_hill_mps: Vec3,
  meanMotionRadS = MEAN_MOTION_RAD_S,
  externalSpecificForce_hill_mps2?: SpecificForce,
): { rDot: Vec3; vDot: Vec3 } {
  const [x, , z] = r_hill_m;
  const [vx, vy] = v_hill_mps;
  const force = forceAt(externalSpecificForce_hill_mps2, t_s, r_hill_m, v_hill_mps);
  const n2 = meanMotionRadS * meanMotionRadS;
  return {
    rDot: [...v_hill_mps],
    vDot: [3 * n2 * x + 2 * meanMotionRadS * vy + force[0],
      -2 * meanMotionRadS * vx + force[1],
      -n2 * z + force[2]],
  };
}

/**
 * Propagate truth by one RK4 step. q_BI rotates inertial→body, angular rate and
 * torque are body-frame quantities, and the body-frame force is rotated body→Hill
 * before entering the CW translational equations. Quaternion norm is restored
 * after every step.
 */
export function stepTruth(state: TruthState, options: TruthStepOptions = {}): TruthState {
  const dt_s = options.dt_s ?? DEFAULT_TRUTH_DT_S;
  const meanMotionRadS = options.meanMotionRadS ?? MEAN_MOTION_RAD_S;
  if (!(dt_s > 0) || !Number.isFinite(dt_s)) throw new RangeError('dt_s must be finite and positive');
  if (!Number.isFinite(meanMotionRadS)) throw new RangeError('meanMotionRadS must be finite');
  const inertia_kg_m2 = options.inertia_kg_m2 ?? DEFAULT_INERTIA_KG_M2;
  validateInertia(inertia_kg_m2);
  const torque_body_Nm = options.torque_body_Nm ?? [0, 0, 0];
  validateTorque(torque_body_Nm);
  const force = options.externalSpecificForce_body_mps2 ?? options.externalSpecificForce_hill_mps2;
  const integrated = rk4TruthStep(
    state,
    dt_s,
    meanMotionRadS,
    force,
    torque_body_Nm,
    inertia_kg_m2,
  );
  const propellantRate = Math.max(0, options.propellantRate_kg_s ?? 0);
  return {
    t_s: state.t_s + dt_s,
    r_hill_m: integrated.r_hill_m,
    v_hill_mps: integrated.v_hill_mps,
    q_BI: integrated.q_BI,
    w_body_rps: integrated.w_body_rps,
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
