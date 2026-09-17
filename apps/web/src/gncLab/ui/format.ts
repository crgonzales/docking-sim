/**
 * Display formatting for the GNC causal chain (F_0.16.0 B5).
 *
 * Values arrive in the SI units the port descriptors declare (m, m/s, rad,
 * rad/s, N, N*m, s, kg, m/s^2, 1). This module is the only place where degrees
 * exist: `rad` and `rad/s` readings are converted for display and nothing else
 * is rescaled. Every helper is a pure function of its arguments — no clock, no
 * store, no simulation time is consulted.
 *
 * Unavailable readings (`null`, NaN, ±Infinity) render as an em dash or the
 * caller's explicit unavailable status; an exact zero renders as a number.
 */

/** Shown for any reading that has no finite value and no explicit status. */
export const UNAVAILABLE = '—';

const DEG_PER_RAD = 180 / Math.PI;

/** Radians → degrees. UI-only; never feed the result back into the simulation. */
export function radToDeg(rad: number): number {
  return rad * DEG_PER_RAD;
}

/** True only for a real, finite number; rejects null, NaN and ±Infinity. */
export function isFiniteReading(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Display glyph for an SI port unit string. Angular units become degree glyphs
 * because {@link formatReading} converts those values; the dimensionless unit
 * `'1'` displays as nothing. Unknown unit strings pass through unchanged.
 */
export function displayUnit(unit: string, si = false): string {
  if (si && (unit === 'rad' || unit === 'rad/s')) return unit;
  switch (unit) {
    case 'rad':
      return '°';
    case 'rad/s':
      return '°/s';
    case 'N*m':
      return 'N·m';
    case 'm/s^2':
      return 'm/s²';
    case '1':
      return '';
    default:
      return unit;
  }
}

export interface ReadingFormat {
  /** Keep angular values in SI for the compact chain; legacy display defaults remain. */
  si?: boolean;
  /** SI value, or `null` when the source has not produced one. */
  value: number | null;
  /** SI unit string as declared by the port descriptor (`'m'`, `'rad'`, `'N*m'`, `'1'`, …). */
  unit: string;
  /** Fixed decimals after the display conversion. Default 2. */
  digits?: number;
  /**
   * Text to show instead of the em dash when `value` is unavailable
   * (for example `'DROPOUT'` or `'PENDING'`). Ignored when a finite value exists.
   */
  unavailableStatus?: string;
}

/** Formatted parts of one reading; `text` is the concatenated display string. */
export interface FormattedReading {
  /** Number text, or the unavailable marker / status. */
  number: string;
  /** Display unit glyph; empty when the reading is unavailable or dimensionless. */
  unit: string;
  /** `number` followed by a thin space and `unit` when a unit is shown. */
  text: string;
  available: boolean;
}

/**
 * Format one SI reading for display. Finite values are printed with fixed
 * decimals; `rad` and `rad/s` are converted to degrees first. An exact zero
 * prints as `0.00`, never as the unavailable marker.
 */
export function formatReading(reading: ReadingFormat): FormattedReading {
  const digits = reading.digits ?? 2;
  if (!isFiniteReading(reading.value)) {
    const status = reading.unavailableStatus ?? UNAVAILABLE;
    return { number: status, unit: '', text: status, available: false };
  }
  const angular = !reading.si && (reading.unit === 'rad' || reading.unit === 'rad/s');
  const shown = angular ? radToDeg(reading.value) : reading.value;
  const numberText = (Object.is(shown, -0) ? 0 : shown).toFixed(digits);
  const unit = displayUnit(reading.unit, reading.si);
  const text = unit === '' ? numberText : `${numberText} ${unit}`;
  return { number: numberText, unit, text, available: true };
}

/** Sample time in sim seconds, e.g. `t 12.30 s`; em dash when no sample exists. */
export function formatSampleTime(t_s: number | null): string {
  if (!isFiniteReading(t_s)) return UNAVAILABLE;
  return `t ${t_s.toFixed(2)} s`;
}

/**
 * Caller-supplied age of a held sample. Sub-second ages print in whole
 * milliseconds (the FSW hold is 0–90 ms), longer ages in seconds. A negative
 * age is a caller error and is shown as such rather than clamped to zero.
 */
export function formatSampleAge(age_s: number | null): string {
  if (!isFiniteReading(age_s)) return UNAVAILABLE;
  if (age_s < 0) return 'age <0';
  if (age_s < 1) return `age ${Math.round(age_s * 1000)} ms`;
  return `age ${age_s.toFixed(2)} s`;
}
