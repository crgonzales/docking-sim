// Vitest supplies these Node modules at runtime; the web tsconfig intentionally
// does not include a Node type library for application code.
// @ts-expect-error Vitest runtime module
import { createHash } from 'node:crypto';
// @ts-expect-error Vitest runtime module
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SKY_CONFIG } from './skyConfig';
import {
  MULTIPLE_SCATTERING_LUT_SIZE,
  TRANSMITTANCE_LUT_SIZE,
  TRANSMITTANCE_FLOOR,
  bakeMultipleScatteringLut,
  bakeTransmittanceLut,
  hillaireMultipleScattering,
  transmittanceAlongRay,
  transmittanceForPathLength,
} from './atmosphereMath';

const coefficients = SKY_CONFIG.atmosphere;
const lutDirectory = new URL('../../../public/assets/lut/', import.meta.url);

function artifactBytes(data: Float32Array): Uint8Array {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('atmosphere bake math', () => {
  it('stores positive transmittance that decreases with path length', () => {
    const pathsKm = [0, 1, 5, 20, 50];
    const samples = pathsKm.map((pathKm) => transmittanceForPathLength(pathKm, coefficients));
    for (const sample of samples) {
      for (const channel of sample) {
        expect(channel).toBeGreaterThan(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
    for (let index = 1; index < samples.length; index += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        expect(samples[index - 1]![channel]).toBeGreaterThan(samples[index]![channel]);
      }
    }
  });

  it('preserves the blue > green > red beta ordering through the baked T payload', () => {
    const lut = bakeTransmittanceLut(coefficients);
    const zenithOffset = (TRANSMITTANCE_LUT_SIZE.width - 1) * 3;
    for (let channel = 0; channel < 3; channel += 1) {
      expect(lut[zenithOffset + channel]).toBeGreaterThan(0);
      expect(lut[zenithOffset + channel]).toBeLessThanOrEqual(1);
    }
    const redTau = -Math.log(lut[zenithOffset]!);
    const greenTau = -Math.log(lut[zenithOffset + 1]!);
    const blueTau = -Math.log(lut[zenithOffset + 2]!);
    expect(coefficients.rayleighScatteringM[2]).toBeGreaterThan(coefficients.rayleighScatteringM[1]);
    expect(coefficients.rayleighScatteringM[1]).toBeGreaterThan(coefficients.rayleighScatteringM[0]);
    expect(blueTau).toBeGreaterThan(greenTau);
    expect(greenTau).toBeGreaterThan(redTau);
  });

  it('keeps multiple-scattered energy below incident energy', () => {
    for (const altitudeKm of [0, 7, 25, 80]) {
      for (const muSun of [-0.5, 0, 0.5, 1]) {
        const scattered = hillaireMultipleScattering(altitudeKm, muSun, coefficients);
        for (const channel of scattered) {
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('matches the published clear-sky zenith transmission spot check near 556 nm', () => {
    // NASA CR-1324, p. 122, gives 85% zenith transmission at 0.556 micrometres
    // for a clear atmosphere. The configured green channel is the 550 nm proxy.
    const zenith = transmittanceAlongRay(0, 1, coefficients);
    expect(zenith[1]).toBeCloseTo(0.85, 1);
  });

  it('re-bakes byte-identical payloads matching the committed artifacts', () => {
    const transmittance = bakeTransmittanceLut(coefficients, TRANSMITTANCE_LUT_SIZE);
    const multipleScattering = bakeMultipleScatteringLut(coefficients, MULTIPLE_SCATTERING_LUT_SIZE);
    const committedTransmittance = readFileSync(new URL('transmittance.bin', lutDirectory));
    const committedMultipleScattering = readFileSync(new URL('multiple_scattering.bin', lutDirectory));

    expect(committedTransmittance.byteLength).toBe(TRANSMITTANCE_LUT_SIZE.width * TRANSMITTANCE_LUT_SIZE.height * 3 * 4);
    expect(committedMultipleScattering.byteLength).toBe(MULTIPLE_SCATTERING_LUT_SIZE.width * MULTIPLE_SCATTERING_LUT_SIZE.height * 3 * 4);
    expect(sha256(artifactBytes(transmittance))).toBe(sha256(committedTransmittance));
    expect(sha256(artifactBytes(multipleScattering))).toBe(sha256(committedMultipleScattering));

    for (const value of transmittance) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
