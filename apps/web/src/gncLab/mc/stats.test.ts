import { describe, expect, it } from 'vitest';
import { histogram, scalarSummary, wilsonInterval, Z_95 } from './stats';

describe('Wilson score interval', () => {
  it('matches hand-computed 95% bounds for 5 of 10', () => {
    const interval = wilsonInterval(5, 10);
    expect(interval.p).toBe(0.5);
    expect(interval.lower).toBeCloseTo(0.2366, 4);
    expect(interval.upper).toBeCloseTo(0.7634, 4);
    expect(interval.z).toBe(Z_95);
  });

  it('handles the p = 0 and p = 1 edges without leaving [0, 1]', () => {
    const none = wilsonInterval(0, 10);
    expect(none.p).toBe(0);
    expect(none.lower).toBe(0);
    // upper = z^2 / (n + z^2) at zero successes
    expect(none.upper).toBeCloseTo(Z_95 ** 2 / (10 + Z_95 ** 2), 12);
    expect(none.upper).toBeCloseTo(0.2775, 4);

    const all = wilsonInterval(10, 10);
    expect(all.p).toBe(1);
    expect(all.upper).toBe(1);
    expect(all.lower).toBeCloseTo(1 - none.upper, 12);

    const single = wilsonInterval(0, 1);
    expect(single.lower).toBe(0);
    expect(single.upper).toBeCloseTo(Z_95 ** 2 / (1 + Z_95 ** 2), 12);
  });

  it('is symmetric under success/failure exchange and narrows with more trials', () => {
    const a = wilsonInterval(3, 20);
    const b = wilsonInterval(17, 20);
    expect(a.lower).toBeCloseTo(1 - b.upper, 12);
    expect(a.upper).toBeCloseTo(1 - b.lower, 12);
    const wide = wilsonInterval(50, 100);
    const narrow = wilsonInterval(500, 1000);
    expect(narrow.upper - narrow.lower).toBeLessThan(wide.upper - wide.lower);
  });

  it('rejects an empty population or inconsistent counts', () => {
    expect(() => wilsonInterval(0, 0)).toThrow(RangeError);
    expect(() => wilsonInterval(11, 10)).toThrow(RangeError);
    expect(() => wilsonInterval(-1, 10)).toThrow(RangeError);
    expect(() => wilsonInterval(2.5, 10)).toThrow(RangeError);
    expect(() => wilsonInterval(1, 10, 0)).toThrow(RangeError);
  });
});

describe('scalar summary', () => {
  it('computes min, max, mean and median for odd and even samples', () => {
    expect(scalarSummary([5, 1, 3])).toEqual({ n: 3, min: 1, max: 5, mean: 3, median: 3 });
    expect(scalarSummary([4, 1, 3, 2])).toEqual({ n: 4, min: 1, max: 4, mean: 2.5, median: 2.5 });
  });

  it('returns null for an empty sample and rejects non-finite values', () => {
    expect(scalarSummary([])).toBeNull();
    expect(() => scalarSummary([1, Number.NaN])).toThrow(RangeError);
  });
});

describe('fixed-bin histogram', () => {
  it('bins values, keeps the maximum in the last bin and counts out-of-range values separately', () => {
    const result = histogram([0, 0.5, 1, 1.5, 2, 2.5, 3, 3, -1, 4], { min: 0, max: 3, bins: 3 });
    expect(result.edges).toEqual([0, 1, 2, 3]);
    expect(result.counts).toEqual([2, 2, 4]);
    expect(result.below).toBe(1);
    expect(result.above).toBe(1);
    expect(result.counts.reduce((sum, value) => sum + value, 0) + result.below + result.above).toBe(10);
  });

  it('rejects an invalid specification', () => {
    expect(() => histogram([], { min: 0, max: 1, bins: 0 })).toThrow(RangeError);
    expect(() => histogram([], { min: 1, max: 1, bins: 2 })).toThrow(RangeError);
    expect(() => histogram([Number.POSITIVE_INFINITY], { min: 0, max: 1, bins: 2 })).toThrow(RangeError);
  });
});
