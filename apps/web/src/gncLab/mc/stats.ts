/**
 * Closed-form statistics for the Monte Carlo aggregator (F_0.19.0 B1).
 * Pure functions, no randomness, no I/O.
 */

/** Two-sided 95% normal quantile. */
export const Z_95 = 1.959963984540054;

export interface WilsonInterval {
  successes: number;
  trials: number;
  z: number;
  /** Point estimate successes / trials. */
  p: number;
  lower: number;
  upper: number;
}

/**
 * Wilson score interval for a binomial proportion on a fixed population.
 * `trials` must be a positive integer and `successes` an integer in [0, trials].
 */
export function wilsonInterval(successes: number, trials: number, z = Z_95): WilsonInterval {
  if (!Number.isInteger(trials) || trials <= 0) throw new RangeError('trials must be a positive integer');
  if (!Number.isInteger(successes) || successes < 0 || successes > trials) {
    throw new RangeError('successes must be an integer in [0, trials]');
  }
  if (!(z > 0) || !Number.isFinite(z)) throw new RangeError('z must be positive and finite');
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denominator;
  const halfWidth = (z / denominator) * Math.sqrt(p * (1 - p) / trials + z2 / (4 * trials * trials));
  // At the edges the Wilson bound is exactly 0 or 1; float round-off in the
  // centre/half-width sum must not report 0.9999999999999999 for a 100% sample.
  const lower = successes === 0 ? 0 : Math.max(0, centre - halfWidth);
  const upper = successes === trials ? 1 : Math.min(1, centre + halfWidth);
  return { successes, trials, z, p, lower, upper };
}

export interface ScalarSummary {
  n: number;
  min: number;
  max: number;
  mean: number;
  median: number;
}

/** Min, max, mean and median of a finite sample; `null` for an empty sample. */
export function scalarSummary(values: readonly number[]): ScalarSummary | null {
  if (values.length === 0) return null;
  if (values.some((value) => !Number.isFinite(value))) throw new RangeError('scalar values must be finite');
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const middle = Math.floor(n / 2);
  const median = n % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / n;
  return { n, min: sorted[0]!, max: sorted[n - 1]!, mean, median };
}

export interface HistogramSpec {
  min: number;
  max: number;
  bins: number;
}

export interface Histogram extends HistogramSpec {
  /** `bins + 1` ascending bin edges from `min` to `max`. */
  edges: number[];
  /** Count per bin; a value equal to `max` falls in the last bin. */
  counts: number[];
  below: number;
  above: number;
}

/** Fixed-bin histogram with explicit out-of-range counts. */
export function histogram(values: readonly number[], spec: HistogramSpec): Histogram {
  if (!Number.isInteger(spec.bins) || spec.bins <= 0) throw new RangeError('bins must be a positive integer');
  if (!Number.isFinite(spec.min) || !Number.isFinite(spec.max) || !(spec.max > spec.min)) {
    throw new RangeError('histogram range must be finite with max > min');
  }
  const width = (spec.max - spec.min) / spec.bins;
  const edges = Array.from({ length: spec.bins + 1 }, (_, index) => (index === spec.bins ? spec.max : spec.min + index * width));
  const counts = new Array<number>(spec.bins).fill(0);
  let below = 0;
  let above = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new RangeError('histogram values must be finite');
    if (value < spec.min) { below += 1; continue; }
    if (value > spec.max) { above += 1; continue; }
    const bin = Math.min(spec.bins - 1, Math.floor((value - spec.min) / width));
    counts[bin]! += 1;
  }
  return { ...spec, edges, counts, below, above };
}
