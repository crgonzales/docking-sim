import { MEAN_MOTION_RAD_S } from './dynamics.js';
import {
  conjugateQuaternion,
  multiplyQuaternion,
  normalizeQuaternion,
  rotateVector,
  smallAngleExp,
} from './attitude.js';
import { inverseMatrix } from './linalg.js';
import { bearingToLosUnit, losToBearing } from './sensors.js';
import type { Quat, SensorFrame, Vec3 } from './types.js';

export type State6 = [number, number, number, number, number, number];
export type Matrix6 = number[][];
export type Measurement3 = [number, number, number];
export type Matrix3 = number[][];

export interface NavPrior {
  state: State6;
  covariance: Matrix6;
}

export interface EkfConfig {
  meanMotionRadS?: number;
  initialNavPrior?: NavPrior;
  p0?: Matrix6;
  P0?: Matrix6;
  q?: Matrix6;
  Q?: Matrix6;
  r?: Matrix3;
  R?: Matrix3;
}

export interface NavDiag {
  state: State6;
  covariance: Matrix6;
  initialized: boolean;
}

export interface EkfMeasurement {
  range_m: number;
  bearing_body_rad: [number, number];
}

/** Attitude estimate used to express the Hill-state bearing in body axes. */
export interface EkfAttitudeContext {
  /** q_BH rotates Hill vectors into body axes. */
  q_BH: Quat;
  /** MEKF attitude-error covariance P_theta-theta, in rad². */
  attitudeCovariance?: Matrix3;
}

export interface Ekf {
  predict(dt_s: number, controlSpecificForce_mps2?: Vec3): void;
  predictWithImpulse(dt_s: number, controlSpecificForceImpulse_mps: Vec3): void;
  update(measurement: EkfMeasurement, attitude?: EkfAttitudeContext): boolean;
  step(
    sensor: SensorFrame,
    dt_s: number,
    velocityReference_mps: Vec3,
    controlSpecificForce_mps2?: Vec3,
    attitude?: EkfAttitudeContext,
  ): void;
  getNavDiag(): NavDiag;
  readonly initialized: boolean;
}

interface DiscreteCwMatrices {
  phi: Matrix6;
  gamma: number[][];
}

const ZERO_VEC3: Vec3 = [0, 0, 0];
const DEFAULT_INITIAL_STATE: State6 = [0, 0, 0, 0, 0, 0];
const DEFAULT_P0: Matrix6 = diagonalMatrix([100 ** 2, 100 ** 2, 100 ** 2, 1, 1, 1]);
const DEFAULT_Q: Matrix6 = diagonalMatrix([1e-8, 1e-8, 1e-8, 1e-10, 1e-10, 1e-10]);
const DEFAULT_R: Matrix3 = diagonalMatrix([0.05 ** 2, 0.001 ** 2, 0.001 ** 2]);

function diagonalMatrix(diagonal: number[]): number[][] {
  return diagonal.map((value, row) => diagonal.map((_, column) => row === column ? value : 0));
}

function cloneMatrix(matrix: number[][]): number[][] {
  return matrix.map((row) => [...row]);
}

function cloneState(state: State6): State6 {
  return [...state] as State6;
}

function addMatrices(a: number[][], b: number[][]): number[][] {
  return a.map((row, rowIndex) => row.map((value, column) => value + (b[rowIndex]?.[column] ?? 0)));
}

function transpose(matrix: number[][]): number[][] {
  return matrix[0]!.map((_, column) => matrix.map((row) => row[column] ?? 0));
}

function multiplyMatrices(a: number[][], b: number[][]): number[][] {
  const bTransposed = transpose(b);
  return a.map((row) => bTransposed.map((column) => row.reduce((sum, value, index) => sum + value * (column[index] ?? 0), 0)));
}

function multiplyMatrixVector(matrix: number[][], vector: number[]): number[] {
  return matrix.map((row) => row.reduce((sum, value, index) => sum + value * (vector[index] ?? 0), 0));
}

function symmetrize(matrix: number[][]): number[][] {
  return matrix.map((row, rowIndex) => row.map((value, column) => (value + (matrix[column]?.[rowIndex] ?? value)) / 2));
}


function continuousCwMatrix(meanMotionRadS: number): number[][] {
  const n2 = meanMotionRadS * meanMotionRadS;
  return [
    [0, 0, 0, 1, 0, 0],
    [0, 0, 0, 0, 1, 0],
    [0, 0, 0, 0, 0, 1],
    [3 * n2, 0, 0, 0, 2 * meanMotionRadS, 0],
    [0, 0, 0, -2 * meanMotionRadS, 0, 0],
    [0, 0, -n2, 0, 0, 0],
  ];
}

function continuousInputMatrix(): number[][] {
  return [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
}

/**
 * Exact CW transition and constant-specific-force input matrix for one step.
 * The transition is obtained from the existing analytic CW oracle; Gamma is
 * the converged matrix-exponential integral for the same continuous model.
 */
export function cwDiscreteMatrices(meanMotionRadS: number, dt_s: number): DiscreteCwMatrices {
  if (!(dt_s > 0) || !Number.isFinite(dt_s)) throw new RangeError('dt_s must be finite and positive');
  const n = meanMotionRadS;
  // Inline the closed form to keep the exact oracle contract local to this module.
  const c = Math.cos(n * dt_s);
  const s = Math.sin(n * dt_s);
  const phi: Matrix6 = [
    [4 - 3 * c, 0, 0, s / n, 2 * (1 - c) / n, 0],
    [6 * (s - n * dt_s), 1, 0, 2 * (c - 1) / n, (4 * s - 3 * n * dt_s) / n, 0],
    [0, 0, c, 0, 0, s / n],
    [3 * n * s, 0, 0, c, 2 * s, 0],
    [6 * n * (c - 1), 0, 0, -2 * s, 4 * c - 3, 0],
    [0, 0, -n * s, 0, 0, c],
  ];
  const a = continuousCwMatrix(n);
  const b = continuousInputMatrix();
  let aPowerTimesB = b;
  const gamma = Array.from({ length: 6 }, () => new Array<number>(3).fill(0));
  let factorial = 1;
  let dtPower = dt_s;
  for (let order = 0; order <= 20; order += 1) {
    const coefficient = dtPower / factorial;
    for (let row = 0; row < 6; row += 1) {
      for (let column = 0; column < 3; column += 1) gamma[row]![column]! += coefficient * (aPowerTimesB[row]?.[column] ?? 0);
    }
    aPowerTimesB = a.map((row) => [0, 1, 2].map((column) => row.reduce((sum, value, index) => sum + value * (aPowerTimesB[index]?.[column] ?? 0), 0)));
    factorial *= order + 2;
    dtPower *= dt_s;
  }
  return { phi, gamma };
}

const IDENTITY_QUATERNION: Quat = [1, 0, 0, 0];

function measurementFromState(state: State6, q_BH: Quat = IDENTITY_QUATERNION): Measurement3 {
  const position: Vec3 = [state[0], state[1], state[2]];
  const range_m = Math.hypot(...position);
  if (range_m === 0) throw new RangeError('EKF state position must be non-zero for measurement model');
  const los_hill: Vec3 = [-position[0] / range_m, -position[1] / range_m, -position[2] / range_m];
  const bearing = losToBearing(rotateVector(q_BH, los_hill));
  return [range_m, bearing[0], bearing[1]];
}

/** Public measurement model used by the EKF oracle tests and later FSW code. */
export function ekfMeasurementModel(state: State6, q_BH: Quat = IDENTITY_QUATERNION): Measurement3 {
  return measurementFromState(state, q_BH);
}

function measurementJacobian(state: State6, q_BH: Quat): number[][] {
  const jacobian = Array.from({ length: 3 }, () => new Array<number>(6).fill(0));
  for (let column = 0; column < 6; column += 1) {
    const step = column < 3 ? 1e-5 : 1e-6;
    const plus = cloneState(state);
    const minus = cloneState(state);
    plus[column]! += step;
    minus[column]! -= step;
    const plusMeasurement = measurementFromState(plus, q_BH);
    const minusMeasurement = measurementFromState(minus, q_BH);
    jacobian[0]![column] = (plusMeasurement[0] - minusMeasurement[0]) / (2 * step);
    jacobian[1]![column] = wrapAngle(plusMeasurement[1] - minusMeasurement[1]) / (2 * step);
    jacobian[2]![column] = (plusMeasurement[2] - minusMeasurement[2]) / (2 * step);
  }
  return jacobian;
}

function attitudeBearingJacobian(state: State6, q_BH: Quat): Matrix3 {
  const jacobian = Array.from({ length: 3 }, () => new Array<number>(3).fill(0)) as Matrix3;
  const step_rad = 1e-6;
  for (let axis = 0; axis < 3; axis += 1) {
    const delta: Vec3 = [0, 0, 0];
    delta[axis] = step_rad;
    const plusQuaternion = normalizeQuaternion(multiplyQuaternion(smallAngleExp(delta), q_BH));
    delta[axis] = -step_rad;
    const minusQuaternion = normalizeQuaternion(multiplyQuaternion(smallAngleExp(delta), q_BH));
    const plusMeasurement = measurementFromState(state, plusQuaternion);
    const minusMeasurement = measurementFromState(state, minusQuaternion);
    jacobian[0]![axis] = 0;
    jacobian[1]![axis] = wrapAngle(plusMeasurement[1] - minusMeasurement[1]) / (2 * step_rad);
    jacobian[2]![axis] = (plusMeasurement[2] - minusMeasurement[2]) / (2 * step_rad);
  }
  return jacobian;
}

function wrapAngle(angle_rad: number): number {
  return Math.atan2(Math.sin(angle_rad), Math.cos(angle_rad));
}

function validateMatrix(matrix: number[][], rows: number, columns: number, name: string): void {
  if (matrix.length !== rows || matrix.some((row) => row.length !== columns || row.some((value) => !Number.isFinite(value)))) {
    throw new RangeError(`${name} must be a finite ${rows}x${columns} matrix`);
  }
}

function measurementFromSensor(sensor: SensorFrame): EkfMeasurement | null {
  if (sensor.range_m === null || sensor.bearing_body_rad === null || !Number.isFinite(sensor.range_m) || sensor.range_m <= 0) return null;
  // Calling the inverse helper here makes the measurement validity and angle
  // convention shared with sensors.ts rather than an independently parsed pair.
  const los = bearingToLosUnit(sensor.bearing_body_rad);
  if (los.some((component) => !Number.isFinite(component))) return null;
  return { range_m: sensor.range_m, bearing_body_rad: sensor.bearing_body_rad };
}

/** Create a six-state translational EKF with a truth-independent prior. */
export function createEkf(config: EkfConfig = {}): Ekf {
  const meanMotionRadS = config.meanMotionRadS ?? MEAN_MOTION_RAD_S;
  const priorState = cloneState(config.initialNavPrior?.state ?? DEFAULT_INITIAL_STATE);
  const priorCovariance = cloneMatrix(config.initialNavPrior?.covariance ?? DEFAULT_P0);
  const p0 = cloneMatrix(config.p0 ?? config.P0 ?? DEFAULT_P0);
  const q = cloneMatrix(config.q ?? config.Q ?? DEFAULT_Q);
  const r = cloneMatrix(config.r ?? config.R ?? DEFAULT_R);
  validateMatrix(priorCovariance, 6, 6, 'initialNavPrior.covariance');
  validateMatrix(p0, 6, 6, 'P0');
  validateMatrix(q, 6, 6, 'Q');
  validateMatrix(r, 3, 3, 'R');
  let state = priorState;
  let covariance = priorCovariance;
  let isInitialized = false;

  const predictInternal = (dt_s: number, controlSpecificForce_mps2: Vec3): void => {
    if (!isInitialized) return;
    const matrices = cwDiscreteMatrices(meanMotionRadS, dt_s);
    const transitioned = multiplyMatrixVector(matrices.phi, state);
    const controlContribution = multiplyMatrixVector(matrices.gamma, controlSpecificForce_mps2);
    state = transitioned.map((value, index) => value + (controlContribution[index] ?? 0)) as State6;
    covariance = symmetrize(addMatrices(multiplyMatrices(multiplyMatrices(matrices.phi, covariance), transpose(matrices.phi)), q));
  };

  const updateInternal = (measurement: EkfMeasurement, attitude?: EkfAttitudeContext): boolean => {
    if (!isInitialized || measurement.range_m <= 0 || !Number.isFinite(measurement.range_m)) return false;
    const q_BH = attitude === undefined ? IDENTITY_QUATERNION : normalizeQuaternion(attitude.q_BH);
    const predicted = measurementFromState(state, q_BH);
    const measured: Measurement3 = [measurement.range_m, measurement.bearing_body_rad[0], measurement.bearing_body_rad[1]];
    const innovation = [
      measured[0] - predicted[0],
      wrapAngle(measured[1] - predicted[1]),
      measured[2] - predicted[2],
    ];
    const h = measurementJacobian(state, q_BH);
    const hTranspose = transpose(h);
    const measurementNoise = cloneMatrix(r);
    if (attitude?.attitudeCovariance !== undefined) {
      const attitudeJacobian = attitudeBearingJacobian(state, q_BH);
      const attitudeNoise = multiplyMatrices(
        multiplyMatrices(attitudeJacobian, attitude.attitudeCovariance),
        transpose(attitudeJacobian),
      );
      for (let row = 0; row < 3; row += 1) {
        for (let column = 0; column < 3; column += 1) {
          measurementNoise[row]![column] = (measurementNoise[row]?.[column] ?? 0) + (attitudeNoise[row]?.[column] ?? 0);
        }
      }
    }
    const innovationCovariance = addMatrices(multiplyMatrices(multiplyMatrices(h, covariance), hTranspose), measurementNoise);
    const gain = multiplyMatrices(multiplyMatrices(covariance, hTranspose), inverseMatrix(innovationCovariance));
    state = state.map((value, row) => value + gain[row]!.reduce((sum, coefficient, column) => sum + coefficient * innovation[column]!, 0)) as State6;
    const identityMinusGainH = Array.from({ length: 6 }, (_, row) => Array.from({ length: 6 }, (_, column) => (row === column ? 1 : 0) - gain[row]!.reduce((sum, value, index) => sum + value * h[index]![column]!, 0)));
    covariance = symmetrize(addMatrices(
      multiplyMatrices(multiplyMatrices(identityMinusGainH, covariance), transpose(identityMinusGainH)),
      multiplyMatrices(multiplyMatrices(gain, measurementNoise), transpose(gain)),
    ));
    return true;
  };

  return {
    get initialized() { return isInitialized; },
    predict(dt_s, controlSpecificForce_mps2 = ZERO_VEC3) {
      predictInternal(dt_s, controlSpecificForce_mps2);
    },
    predictWithImpulse(dt_s, controlSpecificForceImpulse_mps) {
      predictInternal(dt_s, [
        controlSpecificForceImpulse_mps[0] / dt_s,
        controlSpecificForceImpulse_mps[1] / dt_s,
        controlSpecificForceImpulse_mps[2] / dt_s,
      ]);
    },
    update(measurement, attitude) {
      return updateInternal(measurement, attitude);
    },
    step(sensor, dt_s, velocityReference_mps, controlSpecificForce_mps2 = ZERO_VEC3, attitude) {
      const measurement = measurementFromSensor(sensor);
      if (!isInitialized) {
        if (measurement === null) return;
        const q_HB = attitude === undefined
          ? IDENTITY_QUATERNION
          : conjugateQuaternion(normalizeQuaternion(attitude.q_BH));
        const los = rotateVector(q_HB, bearingToLosUnit(measurement.bearing_body_rad));
        state = [
          -measurement.range_m * los[0],
          -measurement.range_m * los[1],
          -measurement.range_m * los[2],
          velocityReference_mps[0],
          velocityReference_mps[1],
          velocityReference_mps[2],
        ];
        covariance = cloneMatrix(p0);
        isInitialized = true;
        return;
      }
      predictInternal(dt_s, controlSpecificForce_mps2);
      if (measurement !== null) updateInternal(measurement, attitude);
    },
    getNavDiag() {
      return { state: cloneState(state), covariance: cloneMatrix(covariance), initialized: isInitialized };
    },
  };
}
