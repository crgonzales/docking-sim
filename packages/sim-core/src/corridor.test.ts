import { describe, expect, it } from 'vitest';
import {
  CAPTURE_ENVELOPE,
  CORRIDOR,
  corridorError_m,
  corridorErrorOuter_m,
  insideCaptureEnvelope,
} from './corridor.js';

describe('approach corridor geometry', () => {
  it('keeps on-axis points inside the cone', () => {
    expect(corridorError_m([0, -20, 0])).toBe(0);
    expect(corridorError_m([0, -250, 0])).toBe(0);
  });

  it('matches the perpendicular distance to the 10° cone surface', () => {
    const axialDistance_m = 10;
    const point = [
      10,
      CORRIDOR.apex_hill_m[1] - axialDistance_m,
      CORRIDOR.apex_hill_m[2],
    ] as [number, number, number];
    const expectedDistance_m = 10 * Math.cos(CORRIDOR.halfAngle_rad)
      - axialDistance_m * Math.sin(CORRIDOR.halfAngle_rad);

    expect(corridorError_m(point)).toBeCloseTo(expectedDistance_m, 12);
  });

  it('disengages the cone apex within the capture-range guard', () => {
    expect(corridorError_m(CORRIDOR.apex_hill_m)).toBe(0);
    expect(corridorError_m([
      CORRIDOR.apex_hill_m[0] + 1,
      CORRIDOR.apex_hill_m[1],
      CORRIDOR.apex_hill_m[2],
    ])).toBe(0);
    expect(corridorError_m([
      CORRIDOR.apex_hill_m[0],
      CORRIDOR.apex_hill_m[1] + 1.5,
      CORRIDOR.apex_hill_m[2],
    ])).toBe(0);
  });

  it('makes a point between the 10° and 15° cones outer-safe only', () => {
    const axialDistance_m = 10;
    const lateralDistance_m = axialDistance_m * Math.tan(12 * Math.PI / 180);
    const point: [number, number, number] = [
      lateralDistance_m,
      CORRIDOR.apex_hill_m[1] - axialDistance_m,
      CORRIDOR.apex_hill_m[2],
    ];

    expect(corridorError_m(point)).toBeGreaterThan(0);
    expect(corridorErrorOuter_m(point)).toBe(0);
  });
});

describe('capture envelope', () => {
  it('reports each criterion and the combined result', () => {
    const inside = insideCaptureEnvelope(0.05, 0.05, 2, 0.1);
    expect(inside).toEqual({
      inside: true,
      perCriterion: {
        closing_mps: true,
        lateral_m: true,
        misalign_deg: true,
        rate_dps: true,
      },
    });

    const outsideClosing = insideCaptureEnvelope(CAPTURE_ENVELOPE.closing_mps[1] + 0.01, 0, 0, 0);
    expect(outsideClosing.inside).toBe(false);
    expect(outsideClosing.perCriterion.closing_mps).toBe(false);
    expect(outsideClosing.perCriterion.lateral_m).toBe(true);
    expect(outsideClosing.perCriterion.misalign_deg).toBe(true);
    expect(outsideClosing.perCriterion.rate_dps).toBe(true);

    const outsideLateral = insideCaptureEnvelope(0.05, CAPTURE_ENVELOPE.lateral_m + 0.01, 0, 0);
    expect(outsideLateral.inside).toBe(false);
    expect(outsideLateral.perCriterion.lateral_m).toBe(false);

    const outsideMisalign = insideCaptureEnvelope(0.05, 0, CAPTURE_ENVELOPE.misalign_deg + 0.01, 0);
    expect(outsideMisalign.inside).toBe(false);
    expect(outsideMisalign.perCriterion.misalign_deg).toBe(false);

    const outsideRate = insideCaptureEnvelope(0.05, 0, 0, CAPTURE_ENVELOPE.rate_dps + 0.01);
    expect(outsideRate.inside).toBe(false);
    expect(outsideRate.perCriterion.rate_dps).toBe(false);
  });
});
