import { describe, expect, it } from 'vitest';
import { SKY_CONFIG } from './skyConfig';
import { bakeTransmittanceLut, sampleLut, transmittanceLutUv, TRANSMITTANCE_LUT_SIZE } from './atmosphereMath';

/**
 * TS mirror of skyAtmosphereLutUv / skyTransmittanceRatio in lighting.ts.
 * Delegates altitude/mu -> UV mapping and texel sampling to the already-tested
 * atmosphereMath helpers, so this only reproduces the point/direction geometry
 * the GLSL performs before touching the LUT.
 */
type Vec3 = readonly [number, number, number];

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function length(a: Vec3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

function normalize(a: Vec3): Vec3 {
  const len = length(a);
  return [a[0] / len, a[1] / len, a[2] / len];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function transmittanceRatio(
  lut: Float32Array,
  cameraPoint: Vec3,
  surfacePoint: Vec3,
  direction: Vec3,
  planetCenter: Vec3,
  surfaceRadiusKm: number,
  atmosphereRadiusKm: number,
): Vec3 {
  const sample = (point: Vec3): Vec3 => {
    const radial = sub(point, planetCenter);
    const altitudeKm = Math.min(Math.max(length(radial) - surfaceRadiusKm, 0), atmosphereRadiusKm - surfaceRadiusKm);
    const mu = dot(normalize(radial), direction);
    const [u, v] = transmittanceLutUv(altitudeKm, mu, coefficients);
    return sampleLut(lut, TRANSMITTANCE_LUT_SIZE, u, v);
  };
  const cameraToTop = sample(cameraPoint);
  const pointToTop = sample(surfacePoint);
  return [0, 1, 2].map((channel) => {
    const ratio = pointToTop[channel]! / Math.max(cameraToTop[channel]!, 0.0001);
    return Math.min(Math.max(ratio, 0), 1);
  }) as unknown as Vec3;
}

const coefficients = SKY_CONFIG.atmosphere;

describe('skyTransmittanceRatio direction convention', () => {
  it('produces a non-saturated, wavelength-differentiated aerial-perspective ratio for a receding terrain view', () => {
    const lut = bakeTransmittanceLut(coefficients, TRANSMITTANCE_LUT_SIZE);
    const planetCenter: Vec3 = [0, 0, 0];
    const bottomRadiusKm = coefficients.bottomRadiusKm;
    const topRadiusKm = coefficients.topRadiusKm;

    const cameraPoint: Vec3 = [bottomRadiusKm + 2, 0, 0];
    const arcKm = 50;
    const theta = arcKm / bottomRadiusKm;
    const surfacePoint: Vec3 = [bottomRadiusKm * Math.cos(theta), bottomRadiusKm * Math.sin(theta), 0];

    const surfaceToCamera = normalize(sub(cameraPoint, surfacePoint));
    const ratio = transmittanceRatio(
      lut,
      cameraPoint,
      surfacePoint,
      surfaceToCamera,
      planetCenter,
      bottomRadiusKm,
      topRadiusKm,
    );

    for (const channel of ratio) {
      expect(channel).toBeGreaterThan(0.05);
      expect(channel).toBeLessThan(0.95);
    }
    expect(ratio[0]).toBeGreaterThan(ratio[1]);
    expect(ratio[1]).toBeGreaterThan(ratio[2]);
  });

  it('degenerates to a flat, wavelength-independent floor when traced camera-to-surface instead', () => {
    const lut = bakeTransmittanceLut(coefficients, TRANSMITTANCE_LUT_SIZE);
    const planetCenter: Vec3 = [0, 0, 0];
    const bottomRadiusKm = coefficients.bottomRadiusKm;
    const topRadiusKm = coefficients.topRadiusKm;

    const cameraPoint: Vec3 = [bottomRadiusKm + 2, 0, 0];
    const arcKm = 50;
    const theta = arcKm / bottomRadiusKm;
    const surfacePoint: Vec3 = [bottomRadiusKm * Math.cos(theta), bottomRadiusKm * Math.sin(theta), 0];

    const cameraToSurface = normalize(sub(surfacePoint, cameraPoint));
    const ratio = transmittanceRatio(
      lut,
      cameraPoint,
      surfacePoint,
      cameraToSurface,
      planetCenter,
      bottomRadiusKm,
      topRadiusKm,
    );

    expect(ratio[0]).toBeCloseTo(ratio[1], 5);
    expect(ratio[1]).toBeCloseTo(ratio[2], 5);
    expect(ratio[0]).toBeLessThan(0.05);
  });
});
