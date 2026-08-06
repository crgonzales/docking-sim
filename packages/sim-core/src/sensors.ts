import { createRng, type SeededRng } from './rng.js';
import type { Quat, SensorFrame, TruthState, Vec3 } from './types.js';

export interface SensorBiasRamp {
  range_m?: number;
  bearing_rad?: [number, number];
  gyro_rps?: Vec3;
  attitude_rad?: Vec3;
  rampDuration_s?: number;
}

export interface SensorDropoutConfig {
  range?: boolean;
  bearing?: boolean;
  attitude?: boolean;
}

export interface SensorDegradeConfig {
  /** Sim-time at which the degradation becomes active. */
  start_t_s?: number;
  /** Optional active duration; omitted means active indefinitely. */
  duration_s?: number;
  /** Default bias-ramp duration when the bias block does not specify one. */
  rampDuration_s?: number;
  /** Multiplier applied to all configured noise while active. */
  noiseMultiplier?: number;
  /** Drop nullable measurements while active. */
  dropout?: boolean | SensorDropoutConfig;
  /** Biases ramp from zero after activation. */
  biasRamp?: SensorBiasRamp;
}

export interface SensorModelConfig {
  /** Range sigma = floor + scale * range. */
  range_sigma_floor_m?: number;
  range_sigma_scale?: number;
  bearing_sigma_rad?: number | [number, number];
  gyro_sigma_rps?: number | Vec3;
  attitude_sigma_rad?: number;
  degrade?: SensorDegradeConfig | null;
}

export interface SensorModel {
  sample(truth: TruthState): SensorFrame;
  setDegrade(degrade: SensorDegradeConfig | null): void;
  clearDegrade(): void;
}

const DEFAULT_CONFIG: Required<Omit<SensorModelConfig, 'degrade'>> = {
  range_sigma_floor_m: 0.01,
  range_sigma_scale: 0.001,
  bearing_sigma_rad: 0.0005,
  gyro_sigma_rps: [1e-5, 1e-5, 1e-5],
  attitude_sigma_rad: 0.0005,
};

function normalizeQuaternion(q: Quat): Quat {
  const norm = Math.hypot(q[0], q[1], q[2], q[3]);
  if (norm === 0) return [1, 0, 0, 0];
  return [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm];
}

function multiplyQuaternion(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

function rotationVectorQuaternion(rotationVector_rad: Vec3): Quat {
  const angle_rad = Math.hypot(...rotationVector_rad);
  if (angle_rad < 1e-15) return [1, 0, 0, 0];
  const scale = Math.sin(angle_rad / 2) / angle_rad;
  return [
    Math.cos(angle_rad / 2),
    rotationVector_rad[0] * scale,
    rotationVector_rad[1] * scale,
    rotationVector_rad[2] * scale,
  ];
}

function wrapPi(angle_rad: number): number {
  const wrapped = (angle_rad + Math.PI) % (2 * Math.PI);
  return wrapped <= 0 ? wrapped + Math.PI : wrapped - Math.PI;
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

function vec3Config(value: number | Vec3 | undefined, fallback: Vec3): Vec3 {
  if (value === undefined) return fallback;
  return typeof value === 'number' ? [value, value, value] : [...value];
}

function bearingSigmaConfig(value: number | [number, number] | undefined): [number, number] {
  if (value === undefined) return [DEFAULT_CONFIG.bearing_sigma_rad as number, DEFAULT_CONFIG.bearing_sigma_rad as number];
  return typeof value === 'number' ? [value, value] : [...value];
}

function addVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scaledVec3(a: Vec3, scale: number): Vec3 {
  return [a[0] * scale, a[1] * scale, a[2] * scale];
}

/** Convert the plan's azimuth/elevation convention back to a unit LOS. */
export function bearingToLosUnit(bearing_body_rad: [number, number]): Vec3 {
  const [azimuth_rad, elevation_rad] = bearing_body_rad;
  const cosElevation = Math.cos(elevation_rad);
  return [
    cosElevation * Math.sin(azimuth_rad),
    cosElevation * Math.cos(azimuth_rad),
    Math.sin(elevation_rad),
  ];
}

/**
 * Convert a Hill-frame chaser-to-target LOS into the sensor bearing pair.
 * The body frame is coincident with Hill in Phase 2 and boresight is +y.
 */
export function losToBearing(los_unit: Vec3): [number, number] {
  const norm = Math.hypot(...los_unit);
  if (norm === 0) throw new RangeError('LOS must be non-zero');
  const l: Vec3 = [los_unit[0] / norm, los_unit[1] / norm, los_unit[2] / norm];
  return [wrapPi(Math.atan2(l[0], l[1])), Math.asin(clamp(l[2], -1, 1))];
}

/** Convert relative position to the chaser-to-target bearing convention. */
export function relativePositionToBearing(r_hill_m: Vec3): [number, number] {
  const norm = Math.hypot(...r_hill_m);
  if (norm === 0) throw new RangeError('relative position must be non-zero');
  return losToBearing([-r_hill_m[0] / norm, -r_hill_m[1] / norm, -r_hill_m[2] / norm]);
}

function activeDegradeAt(degrade: SensorDegradeConfig | null, t_s: number): { degrade: SensorDegradeConfig; ramp: number } | null {
  if (degrade === null) return null;
  const start_t_s = degrade.start_t_s ?? 0;
  const elapsed_s = t_s - start_t_s;
  if (elapsed_s < 0 || (degrade.duration_s !== undefined && elapsed_s >= degrade.duration_s)) return null;
  const rampDuration_s = degrade.rampDuration_s ?? degrade.biasRamp?.rampDuration_s ?? 0;
  return { degrade, ramp: rampDuration_s > 0 ? clamp(elapsed_s / rampDuration_s, 0, 1) : 1 };
}

function dropoutActive(dropout: SensorDegradeConfig['dropout'], field: keyof SensorDropoutConfig): boolean {
  if (dropout === true) return true;
  if (dropout === false || dropout === undefined) return false;
  return dropout[field] === true;
}

function validateConfig(config: SensorModelConfig): void {
  const rangeFloor = config.range_sigma_floor_m ?? DEFAULT_CONFIG.range_sigma_floor_m;
  const rangeScale = config.range_sigma_scale ?? DEFAULT_CONFIG.range_sigma_scale;
  const bearingSigma = bearingSigmaConfig(config.bearing_sigma_rad);
  const gyroSigma = vec3Config(config.gyro_sigma_rps, DEFAULT_CONFIG.gyro_sigma_rps as Vec3);
  const attitudeSigma = config.attitude_sigma_rad ?? DEFAULT_CONFIG.attitude_sigma_rad;
  if ([rangeFloor, rangeScale, ...bearingSigma, ...gyroSigma, attitudeSigma].some((value) => value < 0 || !Number.isFinite(value))) {
    throw new RangeError('sensor noise values must be finite and non-negative');
  }
}

/** Create a deterministic, sim-time-driven sensor sampler. */
export function createSensorModel(config: SensorModelConfig = {}, rng: SeededRng = createRng(0)): SensorModel {
  validateConfig(config);
  const rangeRng = rng.substream('sensors.range');
  const bearingRng = rng.substream('sensors.bearing');
  const gyroRng = rng.substream('sensors.gyro');
  const attitudeRng = rng.substream('sensors.attitude');
  const rangeFloor_m = config.range_sigma_floor_m ?? DEFAULT_CONFIG.range_sigma_floor_m;
  const rangeScale = config.range_sigma_scale ?? DEFAULT_CONFIG.range_sigma_scale;
  const [bearingSigmaAz_rad, bearingSigmaEl_rad] = bearingSigmaConfig(config.bearing_sigma_rad);
  const gyroSigma_rps = vec3Config(config.gyro_sigma_rps, DEFAULT_CONFIG.gyro_sigma_rps as Vec3);
  const attitudeSigma_rad = config.attitude_sigma_rad ?? DEFAULT_CONFIG.attitude_sigma_rad;
  let degrade = config.degrade ?? null;

  return {
    setDegrade(nextDegrade) {
      if (nextDegrade?.noiseMultiplier !== undefined && (nextDegrade.noiseMultiplier < 0 || !Number.isFinite(nextDegrade.noiseMultiplier))) {
        throw new RangeError('noiseMultiplier must be finite and non-negative');
      }
      degrade = nextDegrade;
    },
    clearDegrade() {
      degrade = null;
    },
    sample(truth) {
      const active = activeDegradeAt(degrade, truth.t_s);
      const currentDegrade = active?.degrade;
      const ramp = active?.ramp ?? 0;
      const noiseMultiplier = currentDegrade?.noiseMultiplier ?? 1;
      const range_m = Math.hypot(...truth.r_hill_m);
      const rangeSigma_m = (rangeFloor_m + rangeScale * range_m) * noiseMultiplier;
      const [trueAzimuth_rad, trueElevation_rad] = relativePositionToBearing(truth.r_hill_m);
      const rangeBias_m = (currentDegrade?.biasRamp?.range_m ?? 0) * ramp;
      const bearingBias_rad = scaledVec3([
        currentDegrade?.biasRamp?.bearing_rad?.[0] ?? 0,
        currentDegrade?.biasRamp?.bearing_rad?.[1] ?? 0,
        0,
      ], ramp);
      const gyroBias_rps = scaledVec3(currentDegrade?.biasRamp?.gyro_rps ?? [0, 0, 0], ramp);
      const attitudeBias_rad = scaledVec3(currentDegrade?.biasRamp?.attitude_rad ?? [0, 0, 0], ramp);

      const noisyRange_m = Math.max(0, range_m + rangeBias_m + rangeRng.gaussian(0, rangeSigma_m));
      const noisyBearing: [number, number] = [
        wrapPi(trueAzimuth_rad + bearingBias_rad[0] + bearingRng.gaussian(0, bearingSigmaAz_rad * noiseMultiplier)),
        clamp(trueElevation_rad + bearingBias_rad[1] + bearingRng.gaussian(0, bearingSigmaEl_rad * noiseMultiplier), -Math.PI / 2, Math.PI / 2),
      ];
      const gyroNoise: Vec3 = [
        gyroRng.gaussian(0, gyroSigma_rps[0] * noiseMultiplier),
        gyroRng.gaussian(0, gyroSigma_rps[1] * noiseMultiplier),
        gyroRng.gaussian(0, gyroSigma_rps[2] * noiseMultiplier),
      ];
      const gyro_rps = addVec3(addVec3(truth.w_body_rps, gyroBias_rps), gyroNoise);
      const attitudeNoise_rad: Vec3 = [
        attitudeBias_rad[0] + attitudeRng.gaussian(0, attitudeSigma_rad * noiseMultiplier),
        attitudeBias_rad[1] + attitudeRng.gaussian(0, attitudeSigma_rad * noiseMultiplier),
        attitudeBias_rad[2] + attitudeRng.gaussian(0, attitudeSigma_rad * noiseMultiplier),
      ];
      const attitude_q_BI = normalizeQuaternion(multiplyQuaternion(
        rotationVectorQuaternion(attitudeNoise_rad),
        truth.q_BI,
      ));
      const dropout = currentDegrade?.dropout;

      return {
        t_s: truth.t_s,
        range_m: dropoutActive(dropout, 'range') ? null : noisyRange_m,
        bearing_body_rad: dropoutActive(dropout, 'bearing') ? null : noisyBearing,
        gyro_rps,
        attitude_q_BI: dropoutActive(dropout, 'attitude') ? null : attitude_q_BI,
      };
    },
  };
}
