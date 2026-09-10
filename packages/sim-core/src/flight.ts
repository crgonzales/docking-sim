import { conjugateQuaternion, multiplyQuaternion, normalizeQuaternion, rotateVector, smallAngleExp } from './attitude.js';
import type { Quat, Vec3 } from './types.js';

/** Flight-only frames: N = local north/east/down; B = forward/right/down.
 * SI throughout. q_BN rotates N→B. See docs/6-memo/f18-flight-prototype.md.
 * This is an engineering approximation, not a validated F/A-18 dataset. */
export interface FlightParameters {
  mass_kg: number;
  inertia_kgm2: Vec3;
  wingArea_m2: number;
  span_m: number;
  chord_m: number;
  dryThrust_N: number;
  maxThrust_N: number;
  spoolTime_s: number;
  cl0: number;
  clAlpha: number;
  stallAlpha_rad: number;
  cd0: number;
  inducedDrag: number;
  cyBeta: number;
  clBeta: number;
  clP: number;
  clRoll: number;
  cmAlpha: number;
  cmQ: number;
  cmPitch: number;
  cmTrim: number;
  cnBeta: number;
  cnR: number;
  cnYaw: number;
}

export const HORNET_PROTOTYPE: Readonly<FlightParameters> = {
  mass_kg: 14500, inertia_kgm2: [23000, 140000, 160000],
  wingArea_m2: 37.1612, span_m: 12.3, chord_m: 3.5,
  dryThrust_N: 98000, maxThrust_N: 157470, spoolTime_s: 1.5,
  cl0: 0.1, clAlpha: 5, stallAlpha_rad: 0.35,
  cd0: 0.025, inducedDrag: 0.085, cyBeta: -0.8,
  clBeta: -0.08, clP: -0.65, clRoll: 0.065,
  cmAlpha: -0.55, cmQ: -14, cmPitch: 0.10, cmTrim: 0.35,
  cnBeta: 0.14, cnR: -0.22, cnYaw: 0.035,
};
export const FLIGHT_DT_S = 0.01;
export const FLIGHT_GRAVITY_M_S2 = 9.80665;
export const FLIGHT_LIMITS = { radius_m: 50000, ceiling_m: 20000, maxMach: 0.95 } as const;

export interface FlightControls {
  /** Positive: nose up, right wing down, nose right. Normalized [-1,1]. */
  pitch: number;
  roll: number;
  yaw: number;
  throttle: number;
  trim: number;
}
export interface FlightEnvironment {
  wind_N_m_s: Vec3;
  gravity_m_s2: number;
  /** Useful for analytic vacuum oracles; normally 1. */
  densityScale: number;
}
export const STILL_AIR: FlightEnvironment = {
  wind_N_m_s: [0, 0, 0], gravity_m_s2: FLIGHT_GRAVITY_M_S2, densityScale: 1,
};
export interface FlightState {
  time_s: number;
  position_N_m: Vec3;
  velocity_N_m_s: Vec3;
  q_BN: Quat;
  omega_B_rad_s: Vec3;
  engine: number;
  status: 'FLYING' | 'CONTACT' | 'ENVELOPE';
}
export interface FlightLoads {
  force_B_N: Vec3;
  moment_B_Nm: Vec3;
  aeroForce_B_N: Vec3;
  airVelocity_B_m_s: Vec3;
  airspeed_m_s: number;
  alpha_rad: number;
  beta_rad: number;
  density_kg_m3: number;
  dynamicPressure_Pa: number;
  mach: number;
  lift_N: number;
  drag_N: number;
  thrust_N: number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const scale = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function validateFlightParameters(p: Readonly<FlightParameters>): void {
  if (Object.values(p).flat().some((v: number) => !Number.isFinite(v)) || p.mass_kg <= 0 || p.inertia_kgm2.some((v) => v <= 0) || p.spoolTime_s <= 0 || p.span_m <= 0 || p.chord_m <= 0 || p.wingArea_m2 <= 0 || p.dryThrust_N <= 0 || p.maxThrust_N < p.dryThrust_N || p.stallAlpha_rad <= 0 || p.stallAlpha_rad >= Math.PI / 2) throw new RangeError('invalid flight parameters');
}

/** Dry standard atmosphere: tropospheric lapse, then isothermal to 20 km.
 * Finite continuation above 20 km is only for detecting envelope exits. */
export function flightAtmosphere(altitude_m: number): { density_kg_m3: number; soundSpeed_m_s: number } {
  if (!Number.isFinite(altitude_m)) throw new RangeError('altitude must be finite');
  const h = Math.max(0, altitude_m);
  const temperature = 288.15 - 0.0065 * Math.min(h, 11000);
  const p11 = 101325 * (216.65 / 288.15) ** (FLIGHT_GRAVITY_M_S2 / (287.05287 * 0.0065));
  const pressure = h <= 11000
    ? 101325 * (temperature / 288.15) ** (FLIGHT_GRAVITY_M_S2 / (287.05287 * 0.0065))
    : p11 * Math.exp(-FLIGHT_GRAVITY_M_S2 * (h - 11000) / (287.05287 * 216.65));
  return { density_kg_m3: pressure / (287.05287 * temperature), soundSpeed_m_s: Math.sqrt(1.4 * 287.05287 * temperature) };
}

function coefficients(alpha: number, p: Readonly<FlightParameters>): { cl: number; cd: number } {
  const a = Math.abs(alpha);
  const attached = p.cl0 + p.clAlpha * alpha;
  // Blend to a flat-plate continuation through stall; finite even in reverse flow.
  const blend = clamp((a - p.stallAlpha_rad) / 0.25, 0, 1);
  const cl = (1 - blend) * attached + blend * Math.sin(2 * alpha);
  return { cl, cd: p.cd0 + p.inducedDrag * cl * cl + 1.6 * blend * Math.sin(alpha) ** 2 };
}
function thrustAt(engine: number, density: number, p: Readonly<FlightParameters>): number {
  const t = clamp(engine, 0, 1);
  const seaLevel = t <= 0.8 ? p.dryThrust_N * t / 0.8 : p.dryThrust_N + (p.maxThrust_N - p.dryThrust_N) * (t - 0.8) / 0.2;
  return seaLevel * (density / 1.225) ** 0.7;
}

export function flightLoads(state: FlightState, controls: FlightControls, p: Readonly<FlightParameters> = HORNET_PROTOTYPE, environment: FlightEnvironment = STILL_AIR): FlightLoads {
  const atmosphere = flightAtmosphere(-state.position_N_m[2]);
  const density = atmosphere.density_kg_m3 * environment.densityScale;
  const velocity = rotateVector(state.q_BN, add(state.velocity_N_m_s, scale(environment.wind_N_m_s, -1)));
  const speed = Math.hypot(...velocity);
  const alpha = speed < 1e-8 ? 0 : Math.atan2(velocity[2], velocity[0]);
  const beta = speed < 1e-8 ? 0 : Math.atan2(velocity[1], Math.hypot(velocity[0], velocity[2]));
  const ca = Math.cos(alpha), sa = Math.sin(alpha), cb = Math.cos(beta), sb = Math.sin(beta);
  const qbar = 0.5 * density * speed * speed;
  const qs = qbar * p.wingArea_m2;
  const { cl, cd } = coefficients(alpha, p);
  const lift = qs * cl, drag = qs * (cd + 0.3 * sb * sb), side = qs * p.cyBeta * beta;
  const aero: Vec3 = [
    -drag * ca * cb + lift * sa - side * ca * sb,
    -drag * sb + side * cb,
    -drag * sa * cb - lift * ca - side * sa * sb,
  ];
  const thrust = thrustAt(state.engine, density, p);
  const rateScale = 1 / (2 * Math.max(speed, 1));
  const [wx, wy, wz] = state.omega_B_rad_s;
  const moments: Vec3 = [
    qs * p.span_m * (p.clBeta * beta + p.clP * wx * p.span_m * rateScale + p.clRoll * clamp(controls.roll, -1, 1)),
    qs * p.chord_m * (p.cmAlpha * alpha + p.cmQ * wy * p.chord_m * rateScale + p.cmPitch * clamp(controls.pitch, -1, 1) + p.cmTrim * clamp(controls.trim, -1, 1)),
    qs * p.span_m * (p.cnBeta * beta + p.cnR * wz * p.span_m * rateScale + p.cnYaw * clamp(controls.yaw, -1, 1)),
  ];
  return {
    force_B_N: add(aero, [thrust, 0, 0]), moment_B_Nm: moments, aeroForce_B_N: aero,
    airVelocity_B_m_s: velocity, airspeed_m_s: speed, alpha_rad: alpha, beta_rad: beta,
    density_kg_m3: density, dynamicPressure_Pa: qbar, mach: speed / atmosphere.soundSpeed_m_s,
    lift_N: lift, drag_N: drag, thrust_N: thrust,
  };
}

interface Derivative { position: Vec3; velocity: Vec3; q: Quat; omega: Vec3; engine: number }
function derivative(s: FlightState, controls: FlightControls, p: Readonly<FlightParameters>, e: FlightEnvironment): Derivative {
  const loads = flightLoads(s, controls, p, e);
  const angularMomentum: Vec3 = [p.inertia_kgm2[0] * s.omega_B_rad_s[0], p.inertia_kgm2[1] * s.omega_B_rad_s[1], p.inertia_kgm2[2] * s.omega_B_rad_s[2]];
  const torque = add(loads.moment_B_Nm, scale(cross(s.omega_B_rad_s, angularMomentum), -1));
  const spin: Quat = [0, ...s.omega_B_rad_s];
  const qDot = multiplyQuaternion(spin, s.q_BN).map((v) => -0.5 * v) as Quat;
  return {
    position: s.velocity_N_m_s,
    velocity: add(scale(rotateVector(conjugateQuaternion(s.q_BN), loads.force_B_N), 1 / p.mass_kg), [0, 0, e.gravity_m_s2]),
    q: qDot,
    omega: [torque[0] / p.inertia_kgm2[0], torque[1] / p.inertia_kgm2[1], torque[2] / p.inertia_kgm2[2]],
    engine: (clamp(controls.throttle, 0, 1) - s.engine) / p.spoolTime_s,
  };
}
function offset(s: FlightState, d: Derivative, dt: number): FlightState {
  return { ...s, position_N_m: add(s.position_N_m, scale(d.position, dt)), velocity_N_m_s: add(s.velocity_N_m_s, scale(d.velocity, dt)),
    q_BN: s.q_BN.map((v, i) => v + d.q[i]! * dt) as Quat,
    omega_B_rad_s: add(s.omega_B_rad_s, scale(d.omega, dt)), engine: s.engine + d.engine * dt };
}

/** One deterministic 100 Hz RK4 step. Never reads or mutates caller state. */
export function stepFlight(state: FlightState, controls: FlightControls, p: Readonly<FlightParameters> = HORNET_PROTOTYPE, environment: FlightEnvironment = STILL_AIR): FlightState {
  if (Object.values(controls).some((v) => !Number.isFinite(v)) || [...state.position_N_m, ...state.velocity_N_m_s, ...state.q_BN, ...state.omega_B_rad_s, state.engine, state.time_s, ...environment.wind_N_m_s, environment.gravity_m_s2, environment.densityScale].some((v) => !Number.isFinite(v))) throw new RangeError('flight inputs must be finite');
  validateFlightParameters(p);
  if (environment.densityScale < 0) throw new RangeError('density scale must be nonnegative');
  if (state.status !== 'FLYING') return state;
  const dt = FLIGHT_DT_S;
  const a = derivative(state, controls, p, environment);
  const b = derivative(offset(state, a, dt / 2), controls, p, environment);
  const c = derivative(offset(state, b, dt / 2), controls, p, environment);
  const d = derivative(offset(state, c, dt), controls, p, environment);
  const mix = (key: 'position' | 'velocity' | 'omega'): Vec3 => [0, 1, 2].map((i) => (a[key][i]! + 2 * b[key][i]! + 2 * c[key][i]! + d[key][i]!) / 6) as Vec3;
  const result = offset(state, { position: mix('position'), velocity: mix('velocity'), omega: mix('omega'), q: [0, 1, 2, 3].map((i) => (a.q[i]! + 2 * b.q[i]! + 2 * c.q[i]! + d.q[i]!) / 6) as Quat, engine: (a.engine + 2 * b.engine + 2 * c.engine + d.engine) / 6 }, dt);
  result.time_s = state.time_s + dt;
  result.q_BN = normalizeQuaternion(result.q_BN);
  result.engine = clamp(result.engine, 0, 1);
  if (result.position_N_m[2] >= -2) result.status = 'CONTACT';
  else if (-result.position_N_m[2] > FLIGHT_LIMITS.ceiling_m || Math.hypot(result.position_N_m[0], result.position_N_m[1]) > FLIGHT_LIMITS.radius_m || flightLoads(result, controls, p, environment).mach > FLIGHT_LIMITS.maxMach) result.status = 'ENVELOPE';
  return result;
}

/** Solve wings-level, still-air equilibrium including the vertical thrust component. */
export function createTrimmedFlight(altitude_m = 1500, airspeed_m_s = 180, p: Readonly<FlightParameters> = HORNET_PROTOTYPE): { state: FlightState; controls: FlightControls } {
  validateFlightParameters(p);
  if (!Number.isFinite(altitude_m) || altitude_m < 10 || altitude_m > FLIGHT_LIMITS.ceiling_m || !Number.isFinite(airspeed_m_s) || airspeed_m_s < 50 || airspeed_m_s > FLIGHT_LIMITS.maxMach * flightAtmosphere(altitude_m).soundSpeed_m_s) throw new RangeError('trim request outside prototype envelope');
  const density = flightAtmosphere(altitude_m).density_kg_m3;
  const qs = 0.5 * density * airspeed_m_s ** 2 * p.wingArea_m2;
  const residual = (alpha: number): number => {
    const { cl, cd } = coefficients(alpha, p);
    const force_N = qs * (cl + cd * Math.tan(alpha)) - p.mass_kg * FLIGHT_GRAVITY_M_S2;
    if (!Number.isFinite(force_N)) throw new RangeError('trim calculation must remain finite');
    return force_N;
  };
  let low = -0.1, high = p.stallAlpha_rad;
  if (residual(low) > 0 || residual(high) < 0) throw new RangeError('no attached-flow trim at requested speed');
  for (let i = 0; i < 60; i++) { const mid = (low + high) / 2; if (residual(mid) < 0) low = mid; else high = mid; }
  const alpha = (low + high) / 2;
  const thrust = qs * coefficients(alpha, p).cd / Math.cos(alpha);
  const seaLevelThrust = thrust / (density / 1.225) ** 0.7;
  if (!Number.isFinite(seaLevelThrust) || seaLevelThrust < 0 || seaLevelThrust > p.maxThrust_N) throw new RangeError('trim exceeds thrust authority');
  const throttle = seaLevelThrust <= p.dryThrust_N ? 0.8 * seaLevelThrust / p.dryThrust_N : 0.8 + 0.2 * (seaLevelThrust - p.dryThrust_N) / (p.maxThrust_N - p.dryThrust_N);
  const pitchCoefficient = p.cmAlpha * alpha;
  // A coefficient tolerance admits bisection roundoff at an already balanced alpha.
  if (p.cmTrim === 0 && Math.abs(pitchCoefficient) > 1e-12) throw new RangeError('no pitch trim authority for unbalanced moment');
  const trim = p.cmTrim === 0 ? 0 : -pitchCoefficient / p.cmTrim;
  if (!Number.isFinite(throttle) || !Number.isFinite(trim) || throttle < 0 || throttle > 1 || Math.abs(trim) > 1) throw new RangeError('trim exceeds control authority');
  return { state: { time_s: 0, position_N_m: [0, 0, -altitude_m], velocity_N_m_s: [airspeed_m_s, 0, 0], q_BN: smallAngleExp([0, -alpha, 0]), omega_B_rad_s: [0, 0, 0], engine: throttle, status: 'FLYING' }, controls: { pitch: 0, roll: 0, yaw: 0, throttle, trim } };
}

export function flightInstruments(state: FlightState, controls: FlightControls, p: Readonly<FlightParameters> = HORNET_PROTOTYPE, environment: FlightEnvironment = STILL_AIR) {
  const loads = flightLoads(state, controls, p, environment);
  const q_NB = conjugateQuaternion(state.q_BN);
  const forward = rotateVector(q_NB, [1, 0, 0]);
  const right = rotateVector(q_NB, [0, 1, 0]);
  const down = rotateVector(q_NB, [0, 0, 1]);
  return { ...loads, time_s: state.time_s, status: state.status, altitude_m: -state.position_N_m[2], verticalSpeed_m_s: -state.velocity_N_m_s[2], groundSpeed_m_s: Math.hypot(state.velocity_N_m_s[0], state.velocity_N_m_s[1]), heading_rad: (Math.atan2(forward[1], forward[0]) + 2 * Math.PI) % (2 * Math.PI), pitch_rad: Math.asin(clamp(-forward[2], -1, 1)), bank_rad: Math.atan2(right[2], down[2]), normalLoad_g: -loads.force_B_N[2] / (p.mass_kg * FLIGHT_GRAVITY_M_S2) };
}
