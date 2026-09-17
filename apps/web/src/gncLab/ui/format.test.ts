import { describe, expect, it } from 'vitest';
import {
  UNAVAILABLE,
  displayUnit,
  formatReading,
  formatSampleAge,
  formatSampleTime,
  isFiniteReading,
  radToDeg,
} from './format';

describe('formatReading — zero versus unavailable', () => {
  it('prints an exact zero as a number, not as the unavailable marker', () => {
    const zero = formatReading({ value: 0, unit: 'm' });
    expect(zero.text).toBe('0.00 m');
    expect(zero.available).toBe(true);
    expect(zero.text).not.toContain(UNAVAILABLE);
  });

  it('prints negative zero without a sign', () => {
    expect(formatReading({ value: -0, unit: 'N' }).number).toBe('0.00');
  });

  it('renders null as an em dash with no unit', () => {
    const missing = formatReading({ value: null, unit: 'm' });
    expect(missing).toEqual({ number: UNAVAILABLE, unit: '', text: UNAVAILABLE, available: false });
  });

  it('never substitutes zero for NaN or infinite readings', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const shown = formatReading({ value, unit: 'm/s' });
      expect(shown.available).toBe(false);
      expect(shown.text).toBe(UNAVAILABLE);
      expect(shown.text).not.toMatch(/0/);
    }
  });

  it('shows the explicit unavailable status only when no finite value exists', () => {
    expect(formatReading({ value: null, unit: 'm', unavailableStatus: 'DROPOUT' }).text).toBe('DROPOUT');
    expect(formatReading({ value: Number.NaN, unit: 'm', unavailableStatus: 'DROPOUT' }).text).toBe('DROPOUT');
    expect(formatReading({ value: 0, unit: 'm', unavailableStatus: 'DROPOUT' }).text).toBe('0.00 m');
  });
});

describe('formatReading — precision and units', () => {
  it('respects the requested fixed decimals and defaults to two', () => {
    expect(formatReading({ value: 1.23456, unit: 'm' }).number).toBe('1.23');
    expect(formatReading({ value: 1.23456, unit: 'm', digits: 0 }).number).toBe('1');
    expect(formatReading({ value: 1.23456, unit: 'm', digits: 4 }).number).toBe('1.2346');
    expect(formatReading({ value: -0.004, unit: 'm', digits: 3 }).number).toBe('-0.004');
  });

  it('keeps SI units other than angles unscaled', () => {
    expect(formatReading({ value: 0.0125, unit: 'N', digits: 4 }).text).toBe('0.0125 N');
    expect(formatReading({ value: 1500, unit: 'm', digits: 0 }).text).toBe('1500 m');
  });

  it('omits the unit for dimensionless readings', () => {
    const shown = formatReading({ value: 3, unit: '1', digits: 0 });
    expect(shown.text).toBe('3');
    expect(shown.unit).toBe('');
  });
});

describe('angular conversion is display-only and exact at known angles', () => {
  it('converts radians to degrees', () => {
    expect(radToDeg(Math.PI)).toBeCloseTo(180, 12);
    expect(radToDeg(Math.PI / 2)).toBeCloseTo(90, 12);
    expect(radToDeg(0)).toBe(0);
    expect(radToDeg(-Math.PI / 6)).toBeCloseTo(-30, 12);
  });

  it('formats rad readings in degrees with the degree glyph', () => {
    expect(formatReading({ value: Math.PI / 4, unit: 'rad', digits: 1 }).text).toBe('45.0 °');
    expect(formatReading({ value: 0, unit: 'rad' }).text).toBe('0.00 °');
  });

  it('formats rad/s readings in degrees per second', () => {
    expect(formatReading({ value: Math.PI / 180, unit: 'rad/s', digits: 3 }).text).toBe('1.000 °/s');
  });

  it('does not convert units that merely mention an angle elsewhere', () => {
    expect(formatReading({ value: 2, unit: 'm', digits: 0 }).text).toBe('2 m');
    expect(displayUnit('rad/s^2')).toBe('rad/s^2');
  });
});

describe('displayUnit', () => {
  it('maps the declared SI unit strings to display glyphs and passes others through', () => {
    expect(displayUnit('N*m')).toBe('N·m');
    expect(displayUnit('m/s^2')).toBe('m/s²');
    expect(displayUnit('rad')).toBe('°');
    expect(displayUnit('rad/s')).toBe('°/s');
    expect(displayUnit('1')).toBe('');
    expect(displayUnit('m/s')).toBe('m/s');
    expect(displayUnit('kg')).toBe('kg');
  });
});

describe('isFiniteReading', () => {
  it('accepts finite numbers including zero and rejects everything else', () => {
    expect(isFiniteReading(0)).toBe(true);
    expect(isFiniteReading(-12.5)).toBe(true);
    expect(isFiniteReading(null)).toBe(false);
    expect(isFiniteReading(undefined)).toBe(false);
    expect(isFiniteReading(Number.NaN)).toBe(false);
    expect(isFiniteReading(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('sample time and age are caller-supplied, never invented', () => {
  it('formats a sample time and marks a missing one unavailable', () => {
    expect(formatSampleTime(12.3)).toBe('t 12.30 s');
    expect(formatSampleTime(0)).toBe('t 0.00 s');
    expect(formatSampleTime(null)).toBe(UNAVAILABLE);
    expect(formatSampleTime(Number.NaN)).toBe(UNAVAILABLE);
  });

  it('formats held-sample ages in milliseconds below one second and seconds above', () => {
    expect(formatSampleAge(0)).toBe('age 0 ms');
    expect(formatSampleAge(0.03)).toBe('age 30 ms');
    expect(formatSampleAge(0.09)).toBe('age 90 ms');
    expect(formatSampleAge(2.5)).toBe('age 2.50 s');
  });

  it('does not clamp a negative age to zero and does not fabricate a missing one', () => {
    expect(formatSampleAge(-0.01)).toBe('age <0');
    expect(formatSampleAge(null)).toBe(UNAVAILABLE);
    expect(formatSampleAge(Number.POSITIVE_INFINITY)).toBe(UNAVAILABLE);
  });
});
