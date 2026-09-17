import { conjugateQuaternion, hillFromInertial, multiplyQuaternion, normalizeQuaternion, rotateVector, smallAngleExp } from './attitude.js';
import { DEFAULT_MEAN_MOTION_RAD_S } from './attitude.js';
import { MU_EARTH_M3_S2 } from './constants.js';
import type { Quat, Vec3 } from './types.js';

/** Constant synthetic Earth rotation, rad/s; not a full sidereal-time model. */
export const EARTH_ROTATION_RAD_S = 7.292115e-5;
export const GPS_WEEK_S = 604800;

export interface GnssEpoch {
  readonly gpsWeek: number;
  readonly secondsOfWeek_s: number;
  /** Signed UTC minus GPS seconds, fixed for the run and used only for display. */
  readonly utcMinusGps_leapSeconds: number;
}
export interface WorldAnchorConfig {
  readonly meanMotionRadS?: number;
  readonly inclination_rad: number;
  readonly raan_rad: number;
  readonly argumentOfLatitude_rad: number;
  readonly gmstAtEpoch_rad: number;
  /** The GPS date and all epoch angles correspond to simulation t_s = 0. */
  readonly epoch: GnssEpoch;
}
export interface WorldAnchor extends WorldAnchorConfig {
  readonly meanMotionRadS: number;
  readonly radius_m: number;
  /** Constant C_ECI_I0 represented as a scalar-first quaternion, I0 → ECI. */
  readonly q_ECI_I0: Readonly<Quat>;
}
/** Position and coordinate derivative in the frame named by the calling API. */
export interface CartesianState { r_m: Vec3; v_mps: Vec3 }
export interface AbsoluteState { t_s: number; eci: CartesianState; ecef: CartesianState }

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}
function validateEpoch(epoch: GnssEpoch): void {
  if (!Number.isSafeInteger(epoch.gpsWeek) || epoch.gpsWeek < 0) throw new RangeError('gpsWeek must be a nonnegative safe integer');
  if (!Number.isFinite(epoch.secondsOfWeek_s) || epoch.secondsOfWeek_s < 0 || epoch.secondsOfWeek_s >= GPS_WEEK_S) {
    throw new RangeError('secondsOfWeek_s must be in [0, 604800)');
  }
  if (!Number.isSafeInteger(epoch.utcMinusGps_leapSeconds)) throw new RangeError('utcMinusGps_leapSeconds must be a fixed integer');
}

/** Construction validates this anchor only; cross-module mean-motion checks belong to SimConfig integration. */
export function createWorldAnchor(config: WorldAnchorConfig): WorldAnchor {
  const meanMotionRadS = config.meanMotionRadS ?? DEFAULT_MEAN_MOTION_RAD_S;
  finite(meanMotionRadS, 'meanMotionRadS');
  if (meanMotionRadS <= 0) throw new RangeError('meanMotionRadS must be positive');
  for (const key of ['inclination_rad', 'raan_rad', 'argumentOfLatitude_rad', 'gmstAtEpoch_rad'] as const) finite(config[key], key);
  if (config.inclination_rad < 0 || config.inclination_rad > Math.PI) throw new RangeError('inclination_rad must be in [0, pi]');
  validateEpoch(config.epoch);
  const radius_m = Math.cbrt(MU_EARTH_M3_S2 / meanMotionRadS / meanMotionRadS);
  if (!Number.isFinite(radius_m) || radius_m <= 0) throw new RangeError('meanMotionRadS must yield a finite positive radius');
  // Active orbit placement: Rz(RAAN) Rx(inclination) Rz(argument of latitude).
  const q_ECI_I0 = normalizeQuaternion(multiplyQuaternion(
    multiplyQuaternion(smallAngleExp([0, 0, config.raan_rad]), smallAngleExp([config.inclination_rad, 0, 0])),
    smallAngleExp([0, 0, config.argumentOfLatitude_rad]),
  ));
  return Object.freeze({ ...config, meanMotionRadS, radius_m,
    epoch: Object.freeze({ ...config.epoch }), q_ECI_I0: Object.freeze(q_ECI_I0) });
}

/** Hill → physical ECI; the legacy I0 frame helper and its t=0 origin stay unchanged. */
export function physicalHillToEci(anchor: WorldAnchor, t_s: number): Quat {
  finite(t_s, 't_s');
  return normalizeQuaternion(multiplyQuaternion([...anchor.q_ECI_I0], hillFromInertial(t_s, anchor.meanMotionRadS)));
}

/** ECI → ECEF rotation at GMST(epoch) + omegaEarth*t_s (synthetic approximation). */
export function eciToEcef(anchor: WorldAnchor, t_s: number): Quat {
  finite(t_s, 't_s');
  return smallAngleExp([0, 0, -(anchor.gmstAtEpoch_rad + EARTH_ROTATION_RAD_S * t_s)]);
}

/** v_ECEF = C_ECEF_ECI v_ECI - omegaEarth × r_ECEF. */
export function eciStateToEcef(anchor: WorldAnchor, t_s: number, state: CartesianState): CartesianState {
  const q = eciToEcef(anchor, t_s);
  const r_m = rotateVector(q, state.r_m), v = rotateVector(q, state.v_mps);
  return { r_m, v_mps: [v[0] + EARTH_ROTATION_RAD_S * r_m[1], v[1] - EARTH_ROTATION_RAD_S * r_m[0], v[2]] };
}

/** Inverse coordinate-derivative transform, including Earth's rotational velocity. */
export function ecefStateToEci(anchor: WorldAnchor, t_s: number, state: CartesianState): CartesianState {
  const q = conjugateQuaternion(eciToEcef(anchor, t_s));
  const { r_m, v_mps: v } = state;
  return { r_m: rotateVector(q, r_m), v_mps: rotateVector(q,
    [v[0] - EARTH_ROTATION_RAD_S * r_m[1], v[1] + EARTH_ROTATION_RAD_S * r_m[0], v[2]]) };
}

/** Anchor ephemeris plus Hill displacement; velocity includes n*zHat × displacement. */
export function chaserAbsoluteState(anchor: WorldAnchor, t_s: number, r_hill_m: Vec3, v_hill_mps: Vec3): AbsoluteState {
  r_hill_m.forEach(value => finite(value, 'r_hill_m'));
  v_hill_mps.forEach(value => finite(value, 'v_hill_mps'));
  const q = physicalHillToEci(anchor, t_s), n = anchor.meanMotionRadS;
  const r: Vec3 = [anchor.radius_m + r_hill_m[0], r_hill_m[1], r_hill_m[2]];
  const eci = { r_m: rotateVector(q, r), v_mps: rotateVector(q,
    [v_hill_mps[0] - n * r[1], v_hill_mps[1] + n * r[0], v_hill_mps[2]]) };
  return { t_s, eci, ecef: eciStateToEcef(anchor, t_s, eci) };
}

/** Circular reference ephemeris; this is not an estimated station state. */
export function stationAbsoluteState(anchor: WorldAnchor, t_s: number): AbsoluteState {
  return chaserAbsoluteState(anchor, t_s, [0, 0, 0], [0, 0, 0]);
}

/** Same-epoch ECI states → relative Hill state; optional station input is receiver-side data. */
export function hillFromAbsolute(anchor: WorldAnchor, t_s: number, chaserEci: CartesianState,
  stationEci: CartesianState = stationAbsoluteState(anchor, t_s).eci): { r_hill_m: Vec3; v_hill_mps: Vec3 } {
  const q = conjugateQuaternion(physicalHillToEci(anchor, t_s));
  const r_hill_m = rotateVector(q, chaserEci.r_m.map((v, i) => v - stationEci.r_m[i]!) as Vec3);
  const v = rotateVector(q, chaserEci.v_mps.map((value, i) => value - stationEci.v_mps[i]!) as Vec3);
  const n = anchor.meanMotionRadS;
  return { r_hill_m, v_hill_mps: [v[0] + n * r_hill_m[1], v[1] - n * r_hill_m[0], v[2]] };
}

/** Continuous GPS time; normalize week rollover without adding UTC/leap seconds. */
export function gnssTimeAt(anchor: WorldAnchor, t_s: number): GnssEpoch {
  finite(t_s, 't_s');
  const seconds = anchor.epoch.secondsOfWeek_s + t_s;
  const weeks = Math.floor(seconds / GPS_WEEK_S);
  const result = { gpsWeek: anchor.epoch.gpsWeek + weeks, secondsOfWeek_s: seconds - weeks * GPS_WEEK_S,
    utcMinusGps_leapSeconds: anchor.epoch.utcMinusGps_leapSeconds };
  validateEpoch(result);
  return result;
}
