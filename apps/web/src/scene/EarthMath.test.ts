import { describe, expect, it } from 'vitest';
import {
  computeCloudShadowUv,
  deriveRayleighCoefficients,
  henyeyGreensteinPhase,
  rayleighPhase,
} from './EarthMath';

describe('analytic atmospheric helpers', () => {
  it('derives Rayleigh beta with blue > green > red ordering', () => {
    const [red, green, blue] = deriveRayleighCoefficients();
    expect(red).toBeCloseTo(1, 12);
    expect(blue).toBeGreaterThan(green);
    expect(green).toBeGreaterThan(red);
  });

  it('keeps the phase functions positive and bounded', () => {
    const rayleighSamples = [-1, -0.5, 0, 0.5, 1].map(rayleighPhase);
    const rayleighMinimum = 3 / (16 * Math.PI);
    const rayleighMaximum = 3 / (8 * Math.PI);
    for (const sample of rayleighSamples) {
      expect(sample).toBeGreaterThanOrEqual(rayleighMinimum);
      expect(sample).toBeLessThanOrEqual(rayleighMaximum);
    }

    expect(henyeyGreensteinPhase(1)).toBeGreaterThan(0);
    expect(henyeyGreensteinPhase(1)).toBeGreaterThan(henyeyGreensteinPhase(-1));
  });

  it('projects cloud shadows toward the sun and wraps the equirectangular seam', () => {
    // +x maps to u=0.5 (SphereGeometry convention); a sun with a +z component
    // pulls the blocker toward +z, i.e. toward u=0.25.
    const uv = computeCloudShadowUv([1, 0, 0], [1, 0, 1], 0.04, 6.371, 0);
    expect(uv[0]).toBeGreaterThan(0.25);
    expect(uv[0]).toBeLessThan(0.5);
    expect(uv[1]).toBeGreaterThan(0);
    expect(uv[1]).toBeLessThan(1);

    const seamUv = computeCloudShadowUv([-1, 0, 0], [-1, 0, -1], 0.04, 6.371, 0);
    expect(seamUv[0]).toBeGreaterThanOrEqual(0);
    expect(seamUv[0]).toBeLessThan(1);
  });
});
