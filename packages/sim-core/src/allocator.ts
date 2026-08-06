import { FSW_HZ, TRUTH_HZ } from './constants.js';
import { solveLinearSystem } from './linalg.js';
import {
  DEFAULT_MIN_ON_TIME_S,
  DRACO_THRUSTER_SPECS,
} from './thrusters.js';
import type { ThrusterSpec } from './thrusters.js';
import type { ThrusterCommand, Vec3 } from './types.js';

export interface AllocatorConfig {
  specs?: readonly ThrusterSpec[];
  fswHz?: number;
  truthHz?: number;
  minOnTime_s?: number;
  /** Optional scalar weight applied to force rows. */
  forceWeight?: number;
  /** Weight applied to torque rows; defaults from characteristicArm_m. */
  torqueWeight?: number;
  /**
   * Maximum force back-off halvings when torque tracking is being sacrificed
   * (default 6, i.e. force may shrink to 1/64). Attitude authority must win
   * under saturation: an unmet force command just translates slower, but an
   * unmet torque command tumbles the vehicle (the v0.4.0 manual-translation
   * tumble). Implemented as lexicographic back-off rather than skewed row
   * weights because the active-set solve is only exactness-proven at
   * comparable row scales.
   */
  maxForceBackoffs?: number;
  /** Optional per-axis force row weights. */
  forceWeights?: Vec3;
  /** Optional per-axis torque row weights. */
  torqueWeights?: Vec3;
  /** Physical arm used to make force and torque rows comparable. */
  characteristicArm_m?: number;
  forceResidualFloor_N?: number;
  torqueResidualFloor_Nm?: number;
  maxIterations?: number;
  availableMask?: Partial<Record<string, boolean>>;
  availabilityMask?: Partial<Record<string, boolean>>;
  isolatedIds?: readonly string[];
}

export interface ThrusterAllocation {
  /** Final command after deadband and truth-tick quantization. */
  onTimes: ThrusterCommand;
  /** Force residual from the bounded solve, before deadband/quantization. */
  solveResidual_N: Vec3;
  /** Torque residual from the bounded solve, before deadband/quantization. */
  solveTorqueResidual_Nm: Vec3;
  satFlag: boolean;
  /** Exposed for truth-side bookkeeping and actuator diagnostics. */
  preQuantizedOnTimes_s: ThrusterCommand;
  achievedForce_N: Vec3;
  achievedTorque_Nm: Vec3;
  achievedQuantizedForce_N: Vec3;
  achievedQuantizedTorque_Nm: Vec3;
}

export interface ThrusterAllocator {
  allocate(
    commandedForce_N: Vec3,
    commandedTorque_Nm: Vec3,
    availableMask?: Partial<Record<string, boolean>>,
  ): ThrusterAllocation;
}

interface LinearSystem {
  matrix: number[][];
  target: number[];
  specs: readonly ThrusterSpec[];
  window_s: number;
}

type BoundStatus = -1 | 0 | 1;

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function norm(v: Vec3): number {
  return Math.hypot(...v);
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function multiplyMatrixVector(matrix: number[][], vector: number[]): number[] {
  return matrix.map((row) => row.reduce((sum, value, index) => sum + value * (vector[index] ?? 0), 0));
}

function forceTorqueForTimes(specs: readonly ThrusterSpec[], onTimes_s: number[], window_s: number): { force_N: Vec3; torque_Nm: Vec3 } {
  const force_N: Vec3 = [0, 0, 0];
  const torque_Nm: Vec3 = [0, 0, 0];
  specs.forEach((spec, index) => {
    const forceMagnitude_N = spec.thrust_N * (onTimes_s[index] ?? 0) / window_s;
    const force: Vec3 = [
      spec.direction_body[0] * forceMagnitude_N,
      spec.direction_body[1] * forceMagnitude_N,
      spec.direction_body[2] * forceMagnitude_N,
    ];
    force_N[0] += force[0];
    force_N[1] += force[1];
    force_N[2] += force[2];
    const torque = cross(spec.position_body_m, force);
    torque_Nm[0] += torque[0];
    torque_Nm[1] += torque[1];
    torque_Nm[2] += torque[2];
  });
  return { force_N, torque_Nm };
}

function buildSystem(
  commandedForce_N: Vec3,
  commandedTorque_Nm: Vec3,
  specs: readonly ThrusterSpec[],
  window_s: number,
  forceWeights: Vec3,
  torqueWeights: Vec3,
): LinearSystem {
  const matrix = specs.map((spec) => {
    const forceScale_N_s = spec.thrust_N / window_s;
    const torquePerOnTime_Nm_s = cross(spec.position_body_m, [
      spec.direction_body[0] * forceScale_N_s,
      spec.direction_body[1] * forceScale_N_s,
      spec.direction_body[2] * forceScale_N_s,
    ]);
    return [
      spec.direction_body[0] * forceScale_N_s * forceWeights[0],
      spec.direction_body[1] * forceScale_N_s * forceWeights[1],
      spec.direction_body[2] * forceScale_N_s * forceWeights[2],
      torquePerOnTime_Nm_s[0] * torqueWeights[0],
      torquePerOnTime_Nm_s[1] * torqueWeights[1],
      torquePerOnTime_Nm_s[2] * torqueWeights[2],
    ];
  });
  return {
    matrix: [0, 1, 2, 3, 4, 5].map((row) => matrix.map((column) => column[row] ?? 0)),
    target: [
      commandedForce_N[0] * forceWeights[0],
      commandedForce_N[1] * forceWeights[1],
      commandedForce_N[2] * forceWeights[2],
      commandedTorque_Nm[0] * torqueWeights[0],
      commandedTorque_Nm[1] * torqueWeights[1],
      commandedTorque_Nm[2] * torqueWeights[2],
    ],
    specs,
    window_s,
  };
}


/** Solve the current free-variable least-squares subproblem. */
function solveFreeVariables(
  system: LinearSystem,
  x: number[],
  freeIndices: number[],
): number[] {
  const residualTarget = system.target.map((target, row) => target - system.matrix[row]!.reduce(
    (sum, coefficient, column) => sum + coefficient * (x[column] ?? 0),
    0,
  ));
  const normalMatrix = freeIndices.map((freeColumn) => freeIndices.map((otherColumn) => system.matrix.reduce(
    (sum, row) => sum + row[freeColumn]! * row[otherColumn]!,
    0,
  )));
  const normalRightHandSide = freeIndices.map((freeColumn) => system.matrix.reduce(
    (sum, row, rowIndex) => sum + row[freeColumn]! * residualTarget[rowIndex]!,
    0,
  ));
  const regularization = Math.max(1, ...normalMatrix.flat().map(Math.abs)) * 1e-10;
  normalMatrix.forEach((row, index) => { row[index] = (row[index] ?? 0) + regularization; });
  return solveLinearSystem(normalMatrix, normalRightHandSide);
}

function gradient(system: LinearSystem, x: number[]): number[] {
  const residual = multiplyMatrixVector(system.matrix, x).map((value, row) => value - (system.target[row] ?? 0));
  return system.matrix[0]!.map((_, column) => system.matrix.reduce(
    (sum, row, rowIndex) => sum + row[column]! * residual[rowIndex]!,
    0,
  ));
}

/**
 * Bounded active-set NNLS. Variables start at their lower bound, enter the
 * free set from the KKT gradient, and are moved to bounds by line search.
 * This is intentionally a bounded solve rather than an unconstrained solve
 * followed by clamping.
 */
function boundedActiveSetSolve(system: LinearSystem, upperBound_s: number, maxIterations: number): number[] {
  const variableCount = system.specs.length;
  const x = new Array<number>(variableCount).fill(0);
  const status = new Array<BoundStatus>(variableCount).fill(-1);
  const tolerance = 1e-8;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let gradients = gradient(system, x);
    let releaseIndex = -1;
    let releaseViolation = tolerance;
    for (let index = 0; index < variableCount; index += 1) {
      const violation = status[index] === -1 ? -gradients[index]! : status[index] === 1 ? gradients[index]! : -1;
      if (violation > releaseViolation) {
        releaseViolation = violation;
        releaseIndex = index;
      }
    }
    if (releaseIndex >= 0) status[releaseIndex] = 0;

    const freeIndices = status.flatMap((bound, index) => bound === 0 ? [index] : []);
    if (freeIndices.length === 0) return x;
    const freeDirections = solveFreeVariables(system, x, freeIndices);
    const candidateValues = freeDirections.map((direction, index) => direction + (x[freeIndices[index]!] ?? 0));
    let stepFraction = 1;
    let limitingIndex = -1;
    let limitingStatus: BoundStatus = -1;
    for (let candidateIndex = 0; candidateIndex < freeIndices.length; candidateIndex += 1) {
      const index = freeIndices[candidateIndex]!;
      const candidate = candidateValues[candidateIndex] ?? 0;
      const current = x[index] ?? 0;
      if (candidate < 0 && candidate < current) {
        const fraction = current / (current - candidate);
        if (fraction < stepFraction) {
          stepFraction = fraction;
          limitingIndex = index;
          limitingStatus = -1;
        }
      } else if (candidate > upperBound_s && candidate > current) {
        const fraction = (upperBound_s - current) / (candidate - current);
        if (fraction < stepFraction) {
          stepFraction = fraction;
          limitingIndex = index;
          limitingStatus = 1;
        }
      }
    }
    freeIndices.forEach((index, candidateIndex) => {
      const current = x[index] ?? 0;
      const candidate = candidateValues[candidateIndex] ?? 0;
      x[index] = current + stepFraction * (candidate - current);
    });
    if (limitingIndex >= 0) {
      x[limitingIndex] = limitingStatus === 1 ? upperBound_s : 0;
      status[limitingIndex] = limitingStatus;
      continue;
    }
    freeIndices.forEach((index, candidateIndex) => { x[index] = candidateValues[candidateIndex] ?? 0; });
    gradients = gradient(system, x);
    let kktViolation = -1;
    let kktIndex = -1;
    for (let index = 0; index < variableCount; index += 1) {
      const violation = status[index] === -1 ? -gradients[index]! : status[index] === 1 ? gradients[index]! : 0;
      if (violation > kktViolation) {
        kktViolation = violation;
        kktIndex = index;
      }
    }
    if (kktIndex < 0 || kktViolation <= tolerance) return x;
    status[kktIndex] = 0;
  }
  return x;
}

function resolveAvailableSpecs(config: AllocatorConfig, maskOverride?: Partial<Record<string, boolean>>): readonly ThrusterSpec[] {
  const mask = maskOverride ?? config.availableMask ?? config.availabilityMask;
  const isolated = new Set(config.isolatedIds ?? []);
  return (config.specs ?? DRACO_THRUSTER_SPECS).filter((spec) => mask?.[spec.id] !== false && !isolated.has(spec.id));
}

function validateAllocatorConfig(config: AllocatorConfig): void {
  const fswHz = config.fswHz ?? FSW_HZ;
  const truthHz = config.truthHz ?? TRUTH_HZ;
  const minOnTime_s = config.minOnTime_s ?? DEFAULT_MIN_ON_TIME_S;
  const forceWeight = config.forceWeight ?? 1;
  const characteristicArm_m = config.characteristicArm_m ?? 1;
  const torqueWeight = config.torqueWeight ?? forceWeight / characteristicArm_m;
  const floors = [config.forceResidualFloor_N ?? 0.05, config.torqueResidualFloor_Nm ?? 0.05];
  const weights = [forceWeight, torqueWeight, ...(config.forceWeights ?? []), ...(config.torqueWeights ?? [])];
  if (![fswHz, truthHz, minOnTime_s, characteristicArm_m, ...floors, ...weights]
    .every((value) => Number.isFinite(value) && value > 0)) {
    throw new RangeError('allocator configuration must be finite and positive');
  }
  if (config.maxForceBackoffs !== undefined && (!Number.isInteger(config.maxForceBackoffs) || config.maxForceBackoffs < 0)) {
    throw new RangeError('maxForceBackoffs must be a non-negative integer');
  }
  if (config.forceWeights?.length !== undefined && config.forceWeights.length !== 3) throw new RangeError('forceWeights must have three axes');
  if (config.torqueWeights?.length !== undefined && config.torqueWeights.length !== 3) throw new RangeError('torqueWeights must have three axes');
}

function makeAllocator(config: AllocatorConfig): ThrusterAllocator {
  validateAllocatorConfig(config);
  const fswHz = config.fswHz ?? FSW_HZ;
  const truthHz = config.truthHz ?? TRUTH_HZ;
  const minOnTime_s = config.minOnTime_s ?? DEFAULT_MIN_ON_TIME_S;
  const forceWeight = config.forceWeight ?? 1;
  const characteristicArm_m = config.characteristicArm_m ?? 1;
  const torqueWeight = config.torqueWeight ?? forceWeight / characteristicArm_m;
  const maxForceBackoffs = config.maxForceBackoffs ?? 6;
  const forceWeights = config.forceWeights ?? [forceWeight, forceWeight, forceWeight];
  const torqueWeights = config.torqueWeights ?? [torqueWeight, torqueWeight, torqueWeight];
  const forceResidualFloor_N = config.forceResidualFloor_N ?? 0.05;
  const torqueResidualFloor_Nm = config.torqueResidualFloor_Nm ?? 0.05;
  const window_s = 1 / fswHz;
  const maxIterations = config.maxIterations ?? 256;
  // FSW-side min-impulse accumulator state (like a PID integrator): carries
  // sub-min-impulse on-time demand across ticks so average thrust is honored.
  const impulseCarry_s: Record<string, number> = {};
  return {
    allocate(commandedForce_N, commandedTorque_Nm, availableMask) {
      const specs = resolveAvailableSpecs(config, availableMask);
      // Lexicographic torque priority via force back-off: solve at balanced
      // weights (the regime the active-set solve is exactness-proven in); if
      // torque tracking was sacrificed to chase an infeasible force demand,
      // halve the force command and re-solve. An unmet force command just
      // translates slower — an unmet torque command tumbles the vehicle.
      const torqueTolerance_Nm = Math.max(torqueResidualFloor_Nm, 0.05 * norm(commandedTorque_Nm));
      let forceScale = 1;
      let solvedOnTimes = boundedActiveSetSolve(
        buildSystem(commandedForce_N, commandedTorque_Nm, specs, window_s, forceWeights, torqueWeights),
        window_s,
        maxIterations,
      );
      let preResult = forceTorqueForTimes(specs, solvedOnTimes, window_s);
      for (let backoff = 0; backoff < maxForceBackoffs; backoff += 1) {
        const torqueResidual_Nm = norm(subtract(commandedTorque_Nm, preResult.torque_Nm));
        if (torqueResidual_Nm <= torqueTolerance_Nm) break;
        forceScale /= 2;
        const scaledForce_N = commandedForce_N.map((value) => value * forceScale) as Vec3;
        solvedOnTimes = boundedActiveSetSolve(
          buildSystem(scaledForce_N, commandedTorque_Nm, specs, window_s, forceWeights, torqueWeights),
          window_s,
          maxIterations,
        );
        preResult = forceTorqueForTimes(specs, solvedOnTimes, window_s);
      }
      // Residuals report against the ORIGINAL command so sat_flag correctly
      // reflects any back-off as unmet force demand.
      const solveResidual_N = subtract(commandedForce_N, preResult.force_N);
      const solveTorqueResidual_Nm = subtract(commandedTorque_Nm, preResult.torque_Nm);
      const forceThreshold_N = Math.max(forceResidualFloor_N, 0.05 * norm(commandedForce_N));
      const torqueThreshold_Nm = Math.max(torqueResidualFloor_Nm, 0.05 * norm(commandedTorque_Nm));
      const satFlag = norm(solveResidual_N) > forceThreshold_N || norm(solveTorqueResidual_Nm) > torqueThreshold_Nm;
      const preQuantizedOnTimes_s: ThrusterCommand = {};
      const onTimes: ThrusterCommand = {};
      const quantizedValues: number[] = [];
      const tick_s = 1 / truthHz;
      for (const spec of config.specs ?? DRACO_THRUSTER_SPECS) {
        const availableIndex = specs.findIndex((availableSpec) => availableSpec.id === spec.id);
        const solved = availableIndex >= 0 ? solvedOnTimes[availableIndex] ?? 0 : 0;
        preQuantizedOnTimes_s[spec.id] = solved;
        // Min-impulse handling via a per-jet impulse ACCUMULATOR (PWM across
        // FSW cycles, the standard real-RCS approach): sub-minimum demand is
        // carried to later ticks instead of being deadbanded away. A naive
        // per-tick deadband silently zeroed every torque-balanced (spread-out)
        // or fine-control solution — the vehicle got NO thrust at all from
        // small commands, which is what let attitude drift unopposed.
        const accumulated = (impulseCarry_s[spec.id] ?? 0) + solved;
        const fireable = Math.min(window_s, Math.floor(accumulated / tick_s + 1e-9) * tick_s);
        if (availableIndex >= 0 && fireable >= minOnTime_s) {
          onTimes[spec.id] = fireable;
          impulseCarry_s[spec.id] = accumulated - fireable;
        } else {
          onTimes[spec.id] = 0;
          // Carry decays instead of accumulating forever on masked/idle jets.
          impulseCarry_s[spec.id] = availableIndex >= 0 ? accumulated : 0;
        }
        quantizedValues.push(onTimes[spec.id]!);
      }
      const quantizedResult = forceTorqueForTimes(config.specs ?? DRACO_THRUSTER_SPECS, quantizedValues, window_s);
      return {
        onTimes,
        solveResidual_N,
        solveTorqueResidual_Nm,
        satFlag,
        preQuantizedOnTimes_s,
        achievedForce_N: preResult.force_N,
        achievedTorque_Nm: preResult.torque_Nm,
        achievedQuantizedForce_N: quantizedResult.force_N,
        achievedQuantizedTorque_Nm: quantizedResult.torque_Nm,
      };
    },
  };
}

/** Create an allocator with fixed FSW bounds and availability configuration. */
export function createAllocator(config: AllocatorConfig = {}): ThrusterAllocator {
  return makeAllocator(config);
}

/** Stateless convenience wrapper for one force+torque request. */
export function allocateThrusters(
  commandedForce_N: Vec3,
  commandedTorque_Nm: Vec3,
  config: AllocatorConfig = {},
): ThrusterAllocation {
  return makeAllocator(config).allocate(commandedForce_N, commandedTorque_Nm);
}
