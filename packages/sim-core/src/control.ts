import { MEAN_MOTION_RAD_S } from './dynamics.js';
import { cwDiscreteMatrices, type Matrix6, type State6 } from './ekf.js';
import type { GuidanceReference } from './guidance.js';
import type { Vec3 } from './types.js';

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

function asVec3(value: number | Vec3): Vec3 {
  return typeof value === 'number' ? [value, value, value] : [...value];
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
