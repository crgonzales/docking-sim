import { SUN_DIR } from '../sun';
import { SKY_CONFIG, type FrameExposureConfig } from './skyConfig';

export interface Vector3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface FrameExposureFrame {
  cameraPositionWorld: Vector3Like;
  planetCenterWorld: Vector3Like;
  cameraAltitudeKm: number;
}

export interface FrameExposureResult {
  /** Clamped exposure value in photographic stops. */
  ev: number;
  /** Linear multiplier corresponding to the clamped EV. */
  exposure: number;
  /** The ground-point sine of sun elevation used by the EV calculation. */
  sinSunElevation: number;
  /** Saturated sun term before the floor is applied. */
  sunFactor: number;
  /** Smoothly clamped altitude term from ground to the atmosphere top. */
  altitudeTerm: number;
}

const ATMOSPHERE_TOP_ALTITUDE_KM =
  SKY_CONFIG.atmosphere.topRadiusKm - SKY_CONFIG.atmosphere.bottomRadiusKm;

/**
 * Fixed EV oracles for the starting coefficients. These are intentionally
 * recorded values rather than expressions derived from the implementation so
 * calibration changes cannot silently update the test expectations.
 */
export const NOON_GROUND_EV_GOLDEN = 0;
export const SUNSET_LIMB_EV_GOLDEN = -3.482892142331043;
export const NIGHT_EV_GOLDEN = -6;
export const ORBIT_EV_GOLDEN = 1.5;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function smoothstep01(value: number): number {
  const clamped = clamp(value, 0, 1);
  return clamped * clamped * (3 - 2 * clamped);
}

function finiteVector(vector: Vector3Like, name: string): void {
  if (!Number.isFinite(vector.x) || !Number.isFinite(vector.y) || !Number.isFinite(vector.z)) {
    throw new Error(`${name} must be finite`);
  }
}

function normalizedOffset(camera: Vector3Like, center: Vector3Like): Vector3Like {
  const x = camera.x - center.x;
  const y = camera.y - center.y;
  const z = camera.z - center.z;
  const length = Math.hypot(x, y, z);
  if (length <= 0) throw new Error('Camera position must differ from planet center');
  return { x: x / length, y: y / length, z: z / length };
}

function validateConfig(config: FrameExposureConfig, topAtmosphereAltitudeKm: number): void {
  if (!Number.isFinite(config.evBase)
    || !Number.isFinite(config.kSun)
    || !Number.isFinite(config.kAlt)
    || !Number.isFinite(config.sunFloor)
    || !Number.isFinite(config.twilightBias)
    || !Number.isFinite(config.evMin)
    || !Number.isFinite(config.evMax)
    || config.sunFloor <= 0
    || config.evMin > config.evMax
    || !Number.isFinite(topAtmosphereAltitudeKm)
    || topAtmosphereAltitudeKm <= 0) {
    throw new Error('Invalid frame exposure configuration');
  }
}

/**
 * Computes one continuous frame-global exposure from the sub-nadir ground
 * point. `SUN_DIR` is the fixed, normalized Earth-to-sun direction, so the
 * ground-point sine of sun elevation is the dot product of it with the
 * camera's planet-center radial direction — not a direction measured from the
 * camera's position in orbit.
 */
export function frameExposureFromCamera(
  frame: FrameExposureFrame,
  config: FrameExposureConfig = SKY_CONFIG.frameExposure,
  topAtmosphereAltitudeKm = ATMOSPHERE_TOP_ALTITUDE_KM,
): FrameExposureResult {
  finiteVector(frame.cameraPositionWorld, 'Camera position');
  finiteVector(frame.planetCenterWorld, 'Planet center');
  if (!Number.isFinite(frame.cameraAltitudeKm)) throw new Error('Camera altitude must be finite');
  validateConfig(config, topAtmosphereAltitudeKm);

  const radial = normalizedOffset(frame.cameraPositionWorld, frame.planetCenterWorld);
  const sinSunElevation = clamp(
    radial.x * SUN_DIR.x + radial.y * SUN_DIR.y + radial.z * SUN_DIR.z,
    -1,
    1,
  );
  const sunFactor = clamp(sinSunElevation + config.twilightBias, 0, 1);
  const altitudeTerm = smoothstep01(frame.cameraAltitudeKm / topAtmosphereAltitudeKm);
  const unclampedEv = config.evBase
    + config.kSun * Math.log2(Math.max(sunFactor, config.sunFloor))
    + config.kAlt * altitudeTerm;
  const ev = clamp(unclampedEv, config.evMin, config.evMax);

  return {
    ev,
    exposure: 2 ** (-ev),
    sinSunElevation,
    sunFactor,
    altitudeTerm,
  };
}
