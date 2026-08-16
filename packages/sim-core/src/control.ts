import { MEAN_MOTION_RAD_S } from './dynamics.js';
import {
  conjugateQuaternion,
  errorQuaternion,
  hillToBody,
  multiplyQuaternion,
  normalizeQuaternion,
  rotateVector,
  smallAngleExp,
} from './attitude.js';
import { cwDiscreteMatrices, type Matrix6, type State6 } from './ekf.js';
import type { GuidanceReference } from './guidance.js';
import type { ManualCommand, Quat, Vec3 } from './types.js';

export type { ManualCommand } from './types.js';

export type Matrix3x6 = number[][];

export interface PidGains {
  kp_N_per_m: number | Vec3;
  ki_N_per_m_s: number | Vec3;
  kd_N_s_per_m: number | Vec3;
}

export interface PidConfig {
  gains: PidGains;
  maxForce_N?: number | Vec3;
  antiWindupGain_s_inv?: number;
}

export interface LqrConfig {
  meanMotionRadS?: number;
  dt_s?: number;
  mass_kg?: number;
  qWeights?: State6;
  rWeights?: Vec3;
  maxForce_N?: number | Vec3;
  maxIterations?: number;
  convergenceTolerance?: number;
}

export interface StateController {
  step(state: State6, reference: GuidanceReference | State6, dt_s?: number): Vec3;
  reset?(): void;
}

export interface LqrController extends StateController {
  readonly gain_3x6: Matrix3x6;
  readonly riccatiResidual: number;
  readonly closedLoopMatrix: Matrix6;
}

export type ManualAuthority = 'LOW' | 'HIGH';

export interface ManualLimitPreset {
  maxRate_rps: number | Vec3;
  maxVelocity_mps: number | Vec3;
  pulseForce_N: number | Vec3;
  pulseTorque_Nm: number | Vec3;
  manualForceLimit_N: number;
  kp?: Vec3;
  kd?: Vec3;
}

export const MANUAL_AUTHORITY_PRESETS: Record<ManualAuthority, ManualLimitPreset> = {
  LOW: {
    maxRate_rps: 1.5 * Math.PI / 180,
    maxVelocity_mps: 0.5,
    pulseForce_N: 40,
    pulseTorque_Nm: 8,
    manualForceLimit_N: 60,
  },
  HIGH: {
    maxRate_rps: 8 * Math.PI / 180,
    maxVelocity_mps: 1,
    pulseForce_N: 55,
    pulseTorque_Nm: 45,
    manualForceLimit_N: 75,
    kp: [250, 167, 250],
    kd: [2000, 1333, 2000],
  },
};

export interface ResolvedManualLimits {
  maxRate_rps: Vec3;
  maxVelocity_mps: Vec3;
  pulseForce_N: Vec3;
  pulseTorque_Nm: Vec3;
  manualForceLimit_N: number;
  kp_Nm_per_rad: Vec3;
  kd_Nms_per_rad: Vec3;
}

export interface AttitudeControllerConfig {
  meanMotionRadS?: number;
  kp_Nm_per_rad?: number | Vec3;
  kd_Nms_per_rad?: number | Vec3;
  manualKp_Nm_per_rad?: number | Vec3;
  manualKd_Nms_per_rad?: number | Vec3;
  manualForceLimit_N?: number;
  initialManualAuthority?: ManualAuthority;
  maxTorque_Nm?: number | Vec3;
  maxRate_rps?: number | Vec3;
  maxVelocity_mps?: number | Vec3;
  pulseForce_N?: number | Vec3;
  pulseTorque_Nm?: number | Vec3;
}

export interface RateCommandTargets {
  bodyRate_rps: Vec3;
  velocity_body_mps: Vec3;
}

export interface ManualRateReference {
  q_target_BH: Quat;
  omega_ref_body_rps: Vec3;
  r_target_hill_m: Vec3;
  velocity_ref_body_mps: Vec3;
  velocity_ref_hill_mps: Vec3;
}

export interface ManualPulseCommand {
  force_body_N: Vec3;
  torque_body_Nm: Vec3;
}

export interface AttitudeController {
  /** Quaternion-error PD; q_BH and q_target_BH rotate Hill→body vectors. */
  step(q_BH_est: Quat, omega_est_body_rps: Vec3, q_target_BH?: Quat, omega_ref_body_rps?: Vec3): Vec3;
  /** Quaternion-error PD using the active authority's manual gains. */
  stepManualDamping(q_BH_est: Quat, omega_est_body_rps: Vec3, q_target_BH?: Quat, omega_ref_body_rps?: Vec3): Vec3;
  /** AUTO LVLH hold from q_BI, using the shared inertial/Hill frame chain. */
  stepAuto(q_BI_est: Quat, t_s: number, omega_est_body_rps: Vec3): Vec3;
  /** Capture a fresh RATE target and reset all controller/reference state. */
  captureReference(q_BH_est: Quat, r_est_hill_m: Vec3): void;
  /** Update the stateful RATE reference and return its current targets/torque. */
  stepRate(
    q_BH_est: Quat,
    omega_est_body_rps: Vec3,
    r_est_hill_m: Vec3,
    command: ManualCommand,
    dt_s: number,
  ): { torque_body_Nm: Vec3; reference: ManualRateReference };
  /** Shape normalized RATE/PULSE pilot inputs without changing state. */
  shapeRate(command: ManualCommand): RateCommandTargets;
  shapePulse(command: ManualCommand): ManualPulseCommand;
  getResolvedManualLimits(): ResolvedManualLimits;
  setAuthority(level: ManualAuthority): void;
  getAuthority(): ManualAuthority;
  getReference(): ManualRateReference | null;
  reset(): void;
}

function asVec3(value: number | Vec3): Vec3 {
  return typeof value === 'number' ? [value, value, value] : [...value];
}

function cloneQuat(value: Quat): Quat {
  return [...value];
}

function clampTorque(torque_Nm: Vec3, maxTorque_Nm: Vec3): Vec3 {
  return torque_Nm.map((value, axis) => Math.max(-maxTorque_Nm[axis]!, Math.min(maxTorque_Nm[axis]!, value))) as Vec3;
}

function validateNormalizedCommand(command: ManualCommand): void {
  if ([...command.translation, ...command.rotation].some((value) => !Number.isFinite(value) || value < -1 || value > 1)) {
    throw new RangeError('manual command axes must be finite and in [-1, 1]');
  }
}

function validatePositiveVector(value: Vec3, name: string): void {
  if (value.some((component) => (component !== Number.POSITIVE_INFINITY && !Number.isFinite(component)) || component <= 0)) throw new RangeError(`${name} must be finite and positive`);
}

function vectorIsZero(value: Vec3): boolean {
  return value[0] === 0 && value[1] === 0 && value[2] === 0;
}

function addVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scaleVec3(value: Vec3, scale: number): Vec3 {
  return [value[0] * scale, value[1] * scale, value[2] * scale];
}

function stateFromReference(reference: GuidanceReference | State6): State6 {
  return 'state' in reference ? reference.state : reference;
}

function clampForce(force_N: Vec3, maxForce_N: Vec3): Vec3 {
  return [
    Math.max(-maxForce_N[0], Math.min(maxForce_N[0], force_N[0])),
    Math.max(-maxForce_N[1], Math.min(maxForce_N[1], force_N[1])),
    Math.max(-maxForce_N[2], Math.min(maxForce_N[2], force_N[2])),
  ];
}

function multiply(a: number[][], b: number[][]): number[][] {
  const bTranspose = b[0]!.map((_, column) => b.map((row) => row[column] ?? 0));
  return a.map((row) => bTranspose.map((column) => row.reduce((sum, value, index) => sum + value * (column[index] ?? 0), 0)));
}

function transpose(matrix: number[][]): number[][] {
  return matrix[0]!.map((_, column) => matrix.map((row) => row[column] ?? 0));
}

function add(a: number[][], b: number[][]): number[][] {
  return a.map((row, rowIndex) => row.map((value, column) => value + (b[rowIndex]?.[column] ?? 0)));
}

function subtract(a: number[][], b: number[][]): number[][] {
  return a.map((row, rowIndex) => row.map((value, column) => value - (b[rowIndex]?.[column] ?? 0)));
}

function diagonal(values: Vec3 | State6): number[][] {
  return values.map((value, row) => values.map((_, column) => row === column ? value : 0));
}

function inverse(matrix: number[][]): number[][] {
  const size = matrix.length;
  const augmented = matrix.map((row, rowIndex) => [...row, ...Array.from({ length: size }, (_, column) => rowIndex === column ? 1 : 0)]);
  for (let pivot = 0; pivot < size; pivot += 1) {
    let pivotRow = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(augmented[row]![pivot]!) > Math.abs(augmented[pivotRow]![pivot]!)) pivotRow = row;
    }
    if (Math.abs(augmented[pivotRow]![pivot]!) < 1e-14) throw new RangeError('singular control matrix');
    [augmented[pivot], augmented[pivotRow]] = [augmented[pivotRow]!, augmented[pivot]!];
    const pivotValue = augmented[pivot]![pivot]!;
    for (let column = pivot; column < 2 * size; column += 1) augmented[pivot]![column]! /= pivotValue;
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row]![pivot]!;
      for (let column = pivot; column < 2 * size; column += 1) augmented[row]![column]! -= factor * augmented[pivot]![column]!;
    }
  }
  return augmented.map((row) => row.slice(size));
}

function matrixNorm(matrix: number[][]): number {
  return Math.sqrt(matrix.reduce((sum, row) => sum + row.reduce((rowSum, value) => rowSum + value * value, 0), 0));
}

function stateError(state: State6, reference: GuidanceReference | State6): State6 {
  const desired = stateFromReference(reference);
  return state.map((value, index) => value - desired[index]!) as State6;
}

function validateMaxForce(value: number | Vec3 | undefined): Vec3 {
  const maxForce = asVec3(value ?? Number.POSITIVE_INFINITY);
  if (maxForce.some((component) => component <= 0 || Number.isNaN(component))) throw new RangeError('maxForce_N must be positive');
  return maxForce;
}

/**
 * Create the quaternion-error PD attitude controller and stateful manual
 * reference generator. q_BH rotates Hill→body vectors; body-rate targets and
 * torque outputs are expressed in body axes.
 */
export function createAttitudeController(config: AttitudeControllerConfig = {}): AttitudeController {
  const meanMotionRadS = config.meanMotionRadS ?? MEAN_MOTION_RAD_S;
  const kp_Nm_per_rad = asVec3(config.kp_Nm_per_rad ?? [120, 80, 120]);
  const kd_Nms_per_rad = asVec3(config.kd_Nms_per_rad ?? [180, 120, 180]);
  const maxTorque_Nm = asVec3(config.maxTorque_Nm ?? Number.POSITIVE_INFINITY);
  const manualKp_Nm_per_rad = config.manualKp_Nm_per_rad === undefined ? undefined : asVec3(config.manualKp_Nm_per_rad);
  const manualKd_Nms_per_rad = config.manualKd_Nms_per_rad === undefined ? undefined : asVec3(config.manualKd_Nms_per_rad);
  const initialManualAuthority = config.initialManualAuthority ?? 'LOW';
  if (initialManualAuthority !== 'LOW' && initialManualAuthority !== 'HIGH') throw new RangeError('initialManualAuthority must be LOW or HIGH');
  if (!Number.isFinite(meanMotionRadS)) throw new RangeError('meanMotionRadS must be finite');
  validatePositiveVector(kp_Nm_per_rad, 'kp_Nm_per_rad');
  validatePositiveVector(kd_Nms_per_rad, 'kd_Nms_per_rad');
  if (manualKp_Nm_per_rad !== undefined) validatePositiveVector(manualKp_Nm_per_rad, 'manualKp_Nm_per_rad');
  if (manualKd_Nms_per_rad !== undefined) validatePositiveVector(manualKd_Nms_per_rad, 'manualKd_Nms_per_rad');
  validatePositiveVector(maxTorque_Nm, 'maxTorque_Nm');
  if (config.manualForceLimit_N !== undefined && (!Number.isFinite(config.manualForceLimit_N) || config.manualForceLimit_N <= 0)) {
    throw new RangeError('manualForceLimit_N must be finite and positive');
  }
  if (config.maxRate_rps !== undefined) validatePositiveVector(asVec3(config.maxRate_rps), 'maxRate_rps');
  if (config.maxVelocity_mps !== undefined) validatePositiveVector(asVec3(config.maxVelocity_mps), 'maxVelocity_mps');
  if (config.pulseForce_N !== undefined) validatePositiveVector(asVec3(config.pulseForce_N), 'pulseForce_N');
  if (config.pulseTorque_Nm !== undefined) validatePositiveVector(asVec3(config.pulseTorque_Nm), 'pulseTorque_Nm');

  const integratorState: Vec3 = [0, 0, 0];
  let reference: ManualRateReference | null = null;
  let lastReferenceState: { q_BH_est: Quat; r_est_hill_m: Vec3 } | null = null;
  let authority: ManualAuthority = initialManualAuthority;

  const getResolvedManualLimits = (): ResolvedManualLimits => {
    const preset = MANUAL_AUTHORITY_PRESETS[authority];
    return {
      maxRate_rps: asVec3(config.maxRate_rps ?? preset.maxRate_rps),
      maxVelocity_mps: asVec3(config.maxVelocity_mps ?? preset.maxVelocity_mps),
      pulseForce_N: asVec3(config.pulseForce_N ?? preset.pulseForce_N),
      pulseTorque_Nm: asVec3(config.pulseTorque_Nm ?? preset.pulseTorque_Nm),
      manualForceLimit_N: config.manualForceLimit_N ?? preset.manualForceLimit_N,
      // LOW deliberately omits kp/kd: the omission inherits the already
      // resolved AUTO gains, so custom AUTO gains retain today's behavior.
      kp_Nm_per_rad: [...(manualKp_Nm_per_rad ?? preset.kp ?? kp_Nm_per_rad)],
      kd_Nms_per_rad: [...(manualKd_Nms_per_rad ?? preset.kd ?? kd_Nms_per_rad)],
    };
  };

  const copyReference = (value: ManualRateReference): ManualRateReference => ({
    q_target_BH: cloneQuat(value.q_target_BH),
    omega_ref_body_rps: [...value.omega_ref_body_rps],
    r_target_hill_m: [...value.r_target_hill_m],
    velocity_ref_body_mps: [...value.velocity_ref_body_mps],
    velocity_ref_hill_mps: [...value.velocity_ref_hill_mps],
  });

  const stepWithGains = (
    q_BH_est: Quat,
    omega_est_body_rps: Vec3,
    q_target_BH: Quat = [1, 0, 0, 0],
    omega_ref_body_rps: Vec3 = [0, 0, 0],
    kp: Vec3 = kp_Nm_per_rad,
    kd: Vec3 = kd_Nms_per_rad,
  ): Vec3 => {
    // errorQuaternion(current, target) is the shortest target-relative error;
    // its vector is the correction direction for the q_BI I→B convention.
    const qError = errorQuaternion(q_BH_est, q_target_BH);
    const torque: Vec3 = [
      -kp[0]! * qError[1] - kd[0]! * (omega_est_body_rps[0] - omega_ref_body_rps[0]) + integratorState[0],
      -kp[1]! * qError[2] - kd[1]! * (omega_est_body_rps[1] - omega_ref_body_rps[1]) + integratorState[1],
      -kp[2]! * qError[3] - kd[2]! * (omega_est_body_rps[2] - omega_ref_body_rps[2]) + integratorState[2],
    ];
    return clampTorque(torque, maxTorque_Nm);
  };

  const step = (
    q_BH_est: Quat,
    omega_est_body_rps: Vec3,
    q_target_BH: Quat = [1, 0, 0, 0],
    omega_ref_body_rps: Vec3 = [0, 0, 0],
  ): Vec3 => stepWithGains(q_BH_est, omega_est_body_rps, q_target_BH, omega_ref_body_rps);

  const stepManualDamping = (
    q_BH_est: Quat,
    omega_est_body_rps: Vec3,
    q_target_BH: Quat = [1, 0, 0, 0],
    omega_ref_body_rps: Vec3 = [0, 0, 0],
  ): Vec3 => {
    const limits = getResolvedManualLimits();
    return stepWithGains(q_BH_est, omega_est_body_rps, q_target_BH, omega_ref_body_rps, limits.kp_Nm_per_rad, limits.kd_Nms_per_rad);
  };

  const shapeRate = (command: ManualCommand): RateCommandTargets => {
    validateNormalizedCommand(command);
    const limits = getResolvedManualLimits();
    return {
      bodyRate_rps: command.rotation.map((value, axis) => value * limits.maxRate_rps[axis]!) as Vec3,
      velocity_body_mps: command.translation.map((value, axis) => value * limits.maxVelocity_mps[axis]!) as Vec3,
    };
  };

  const shapePulse = (command: ManualCommand): ManualPulseCommand => {
    validateNormalizedCommand(command);
    const limits = getResolvedManualLimits();
    return {
      force_body_N: command.translation.map((value, axis) => value * limits.pulseForce_N[axis]!) as Vec3,
      torque_body_Nm: command.rotation.map((value, axis) => value * limits.pulseTorque_Nm[axis]!) as Vec3,
    };
  };

  const captureReference = (q_BH_est: Quat, r_est_hill_m: Vec3): void => {
    lastReferenceState = { q_BH_est: normalizeQuaternion(q_BH_est), r_est_hill_m: [...r_est_hill_m] };
    reference = {
      q_target_BH: [...lastReferenceState.q_BH_est],
      omega_ref_body_rps: rotateVector(lastReferenceState.q_BH_est, [0, 0, meanMotionRadS]),
      r_target_hill_m: [...lastReferenceState.r_est_hill_m],
      velocity_ref_body_mps: [0, 0, 0],
      velocity_ref_hill_mps: [0, 0, 0],
    };
    integratorState[0] = 0;
    integratorState[1] = 0;
    integratorState[2] = 0;
  };

  return {
    step,
    stepManualDamping,
    stepAuto(q_BI_est, t_s, omega_est_body_rps) {
      const q_BH_est = hillToBody(q_BI_est, t_s, meanMotionRadS);
      const omega_ref_body_rps = rotateVector(q_BH_est, [0, 0, meanMotionRadS]);
      return step(q_BH_est, omega_est_body_rps, [1, 0, 0, 0], omega_ref_body_rps);
    },
    captureReference,
    stepRate(q_BH_est, omega_est_body_rps, r_est_hill_m, command, dt_s) {
      if (!(dt_s > 0) || !Number.isFinite(dt_s)) throw new RangeError('dt_s must be finite and positive');
      if (reference === null) this.captureReference(q_BH_est, r_est_hill_m);
      lastReferenceState = { q_BH_est: normalizeQuaternion(q_BH_est), r_est_hill_m: [...r_est_hill_m] };
      const targets = shapeRate(command);
      const current = reference!;
      if (!vectorIsZero(targets.bodyRate_rps)) {
        current.q_target_BH = normalizeQuaternion(multiplyQuaternion(
          smallAngleExp(scaleVec3(targets.bodyRate_rps, -dt_s)),
          current.q_target_BH,
        ));
      }
      if (!vectorIsZero(targets.velocity_body_mps)) {
        current.velocity_ref_body_mps = [...targets.velocity_body_mps];
        current.velocity_ref_hill_mps = rotateVector(conjugateQuaternion(q_BH_est), targets.velocity_body_mps);
        current.r_target_hill_m = addVec3(current.r_target_hill_m, scaleVec3(current.velocity_ref_hill_mps, dt_s));
      } else {
        // Release latches the position target and clears the velocity target.
        current.velocity_ref_body_mps = [0, 0, 0];
        current.velocity_ref_hill_mps = [0, 0, 0];
      }
      current.omega_ref_body_rps = addVec3(
        rotateVector(q_BH_est, [0, 0, meanMotionRadS]),
        targets.bodyRate_rps,
      );
      const outputReference = copyReference(current);
      return {
        torque_body_Nm: stepManualDamping(q_BH_est, omega_est_body_rps, current.q_target_BH, current.omega_ref_body_rps),
        reference: outputReference,
      };
    },
    shapeRate,
    shapePulse,
    getResolvedManualLimits,
    setAuthority(level) {
      if (level !== 'LOW' && level !== 'HIGH') throw new RangeError('manual authority must be LOW or HIGH');
      if (level === authority) return;
      authority = level;
      integratorState[0] = 0;
      integratorState[1] = 0;
      integratorState[2] = 0;
      if (lastReferenceState !== null) captureReference(lastReferenceState.q_BH_est, lastReferenceState.r_est_hill_m);
      else reference = null;
    },
    getAuthority() {
      return authority;
    },
    getReference() {
      return reference === null ? null : copyReference(reference);
    },
    reset() {
      reference = null;
      lastReferenceState = null;
      integratorState[0] = 0;
      integratorState[1] = 0;
      integratorState[2] = 0;
    },
  };
}

/** Create a per-axis PID force controller with integral anti-windup. */
export function createPidController(config: PidConfig): StateController {
  const kp = asVec3(config.gains.kp_N_per_m);
  const ki = asVec3(config.gains.ki_N_per_m_s);
  const kd = asVec3(config.gains.kd_N_s_per_m);
  const maxForce_N = validateMaxForce(config.maxForce_N);
  const antiWindupGain_s_inv = config.antiWindupGain_s_inv ?? 1;
  if ([...kp, ...ki, ...kd, antiWindupGain_s_inv].some((value) => value < 0 || !Number.isFinite(value))) throw new RangeError('PID gains must be finite and non-negative');
  const integralForce_N: Vec3 = [0, 0, 0];

  return {
    step(state, reference, dt_s = 0.1) {
      if (!(dt_s > 0) || !Number.isFinite(dt_s)) throw new RangeError('dt_s must be finite and positive');
      const error = stateError(state, reference);
      const rawForce: Vec3 = [
        -kp[0] * error[0] - kd[0] * error[3] + integralForce_N[0],
        -kp[1] * error[1] - kd[1] * error[4] + integralForce_N[1],
        -kp[2] * error[2] - kd[2] * error[5] + integralForce_N[2],
      ];
      const force_N = clampForce(rawForce, maxForce_N);
      for (let axis = 0; axis < 3; axis += 1) {
        integralForce_N[axis]! += ki[axis]! * (-error[axis]!) * dt_s + antiWindupGain_s_inv * (force_N[axis]! - rawForce[axis]!) * dt_s;
      }
      return force_N;
    },
    reset() {
      integralForce_N[0] = 0;
      integralForce_N[1] = 0;
      integralForce_N[2] = 0;
    },
  };
}

function dareIteration(
  a: Matrix6,
  b: number[][],
  q: Matrix6,
  r: number[][],
  maxIterations: number,
  tolerance: number,
): { p: Matrix6; gain: Matrix3x6; residual: number } {
  let p = q.map((row) => [...row]);
  let gain: Matrix3x6 = Array.from({ length: 3 }, () => new Array<number>(6).fill(0));
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const btP = multiply(transpose(b), p);
    const s = add(r, multiply(btP, b));
    const sInverse = inverse(s);
    gain = multiply(multiply(sInverse, btP), a);
    const pNext = add(q, subtract(multiply(multiply(transpose(a), p), a), multiply(multiply(multiply(transpose(a), p), b), gain)));
    const difference = matrixNorm(subtract(pNext, p));
    p = pNext;
    if (difference < tolerance) break;
  }
  const btP = multiply(transpose(b), p);
  const s = add(r, multiply(btP, b));
  gain = multiply(multiply(inverse(s), btP), a);
  const fixedPoint = add(q, subtract(multiply(multiply(transpose(a), p), a), multiply(multiply(multiply(transpose(a), p), b), gain)));
  return { p, gain, residual: matrixNorm(subtract(fixedPoint, p)) };
}

/** Create a discrete CW LQR controller using an iterated DARE solution. */
export function createLqrController(config: LqrConfig = {}): LqrController {
  const meanMotionRadS = config.meanMotionRadS ?? MEAN_MOTION_RAD_S;
  const dt_s = config.dt_s ?? 0.1;
  const mass_kg = config.mass_kg ?? 1_000;
  const qWeights: State6 = config.qWeights ?? [1, 1, 1, 10, 10, 10];
  const rWeights: Vec3 = config.rWeights ?? [1, 1, 1];
  const maxIterations = config.maxIterations ?? 500;
  const tolerance = config.convergenceTolerance ?? 1e-10;
  const maxForce_N = validateMaxForce(config.maxForce_N);
  if (!(mass_kg > 0) || !(dt_s > 0) || qWeights.some((value) => value < 0) || rWeights.some((value) => value <= 0)) throw new RangeError('invalid LQR configuration');
  const matrices = cwDiscreteMatrices(meanMotionRadS, dt_s);
  const q = diagonal(qWeights);
  const r = diagonal(rWeights);
  const solution = dareIteration(matrices.phi, matrices.gamma, q, r, maxIterations, tolerance);
  const closedLoopMatrix = subtract(matrices.phi, multiply(matrices.gamma, solution.gain));
  return {
    gain_3x6: solution.gain,
    riccatiResidual: solution.residual,
    closedLoopMatrix,
    step(state, reference) {
      const error = stateError(state, reference);
      const specificForce_mps2 = solution.gain.map((row) => -row.reduce((sum, value, index) => sum + value * error[index]!, 0)) as Vec3;
      return clampForce(specificForce_mps2.map((value) => value * mass_kg) as Vec3, maxForce_N);
    },
  };
}
