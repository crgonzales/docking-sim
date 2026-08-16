export type CoefficientTriple = readonly [number, number, number];

export interface AtmosphereCoefficients {
  bottomRadiusKm: number;
  topRadiusKm: number;
  rayleighScatteringM: CoefficientTriple;
  rayleighAbsorptionM: CoefficientTriple;
  mieScatteringM: number;
  mieAbsorptionM: number;
  mieExtinctionM: number;
  mieAnisotropy: number;
  ozoneAbsorptionM: CoefficientTriple;
  ozoneScatteringM: CoefficientTriple;
  ozoneCenterKm: number;
  ozoneHalfWidthKm: number;
  rayleighScaleHeightKm: number;
  mieScaleHeightKm: number;
}

export interface SkyConfig {
  earthRadiusKm: number;
  earthOrbitAltitudeKm: number;
  renderScaleMPerUnit: number;
  deckAltitudeKm: number;
  cirrusAltitudeKm: number;
  volumetricBandAltitudeKm: {
    inner: number;
    outer: number;
  };
  cloudGroundSpeedMps: number;
  puffSizeKm: {
    min: number;
    max: number;
  };
  volumetricInstanceCount: number;
  shadowLegibility: number;
  atmosphere: AtmosphereCoefficients;
  flightMaxOrbit: number;
  debugMaxOrbit: number;
  sunAnchorMargin: number;
  sunAngularDiameterDegrees: number;
  sunQuadHalfAngleDegrees: number;
}

export interface SkyDerived {
  earthRadiusM: number;
  earthRadiusScene: number;
  earthCenterDistanceKm: number;
  earthCenterDistanceScene: number;
  deckRadiusMultiplier: number;
  cirrusRadiusMultiplier: number;
  volumetricBandInnerRadiusMultiplier: number;
  volumetricBandOuterRadiusMultiplier: number;
  atmosphereRadiusMultiplier: number;
  cloudDriftRadPerSec: number;
  cirrusDriftRadPerSec: number;
  shadowAngularOffsetRad: number;
  volumetricCapCosine: number;
  sunAnchorDistance: number;
  sunDiscRadius: number;
  sunQuadHalfWidth: number;
}

const EARTH_RADIUS_KM = 6371;

/** Physical sky inputs. Renderer values below are derived from this object. */
export const SKY_CONFIG: SkyConfig = {
  earthRadiusKm: EARTH_RADIUS_KM,
  earthOrbitAltitudeKm: 400,
  renderScaleMPerUnit: 1000,
  deckAltitudeKm: 7,
  cirrusAltitudeKm: 12.7,
  volumetricBandAltitudeKm: { inner: 1.5, outer: 9 },
  cloudGroundSpeedMps: 25,
  puffSizeKm: { min: 8, max: 22 },
  volumetricInstanceCount: 12_000,
  shadowLegibility: 1.5,
  atmosphere: {
    bottomRadiusKm: EARTH_RADIUS_KM,
    topRadiusKm: 6471,
    rayleighScatteringM: [5.802e-6, 13.558e-6, 33.1e-6],
    rayleighAbsorptionM: [0, 0, 0],
    mieScatteringM: 3.996e-6,
    mieAbsorptionM: 0.444e-6,
    mieExtinctionM: 4.44e-6,
    mieAnisotropy: 0.8,
    ozoneAbsorptionM: [0.650e-6, 1.881e-6, 0.085e-6],
    ozoneScatteringM: [0, 0, 0],
    ozoneCenterKm: 25,
    ozoneHalfWidthKm: 15,
    rayleighScaleHeightKm: 8,
    mieScaleHeightKm: 1.2,
  },
  flightMaxOrbit: 2000,
  debugMaxOrbit: 40_000,
  sunAnchorMargin: 5000,
  sunAngularDiameterDegrees: 0.53,
  sunQuadHalfAngleDegrees: 2.3,
};

export function radiusMultiplierFromAltitudeKm(altitudeKm: number, earthRadiusKm = SKY_CONFIG.earthRadiusKm): number {
  return (earthRadiusKm + altitudeKm) / earthRadiusKm;
}

export function altitudeKmFromRadiusMultiplier(radiusMultiplier: number, earthRadiusKm = SKY_CONFIG.earthRadiusKm): number {
  return (radiusMultiplier - 1) * earthRadiusKm;
}

export function driftRadPerSecFromGroundSpeed(
  groundSpeedMps: number,
  earthRadiusKm = SKY_CONFIG.earthRadiusKm,
): number {
  return groundSpeedMps / (earthRadiusKm * 1000);
}

export function shadowAngularOffsetFromAltitude(
  altitudeKm = SKY_CONFIG.deckAltitudeKm,
  legibility = SKY_CONFIG.shadowLegibility,
  radiusKm = SKY_CONFIG.earthRadiusKm,
): number {
  return (altitudeKm * legibility) / radiusKm;
}

/**
 * Covers the visible horizon at the far flight orbit and the camera's
 * displacement around the LEO scene centre. The angles are deliberately
 * written out so the cap cannot become a guessed constant again.
 */
export function capCosineFromCameraEnvelope(
  maxOrbit = SKY_CONFIG.flightMaxOrbit,
  earthCenterDistance = SKY_CONFIG.earthRadiusKm + SKY_CONFIG.earthOrbitAltitudeKm,
  earthRadius = SKY_CONFIG.earthRadiusKm,
): number {
  const horizonAngle = Math.acos(earthRadius / (earthCenterDistance + maxOrbit));
  const cameraDisplacementAngle = Math.asin(maxOrbit / earthCenterDistance);
  return Math.cos(horizonAngle + cameraDisplacementAngle);
}

export function sunAnchorDistanceFromDebugEnvelope(
  debugMaxOrbit = SKY_CONFIG.debugMaxOrbit,
  earthCenterDistance = SKY_CONFIG.earthRadiusKm + SKY_CONFIG.earthOrbitAltitudeKm,
  earthRadius = SKY_CONFIG.earthRadiusKm,
  margin = SKY_CONFIG.sunAnchorMargin,
): number {
  return debugMaxOrbit + earthCenterDistance + earthRadius + margin;
}

const earthCenterDistanceKm = SKY_CONFIG.earthRadiusKm + SKY_CONFIG.earthOrbitAltitudeKm;
const sunAngularRadiusRadians = (SKY_CONFIG.sunAngularDiameterDegrees * Math.PI / 180) / 2;
const sunQuadHalfAngleRadians = (SKY_CONFIG.sunQuadHalfAngleDegrees * Math.PI / 180);

/** All values in this object are renderer-facing and derived from SKY_CONFIG. */
/**
 * Radiometric display scaling. The LUT/raymarch chain is physically normalized
 * (phase functions integrate to 1 over 4π; transmittance is unitless), so its
 * raw output is radiance per unit solar irradiance — order 0.005-0.05. Real
 * displays need an exposure factor; photographs of the limb put the blue band
 * at a sizable fraction of surface brightness. ATMOSPHERE_INTENSITY is that
 * exposure term (solar irradiance × tone scale), applied to the shell's
 * integrated in-scatter. AERIAL_SKY_RADIANCE is the zenith-sky radiance the
 * surface haze saturates toward: aerial in-scatter is
 * AERIAL_SKY_RADIANCE × (1 − T) per channel, so thick paths converge on sky
 * blue rather than washing out to white.
 */
export const ATMOSPHERE_INTENSITY = 26.0;
export const AERIAL_SKY_RADIANCE: readonly [number, number, number] = [0.10, 0.18, 0.33];

export const SKY_DERIVED: SkyDerived = {
  earthRadiusM: SKY_CONFIG.earthRadiusKm * 1000,
  earthRadiusScene: SKY_CONFIG.earthRadiusKm * 1000 / SKY_CONFIG.renderScaleMPerUnit,
  earthCenterDistanceKm,
  earthCenterDistanceScene: earthCenterDistanceKm * 1000 / SKY_CONFIG.renderScaleMPerUnit,
  deckRadiusMultiplier: radiusMultiplierFromAltitudeKm(SKY_CONFIG.deckAltitudeKm),
  cirrusRadiusMultiplier: radiusMultiplierFromAltitudeKm(SKY_CONFIG.cirrusAltitudeKm),
  volumetricBandInnerRadiusMultiplier: radiusMultiplierFromAltitudeKm(SKY_CONFIG.volumetricBandAltitudeKm.inner),
  volumetricBandOuterRadiusMultiplier: radiusMultiplierFromAltitudeKm(SKY_CONFIG.volumetricBandAltitudeKm.outer),
  atmosphereRadiusMultiplier: SKY_CONFIG.atmosphere.topRadiusKm / SKY_CONFIG.atmosphere.bottomRadiusKm,
  cloudDriftRadPerSec: driftRadPerSecFromGroundSpeed(SKY_CONFIG.cloudGroundSpeedMps),
  cirrusDriftRadPerSec: -driftRadPerSecFromGroundSpeed(SKY_CONFIG.cloudGroundSpeedMps),
  shadowAngularOffsetRad: shadowAngularOffsetFromAltitude(),
  volumetricCapCosine: capCosineFromCameraEnvelope(),
  sunAnchorDistance: sunAnchorDistanceFromDebugEnvelope(),
  sunDiscRadius: sunAnchorDistanceFromDebugEnvelope() * Math.tan(sunAngularRadiusRadians),
  sunQuadHalfWidth: sunAnchorDistanceFromDebugEnvelope() * Math.tan(sunQuadHalfAngleRadians),
};

export const EARTH_VIEW_SCALE = SKY_CONFIG.renderScaleMPerUnit;
export const EARTH_RADIUS_M = SKY_DERIVED.earthRadiusM;
export const EARTH_CENTER_DISTANCE = SKY_DERIVED.earthCenterDistanceScene;
export const DECK_RADIUS_MULTIPLIER = SKY_DERIVED.deckRadiusMultiplier;
export const CIRRUS_RADIUS_MULTIPLIER = SKY_DERIVED.cirrusRadiusMultiplier;
export const CLOUD_BAND_INNER_MULTIPLIER = SKY_DERIVED.volumetricBandInnerRadiusMultiplier;
export const CLOUD_BAND_OUTER_MULTIPLIER = SKY_DERIVED.volumetricBandOuterRadiusMultiplier;
export const ATMOSPHERE_RADIUS_MULTIPLIER = SKY_DERIVED.atmosphereRadiusMultiplier;
export const CLOUD_DRIFT_RAD_PER_SEC = SKY_DERIVED.cloudDriftRadPerSec;
export const CIRRUS_DRIFT_RAD_PER_SEC = SKY_DERIVED.cirrusDriftRadPerSec;
export const SHADOW_ANGULAR_OFFSET_RAD = SKY_DERIVED.shadowAngularOffsetRad;
export const VOLUMETRIC_CAP_COSINE = SKY_DERIVED.volumetricCapCosine;
export const SUN_ANCHOR_DISTANCE = SKY_DERIVED.sunAnchorDistance;
export const SUN_DISC_RADIUS = SKY_DERIVED.sunDiscRadius;
export const SUN_QUAD_HALF_WIDTH = SKY_DERIVED.sunQuadHalfWidth;

export const FLIGHT_MAX_ORBIT = SKY_CONFIG.flightMaxOrbit;
export const DEBUG_MAX_ORBIT = SKY_CONFIG.debugMaxOrbit;
export const ATMOSPHERE_TRANSMITTANCE_LUT_PATH = '/assets/lut/transmittance.bin';
export const ATMOSPHERE_MULTIPLE_SCATTERING_LUT_PATH = '/assets/lut/multiple_scattering.bin';

export const NIGHT_EMISSIVE_GAIN = 2.5;
export const SPEC_GAIN = 1.6;
export const OCEAN_TINT_STRENGTH = 0.55;
/**
 * Camera-to-fragment range (scene units = km) over which ocean wave normals
 * fade to the geometric sphere normal. Waves are a NEAR-WATER effect: from
 * any orbital distance real waves are far sub-pixel, so the water must render
 * as a smooth specular sphere with a steady glint patch. The current camera
 * envelope never gets closer than ~371 units to the surface, so waves are
 * effectively disabled everywhere today; the range exists for the planned
 * atmosphere-to-surface descent, whose close-range wave field will need its
 * own (much finer) pattern anyway.
 */
export const OCEAN_WAVE_FADE_START = 50;
export const OCEAN_WAVE_FADE_END = 150;
export const CLOUD_SHADOW_STRENGTH = 0.82;
export const SHADOW_FULL_LIGHT_COSINE = 0.28;

export const CLOUD_DECK_DETAIL_SCALE = 2.4;
export const CLOUD_DECK_DETAIL_STRENGTH = 0.3;
export const CLOUD_DECK_CONTRAST = 1.25;
export const CLOUD_COVERAGE_DETAIL_MODULATION = 0.45;
export const CLOUD_COVERAGE_REMAP_CENTER = 0.42;
export const CLOUD_COVERAGE_SMOOTH_MIN = 0.02;
export const CLOUD_COVERAGE_SMOOTH_MAX = 0.80;
export const CLOUD_COVERAGE_DETAIL_OFFSET: readonly [number, number] = [0.37, 0.11];
export const CLOUD_DECK_OPACITY = 0.92;
export const CLOUD_DECK_UV_OFFSET: readonly [number, number] = [0, 0];
export const CLOUD_CIRRUS_DETAIL_SCALE = 4.1;
export const CLOUD_CIRRUS_DETAIL_STRENGTH = 0.45;
export const CLOUD_CIRRUS_CONTRAST = 1.5;
export const CLOUD_CIRRUS_OPACITY = 0.26;
export const CLOUD_CIRRUS_UV_OFFSET: readonly [number, number] = [0.41, 0.17];

export const VOLUMETRIC_INSTANCE_COUNT = SKY_CONFIG.volumetricInstanceCount;
export const VOLUMETRIC_FADE_IN_START = 14_000;
export const VOLUMETRIC_FADE_IN_END = 18_000;
export const VOLUMETRIC_FADE_OUT_START = 26_000;
export const VOLUMETRIC_FADE_OUT_END = 34_000;
export const PUFF_MIN_SIZE = SKY_CONFIG.puffSizeKm.min;
export const PUFF_SIZE_RANGE = SKY_CONFIG.puffSizeKm.max - SKY_CONFIG.puffSizeKm.min;
export const PUFF_LARGE_MIN_SIZE = 14;
export const PUFF_LARGE_MAX_SIZE = 22;
export const PUFF_DETAIL_MIN_SIZE = 6;
export const PUFF_DETAIL_MAX_SIZE = 10;
export const PUFF_NOISE_OCTAVES = 3;
export const PUFF_NOISE_SCALE = 2.8;
export const PUFF_SILVER_LINING_G = 0.65;
export const CLOUD_COVERAGE_MASK_PATH = '/assets/textures/cloud_coverage_mask.png';

export function cloudCoverageAtCpu(
  base: number,
  detail: number,
  detailStrength = CLOUD_DECK_DETAIL_STRENGTH,
  contrast = CLOUD_DECK_CONTRAST,
): number {
  const coverage = Math.max(0, Math.min(1,
    (base * (1 - detailStrength * CLOUD_COVERAGE_DETAIL_MODULATION * (1 - detail))
      - CLOUD_COVERAGE_REMAP_CENTER) * contrast + CLOUD_COVERAGE_REMAP_CENTER,
  ));
  const edge = Math.max(0, Math.min(1,
    (coverage - CLOUD_COVERAGE_SMOOTH_MIN)
      / (CLOUD_COVERAGE_SMOOTH_MAX - CLOUD_COVERAGE_SMOOTH_MIN),
  ));
  return edge * edge * (3 - 2 * edge);
}

export const skyConfig = SKY_CONFIG;
export const skyDerived = SKY_DERIVED;
