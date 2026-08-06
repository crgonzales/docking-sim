/** Pure baseline-and-EMA closing-rate estimator for the telemetry HUD. */
export interface ClosingRateEstimator {
  /** Add one monotonic sample and return positive-is-approaching rate, or null while warming up. */
  push(t_s: number, range_m: number): number | null;
}

export function createClosingRateEstimator(baseline_s: number, emaAlpha: number): ClosingRateEstimator {
  if (!(baseline_s > 0) || !Number.isFinite(baseline_s)) throw new RangeError('baseline_s must be positive and finite');
  if (!(emaAlpha > 0 && emaAlpha <= 1) || !Number.isFinite(emaAlpha)) throw new RangeError('emaAlpha must be in (0, 1]');

  const history: Array<{ t_s: number; range_m: number }> = [];
  let closingEma_mps: number | null = null;

  return {
    push(t_s, range_m) {
      const last = history[history.length - 1];
      if (!last || t_s > last.t_s) {
        history.push({ t_s, range_m });
        while (history.length > 1 && t_s - history[0]!.t_s > baseline_s) history.shift();
        const base = history[0]!;
        if (t_s - base.t_s >= baseline_s / 2) {
          const raw_mps = -(range_m - base.range_m) / (t_s - base.t_s);
          closingEma_mps = closingEma_mps === null
            ? raw_mps
            : closingEma_mps + emaAlpha * (raw_mps - closingEma_mps);
        }
      }
      return closingEma_mps;
    },
  };
}
