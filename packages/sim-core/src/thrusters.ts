import { TRUTH_HZ } from './constants.js';
import { stepTruth } from './dynamics.js';
import type { ThrusterCommand, TruthState, Vec3 } from './types.js';

export const G0_MPS2 = 9.80665;
export const DEFAULT_THRUST_N = 25;
export const DEFAULT_MIN_ON_TIME_S = 0.020;
export const DEFAULT_ISP_S = 220;
export const DEFAULT_DRY_MASS_KG = 976;
export const DEFAULT_PROP_KG = 24;

export type ThrusterId = string;
export type ThrusterState = 'nominal' | 'isolated' | 'stuck_open' | 'stuck_closed';
export type ThrusterStateMap = Partial<Record<string, ThrusterState>>;

export interface ThrusterSpec {
  id: ThrusterId;
  position_body_m: Vec3;
  direction_body: Vec3;
  thrust_N: number;
}

/** Public jet placement consumed by renderers; force magnitude stays sim-side. */
export type ThrusterGeometry = Pick<ThrusterSpec, 'id' | 'position_body_m' | 'direction_body'>;

export interface ThrusterModelConfig {
  specs?: readonly ThrusterSpec[];
  minOnTime_s?: number;
  truthHz?: number;
  isp_s?: number;
  g0_mps2?: number;
  dryMass_kg?: number;
}

export interface ThrusterApplicationOptions extends ThrusterModelConfig {
  states?: ThrusterStateMap;
  prop_kg?: number;
  window_s?: number;
}

export interface ThrusterApplication {
  quantizedOnTime_s: Record<string, number>;
  activeOnTime_s: Record<string, number>;
  /** Net average force in body axes, in newtons. */
  force_N: Vec3;
  /** Net average torque in body axes, in newton-metres. */
  torque_Nm: Vec3;
  /** Net average specific force in body axes, in m/s². */
  specificForce_body_mps2: Vec3;
  /** @deprecated Compatibility alias; this value is still body-frame. */
  specificForce_hill_mps2: Vec3;
  propellantRate_kg_s: number;
  propellantUsed_kg: number;
  exhausted: boolean;
}

function normalize(v: Vec3): Vec3 {
  const norm = Math.hypot(v[0], v[1], v[2]);
  if (norm === 0) throw new RangeError('thruster direction must be non-zero');
  return [v[0] / norm, v[1] / norm, v[2] / norm];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function addInPlace(a: Vec3, b: Vec3): void {
  a[0] += b[0];
  a[1] += b[1];
  a[2] += b[2];
}

function cornerJets(sx: -1 | 1, sy: -1 | 1, corner: number): ThrusterSpec[] {
  const x = sx * 1.2;
  const y = sy * 0.8;
  const directions: Vec3[] = [
    normalize([sx * 0.35, sy * 0.85, 0.40]),
    normalize([sx * 0.85, sy * 0.35, -0.40]),
    normalize([-sx * 0.75, sy * 0.30, 0.55]),
    normalize([sx * 0.30, -sy * 0.75, -0.55]),
  ];
  return directions.map((direction_body, index) => ({
    id: `J${corner * 4 + index + 1}`,
    position_body_m: [x, y, index < 2 ? 0.45 : -0.45],
    direction_body,
    thrust_N: DEFAULT_THRUST_N,
  }));
}

/** Four canted four-jet corner clusters, specified in body axes. */
export const DRACO_THRUSTER_SPECS: readonly ThrusterSpec[] = Object.freeze([
  ...cornerJets(-1, -1, 0),
  ...cornerJets(-1, 1, 1),
  ...cornerJets(1, -1, 2),
  ...cornerJets(1, 1, 3),
]);

/** Body-frame jet geometry for consumers that do not need propulsion data. */
export const DRACO_THRUSTER_GEOMETRY: readonly ThrusterGeometry[] = Object.freeze(
  DRACO_THRUSTER_SPECS.map(({ id, position_body_m, direction_body }) => ({
    id,
    position_body_m: [...position_body_m] as Vec3,
    direction_body: [...direction_body] as Vec3,
  })),
);

export const DEFAULT_THRUSTER_SPECS = DRACO_THRUSTER_SPECS;

export function quantizeOnTime(
  requested_s: number,
  truthHz = TRUTH_HZ,
  minOnTime_s = DEFAULT_MIN_ON_TIME_S,
): number {
  if (!Number.isFinite(requested_s) || requested_s <= 0) return 0;
  const tick_s = 1 / truthHz;
  if (!(tick_s > 0) || requested_s < minOnTime_s) return 0;
  const quantized = Math.round(requested_s / tick_s) * tick_s;
  return quantized >= minOnTime_s ? quantized : 0;
}

function configWithDefaults(options: ThrusterApplicationOptions): Required<ThrusterModelConfig> & { window_s: number; prop_kg: number; states: ThrusterStateMap } {
  const truthHz = options.truthHz ?? TRUTH_HZ;
  const window_s = options.window_s ?? 1 / truthHz;
  const specs = options.specs ?? DRACO_THRUSTER_SPECS;
  const minOnTime_s = options.minOnTime_s ?? DEFAULT_MIN_ON_TIME_S;
  const isp_s = options.isp_s ?? DEFAULT_ISP_S;
  const g0_mps2 = options.g0_mps2 ?? G0_MPS2;
  const dryMass_kg = options.dryMass_kg ?? DEFAULT_DRY_MASS_KG;
  if (specs.length === 0 || !(window_s > 0) || !(truthHz > 0) || !(isp_s > 0) || !(g0_mps2 > 0) || !(dryMass_kg > 0)) {
    throw new RangeError('invalid thruster model configuration');
  }
  return {
    specs,
    minOnTime_s,
    truthHz,
    isp_s,
    g0_mps2,
    dryMass_kg,
    window_s,
    prop_kg: Math.max(0, options.prop_kg ?? DEFAULT_PROP_KG),
    states: options.states ?? {},
  };
}

/**
 * Resolve one commanded FSW pulse into body-frame force, body-frame torque,
 * and propellant bookkeeping that truth applies.
 */
export function applyThrusterCommand(
  command: ThrusterCommand,
  options: ThrusterApplicationOptions = {},
): ThrusterApplication {
  const config = configWithDefaults(options);
  const quantizedOnTime_s: Record<string, number> = {};
  const activeOnTime_s: Record<string, number> = {};
  const forceImpulse_Ns: Vec3 = [0, 0, 0];
  const torqueImpulse_Nms: Vec3 = [0, 0, 0];
  let totalPropellantUsed_kg = 0;
  const unconstrainedActive: Array<{ spec: ThrusterSpec; active_s: number }> = [];

  for (const spec of config.specs) {
    const requested = Math.min(config.window_s, Math.max(0, command[spec.id] ?? 0));
    const quantized = quantizeOnTime(requested, config.truthHz, config.minOnTime_s);
    const state = config.states[spec.id] ?? 'nominal';
    const active = state === 'stuck_open' ? config.window_s : state === 'nominal' ? Math.min(config.window_s, quantized) : 0;
    quantizedOnTime_s[spec.id] = quantized;
    activeOnTime_s[spec.id] = active;
    if (active > 0) unconstrainedActive.push({ spec, active_s: active });
  }

  const requestedPropellant_kg = unconstrainedActive.reduce(
    (sum, { spec, active_s }) => sum + spec.thrust_N * active_s / (config.isp_s * config.g0_mps2),
    0,
  );
  const propellantScale = requestedPropellant_kg > config.prop_kg ? config.prop_kg / requestedPropellant_kg : 1;

  for (const { spec, active_s } of unconstrainedActive) {
    const effectiveActive_s = active_s * propellantScale;
    activeOnTime_s[spec.id] = effectiveActive_s;
    const impulse: Vec3 = [
      spec.direction_body[0] * spec.thrust_N * effectiveActive_s,
      spec.direction_body[1] * spec.thrust_N * effectiveActive_s,
      spec.direction_body[2] * spec.thrust_N * effectiveActive_s,
    ];
    addInPlace(forceImpulse_Ns, impulse);
    addInPlace(torqueImpulse_Nms, cross(spec.position_body_m, impulse));
  }

  totalPropellantUsed_kg = requestedPropellant_kg * propellantScale;
  const averageForce: Vec3 = forceImpulse_Ns.map((value) => value / config.window_s) as Vec3;
  const averageTorque: Vec3 = torqueImpulse_Nms.map((value) => value / config.window_s) as Vec3;
  const mass_kg = config.dryMass_kg + config.prop_kg;
  const specificForce: Vec3 = averageForce.map((value) => value / mass_kg) as Vec3;
  return {
    quantizedOnTime_s,
    activeOnTime_s,
    force_N: averageForce,
    torque_Nm: averageTorque,
    specificForce_body_mps2: specificForce,
    // Kept for Phase 2 callers; despite the historical name this is now body-frame.
    specificForce_hill_mps2: specificForce,
    propellantRate_kg_s: totalPropellantUsed_kg / config.window_s,
    propellantUsed_kg: totalPropellantUsed_kg,
    exhausted: config.prop_kg <= 0 || totalPropellantUsed_kg >= config.prop_kg,
  };
}

/** Apply a pulse to a truth state over one configured command window. */
export function applyThrusterCommandToTruth(
  state: TruthState,
  command: ThrusterCommand,
  options: ThrusterApplicationOptions = {},
): { state: TruthState; application: ThrusterApplication } {
  const application = applyThrusterCommand(command, { ...options, prop_kg: state.prop_kg });
  const dt_s = options.window_s ?? 1 / (options.truthHz ?? TRUTH_HZ);
  return {
    application,
    state: stepTruth(state, {
      dt_s,
      externalSpecificForce_body_mps2: application.specificForce_body_mps2,
      torque_body_Nm: application.torque_Nm,
      propellantRate_kg_s: application.propellantRate_kg_s,
    }),
  };
}
