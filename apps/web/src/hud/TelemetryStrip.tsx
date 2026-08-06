import { useRef } from 'react';
import { useTelemetryBus } from '../telemetry/bus';
import { createClosingRateEstimator } from './closingRate';

/**
 * Top telemetry strip. Display formulas fixed by the plan (§5):
 *   RANGE   = ‖nav_r_hill_m‖
 *   CLOSING = −Δ(RANGE)/Δt (positive = approaching), computed over a ~1 s
 *             baseline and EMA-smoothed — per-frame differencing at 10 Hz
 *             divides the nav noise by 0.1 s and swamps the true rate.
 *   NAV σ   = √(Σ nav_cov_pos_m2)  (RSS of per-axis variances)
 * PROP is published by the truth-owned simulation state.
 */
const PLACEHOLDER = '----';
const CLOSING_BASELINE_S = 1.0;
const CLOSING_EMA_ALPHA = 0.2;

function fmt(value: number | null, digits: number, unit: string): string {
  return value === null ? PLACEHOLDER : `${value.toFixed(digits)}${unit}`;
}

export function TelemetryStrip() {
  const frame = useTelemetryBus((s) => s.frame);
  const closingRate = useRef(createClosingRateEstimator(CLOSING_BASELINE_S, CLOSING_EMA_ALPHA));

  let range: number | null = null;
  let closing: number | null = null;
  let navSigma: number | null = null;
  let attitudeSigma: number | null = null;
  let bodyRate: number | null = null;
  let clock = PLACEHOLDER;

  if (frame) {
    const [x, y, z] = frame.nav_r_hill_m;
    range = Math.hypot(x, y, z);
    navSigma = Math.sqrt(
      frame.nav_cov_pos_m2[0] + frame.nav_cov_pos_m2[1] + frame.nav_cov_pos_m2[2],
    );
    attitudeSigma = frame.att_sigma_deg;
    bodyRate = Math.hypot(...frame.body_rate_dps_est);

    closing = closingRate.current.push(frame.t_s, range);

    const mm = Math.floor(frame.t_s / 60);
    const ss = Math.floor(frame.t_s % 60);
    clock = `T+${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

  const cells: Array<[string, string]> = [
    ['range', fmt(range, 1, ' m')],
    ['closing', fmt(closing, 2, ' m/s')],
    ['nav σ (rss)', fmt(navSigma, 2, ' m')],
    ['att σ', fmt(attitudeSigma, 2, '°')],
    ['rate', fmt(bodyRate, 2, '°/s')],
    ['prop', frame ? `${frame.prop_kg.toFixed(1)} kg` : PLACEHOLDER],
    ['met', clock],
  ];

  return (
    <div className="hud-strip">
      {cells.map(([label, value]) => (
        <div className="hud-cell" key={label}>
          <div className="hud-cell-label">{label}</div>
          <div className="hud-cell-value">{value}</div>
        </div>
      ))}
    </div>
  );
}
