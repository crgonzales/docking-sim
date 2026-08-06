import { describe, expect, it } from 'vitest';
import { createClosingRateEstimator } from './closingRate';

describe('closing-rate estimator', () => {
  it('returns null during half-baseline warmup', () => {
    const estimator = createClosingRateEstimator(1, 0.2);
    expect(estimator.push(0, 100)).toBeNull();
    expect(estimator.push(0.4, 99.2)).toBeNull();
    expect(estimator.push(0.5, 99)).toBeCloseTo(2, 12);
  });

  it('converges to a constant positive approaching rate', () => {
    const estimator = createClosingRateEstimator(1, 0.2);
    let rate: number | null = null;
    for (let index = 0; index <= 50; index += 1) rate = estimator.push(index / 10, 100 - 2 * index / 10);
    expect(rate).toBeCloseTo(2, 10);
  });

  it('uses positive sign for approach and negative sign for recession', () => {
    const approaching = createClosingRateEstimator(1, 1);
    approaching.push(0, 100);
    expect(approaching.push(1, 99)).toBeGreaterThan(0);

    const receding = createClosingRateEstimator(1, 1);
    receding.push(0, 100);
    expect(receding.push(1, 101)).toBeLessThan(0);
  });

  it('rejects high-frequency range noise better than raw differencing', () => {
    const estimator = createClosingRateEstimator(1, 0.2);
    const rawRates: number[] = [];
    const estimatedRates: number[] = [];
    let previousRange = 100;
    for (let index = 0; index <= 100; index += 1) {
      const t_s = index / 10;
      const range_m = 100 - 1.5 * t_s + (index % 2 === 0 ? 0.8 : -0.8);
      const estimate = estimator.push(t_s, range_m);
      if (index > 0) rawRates.push(-(range_m - previousRange) / 0.1);
      if (estimate !== null) estimatedRates.push(estimate);
      previousRange = range_m;
    }
    const standardDeviation = (values: number[]): number => {
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
    };
    expect(standardDeviation(estimatedRates)).toBeLessThan(standardDeviation(rawRates));
  });
});
