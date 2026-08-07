import { describe, expect, it } from 'vitest';
import { solveLinearSystemStrict } from './linalg.js';
import { solveQp, type QpResult } from './qp.js';

const TOLERANCE = 1e-9;

function dot(left: number[], right: number[]): number {
  return left.reduce((sum, value, index) => sum + value * right[index]!, 0);
}

function matVec(matrix: number[][], vector: number[]): number[] {
  return matrix.map((row) => dot(row, vector));
}

function activeMultipliers(
  H: number[][],
  f: number[],
  A: number[][],
  result: QpResult,
): number[] {
  if (result.active.length === 0) return [];
  const gradient = matVec(H, result.u).map((value, index) => value + f[index]!);
  const activeRows = result.active.map((row) => A[row]!);
  const gram = activeRows.map((left) => activeRows.map((right) => dot(left, right)));
  const rightHandSide = activeRows.map((row) => -dot(row, gradient));
  return solveLinearSystemStrict(gram, rightHandSide);
}

function assertKkt(H: number[][], f: number[], A: number[][], b: number[], result: QpResult): void {
  expect(result.status).toBe('optimal');
  const multipliers = activeMultipliers(H, f, A, result);
  const gradient = matVec(H, result.u).map((value, index) => value + f[index]!);
  const stationarity = [...gradient];
  result.active.forEach((row, activeIndex) => {
    A[row]!.forEach((value, column) => {
      stationarity[column] = stationarity[column]! + value * multipliers[activeIndex]!;
    });
  });
  stationarity.forEach((value) => expect(Math.abs(value)).toBeLessThan(TOLERANCE));
  A.forEach((row, rowIndex) => {
    const slack = b[rowIndex]! - dot(row, result.u);
    expect(slack).toBeGreaterThanOrEqual(-TOLERANCE);
  });
  result.active.forEach((row, activeIndex) => {
    expect(multipliers[activeIndex]).toBeGreaterThanOrEqual(-TOLERANCE);
    expect(b[row]! - dot(A[row]!, result.u)).toBeCloseTo(0, 8);
  });
}

describe('solveQp (analytic KKT oracle)', () => {
  it('solves a hand-computable QP with the known active set', () => {
    const H = [[2, 0], [0, 2]];
    const f = [-2, -4];
    const A = [[1, 1]];
    const b = [2];
    const result = solveQp(H, f, A, b, [0, 0]);

    expect(result.u[0]).toBeCloseTo(0.5, 12);
    expect(result.u[1]).toBeCloseTo(1.5, 12);
    expect(result.active).toEqual([0]);
    assertKkt(H, f, A, b, result);
  });

  it('matches the closed-form unconstrained solution -H^-1 f', () => {
    const H = [[4, 1], [1, 3]];
    const f = [2, -1];
    const result = solveQp(H, f, [], [], [0, 0]);

    expect(result.status).toBe('optimal');
    expect(result.active).toEqual([]);
    expect(result.u[0]).toBeCloseTo(-7 / 11, 12);
    expect(result.u[1]).toBeCloseTo(6 / 11, 12);
  });

  it('reports an iteration cap when the cap is too small', () => {
    const result = solveQp(
      [[2, 0], [0, 2]],
      [-2, -4],
      [[1, 1]],
      [2],
      [0, 0],
      { maxIterations: 1 },
    );

    expect(result.status).toBe('iteration_capped');
    expect(result.iterations).toBe(1);
  });

  it('reports numerical_failure for an infeasible explicit start', () => {
    const result = solveQp([[1]], [0], [[1]], [1], [2]);

    expect(result.status).toBe('numerical_failure');
    expect(result.iterations).toBe(0);
  });

  it('is deterministic for repeated solves of the same problem', () => {
    const H = [[3, 0.2], [0.2, 2]];
    const f = [-1, -3];
    const A = [[1, 1], [-1, 0], [0, -1]];
    const b = [1, 0, 0];
    const x0 = [0, 0];
    const first = solveQp(H, f, A, b, x0);
    const second = solveQp(H, f, A, b, x0);

    expect(second).toEqual(first);
  });
});
