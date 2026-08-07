import { MPC_HZ } from './constants.js';
import { CAPTURE_ENVELOPE, CORRIDOR } from './corridor.js';
import { cwDiscreteMatrices, type Matrix6, type State6 } from './ekf.js';
import { MEAN_MOTION_RAD_S } from './dynamics.js';
import { solveQp, type QpOptions, type QpStatus } from './qp.js';
import type { AccelerationAuthority } from './authority.js';
import type { AllocatorConfig } from './allocator.js';
import type { Vec3 } from './types.js';

type Matrix = number[][];

export interface MpcConfig {
  horizonSteps?: number;
  dt_s?: number;
  meanMotionRadS?: number;
  maxIterations?: number;
  convergenceTolerance?: number;
  /** Symmetric ±axis radii for the inscribed octahedron, in m/s². */
  authority_mps2?: Vec3;
  /** Alias accepted for callers that name the authority by its role. */
  axisAuthority_mps2?: Vec3;
  authority?: AccelerationAuthority;
  allocatorConfig?: AllocatorConfig;
  massEstimate_kg?: number;
  torqueReserve_Nm?: number;
  positionWeights?: Vec3;
  velocityWeights?: Vec3;
  effortWeight?: number;
  closingGain_s_inv?: number;
  maxApproachClosingSpeed_mps?: number;
  terminalTarget_hill_m?: Vec3;
  corridorSlackWeight?: number;
  terminalPositionSlackWeight?: number;
  terminalVelocitySlackWeight?: number;
}

export interface MpcSlacks {
  corridor_m: number;
  terminalPosition_m: number;
  terminalVelocity_mps: number;
}

export interface MpcDiagnostics {
  slacks: MpcSlacks;
  iterations: number;
  engagedStages: number[];
}

export interface MpcStepResult {
  accel_hill_mps2: Vec3;
  status: QpStatus;
  diagnostics: MpcDiagnostics;
  /** Exposed for analytic trajectory constraint oracles. */
  stackedAccel_hill_mps2: number[];
  predictedStates: State6[];
  referenceStates: State6[];
}

export interface MpcController {
  step(navState: State6, t_s: number): MpcStepResult;
  readonly horizonSteps: number;
  readonly dt_s: number;
  readonly authority_mps2: Vec3;
}

interface ConstraintRow {
  coefficients: number[];
  bound: number;
}

interface PredictionModel {
  offsets: State6[];
  sensitivities: Matrix[];
}

const DEFAULT_AUTHORITY_MPS2: Vec3 = [0.2, 0.2, 0.2];
const DEFAULT_POSITION_WEIGHTS: Vec3 = [0.08, 0.25, 0.08];
const DEFAULT_VELOCITY_WEIGHTS: Vec3 = [0.5, 0.8, 0.5];
const DEGREE_8 = Math.PI / 4;

function dot(left: number[], right: number[]): number {
  return left.reduce((sum, value, index) => sum + value * right[index]!, 0);
}

function matVec(matrix: Matrix, vector: number[]): number[] {
  return matrix.map((row) => dot(row, vector));
}

function multiply(left: Matrix, right: Matrix): Matrix {
  return left.map((row) => right[0]!.map((_, column) => row.reduce((sum, value, index) => sum + value * right[index]![column]!, 0)));
}

function transpose(matrix: Matrix): Matrix {
  return matrix[0]!.map((_, column) => matrix.map((row) => row[column]!));
}

function addToMatrix(target: Matrix, row: number, column: number, value: number): void {
  target[row]![column] = target[row]![column]! + value;
}

function matrixPower(base: Matrix, exponent: number): Matrix {
  let result: Matrix = base.map((row, rowIndex) => row.map((_, column) => rowIndex === column ? 1 : 0));
  for (let power = 0; power < exponent; power += 1) result = multiply(result, base);
  return result;
}

function stateError(reference: State6, state: State6): State6 {
  return state.map((value, index) => value - reference[index]!) as State6;
}

function validateVector(vector: Vec3, name: string): void {
  if (vector.length !== 3 || vector.some((value) => !(value > 0) || !Number.isFinite(value))) {
    throw new RangeError(`${name} must contain three positive finite values`);
  }
}

function validateFiniteVector(vector: Vec3, name: string): void {
  if (vector.length !== 3 || vector.some((value) => !Number.isFinite(value))) throw new RangeError(`${name} must contain three finite values`);
}

function predictModel(phiPowers: Matrix6[], gamma: Matrix, horizonSteps: number, state: State6): PredictionModel {
  const offsets = phiPowers.map((phi) => matVec(phi, state) as State6);
  const sensitivities: Matrix[] = [];
  for (let stage = 0; stage < horizonSteps; stage += 1) {
    const sensitivity: Matrix = Array.from({ length: 6 }, () => new Array<number>(3 * horizonSteps).fill(0));
    for (let inputStage = 0; inputStage <= stage; inputStage += 1) {
      const transition = phiPowers[stage - inputStage]!;
      const contribution = multiply(transition, gamma);
      for (let row = 0; row < 6; row += 1) {
        for (let axis = 0; axis < 3; axis += 1) sensitivity[row]![3 * inputStage + axis] = contribution[row]![axis]!;
      }
    }
    sensitivities.push(sensitivity);
  }
  return { offsets, sensitivities };
}

function makeReference(
  state: State6,
  horizonSteps: number,
  closingGain_s_inv: number,
  maxApproachClosingSpeed_mps: number,
  terminalTarget_hill_m: Vec3,
): State6[] {
  const delta: Vec3 = [state[0] - terminalTarget_hill_m[0], state[1] - terminalTarget_hill_m[1], state[2] - terminalTarget_hill_m[2]];
  const range_m = Math.hypot(...delta);
  const approachDirection: Vec3 = range_m > 1e-9
    ? [-delta[0] / range_m, -delta[1] / range_m, -delta[2] / range_m]
    : [0, 1, 0];
  // Terminal floor targets MID-envelope, not the bare 0.03 minimum: the
  // closed loop tracks the reference with sag, and a reference riding the
  // envelope floor arrives just BELOW it (observed 0.024 at contact) —
  // aiming at the middle keeps the achieved speed inside the window.
  const captureFloor_mps = (CAPTURE_ENVELOPE.closing_mps[0] + CAPTURE_ENVELOPE.closing_mps[1]) / 2;
  const closing_mps = range_m <= 10
    ? Math.min(CAPTURE_ENVELOPE.closing_mps[1], Math.max(captureFloor_mps, closingGain_s_inv * range_m))
    : Math.min(maxApproachClosingSpeed_mps, Math.max(CAPTURE_ENVELOPE.closing_mps[1], closingGain_s_inv * range_m));
  return Array.from({ length: horizonSteps }, (_, index) => {
    const travel_m = Math.min(range_m, closing_mps * (index + 1));
    const remaining = range_m > 1e-9 ? 1 - travel_m / range_m : 0;
    const position: Vec3 = [
      terminalTarget_hill_m[0] + delta[0] * remaining,
      terminalTarget_hill_m[1] + delta[1] * remaining,
      terminalTarget_hill_m[2] + delta[2] * remaining,
    ];
    const velocity: Vec3 = range_m <= 1e-9
      ? [state[3], state[4], state[5]]
      : [
        approachDirection[0] * closing_mps,
        approachDirection[1] * closing_mps,
        approachDirection[2] * closing_mps,
      ];
    return [...position, ...velocity] as State6;
  });
}

function addAuthorityConstraints(
  rows: ConstraintRow[],
  horizonSteps: number,
  authority: Vec3,
  variableCount: number,
): void {
  const signs = [-1, 1];
  for (let stage = 0; stage < horizonSteps; stage += 1) {
    for (const sx of signs) for (const sy of signs) for (const sz of signs) {
      const coefficients = new Array<number>(variableCount).fill(0);
      coefficients[3 * stage] = sx / authority[0];
      coefficients[3 * stage + 1] = sy / authority[1];
      coefficients[3 * stage + 2] = sz / authority[2];
      rows.push({ coefficients, bound: 1 });
    }
  }
}

function addSlackNonnegativeRows(rows: ConstraintRow[], variableCount: number, slackIndices: number[]): void {
  slackIndices.forEach((slackIndex) => {
    const coefficients = new Array<number>(variableCount).fill(0);
    coefficients[slackIndex] = -1;
    rows.push({ coefficients, bound: 0 });
  });
}

function addCorridorConstraints(
  rows: ConstraintRow[],
  model: PredictionModel,
  engagedStages: number[],
  corridorSlackIndex: number,
  variableCount: number,
): void {
  // The apothem correction makes the eight-sided pyramid an inner
  // approximation of the circular 10° cone, rather than a circumscribed one.
  const facetSlope = Math.tan(CORRIDOR.halfAngle_rad) * Math.cos(Math.PI / 8);
  for (const stage of engagedStages) {
    const sensitivity = model.sensitivities[stage]!;
    for (let facet = 0; facet < 8; facet += 1) {
      const angle = facet * DEGREE_8;
      const coefficients = new Array<number>(variableCount).fill(0);
      for (let input = 0; input < sensitivity[0]!.length; input += 1) {
        coefficients[input] = Math.cos(angle) * sensitivity[0]![input]!
          + facetSlope * sensitivity[1]![input]!
          + Math.sin(angle) * sensitivity[2]![input]!;
      }
      coefficients[corridorSlackIndex] = -1;
      const offset = model.offsets[stage]!;
      const bound = -(
        Math.cos(angle) * offset[0]
        + facetSlope * (offset[1] - CORRIDOR.apex_hill_m[1])
        + Math.sin(angle) * offset[2]
      );
      rows.push({ coefficients, bound });
    }
  }
}

function addTerminalConstraints(
  rows: ConstraintRow[],
  model: PredictionModel,
  state: State6,
  terminalPositionSlackIndex: number,
  terminalVelocitySlackIndex: number,
  variableCount: number,
): void {
  const terminal = model.offsets.length - 1;
  const sensitivity = model.sensitivities[terminal]!;
  const terminalState = model.offsets[terminal]!;
  const delta: Vec3 = [
    state[0] - CORRIDOR.apex_hill_m[0],
    state[1] - CORRIDOR.apex_hill_m[1],
    state[2] - CORRIDOR.apex_hill_m[2],
  ];
  const range_m = Math.hypot(...delta);
  const direction: Vec3 = range_m > 1e-9 ? [-delta[0] / range_m, -delta[1] / range_m, -delta[2] / range_m] : [0, 1, 0];
  const addStateRow = (stateRow: number[], sign: number, bound: number, slackIndex: number): void => {
    const coefficients = new Array<number>(variableCount).fill(0);
    for (let input = 0; input < sensitivity[0]!.length; input += 1) coefficients[input] = sign * dot(stateRow, sensitivity.map((row) => row[input]!));
    coefficients[slackIndex] = -1;
    rows.push({ coefficients, bound: sign > 0 ? bound - sign * dot(stateRow, terminalState) : bound - sign * dot(stateRow, terminalState) });
  };
  addStateRow([1, 0, 0, 0, 0, 0], 1, 0.10, terminalPositionSlackIndex);
  addStateRow([1, 0, 0, 0, 0, 0], -1, 0.10, terminalPositionSlackIndex);
  addStateRow([0, 0, 1, 0, 0, 0], 1, 0.10, terminalPositionSlackIndex);
  addStateRow([0, 0, 1, 0, 0, 0], -1, 0.10, terminalPositionSlackIndex);
  addStateRow([0, 0, 0, 1, 0, 0].map((value, index) => value * direction[index]!) as number[], 1, CAPTURE_ENVELOPE.closing_mps[1], terminalVelocitySlackIndex);
  addStateRow([0, 0, 0, 1, 0, 0].map((value, index) => value * direction[index]!) as number[], -1, -CAPTURE_ENVELOPE.closing_mps[0], terminalVelocitySlackIndex);
  // The four rows above need y/z velocity contributions too; replace the
  // compact direction rows with the full directional closing-rate rows.
  rows.splice(rows.length - 2, 2);
  const closingRow: number[] = [0, 0, 0, direction[0], direction[1], direction[2]];
  addStateRow(closingRow, 1, CAPTURE_ENVELOPE.closing_mps[1], terminalVelocitySlackIndex);
  addStateRow(closingRow, -1, -CAPTURE_ENVELOPE.closing_mps[0], terminalVelocitySlackIndex);
}

function buildReferenceSelectedStages(reference: State6[]): number[] {
  return reference.map((stage, index) => {
    const range_m = Math.hypot(
      stage[0] - CORRIDOR.apex_hill_m[0],
      stage[1] - CORRIDOR.apex_hill_m[1],
      stage[2] - CORRIDOR.apex_hill_m[2],
    );
    return stage[1] < 0 && range_m > CORRIDOR.captureDisengageRange_m && range_m <= CORRIDOR.engagementRange_m
      ? index
      : -1;
  }).filter((index) => index >= 0);
}

function decodePredictedStates(model: PredictionModel, stackedInput: number[], horizonSteps: number): State6[] {
  return model.offsets.map((offset, stage) => {
    const state = matVec(model.sensitivities[stage]!, stackedInput);
    return offset.map((value, index) => value + state[index]!) as State6;
  }).slice(0, horizonSteps);
}

function maximumViolation(rows: ConstraintRow[], vector: number[], slackIndex: number): number {
  let maximum = 0;
  rows.forEach((row) => {
    if (row.coefficients[slackIndex] === -1) {
      const violation = row.coefficients.reduce((sum, value, index) => index === slackIndex ? sum : sum + value * vector[index]!, 0) - row.bound;
      maximum = Math.max(maximum, violation);
    }
  });
  return maximum;
}

function buildProblem(
  state: State6,
  model: PredictionModel,
  reference: State6[],
  horizonSteps: number,
  authority: Vec3,
  options: { positionWeights: Vec3; velocityWeights: Vec3; effortWeight: number; corridorSlackWeight: number; terminalPositionSlackWeight: number; terminalVelocitySlackWeight: number },
): { H: Matrix; f: number[]; rows: ConstraintRow[]; x0: number[]; engagedStages: number[]; slackIndices: [number, number, number] } {
  const inputCount = 3 * horizonSteps;
  const corridorSlackIndex = inputCount;
  const terminalPositionSlackIndex = inputCount + 1;
  const terminalVelocitySlackIndex = inputCount + 2;
  const variableCount = inputCount + 3;
  const H = Array.from({ length: variableCount }, () => new Array<number>(variableCount).fill(0));
  const f = new Array<number>(variableCount).fill(0);
  for (let stage = 0; stage < horizonSteps; stage += 1) {
    const sensitivity = model.sensitivities[stage]!;
    const error = stateError(reference[stage]!, model.offsets[stage]!);
    for (let row = 0; row < 6; row += 1) {
      const weight = row < 3 ? options.positionWeights[row]! : options.velocityWeights[row - 3]!;
      for (let input = 0; input < inputCount; input += 1) {
        f[input] = f[input]! + weight * sensitivity[row]![input]! * error[row]!;
        for (let other = 0; other < inputCount; other += 1) addToMatrix(H, input, other, weight * sensitivity[row]![input]! * sensitivity[row]![other]!);
      }
    }
    for (let axis = 0; axis < 3; axis += 1) addToMatrix(H, 3 * stage + axis, 3 * stage + axis, options.effortWeight);
  }
  [
    [corridorSlackIndex, options.corridorSlackWeight],
    [terminalPositionSlackIndex, options.terminalPositionSlackWeight],
    [terminalVelocitySlackIndex, options.terminalVelocitySlackWeight],
  ].forEach(([index, weight]) => addToMatrix(H, index!, index!, weight!));
  const rows: ConstraintRow[] = [];
  addAuthorityConstraints(rows, horizonSteps, authority, variableCount);
  const referenceSelectedStages = buildReferenceSelectedStages(reference);
  addCorridorConstraints(rows, model, referenceSelectedStages, corridorSlackIndex, variableCount);
  const terminalRange = Math.hypot(
    reference[horizonSteps - 1]![0] - CORRIDOR.apex_hill_m[0],
    reference[horizonSteps - 1]![1] - CORRIDOR.apex_hill_m[1],
    reference[horizonSteps - 1]![2] - CORRIDOR.apex_hill_m[2],
  );
  if (terminalRange <= CORRIDOR.captureDisengageRange_m) {
    addTerminalConstraints(rows, model, state, terminalPositionSlackIndex, terminalVelocitySlackIndex, variableCount);
  }
  addSlackNonnegativeRows(rows, variableCount, [corridorSlackIndex, terminalPositionSlackIndex, terminalVelocitySlackIndex]);
  const corridorViolation = maximumViolation(rows, new Array<number>(variableCount).fill(0), corridorSlackIndex);
  const terminalPositionViolation = maximumViolation(rows, new Array<number>(variableCount).fill(0), terminalPositionSlackIndex);
  const terminalVelocityViolation = maximumViolation(rows, new Array<number>(variableCount).fill(0), terminalVelocitySlackIndex);
  const x0 = new Array<number>(variableCount).fill(0);
  x0[corridorSlackIndex] = Math.max(0, corridorViolation);
  x0[terminalPositionSlackIndex] = Math.max(0, terminalPositionViolation);
  x0[terminalVelocitySlackIndex] = Math.max(0, terminalVelocityViolation);
  return {
    H: H.map((row) => row.map((value) => 2 * value)),
    f: f.map((value) => 2 * value),
    rows,
    x0,
    engagedStages: referenceSelectedStages,
    slackIndices: [corridorSlackIndex, terminalPositionSlackIndex, terminalVelocitySlackIndex],
  };
}

function validateConfig(config: MpcConfig, authority: Vec3, horizonSteps: number, dt_s: number): void {
  validateVector(authority, 'authority_mps2');
  if (!Number.isInteger(horizonSteps) || horizonSteps <= 0) throw new RangeError('horizonSteps must be a positive integer');
  if (!(dt_s > 0) || !Number.isFinite(dt_s)) throw new RangeError('dt_s must be positive and finite');
  if (config.meanMotionRadS !== undefined && !Number.isFinite(config.meanMotionRadS)) throw new RangeError('meanMotionRadS must be finite');
}

/** Create a condensed, deterministic 1 Hz CW MPC controller. */
export function createMpc(config: MpcConfig = {}): MpcController {
  const horizonSteps = config.horizonSteps ?? 30;
  const dt_s = config.dt_s ?? 1;
  const meanMotionRadS = config.meanMotionRadS ?? MEAN_MOTION_RAD_S;
  const authority = config.authority?.symmetric_mps2
    ?? config.authority_mps2
    ?? config.axisAuthority_mps2
    ?? DEFAULT_AUTHORITY_MPS2;
  validateConfig(config, authority, horizonSteps, dt_s);
  const positionWeights = config.positionWeights ?? DEFAULT_POSITION_WEIGHTS;
  const velocityWeights = config.velocityWeights ?? DEFAULT_VELOCITY_WEIGHTS;
  const effortWeight = config.effortWeight ?? 0.2;
  const corridorSlackWeight = config.corridorSlackWeight ?? 2_000;
  const terminalPositionSlackWeight = config.terminalPositionSlackWeight ?? 10_000;
  const terminalVelocitySlackWeight = config.terminalVelocitySlackWeight ?? 10_000;
  const closingGain_s_inv = config.closingGain_s_inv ?? 0.01;
  const maxApproachClosingSpeed_mps = config.maxApproachClosingSpeed_mps ?? 0.5;
  // Default terminal target is the chaser COM position at port-to-port
  // contact (station port −8.7 minus the 1.7 m chaser nose offset), NOT the
  // port itself — targeting the apex would command the nose 1.7 m into the
  // station structure.
  const terminalTarget_hill_m = config.terminalTarget_hill_m
    ?? [CORRIDOR.apex_hill_m[0], CORRIDOR.apex_hill_m[1] - 1.7, CORRIDOR.apex_hill_m[2]] as Vec3;
  validateVector(positionWeights, 'positionWeights');
  validateVector(velocityWeights, 'velocityWeights');
  validateFiniteVector(terminalTarget_hill_m, 'terminalTarget_hill_m');
  if (!(closingGain_s_inv > 0) || !Number.isFinite(closingGain_s_inv)) throw new RangeError('closingGain_s_inv must be positive and finite');
  if (!(maxApproachClosingSpeed_mps > 0) || !Number.isFinite(maxApproachClosingSpeed_mps)) throw new RangeError('maxApproachClosingSpeed_mps must be positive and finite');
  if ([effortWeight, corridorSlackWeight, terminalPositionSlackWeight, terminalVelocitySlackWeight].some((value) => !(value > 0) || !Number.isFinite(value))) throw new RangeError('MPC weights must be positive and finite');
  const matrices = cwDiscreteMatrices(meanMotionRadS, dt_s);
  const phiPowers = Array.from({ length: horizonSteps }, (_, index) => matrixPower(matrices.phi, index + 1) as Matrix6);
  let lastSolveTime_s: number | null = null;
  let lastResult: MpcStepResult | null = null;
  let lastCommand: Vec3 = [0, 0, 0];
  const qpOptions: QpOptions = {
    maxIterations: config.maxIterations ?? 50,
    tolerance: config.convergenceTolerance ?? 1e-8,
  };

  return {
    horizonSteps,
    dt_s,
    authority_mps2: [...authority],
    step(navState, t_s) {
      if (navState.length !== 6 || navState.some((value) => !Number.isFinite(value))) throw new RangeError('navState must be a finite six-state vector');
      if (!Number.isFinite(t_s) || t_s < 0) throw new RangeError('t_s must be finite and non-negative');
      if (lastSolveTime_s !== null && t_s < lastSolveTime_s) throw new RangeError('MPC timestamps must be non-decreasing');
      if (lastResult !== null && lastSolveTime_s !== null && t_s - lastSolveTime_s < 1 / MPC_HZ - 1e-9) {
        return {
          ...lastResult,
          accel_hill_mps2: [...lastCommand],
          stackedAccel_hill_mps2: [...lastResult.stackedAccel_hill_mps2],
          predictedStates: lastResult.predictedStates.map((state) => [...state] as State6),
          referenceStates: lastResult.referenceStates.map((state) => [...state] as State6),
          diagnostics: { ...lastResult.diagnostics, slacks: { ...lastResult.diagnostics.slacks }, engagedStages: [...lastResult.diagnostics.engagedStages] },
        };
      }
      const reference = makeReference(navState, horizonSteps, closingGain_s_inv, maxApproachClosingSpeed_mps, terminalTarget_hill_m);
      const model = predictModel(phiPowers, matrices.gamma, horizonSteps, navState);
      const problem = buildProblem(navState, model, reference, horizonSteps, authority, {
        positionWeights,
        velocityWeights,
        effortWeight,
        corridorSlackWeight,
        terminalPositionSlackWeight,
        terminalVelocitySlackWeight,
      });
      const result = solveQp(
        problem.H,
        problem.f,
        problem.rows.map((row) => row.coefficients),
        problem.rows.map((row) => row.bound),
        problem.x0,
        qpOptions,
      );
      const stacked = result.u.slice(0, 3 * horizonSteps);
      const predictedStates = decodePredictedStates(model, stacked, horizonSteps);
      const slacks: MpcSlacks = {
        corridor_m: Math.max(0, result.u[problem.slackIndices[0]] ?? 0),
        terminalPosition_m: Math.max(0, result.u[problem.slackIndices[1]] ?? 0),
        terminalVelocity_mps: Math.max(0, result.u[problem.slackIndices[2]] ?? 0),
      };
      const solvedCommand: Vec3 = [stacked[0] ?? 0, stacked[1] ?? 0, stacked[2] ?? 0];
      if (result.status === 'optimal') lastCommand = solvedCommand;
      lastSolveTime_s = t_s;
      lastResult = {
        accel_hill_mps2: [...(result.status === 'optimal' ? solvedCommand : lastCommand)],
        status: result.status,
        diagnostics: { slacks, iterations: result.iterations, engagedStages: [...problem.engagedStages] },
        stackedAccel_hill_mps2: stacked,
        predictedStates,
        referenceStates: reference,
      };
      return {
        ...lastResult,
        accel_hill_mps2: [...lastResult.accel_hill_mps2],
        stackedAccel_hill_mps2: [...stacked],
        predictedStates: predictedStates.map((state) => [...state] as State6),
        referenceStates: reference.map((state) => [...state] as State6),
        diagnostics: { ...lastResult.diagnostics, slacks: { ...slacks }, engagedStages: [...problem.engagedStages] },
      };
    },
  };
}
