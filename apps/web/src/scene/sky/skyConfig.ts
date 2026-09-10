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
  insideRaymarchSteps: number;
}

export interface HeroRegionInput {
  id: string;
  centerLatDeg: number;
  centerLonDeg: number;
  radiusKm: number;
  featherKm: number;
}

export interface FrameExposureConfig {
  evBase: number;
  kSun: number;
  kAlt: number;
  sunFloor: number;
  twilightBias: number;
  evMin: number;
  evMax: number;
}

export interface SkyConfig {
  earthRadiusKm: number;
  earthOrbitAltitudeKm: number;
  renderScaleMPerUnit: number;
  worldFrame: {
    rebaseThresholdKm: number;
  };
  terrain: {
    screenSpaceErrorPx: number;
    skirtDepthM: number;
    maxLevel: number;
    tileCacheBudgetMB: number;
    maxLivePatches: number;
    workerBuildConcurrency: number;
    engagementAltitudeKm: number;
    crossfadeAltitudeKm: {
      start: number;
      end: number;
    };
    detail: {
      seed: number;
      octaves: number;
      baseAmplitudeM: number;
      baseWavelengthKm: number;
      lacunarity: number;
      gain: number;
      slopeSampleKm: number;
      landMaskHeightM: number;
    };
    heroRegions: readonly HeroRegionInput[];
  };
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
  puffBillboardSizeKm: {
    largeMin: number;
    largeMax: number;
    detailMin: number;
    detailMax: number;
  };
  volumetricInstanceCount: number;
  shadowLegibility: number;
  atmosphere: AtmosphereCoefficients;
  flightMaxOrbitKm: number;
  debugMaxOrbitKm: number;
  sunAnchorMarginKm: number;
  oceanWaveFadeKm: {
    start: number;
    end: number;
  };
  volumetricFadeKm: {
    inStart: number;
    inEnd: number;
    outStart: number;
    outEnd: number;
  };
  cloudThroughLayerFogKm: {
    start: number;
    end: number;
  };
  heroCloudCoverageFloor: number;
  flySpeedPerAgl: {
    minMps: number;
    maxMps: number;
    fullSpeedAglM: number;
    curvePower: number;
  };
  flyCollisionClearanceM: number;
  /**
   * The renderer's only exposure control. Shaders emit scene-referred radiance
   * normalized to top-of-atmosphere solar irradiance 1.0; this frame-global
   * scalar and the ACES tonemap are applied exactly once, in the composer.
   */
  frameExposure: FrameExposureConfig;
  cameraNearM: number;
  cockpitCameraNearM: number;
  pipCameraFarM: number;
  cameraFarKm: number;
  sunAngularDiameterDegrees: number;
  sunQuadHalfAngleDegrees: number;
}

export interface SkyDerived {
  earthRadiusM: number;
  earthRadiusScene: number;
  worldFrameRebaseThresholdM: number;
  worldFrameRebaseThresholdScene: number;
  earthCenterDistanceKm: number;
  earthCenterDistanceM: number;
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
  sunAnchorDistanceKm: number;
  sunAnchorDistanceM: number;
  sunAnchorDistance: number;
  sunDiscRadius: number;
  sunQuadHalfWidth: number;
}

const EARTH_RADIUS_KM = 6371;

/** Physical sky inputs. Renderer values below are derived from this object. */
export const SKY_CONFIG: SkyConfig = {
  earthRadiusKm: EARTH_RADIUS_KM,
  earthOrbitAltitudeKm: 400,
  renderScaleMPerUnit: 1,
  worldFrame: {
    rebaseThresholdKm: 10,
  },
  terrain: {
    screenSpaceErrorPx: 2,
    skirtDepthM: 2,
    // GEOMETRY subdivision depth, independent of the raster pyramid's own
    // maxLevel (3, ~2 km/px). A cube face spans ~10,000 km across 32 patch
    // segments, so vertex spacing is 10,000 km / (2^level * 32): level 3 is
    // 39 km/vertex (a barely-faceted sphere — not ground), level 10 is ~305 m,
    // level 16 ~5 m. Below the raster's depth, height comes from the finest
    // resident ancestor tile plus procedural detail.
    //
    // The selector now reserves its full resident closure before each split;
    // it evaluates at most the 300-record budget, even with a deep LOD ceiling.
    // The old depth-10 workaround left ~305 m vertices near the camera and
    // could not represent the existing metre-scale height field. Refine only
    // the nearest footprint to ~5 m while retaining the same memory/work cap.
    maxLevel: 16,
    tileCacheBudgetMB: 64,
    maxLivePatches: 300,
    workerBuildConcurrency: 4,
    engagementAltitudeKm: 120,
    crossfadeAltitudeKm: { start: 20, end: 120 },
    detail: {
      seed: 0x54455252,
      octaves: 12,
      baseAmplitudeM: 35,
      baseWavelengthKm: 4,
      lacunarity: 2,
      gain: 0.5,
      slopeSampleKm: 1,
      landMaskHeightM: 10,
    },
    heroRegions: [
      { id: 'ksc', centerLatDeg: 28.6, centerLonDeg: -80.6, radiusKm: 20, featherKm: 5 },
      { id: 'boca-chica', centerLatDeg: 26.0, centerLonDeg: -97.2, radiusKm: 20, featherKm: 5 },
    ],
  },
  deckAltitudeKm: 7,
  cirrusAltitudeKm: 12.7,
  volumetricBandAltitudeKm: { inner: 1.5, outer: 9 },
  cloudGroundSpeedMps: 25,
  puffSizeKm: { min: 8, max: 22 },
  puffBillboardSizeKm: { largeMin: 14, largeMax: 22, detailMin: 6, detailMax: 10 },
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
    insideRaymarchSteps: 32,
  },
  flightMaxOrbitKm: 2000,
  debugMaxOrbitKm: 40_000,
  sunAnchorMarginKm: 5000,
  oceanWaveFadeKm: { start: 50, end: 150 },
  volumetricFadeKm: { inStart: 14_000, inEnd: 18_000, outStart: 26_000, outEnd: 34_000 },
  cloudThroughLayerFogKm: { start: 1, end: 8 },
  heroCloudCoverageFloor: 0.55,
  flySpeedPerAgl: {
    minMps: 2,
    // A debug tool, not a vehicle: 200 km/s at orbital AGL crosses the
    // 400 km descent in seconds while the AGL curve still lands gently.
    maxMps: 200_000,
    fullSpeedAglM: 400_000,
    curvePower: 1.15,
  },
  flyCollisionClearanceM: 2,
  // Calibration STARTING points, not final values — Phase 1 tunes these against
  // the four reference framings with the render on screen. kSun/evMin are set
  // so the EV clamp only engages below the horizon (~-2 deg): at kSun 3.0 with
  // evMin -4.0 the clamp engaged at 17 deg elevation, flattening the entire
  // twilight range and collapsing the sunset and night reference framings onto
  // an identical EV, which left two of the four golden oracles unable to
  // distinguish the cases they are named for.
  frameExposure: {
    evBase: 0.0,
    kSun: 1.5,
    kAlt: 1.5,
    sunFloor: 0.02,
    twilightBias: 0.10,
    evMin: -6.0,
    evMax: 6.0,
  },
  cameraNearM: 0.5,
  cockpitCameraNearM: 0.05,
  pipCameraFarM: 2_000,
  cameraFarKm: 100_000,
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
  return groundSpeedMps / kmToMeters(earthRadiusKm);
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
  maxOrbitKm = SKY_CONFIG.flightMaxOrbitKm,
  earthCenterDistanceKm = SKY_CONFIG.earthRadiusKm + SKY_CONFIG.earthOrbitAltitudeKm,
  earthRadiusKm = SKY_CONFIG.earthRadiusKm,
): number {
  const horizonAngle = Math.acos(earthRadiusKm / (earthCenterDistanceKm + maxOrbitKm));
  const cameraDisplacementAngle = Math.asin(maxOrbitKm / earthCenterDistanceKm);
  return Math.cos(horizonAngle + cameraDisplacementAngle);
}

export function sunAnchorDistanceFromDebugEnvelope(
  debugMaxOrbitKm = SKY_CONFIG.debugMaxOrbitKm,
  earthCenterDistanceKm = SKY_CONFIG.earthRadiusKm + SKY_CONFIG.earthOrbitAltitudeKm,
  earthRadiusKm = SKY_CONFIG.earthRadiusKm,
  marginKm = SKY_CONFIG.sunAnchorMarginKm,
): number {
  return debugMaxOrbitKm + earthCenterDistanceKm + earthRadiusKm + marginKm;
}

export function kmToMeters(km: number): number {
  return km * 1000;
}

export function metersToSceneUnits(meters: number): number {
  return meters / SKY_CONFIG.renderScaleMPerUnit;
}

/** Convert a physical km quantity to scene units under the active render scale. */
export function kmToSceneUnits(km: number): number {
  return metersToSceneUnits(kmToMeters(km));
}

export function worldFrameRebaseThresholdMFromKm(
  thresholdKm = SKY_CONFIG.worldFrame.rebaseThresholdKm,
): number {
  return kmToMeters(thresholdKm);
}

export function flySpeedMpsFromAgl(
  aglM: number,
  config = SKY_CONFIG.flySpeedPerAgl,
): number {
  if (!Number.isFinite(aglM)) throw new Error('Fly AGL must be finite');
  if (!Number.isFinite(config.minMps) || !Number.isFinite(config.maxMps)
    || !Number.isFinite(config.fullSpeedAglM) || config.minMps < 0
    || config.maxMps < config.minMps || config.fullSpeedAglM <= 0
    || !Number.isFinite(config.curvePower) || config.curvePower <= 0) {
    throw new Error('Invalid fly speed configuration');
  }
  const t = Math.pow(Math.max(0, Math.min(config.fullSpeedAglM, aglM)) / config.fullSpeedAglM, config.curvePower);
  return config.minMps + (config.maxMps - config.minMps) * t;
}

const earthCenterDistanceKm = SKY_CONFIG.earthRadiusKm + SKY_CONFIG.earthOrbitAltitudeKm;
const sunAngularRadiusRadians = (SKY_CONFIG.sunAngularDiameterDegrees * Math.PI / 180) / 2;
const sunQuadHalfAngleRadians = (SKY_CONFIG.sunQuadHalfAngleDegrees * Math.PI / 180);

/** All values in this object are renderer-facing and derived from SKY_CONFIG. */
/**
 * Radiometric display scaling. The LUT/raymarch chain is physically normalized
 * (phase functions integrate to 1 over 4π; transmittance is unitless), so its
 * raw output is radiance per unit solar irradiance — order 0.005-0.05. The
 * frame-global composer exposure provides the display scale.
 * AERIAL_SKY_RADIANCE is the zenith-sky radiance the
 * surface haze saturates toward: aerial in-scatter is
 * AERIAL_SKY_RADIANCE × (1 − T) per channel, so thick paths converge on sky
 * blue rather than washing out to white.
 */
export const AERIAL_SKY_RADIANCE: readonly [number, number, number] = [0.10, 0.18, 0.33];

export const SKY_DERIVED: SkyDerived = {
  earthRadiusM: kmToMeters(SKY_CONFIG.earthRadiusKm),
  earthRadiusScene: kmToSceneUnits(SKY_CONFIG.earthRadiusKm),
  worldFrameRebaseThresholdM: worldFrameRebaseThresholdMFromKm(),
  worldFrameRebaseThresholdScene: worldFrameRebaseThresholdMFromKm() / SKY_CONFIG.renderScaleMPerUnit,
  earthCenterDistanceKm,
  earthCenterDistanceM: kmToMeters(earthCenterDistanceKm),
  earthCenterDistanceScene: kmToSceneUnits(earthCenterDistanceKm),
  deckRadiusMultiplier: radiusMultiplierFromAltitudeKm(SKY_CONFIG.deckAltitudeKm),
  cirrusRadiusMultiplier: radiusMultiplierFromAltitudeKm(SKY_CONFIG.cirrusAltitudeKm),
  volumetricBandInnerRadiusMultiplier: radiusMultiplierFromAltitudeKm(SKY_CONFIG.volumetricBandAltitudeKm.inner),
  volumetricBandOuterRadiusMultiplier: radiusMultiplierFromAltitudeKm(SKY_CONFIG.volumetricBandAltitudeKm.outer),
  atmosphereRadiusMultiplier: SKY_CONFIG.atmosphere.topRadiusKm / SKY_CONFIG.atmosphere.bottomRadiusKm,
  cloudDriftRadPerSec: driftRadPerSecFromGroundSpeed(SKY_CONFIG.cloudGroundSpeedMps),
  cirrusDriftRadPerSec: -driftRadPerSecFromGroundSpeed(SKY_CONFIG.cloudGroundSpeedMps),
  shadowAngularOffsetRad: shadowAngularOffsetFromAltitude(),
  volumetricCapCosine: capCosineFromCameraEnvelope(),
  sunAnchorDistanceKm: sunAnchorDistanceFromDebugEnvelope(),
  sunAnchorDistanceM: kmToMeters(sunAnchorDistanceFromDebugEnvelope()),
  sunAnchorDistance: kmToSceneUnits(sunAnchorDistanceFromDebugEnvelope()),
  sunDiscRadius: kmToSceneUnits(sunAnchorDistanceFromDebugEnvelope()) * Math.tan(sunAngularRadiusRadians),
  sunQuadHalfWidth: kmToSceneUnits(sunAnchorDistanceFromDebugEnvelope()) * Math.tan(sunQuadHalfAngleRadians),
};

export const EARTH_VIEW_SCALE = SKY_CONFIG.renderScaleMPerUnit;
export const EARTH_RADIUS_M = SKY_DERIVED.earthRadiusM;
export const WORLD_FRAME_REBASE_THRESHOLD_M = SKY_DERIVED.worldFrameRebaseThresholdM;
export const WORLD_FRAME_REBASE_THRESHOLD = WORLD_FRAME_REBASE_THRESHOLD_M;
export const TERRAIN_SPLIT_SCREEN_SPACE_ERROR_PX = SKY_CONFIG.terrain.screenSpaceErrorPx;
export const TERRAIN_SKIRT_DEPTH_M = SKY_CONFIG.terrain.skirtDepthM;
export const TERRAIN_MAX_LEVEL = SKY_CONFIG.terrain.maxLevel;
export const TERRAIN_TILE_CACHE_BUDGET_BYTES = SKY_CONFIG.terrain.tileCacheBudgetMB * 1024 * 1024;
export const TERRAIN_MAX_LIVE_PATCHES = SKY_CONFIG.terrain.maxLivePatches;
export const TERRAIN_WORKER_BUILD_CONCURRENCY = SKY_CONFIG.terrain.workerBuildConcurrency;
export const TERRAIN_ENGAGEMENT_ALTITUDE_M = kmToMeters(SKY_CONFIG.terrain.engagementAltitudeKm);
export const TERRAIN_CROSSFADE_START_M = kmToMeters(SKY_CONFIG.terrain.crossfadeAltitudeKm.start);
export const TERRAIN_CROSSFADE_END_M = kmToMeters(SKY_CONFIG.terrain.crossfadeAltitudeKm.end);

/** Terrain opacity: zero above the engagement band, one near the ground. */
export function terrainFadeFromAltitudeM(altitudeM: number): number {
  const start = TERRAIN_CROSSFADE_START_M;
  const end = TERRAIN_CROSSFADE_END_M;
  if (altitudeM <= start) return 1;
  if (altitudeM >= end) return 0;
  const t = (altitudeM - start) / Math.max(end - start, Number.EPSILON);
  const smooth = t * t * (3 - 2 * t);
  return 1 - smooth;
}
export const EARTH_CENTER_DISTANCE = SKY_DERIVED.earthCenterDistanceScene;
export const EARTH_CENTER_DISTANCE_M = SKY_DERIVED.earthCenterDistanceM;
export const DECK_RADIUS_MULTIPLIER = SKY_DERIVED.deckRadiusMultiplier;
export const CIRRUS_RADIUS_MULTIPLIER = SKY_DERIVED.cirrusRadiusMultiplier;
export const CLOUD_BAND_INNER_MULTIPLIER = SKY_DERIVED.volumetricBandInnerRadiusMultiplier;
export const CLOUD_BAND_OUTER_MULTIPLIER = SKY_DERIVED.volumetricBandOuterRadiusMultiplier;
export const ATMOSPHERE_RADIUS_MULTIPLIER = SKY_DERIVED.atmosphereRadiusMultiplier;
export const CLOUD_DRIFT_RAD_PER_SEC = SKY_DERIVED.cloudDriftRadPerSec;
export const CIRRUS_DRIFT_RAD_PER_SEC = SKY_DERIVED.cirrusDriftRadPerSec;
export const SHADOW_ANGULAR_OFFSET_RAD = SKY_DERIVED.shadowAngularOffsetRad;
export const VOLUMETRIC_CAP_COSINE = SKY_DERIVED.volumetricCapCosine;
export const SUN_ANCHOR_DISTANCE_M = SKY_DERIVED.sunAnchorDistanceM;
export const SUN_ANCHOR_DISTANCE = SKY_DERIVED.sunAnchorDistance;
export const SUN_DISC_RADIUS = SKY_DERIVED.sunDiscRadius;
export const SUN_QUAD_HALF_WIDTH = SKY_DERIVED.sunQuadHalfWidth;

export const FLIGHT_MAX_ORBIT = kmToSceneUnits(SKY_CONFIG.flightMaxOrbitKm);
export const DEBUG_MAX_ORBIT = kmToSceneUnits(SKY_CONFIG.debugMaxOrbitKm);
export const FLIGHT_MAX_ORBIT_M = kmToMeters(SKY_CONFIG.flightMaxOrbitKm);
export const DEBUG_MAX_ORBIT_M = kmToMeters(SKY_CONFIG.debugMaxOrbitKm);
export const CAMERA_NEAR = metersToSceneUnits(SKY_CONFIG.cameraNearM);
export const COCKPIT_CAMERA_NEAR = metersToSceneUnits(SKY_CONFIG.cockpitCameraNearM);
export const PIP_CAMERA_FAR = metersToSceneUnits(SKY_CONFIG.pipCameraFarM);
export const CAMERA_FAR = kmToSceneUnits(SKY_CONFIG.cameraFarKm);
export const ATMOSPHERE_TRANSMITTANCE_LUT_PATH = '/assets/lut/transmittance.bin';
export const ATMOSPHERE_MULTIPLE_SCATTERING_LUT_PATH = '/assets/lut/multiple_scattering.bin';

export const NIGHT_EMISSIVE_GAIN = 2.5;
export const SPEC_GAIN = 1.6;
export const OCEAN_TINT_STRENGTH = 0.55;
/**
 * Camera-to-fragment range (derived scene units) over which ocean wave normals
 * fade to the geometric sphere normal. Waves are a NEAR-WATER effect: from
 * any orbital distance real waves are far sub-pixel, so the water must render
 * as a smooth specular sphere with a steady glint patch. The current camera
 * envelope never gets closer than ~371 units to the surface, so waves are
 * effectively disabled everywhere today; the range exists for the planned
 * atmosphere-to-surface descent, whose close-range wave field will need its
 * own (much finer) pattern anyway.
 */
export const OCEAN_WAVE_FADE_START = kmToSceneUnits(SKY_CONFIG.oceanWaveFadeKm.start);
export const OCEAN_WAVE_FADE_END = kmToSceneUnits(SKY_CONFIG.oceanWaveFadeKm.end);
export const CLOUD_THROUGH_LAYER_FOG_START = kmToSceneUnits(SKY_CONFIG.cloudThroughLayerFogKm.start);
export const CLOUD_THROUGH_LAYER_FOG_END = kmToSceneUnits(SKY_CONFIG.cloudThroughLayerFogKm.end);
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
export const VOLUMETRIC_FADE_IN_START = kmToSceneUnits(SKY_CONFIG.volumetricFadeKm.inStart);
export const VOLUMETRIC_FADE_IN_END = kmToSceneUnits(SKY_CONFIG.volumetricFadeKm.inEnd);
export const VOLUMETRIC_FADE_OUT_START = kmToSceneUnits(SKY_CONFIG.volumetricFadeKm.outStart);
export const VOLUMETRIC_FADE_OUT_END = kmToSceneUnits(SKY_CONFIG.volumetricFadeKm.outEnd);
export const PUFF_MIN_SIZE = kmToSceneUnits(SKY_CONFIG.puffSizeKm.min);
export const PUFF_SIZE_RANGE = kmToSceneUnits(SKY_CONFIG.puffSizeKm.max - SKY_CONFIG.puffSizeKm.min);
export const PUFF_LARGE_MIN_SIZE = kmToSceneUnits(SKY_CONFIG.puffBillboardSizeKm.largeMin);
export const PUFF_LARGE_MAX_SIZE = kmToSceneUnits(SKY_CONFIG.puffBillboardSizeKm.largeMax);
export const PUFF_DETAIL_MIN_SIZE = kmToSceneUnits(SKY_CONFIG.puffBillboardSizeKm.detailMin);
export const PUFF_DETAIL_MAX_SIZE = kmToSceneUnits(SKY_CONFIG.puffBillboardSizeKm.detailMax);
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
