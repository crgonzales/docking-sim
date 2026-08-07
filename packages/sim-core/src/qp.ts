import { solveLinearSystemStrict } from './linalg.js';

export interface QpOptions {
  /** Maximum number of active-set iterations. Defaults to 50. */
  maxIterations?: number;
  /** Absolute feasibility/KKT tolerance. Defaults to 1e-9. */
  tolerance?: number;
  /** Alias for maxIterations for callers that use the plan's terminology. */
  iterationCap?: number;
}

export type QpStatus = 'optimal' | 'iteration_capped' | 'numerical_failure';

export interface QpResult {
  u: number[];
  /** Constraint row indices in the final working set. */
  active: number[];
  status: QpStatus;
  iterations: number;
}

interface EqualityStep {
  direction: number[];
  multipliers: number[];
}

function isFiniteVector(vector: number[]): boolean {
  return vector.every((value) => Number.isFinite(value));
}

function infinityNorm(vector: number[]): number {
  return vector.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
}

function dot(left: number[], right: number[]): number {
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result += left[index]! * right[index]!;
  return result;
}

function matrixVectorMultiply(matrix: number[][], vector: number[]): number[] {
  return matrix.map((row) => dot(row, vector));
}

function validateProblem(H: number[][], f: number[], A: number[][], b: number[], x0: number[]): boolean {
  const dimension = f.length;
  return H.length === dimension
    && H.every((row) => row.length === dimension && isFiniteVector(row))
    && isFiniteVector(f)
    && A.length === b.length
    && A.every((row) => row.length === dimension && isFiniteVector(row))
    && isFiniteVector(b)
    && x0.length === dimension
    && isFiniteVector(x0);
}

function solveEqualityConstrainedStep(
  H: number[][],
  gradient: number[],
  A: number[][],
  active: number[],
): EqualityStep {
  const dimension = gradient.length;
  if (active.length === 0) {
    return {
      direction: solveLinearSystemStrict(H, gradient.map((value) => -value)),
      multipliers: [],
    };
  }

  const systemSize = dimension + active.length;
  const matrix = Array.from({ length: systemSize }, () => Array(systemSize).fill(0));
  const rightHandSide = Array(systemSize).fill(0);

  for (let row = 0; row < dimension; row += 1) {
    for (let column = 0; column < dimension; column += 1) matrix[row]![column] = H[row]![column]!;
    rightHandSide[row] = -gradient[row]!;
  }
  for (let activeIndex = 0; activeIndex < active.length; activeIndex += 1) {
    const constraint = A[active[activeIndex]!]!;
    const systemIndex = dimension + activeIndex;
    for (let column = 0; column < dimension; column += 1) {
      matrix[column]![systemIndex] = constraint[column]!;
      matrix[systemIndex]![column] = constraint[column]!;
    }
  }

  const solution = solveLinearSystemStrict(matrix, rightHandSide);
  return {
    direction: solution.slice(0, dimension),
    multipliers: solution.slice(dimension),
  };
}

/**
 * Solve a strictly convex dense QP with a primal active-set method.
 *
 * The caller must provide a feasible starting point. Constraints use the
 * convention A*u <= b. Entering constraints are selected by the largest
 * blocking step, with the lowest row index breaking ties.
 */
export function solveQp(
  H: number[][],
  f: number[],
  A: number[][],
  b: number[],
  x0: number[],
  options: QpOptions = {},
): QpResult {
  const tolerance = options.tolerance ?? 1e-9;
  const maxIterations = options.maxIterations ?? options.iterationCap ?? 50;
  const fallback = { u: [...x0], active: [], status: 'numerical_failure' as QpStatus, iterations: 0 };

  if (!Number.isFinite(tolerance) || tolerance <= 0 || !Number.isInteger(maxIterations) || maxIterations < 0) {
    return fallback;
  }
  if (!validateProblem(H, f, A, b, x0)) return fallback;

  const initialSlack = b.map((bound, row) => bound - dot(A[row]!, x0));
  if (initialSlack.some((slack) => slack < -tolerance)) return fallback;
  if (maxIterations === 0) {
    return { u: [...x0], active: [], status: 'iteration_capped', iterations: 0 };
  }

  let u = [...x0];
  const active = new Set<number>();
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations += 1;
    const activeRows = [...active].sort((left, right) => left - right);
    const gradient = matrixVectorMultiply(H, u).map((value, index) => value + f[index]!);
    let step: EqualityStep;
    try {
      step = solveEqualityConstrainedStep(H, gradient, A, activeRows);
    } catch {
      return { u, active: activeRows, status: 'numerical_failure', iterations };
    }
    if (!isFiniteVector(step.direction) || !isFiniteVector(step.multipliers)) {
      return { u, active: activeRows, status: 'numerical_failure', iterations };
    }

    const scale = Math.max(1, infinityNorm(u), infinityNorm(gradient));
    const stepTolerance = tolerance * scale;
    if (infinityNorm(step.direction) <= stepTolerance) {
      let leavingPosition = -1;
      let mostNegative = -tolerance;
      for (let index = 0; index < step.multipliers.length; index += 1) {
        const multiplier = step.multipliers[index]!;
        if (multiplier < mostNegative) {
          mostNegative = multiplier;
          leavingPosition = index;
        }
      }
      if (leavingPosition < 0) {
        return { u, active: activeRows, status: 'optimal', iterations };
      }
      active.delete(activeRows[leavingPosition]!);
      continue;
    }

    let stepLength = 1;
    let blockingConstraint: number | null = null;
    for (let row = 0; row < A.length; row += 1) {
      if (active.has(row)) continue;
      const directionalChange = dot(A[row]!, step.direction);
      if (directionalChange <= tolerance) continue;
      const slack = b[row]! - dot(A[row]!, u);
      const candidate = Math.max(0, slack / directionalChange);
      if (candidate < stepLength - tolerance
        || (Math.abs(candidate - stepLength) <= tolerance
          && (blockingConstraint === null || row < blockingConstraint))) {
        stepLength = candidate;
        blockingConstraint = row;
      }
    }

    for (let index = 0; index < u.length; index += 1) {
      u[index] = u[index]! + stepLength * step.direction[index]!;
    }
    if (!isFiniteVector(u)) return { u, active: activeRows, status: 'numerical_failure', iterations };
    if (blockingConstraint !== null) active.add(blockingConstraint);
  }

  return {
    u,
    active: [...active].sort((left, right) => left - right),
    status: 'iteration_capped',
    iterations,
  };
}
