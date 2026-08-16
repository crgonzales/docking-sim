export type Spectrum = readonly [number, number, number];

export interface AtmosphereCoefficients {
  bottomRadiusKm: number;
  topRadiusKm: number;
  rayleighScatteringM: Spectrum;
  rayleighAbsorptionM: Spectrum;
  mieScatteringM: number;
  mieAbsorptionM: number;
  mieExtinctionM: number;
  mieAnisotropy: number;
  ozoneAbsorptionM: Spectrum;
  ozoneScatteringM: Spectrum;
  ozoneCenterKm: number;
  ozoneHalfWidthKm: number;
  rayleighScaleHeightKm: number;
  mieScaleHeightKm: number;
}

export interface LutSize {
  width: number;
  height: number;
}

export const TRANSMITTANCE_LUT_SIZE: LutSize = { width: 256, height: 64 };
export const MULTIPLE_SCATTERING_LUT_SIZE: LutSize = { width: 32, height: 32 };
const DEFAULT_INTEGRATION_STEPS = 64;
const MULTIPLE_SCATTERING_ORDERS = 4;
const MULTIPLE_SCATTERING_ANGLE_SAMPLES = 8;
export const TRANSMITTANCE_FLOOR = 1e-6;
const PI = Math.PI;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function addScaled(a: number[], b: Spectrum, scale: number): void {
  a[0] = (a[0] ?? 0) + b[0] * scale;
  a[1] = (a[1] ?? 0) + b[1] * scale;
  a[2] = (a[2] ?? 0) + b[2] * scale;
}

function minSpectrum(a: Spectrum, b: Spectrum): Spectrum {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
}

export function rayleighDensityAtAltitudeKm(altitudeKm: number, coefficients: AtmosphereCoefficients): number {
  return Math.exp(-Math.max(altitudeKm, 0) / coefficients.rayleighScaleHeightKm);
}

export function mieDensityAtAltitudeKm(altitudeKm: number, coefficients: AtmosphereCoefficients): number {
  return Math.exp(-Math.max(altitudeKm, 0) / coefficients.mieScaleHeightKm);
}

export function ozoneDensityAtAltitudeKm(altitudeKm: number, coefficients: AtmosphereCoefficients): number {
  const distance = Math.abs(altitudeKm - coefficients.ozoneCenterKm);
  return clamp(1 - distance / coefficients.ozoneHalfWidthKm, 0, 1);
}

export function extinctionAtAltitudeM(altitudeKm: number, coefficients: AtmosphereCoefficients): Spectrum {
  const rayleighDensity = rayleighDensityAtAltitudeKm(altitudeKm, coefficients);
  const mieDensity = mieDensityAtAltitudeKm(altitudeKm, coefficients);
  const ozoneDensity = ozoneDensityAtAltitudeKm(altitudeKm, coefficients);
  return [
    (coefficients.rayleighScatteringM[0] + coefficients.rayleighAbsorptionM[0]) * rayleighDensity
      + coefficients.mieExtinctionM * mieDensity
      + (coefficients.ozoneAbsorptionM[0] + coefficients.ozoneScatteringM[0]) * ozoneDensity,
    (coefficients.rayleighScatteringM[1] + coefficients.rayleighAbsorptionM[1]) * rayleighDensity
      + coefficients.mieExtinctionM * mieDensity
      + (coefficients.ozoneAbsorptionM[1] + coefficients.ozoneScatteringM[1]) * ozoneDensity,
    (coefficients.rayleighScatteringM[2] + coefficients.rayleighAbsorptionM[2]) * rayleighDensity
      + coefficients.mieExtinctionM * mieDensity
      + (coefficients.ozoneAbsorptionM[2] + coefficients.ozoneScatteringM[2]) * ozoneDensity,
  ];
}

/** Constant-density oracle used by tests and by callers that need a simple path check. */
export function transmittanceForPathLength(
  pathLengthKm: number,
  coefficients: AtmosphereCoefficients,
  altitudeKm = 0,
): Spectrum {
  const extinction = extinctionAtAltitudeM(altitudeKm, coefficients);
  const distanceM = Math.max(pathLengthKm, 0) * 1000;
  return [
    Math.exp(-extinction[0] * distanceM),
    Math.exp(-extinction[1] * distanceM),
    Math.exp(-extinction[2] * distanceM),
  ];
}

function rayIntersectsGround(altitudeKm: number, mu: number, coefficients: AtmosphereCoefficients): boolean {
  const radiusKm = coefficients.bottomRadiusKm + altitudeKm;
  const closestApproachSquared = radiusKm * radiusKm * (1 - mu * mu);
  return mu < 0 && closestApproachSquared <= coefficients.bottomRadiusKm ** 2;
}

export function distanceToTopOfAtmosphereKm(
  altitudeKm: number,
  mu: number,
  coefficients: AtmosphereCoefficients,
): number {
  const radiusKm = coefficients.bottomRadiusKm + altitudeKm;
  const topRadiusKm = coefficients.topRadiusKm;
  return -radiusKm * mu + Math.sqrt(Math.max(
    radiusKm * radiusKm * mu * mu + topRadiusKm * topRadiusKm - radiusKm * radiusKm,
    0,
  ));
}

/**
 * Spherical exponential atmosphere integration. The result is T = exp(-tau),
 * intentionally returning payload semantics rather than optical depth.
 */
export function transmittanceAlongRay(
  altitudeKm: number,
  mu: number,
  coefficients: AtmosphereCoefficients,
  steps = DEFAULT_INTEGRATION_STEPS,
): Spectrum {
  const cosine = clamp(mu, -1, 1);
  if (rayIntersectsGround(altitudeKm, cosine, coefficients)) {
    return [TRANSMITTANCE_FLOOR, TRANSMITTANCE_FLOOR, TRANSMITTANCE_FLOOR];
  }

  const pathLengthKm = distanceToTopOfAtmosphereKm(altitudeKm, cosine, coefficients);
  if (pathLengthKm <= 0) return [1, 1, 1];

  const radiusKm = coefficients.bottomRadiusKm + altitudeKm;
  const opticalDepth = [0, 0, 0];
  const sampleCount = Math.max(1, Math.floor(steps));
  const segmentKm = pathLengthKm / sampleCount;
  for (let index = 0; index < sampleCount; index += 1) {
    const distanceKm = (index + 0.5) * segmentKm;
    const sampleRadiusKm = Math.sqrt(Math.max(
      radiusKm * radiusKm + distanceKm * distanceKm + 2 * radiusKm * cosine * distanceKm,
      coefficients.bottomRadiusKm ** 2,
    ));
    const sampleAltitudeKm = sampleRadiusKm - coefficients.bottomRadiusKm;
    addScaled(opticalDepth, extinctionAtAltitudeM(sampleAltitudeKm, coefficients), segmentKm * 1000);
  }

  return [Math.exp(-opticalDepth[0]), Math.exp(-opticalDepth[1]), Math.exp(-opticalDepth[2])];
}

function scatteringAlbedoAtAltitudeKm(altitudeKm: number, coefficients: AtmosphereCoefficients): Spectrum {
  const rayleighDensity = rayleighDensityAtAltitudeKm(altitudeKm, coefficients);
  const mieDensity = mieDensityAtAltitudeKm(altitudeKm, coefficients);
  const extinction = extinctionAtAltitudeM(altitudeKm, coefficients);
  const scatter = [
    coefficients.rayleighScatteringM[0] * rayleighDensity
      + coefficients.mieScatteringM * mieDensity
      + coefficients.ozoneScatteringM[0] * ozoneDensityAtAltitudeKm(altitudeKm, coefficients),
    coefficients.rayleighScatteringM[1] * rayleighDensity
      + coefficients.mieScatteringM * mieDensity
      + coefficients.ozoneScatteringM[1] * ozoneDensityAtAltitudeKm(altitudeKm, coefficients),
    coefficients.rayleighScatteringM[2] * rayleighDensity
      + coefficients.mieScatteringM * mieDensity
      + coefficients.ozoneScatteringM[2] * ozoneDensityAtAltitudeKm(altitudeKm, coefficients),
  ] as const;
  return [
    clamp(scatter[0] / Math.max(extinction[0], Number.EPSILON), 0, 1),
    clamp(scatter[1] / Math.max(extinction[1], Number.EPSILON), 0, 1),
    clamp(scatter[2] / Math.max(extinction[2], Number.EPSILON), 0, 1),
  ];
}

/**
 * Hillaire-style Ψ_ms recurrence. Each order is fed by the previous order's
 * scattered energy and the extinction albedo, so the accumulated result is
 * bounded by incident energy even at the brightest LUT texel.
 */
export function hillaireMultipleScattering(
  altitudeKm: number,
  muSun: number,
  coefficients: AtmosphereCoefficients,
): Spectrum {
  const directSun = transmittanceAlongRay(altitudeKm, muSun, coefficients, 48);
  let averageEscape = 0;
  for (let index = 0; index < MULTIPLE_SCATTERING_ANGLE_SAMPLES; index += 1) {
    const mu = -1 + (index + 0.5) * (2 / MULTIPLE_SCATTERING_ANGLE_SAMPLES);
    const escape = transmittanceAlongRay(altitudeKm, mu, coefficients, 32);
    averageEscape += (escape[0] + escape[1] + escape[2]) / 3;
  }
  averageEscape /= MULTIPLE_SCATTERING_ANGLE_SAMPLES;

  const albedo = scatteringAlbedoAtAltitudeKm(altitudeKm, coefficients);
  const collisionProbability = clamp(1 - averageEscape, 0, 1);
  let order: Spectrum = directSun;
  let accumulated: Spectrum = [0, 0, 0];
  for (let index = 0; index < MULTIPLE_SCATTERING_ORDERS; index += 1) {
    const nextOrder: Spectrum = [
      order[0] * albedo[0] * collisionProbability * 0.5,
      order[1] * albedo[1] * collisionProbability * 0.5,
      order[2] * albedo[2] * collisionProbability * 0.5,
    ];
    accumulated = [
      accumulated[0] + nextOrder[0],
      accumulated[1] + nextOrder[1],
      accumulated[2] + nextOrder[2],
    ];
    order = nextOrder;
  }
  return minSpectrum(accumulated, [1, 1, 1]);
}

export const computeMultipleScattering = hillaireMultipleScattering;

export function bakeTransmittanceLut(
  coefficients: AtmosphereCoefficients,
  size: LutSize = TRANSMITTANCE_LUT_SIZE,
): Float32Array {
  const data = new Float32Array(size.width * size.height * 3);
  for (let y = 0; y < size.height; y += 1) {
    const altitudeKm = (y / (size.height - 1)) * (coefficients.topRadiusKm - coefficients.bottomRadiusKm);
    for (let x = 0; x < size.width; x += 1) {
      const mu = (x / (size.width - 1)) * 2 - 1;
      const transmittance = transmittanceAlongRay(altitudeKm, mu, coefficients);
      const offset = (y * size.width + x) * 3;
      data[offset] = transmittance[0];
      data[offset + 1] = transmittance[1];
      data[offset + 2] = transmittance[2];
    }
  }
  return data;
}

export function bakeMultipleScatteringLut(
  coefficients: AtmosphereCoefficients,
  size: LutSize = MULTIPLE_SCATTERING_LUT_SIZE,
): Float32Array {
  const data = new Float32Array(size.width * size.height * 3);
  for (let y = 0; y < size.height; y += 1) {
    const altitudeKm = (y / (size.height - 1)) * (coefficients.topRadiusKm - coefficients.bottomRadiusKm);
    for (let x = 0; x < size.width; x += 1) {
      const muSun = (x / (size.width - 1)) * 2 - 1;
      const multipleScattering = hillaireMultipleScattering(altitudeKm, muSun, coefficients);
      const offset = (y * size.width + x) * 3;
      data[offset] = multipleScattering[0];
      data[offset + 1] = multipleScattering[1];
      data[offset + 2] = multipleScattering[2];
    }
  }
  return data;
}

export function transmittanceLutUv(
  altitudeKm: number,
  mu: number,
  coefficients: AtmosphereCoefficients,
): readonly [number, number] {
  return [
    clamp(mu, -1, 1) * 0.5 + 0.5,
    clamp(
      (altitudeKm - 0) / (coefficients.topRadiusKm - coefficients.bottomRadiusKm),
      0,
      1,
    ),
  ];
}

export function sampleLut(
  data: Float32Array,
  size: LutSize,
  u: number,
  v: number,
): Spectrum {
  const x = clamp(u, 0, 1) * (size.width - 1);
  const y = clamp(v, 0, 1) * (size.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, size.width - 1);
  const y1 = Math.min(y0 + 1, size.height - 1);
  const tx = x - x0;
  const ty = y - y0;
  const at = (column: number, row: number, channel: number): number => data[(row * size.width + column) * 3 + channel] ?? 0;
  const result = [0, 0, 0];
  for (let channel = 0; channel < 3; channel += 1) {
    const top = at(x0, y0, channel) * (1 - tx) + at(x1, y0, channel) * tx;
    const bottom = at(x0, y1, channel) * (1 - tx) + at(x1, y1, channel) * tx;
    result[channel] = top * (1 - ty) + bottom * ty;
  }
  return result as unknown as Spectrum;
}

export function sampleTransmittanceLut(
  data: Float32Array,
  size: LutSize,
  altitudeKm: number,
  mu: number,
  coefficients: AtmosphereCoefficients,
): Spectrum {
  const [u, v] = transmittanceLutUv(altitudeKm, mu, coefficients);
  return sampleLut(data, size, u, v);
}
