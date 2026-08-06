import {
  errorQuaternion,
  multiplyQuaternion,
  normalizeQuaternion,
  smallAngleExp,
  smallAngleLog,
} from './attitude.js';
import { inverseMatrix } from './linalg.js';
import type { Matrix3, Matrix6 } from './ekf.js';
import type { Quat, SensorFrame, Vec3 } from './types.js';

/** Configuration for the six-state attitude/bias multiplicative EKF. */
export interface MekfConfig {
  /** Optional initial reference; a first star-tracker sample still corrects it. */
  initial_q_ref_BI?: Quat;
  /** Alias using the descriptive quaternion name. */
  initialQuaternion_BI?: Quat;
  initialBias_rps?: Vec3;
  /** Initial covariance for [δθ, gyro bias]. Bias entries should be generous. */
  p0?: Matrix6;
  P0?: Matrix6;
  /** Discrete covariance added on each predict; rates are used when omitted. */
  q?: Matrix6;
  Q?: Matrix6;
  r?: Matrix3;
  R?: Matrix3;
  /** White gyro measurement noise standard deviation in rad/s. */
  gyro_sigma_rps?: number | Vec3;
  /** Alias for gyro_sigma_rps. */
  gyro_white_noise_rps?: number | Vec3;
  /** Gyro bias random-walk rate in rad/s per sqrt(s). */
  gyro_bias_random_walk_rps_sqrt_s?: number | Vec3;
  /** Alias for the random-walk rate. */
  gyro_bias_rw_rps_sqrt_s?: number | Vec3;
  /** Star-tracker small-angle measurement standard deviation in radians. */
  star_tracker_sigma_rad?: number | Vec3;
  /** Alias for star-tracker sigma. */
  attitude_sigma_rad?: number | Vec3;
}

/** Truth-independent diagnostic state returned by the MEKF. */
export interface AttDiag {
  q_ref_BI: Quat;
  bias_rps: Vec3;
  covariance: Matrix6;
  initialized: boolean;
}

export interface Mekf {
  readonly initialized: boolean;
  step(sensor: SensorFrame, dt_s: number): void;
  predict(gyro_rps: Vec3, dt_s: number): void;
  update(star_tracker_q_BI: Quat): boolean;
  getAttDiag(): AttDiag;
}

const DEFAULT_GYRO_SIGMA_RPS: Vec3 = [1e-5, 1e-5, 1e-5];
const DEFAULT_BIAS_RW_RPS_SQRT_S: Vec3 = [1e-6, 1e-6, 1e-6];
const DEFAULT_STAR_TRACKER_SIGMA_RAD: Vec3 = [0.0005, 0.0005, 0.0005];
const DEFAULT_P0: Matrix6 = [
  [0.25 ** 2, 0, 0, 0, 0, 0],
  [0, 0.25 ** 2, 0, 0, 0, 0],
  [0, 0, 0.25 ** 2, 0, 0, 0],
  [0, 0, 0, 0.01 ** 2, 0, 0],
  [0, 0, 0, 0, 0.01 ** 2, 0],
  [0, 0, 0, 0, 0, 0.01 ** 2],
];

function diagonal(values: Vec3 | [number, number, number, number, number, number]): number[][] {
  return values.map((value, row) => values.map((_, column) => row === column ? value : 0));
}

function cloneMatrix(matrix: number[][]): number[][] {
  return matrix.map((row) => [...row]);
}

function cloneVec3(vector: Vec3): Vec3 {
  return [...vector];
}

function cloneQuat(quaternion: Quat): Quat {
  return [...quaternion];
}

function addMatrices(a: number[][], b: number[][]): number[][] {
  return a.map((row, rowIndex) => row.map((value, column) => value + (b[rowIndex]?.[column] ?? 0)));
}

function multiplyMatrices(a: number[][], b: number[][]): number[][] {
  const bTranspose = transpose(b);
  return a.map((row) => bTranspose.map((column) => row.reduce(
    (sum, value, index) => sum + value * (column[index] ?? 0),
    0,
  )));
}

function multiplyMatrixVector(matrix: number[][], vector: number[]): number[] {
  return matrix.map((row) => row.reduce((sum, value, index) => sum + value * (vector[index] ?? 0), 0));
}

function transpose(matrix: number[][]): number[][] {
  return matrix[0]!.map((_, column) => matrix.map((row) => row[column] ?? 0));
}

function symmetrize(matrix: number[][]): number[][] {
  return matrix.map((row, rowIndex) => row.map((value, column) => (
    value + (matrix[column]?.[rowIndex] ?? value)
  ) / 2));
}

function skew(vector: Vec3): Matrix3 {
  return [
    [0, -vector[2], vector[1]],
    [vector[2], 0, -vector[0]],
    [-vector[1], vector[0], 0],
  ];
}

function vec3Config(value: number | Vec3 | undefined, fallback: Vec3): Vec3 {
  return value === undefined ? [...fallback] : typeof value === 'number' ? [value, value, value] : [...value];
}

function validateVector(vector: Vec3, name: string, nonNegative = false): void {
  if (vector.some((value) => !Number.isFinite(value) || (nonNegative && value < 0))) {
    throw new RangeError(`${name} must be finite${nonNegative ? ' and non-negative' : ''}`);
  }
}

function validateMatrix(matrix: number[][], rows: number, columns: number, name: string): void {
  if (matrix.length !== rows || matrix.some((row) => row.length !== columns || row.some((value) => !Number.isFinite(value)))) {
    throw new RangeError(`${name} must be a finite ${rows}x${columns} matrix`);
  }
}

function validateQuaternion(quaternion: Quat, name: string): void {
  if (quaternion.some((value) => !Number.isFinite(value))) throw new RangeError(`${name} must be finite`);
}

function attitudeCovarianceTransition(omega_rps: Vec3, dt_s: number): Matrix6 {
  const omegaSkew = skew(omega_rps);
  const phi: Matrix6 = diagonal([1, 1, 1, 1, 1, 1]);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      phi[row]![column] = (row === column ? 1 : 0) - omegaSkew[row]![column]! * dt_s;
      // δθ is truth-minus-reference, so a positive bias error accumulates as
      // a positive attitude error under gyro-minus-estimated-bias propagation.
      phi[row]![column + 3] = (row === column ? 1 : 0) * dt_s;
    }
  }
  return phi;
}

function processCovariance(
  dt_s: number,
  gyroSigma_rps: Vec3,
  biasRandomWalk_rps_sqrt_s: Vec3,
  configuredQ: Matrix6 | undefined,
): Matrix6 {
  if (configuredQ !== undefined) return cloneMatrix(configuredQ);
  const q = diagonal([0, 0, 0, 0, 0, 0]) as Matrix6;
  for (let axis = 0; axis < 3; axis += 1) {
    // Sensor gyro noise is a per-sample rate sigma, hence its integrated
    // angle variance scales as dt²; bias random walk variance scales as dt.
    q[axis]![axis] = gyroSigma_rps[axis]! ** 2 * dt_s ** 2;
    q[axis + 3]![axis + 3] = biasRandomWalk_rps_sqrt_s[axis]! ** 2 * dt_s;
  }
  return q;
}

function starTrackerFromSensor(sensor: SensorFrame): Quat | null {
  return sensor.star_tracker_q_BI ?? sensor.attitude_q_BI ?? null;
}

/** Create a six-state multiplicative EKF for q_BI and gyro bias. */
export function createMekf(config: MekfConfig = {}): Mekf {
  const initialQuaternion = config.initial_q_ref_BI ?? config.initialQuaternion_BI ?? [1, 0, 0, 0];
  const initialBias_rps = config.initialBias_rps ?? [0, 0, 0];
  const gyroSigma_rps = vec3Config(config.gyro_sigma_rps ?? config.gyro_white_noise_rps, DEFAULT_GYRO_SIGMA_RPS);
  const biasRandomWalk_rps_sqrt_s = vec3Config(
    config.gyro_bias_random_walk_rps_sqrt_s ?? config.gyro_bias_rw_rps_sqrt_s,
    DEFAULT_BIAS_RW_RPS_SQRT_S,
  );
  const starTrackerSigma_rad = vec3Config(
    config.star_tracker_sigma_rad ?? config.attitude_sigma_rad,
    DEFAULT_STAR_TRACKER_SIGMA_RAD,
  );
  const p0 = cloneMatrix(config.p0 ?? config.P0 ?? DEFAULT_P0);
  const configuredQ = config.q ?? config.Q;
  const r = cloneMatrix(config.r ?? config.R ?? diagonal([
    starTrackerSigma_rad[0]! ** 2,
    starTrackerSigma_rad[1]! ** 2,
    starTrackerSigma_rad[2]! ** 2,
  ]));
  validateQuaternion(initialQuaternion, 'initial quaternion');
  validateVector(initialBias_rps, 'initial gyro bias');
  validateVector(gyroSigma_rps, 'gyro sigma', true);
  validateVector(biasRandomWalk_rps_sqrt_s, 'gyro bias random-walk rate', true);
  validateVector(starTrackerSigma_rad, 'star-tracker sigma', true);
  validateMatrix(p0, 6, 6, 'P0');
  if (configuredQ !== undefined) validateMatrix(configuredQ, 6, 6, 'Q');
  validateMatrix(r, 3, 3, 'R');

  let q_ref_BI = normalizeQuaternion(initialQuaternion);
  let bias_rps = cloneVec3(initialBias_rps);
  let covariance = cloneMatrix(p0);
  let isInitialized = config.initial_q_ref_BI !== undefined || config.initialQuaternion_BI !== undefined;

  const predictInternal = (gyro_rps: Vec3, dt_s: number): void => {
    if (!(dt_s > 0) || !Number.isFinite(dt_s)) throw new RangeError('MEKF dt_s must be finite and positive');
    validateVector(gyro_rps, 'gyro measurement');
    if (!isInitialized) return;
    const correctedGyro_rps: Vec3 = [
      gyro_rps[0] - bias_rps[0],
      gyro_rps[1] - bias_rps[1],
      gyro_rps[2] - bias_rps[2],
    ];
    const deltaQuaternion = smallAngleExp([
      -correctedGyro_rps[0] * dt_s,
      -correctedGyro_rps[1] * dt_s,
      -correctedGyro_rps[2] * dt_s,
    ]);
    q_ref_BI = normalizeQuaternion(multiplyQuaternion(deltaQuaternion, q_ref_BI));
    const phi = attitudeCovarianceTransition(correctedGyro_rps, dt_s);
    covariance = symmetrize(addMatrices(
      multiplyMatrices(multiplyMatrices(phi, covariance), transpose(phi)),
      processCovariance(dt_s, gyroSigma_rps, biasRandomWalk_rps_sqrt_s, configuredQ),
    ));
  };

  const updateInternal = (measured_q_BI: Quat): boolean => {
    validateQuaternion(measured_q_BI, 'star-tracker quaternion');
    if (!isInitialized) {
      q_ref_BI = normalizeQuaternion(measured_q_BI);
      covariance = cloneMatrix(p0);
      isInitialized = true;
      return true;
    }
    const innovation = smallAngleLog(errorQuaternion(q_ref_BI, measured_q_BI));
    const innovationCovariance = addMatrices(
      covariance.slice(0, 3).map((row) => row.slice(0, 3)),
      r,
    );
    const gain = multiplyMatrices(
      covariance.map((row) => row.slice(0, 3)),
      inverseMatrix(innovationCovariance, { strict: true }),
    );
    const correction = multiplyMatrixVector(gain, innovation);
    q_ref_BI = normalizeQuaternion(multiplyQuaternion(
      smallAngleExp([correction[0]!, correction[1]!, correction[2]!]),
      q_ref_BI,
    ));
    bias_rps = [
      bias_rps[0] + correction[3]!,
      bias_rps[1] + correction[4]!,
      bias_rps[2] + correction[5]!,
    ];

    const identityMinusGainH: Matrix6 = Array.from({ length: 6 }, (_, row) => Array.from(
      { length: 6 },
      (_, column) => row === column ? 1 : 0,
    ));
    // H selects the first three state components; fill the complete I-KH
    // block explicitly so the Joseph covariance update remains readable.
    for (let row = 0; row < 6; row += 1) {
      for (let column = 0; column < 3; column += 1) identityMinusGainH[row]![column] = (row === column ? 1 : 0) - gain[row]![column]!;
    }
    const posterior = symmetrize(addMatrices(
      multiplyMatrices(multiplyMatrices(identityMinusGainH, covariance), transpose(identityMinusGainH)),
      multiplyMatrices(multiplyMatrices(gain, r), transpose(gain)),
    ));
    // Multiplicative error injection changes the local attitude-error chart;
    // apply its first-order reset Jacobian after the Joseph covariance update.
    const reset = diagonal([1, 1, 1, 1, 1, 1]) as Matrix6;
    const correctionSkew = skew([correction[0]!, correction[1]!, correction[2]!]);
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) reset[row]![column] = (reset[row]![column] ?? 0) - correctionSkew[row]![column]!;
    }
    covariance = symmetrize(multiplyMatrices(multiplyMatrices(reset, posterior), transpose(reset)));
    return true;
  };

  return {
    get initialized() {
      return isInitialized;
    },
    step(sensor, dt_s) {
      const starTracker = starTrackerFromSensor(sensor);
      if (!isInitialized) {
        if (starTracker !== null) updateInternal(starTracker);
        return;
      }
      predictInternal(sensor.gyro_rps, dt_s);
      if (starTracker !== null) updateInternal(starTracker);
    },
    predict(gyro_rps, dt_s) {
      predictInternal(gyro_rps, dt_s);
    },
    update(star_tracker_q_BI) {
      return updateInternal(star_tracker_q_BI);
    },
    getAttDiag() {
      return {
        q_ref_BI: cloneQuat(q_ref_BI),
        bias_rps: cloneVec3(bias_rps),
        covariance: cloneMatrix(covariance),
        initialized: isInitialized,
      };
    },
  };
}
