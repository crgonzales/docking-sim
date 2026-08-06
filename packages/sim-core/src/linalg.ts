/**
 * Shared dense linear-algebra helpers (Gauss-Jordan with partial pivoting).
 * Small fixed-size systems only (≤ 16×16) — no external dependency warranted.
 */

function gaussJordan(matrix: number[][], rightHandSide: number[], strict: boolean): number[] {
  const size = rightHandSide.length;
  const augmented = matrix.map((row, rowIndex) => [...row, rightHandSide[rowIndex] ?? 0]);
  for (let pivot = 0; pivot < size; pivot += 1) {
    let pivotRow = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(augmented[row]![pivot]!) > Math.abs(augmented[pivotRow]![pivot]!)) pivotRow = row;
    }
    if (Math.abs(augmented[pivotRow]![pivot]!) < 1e-14) {
      if (strict) throw new RangeError('linear system is singular');
      continue;
    }
    [augmented[pivot], augmented[pivotRow]] = [augmented[pivotRow]!, augmented[pivot]!];
    const pivotValue = augmented[pivot]![pivot]!;
    for (let column = pivot; column <= size; column += 1) augmented[pivot]![column]! /= pivotValue;
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row]![pivot]!;
      for (let column = pivot; column <= size; column += 1) augmented[row]![column]! -= factor * augmented[pivot]![column]!;
    }
  }
  return augmented.map((row) => row[size] ?? 0);
}

/** Solve Ax = b; near-singular pivots are skipped (rank-deficient tolerant). */
export function solveLinearSystem(matrix: number[][], rightHandSide: number[]): number[] {
  return gaussJordan(matrix, rightHandSide, false);
}

/** Solve Ax = b; throws RangeError on a singular system. */
export function solveLinearSystemStrict(matrix: number[][], rightHandSide: number[]): number[] {
  return gaussJordan(matrix, rightHandSide, true);
}

/** Invert a square matrix column-by-column via the chosen solver. */
export function inverseMatrix(matrix: number[][], options: { strict?: boolean } = {}): number[][] {
  const solve = options.strict ? solveLinearSystemStrict : solveLinearSystem;
  const columns = matrix[0]!.map((_, column) => solve(matrix, matrix.map((_, row) => (row === column ? 1 : 0))));
  return columns[0]!.map((_, row) => columns.map((column) => column[row] ?? 0));
}
