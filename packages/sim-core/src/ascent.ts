/**
 * Launch ascent truth model (F_0.20.0 Phase 1a atmosphere + Phase 1b dynamics).
 *
 * `stepAscent` is the **single owner of every event and latch phase**. It runs
 * them once per call in a fixed order, and a caller supplies inputs to one call
 * rather than re-implementing any part of that pipeline. Guidance is not here:
 * it is Phase 2, and it consumes `AscentInstruments`, never `AscentState`.
 *
 * Frames and altitude: the state uses launch-local NED whose origin is the pad
 * surface, x north, y east, z down. `position_N_m` is the **active body's centre
 * of mass**. The atmosphere, however, is a function of **geometric altitude
 * above mean sea level**, so the pad's own elevation is added to the
 * launch-local height before any lookup — see `launchAltitudeToMsl`. Confusing
 * height above the pad with the standard-atmosphere coordinate is a 105 m error
 * at sea level and it does not cancel.
 *
 * SI units throughout. Pure TypeScript: no DOM, React or Three.js. The
 * aerodynamic, damping and recovery coefficients are documented engineering
 * approximations for a game, not a validated vehicle dataset.
 */
import { MU_EARTH_M3_S2, R_EARTH_M } from './constants.js';
import {
  conjugateQuaternion,
  multiplyQuaternion,
  normalizeQuaternion,
  quaternionFromBasis,
  rotateVector,
} from './attitude.js';
import {
  dragCoefficient,
  engineSpec,
  rollControlAuthority,
  stageProperties,
  tankCapacity,
  vehicleGeometry,
  type VehicleConfig,
  type VehicleStage,
} from './vehicle.js';
import type { Quat, Vec3 } from './types.js';

/** Four-field atmosphere sample. All SI. */
export interface Atmosphere {
  density_kg_m3: number;
  pressure_Pa: number;
  temperature_K: number;
  soundSpeed_m_s: number;
}

export interface AscentEnvironment {
  /** Scales aerodynamic density only; it does not touch ambient pressure. */
  densityScale: number;
  /** Pad elevation above mean sea level; defaults to the airfield datum. */
  padAltitudeMsl_m?: number;
  /**
   * True vacuum: removes aerodynamic density **and** nozzle back-pressure
   * together. The closed-form Tsiolkovsky and ballistic oracles require this,
   * because zero density with a live `p_a · A_exit` term is not a vacuum burn.
   */
  vacuum?: boolean;
  wind_N_m_s: Vec3;
  /** Useful for analytic oracles; normally gravity varies with altitude. */
  constantGravity_m_s2?: number;
}

export const STILL_AIR_ASCENT: AscentEnvironment = {
  densityScale: 1,
  wind_N_m_s: [0, 0, 0],
};

export const VACUUM_ASCENT: AscentEnvironment = {
  densityScale: 0,
  vacuum: true,
  wind_N_m_s: [0, 0, 0],
};

/** Specific gas constant for dry air, J/(kg·K). */
export const AIR_GAS_CONSTANT_J_KG_K = 287.05287;
export const AIR_HEAT_CAPACITY_RATIO = 1.4;
export const STANDARD_GRAVITY_M_S2 = 9.80665;
/** US Standard Atmosphere 1976 effective Earth radius for geopotential altitude. */
export const USSA_EARTH_RADIUS_M = 6_356_766;
/** Top of the tabulated layers, in geometric altitude. */
export const ATMOSPHERE_LAYER_TOP_M = 86_000;
/** Above this altitude the model reports a hard vacuum. */
export const ATMOSPHERE_TOP_M = 200_000;
/** Scale height of the exponential continuation above the tabulated layers. */
export const UPPER_SCALE_HEIGHT_M = 7_000;
/**
 * Ratio between the 86 km values and the continuation's value at the 200 km
 * cutoff. The density and pressure jump to zero there is **intentional**: the
 * model cannot both continue exponentially and be continuous at a hard cutoff,
 * so the jump is declared and bounded rather than hidden behind a tolerance.
 */
export const ATMOSPHERE_CUTOFF_RATIO = Math.exp(-(ATMOSPHERE_TOP_M - ATMOSPHERE_LAYER_TOP_M) / UPPER_SCALE_HEIGHT_M);

/** Pad elevation of the existing airfield site. The web layer owns the real
 * datum; sim-core cannot import it, so this mirrors it as a default. */
export const DEFAULT_PAD_ALTITUDE_MSL_M = 105;

interface Layer {
  baseGeopotential_m: number;
  baseTemperature_K: number;
  lapse_K_m: number;
}

const LAYERS: readonly Layer[] = [
  { baseGeopotential_m: 0, baseTemperature_K: 288.15, lapse_K_m: -0.0065 },
  { baseGeopotential_m: 11_000, baseTemperature_K: 216.65, lapse_K_m: 0 },
  { baseGeopotential_m: 20_000, baseTemperature_K: 216.65, lapse_K_m: 0.001 },
  { baseGeopotential_m: 32_000, baseTemperature_K: 228.65, lapse_K_m: 0.0028 },
  { baseGeopotential_m: 47_000, baseTemperature_K: 270.65, lapse_K_m: 0 },
  { baseGeopotential_m: 51_000, baseTemperature_K: 270.65, lapse_K_m: -0.0028 },
  { baseGeopotential_m: 71_000, baseTemperature_K: 214.65, lapse_K_m: -0.002 },
];

const SEA_LEVEL_PRESSURE_PA = 101_325;

function layerPressure(layer: Layer, basePressure_Pa: number, geopotential_m: number): number {
  const delta = geopotential_m - layer.baseGeopotential_m;
  if (layer.lapse_K_m === 0) {
    return basePressure_Pa * Math.exp(-STANDARD_GRAVITY_M_S2 * delta / (AIR_GAS_CONSTANT_J_KG_K * layer.baseTemperature_K));
  }
  const temperature = layer.baseTemperature_K + layer.lapse_K_m * delta;
  const exponent = STANDARD_GRAVITY_M_S2 / (AIR_GAS_CONSTANT_J_KG_K * layer.lapse_K_m);
  return basePressure_Pa * (layer.baseTemperature_K / temperature) ** exponent;
}

/** Base pressure at each layer floor, built once by walking up the layers. */
const LAYER_BASE_PRESSURES_PA: readonly number[] = (() => {
  const pressures: number[] = [SEA_LEVEL_PRESSURE_PA];
  for (let i = 1; i < LAYERS.length; i++) {
    const below = LAYERS[i - 1]!;
    pressures.push(layerPressure(below, pressures[i - 1]!, LAYERS[i]!.baseGeopotential_m));
  }
  return pressures;
})();

/** Geopotential altitude of the top tabulated layer, i.e. 86 km geometric. */
const TOP_GEOPOTENTIAL_M = USSA_EARTH_RADIUS_M * ATMOSPHERE_LAYER_TOP_M / (USSA_EARTH_RADIUS_M + ATMOSPHERE_LAYER_TOP_M);

/** Convert geometric altitude above sea level to geopotential altitude. */
export function geopotentialAltitude(altitude_m: number): number {
  if (!Number.isFinite(altitude_m)) throw new RangeError('altitude must be finite');
  return USSA_EARTH_RADIUS_M * altitude_m / (USSA_EARTH_RADIUS_M + altitude_m);
}

/** Launch-local `down` to geometric altitude above mean sea level. */
export function launchAltitudeToMsl(down_m: number, padAltitudeMsl_m: number = DEFAULT_PAD_ALTITUDE_MSL_M): number {
  if (!Number.isFinite(down_m) || !Number.isFinite(padAltitudeMsl_m)) throw new RangeError('launch altitude inputs must be finite');
  return padAltitudeMsl_m - down_m;
}

function tabulated(geopotential_m: number): { temperature_K: number; pressure_Pa: number } {
  let index = 0;
  for (let i = 1; i < LAYERS.length; i++) {
    if (geopotential_m >= LAYERS[i]!.baseGeopotential_m) index = i;
  }
  const layer = LAYERS[index]!;
  const basePressure = LAYER_BASE_PRESSURES_PA[index]!;
  return {
    temperature_K: layer.baseTemperature_K + layer.lapse_K_m * (geopotential_m - layer.baseGeopotential_m),
    pressure_Pa: layerPressure(layer, basePressure, geopotential_m),
  };
}

const TOP_OF_LAYERS = tabulated(TOP_GEOPOTENTIAL_M);

function sample(temperature_K: number, pressure_Pa: number): Atmosphere {
  return {
    density_kg_m3: pressure_Pa / (AIR_GAS_CONSTANT_J_KG_K * temperature_K),
    pressure_Pa,
    temperature_K,
    soundSpeed_m_s: Math.sqrt(AIR_HEAT_CAPACITY_RATIO * AIR_GAS_CONSTANT_J_KG_K * temperature_K),
  };
}

/**
 * US Standard Atmosphere 1976 to 86 km, then an isothermal exponential
 * continuation, then a declared hard vacuum.
 *
 * - Input is **geometric** altitude above mean sea level; below sea level is
 *   clamped to zero.
 * - Through 86 km the seven tabulated layers are evaluated on geopotential
 *   altitude, which is what makes the published boundary values reproduce.
 * - Above 86 km temperature holds at its 86 km value and pressure decays with a
 *   7 km scale height; density follows from the ideal gas law, so it decays with
 *   the same scale height and stays thermodynamically consistent.
 * - The continuation applies **up to and including exactly 200 km**. Strictly
 *   above it, pressure and density are exactly zero while temperature and sound
 *   speed hold, so those two remain continuous across the cutoff and Mach can be
 *   reported as undefined rather than infinite by the caller.
 */
export function standardAtmosphere(altitude_m: number): Atmosphere {
  if (!Number.isFinite(altitude_m)) throw new RangeError('altitude must be finite');
  const altitude = Math.max(0, altitude_m);
  if (altitude <= ATMOSPHERE_LAYER_TOP_M) {
    const { temperature_K, pressure_Pa } = tabulated(geopotentialAltitude(altitude));
    return sample(temperature_K, pressure_Pa);
  }
  const temperature_K = TOP_OF_LAYERS.temperature_K;
  if (altitude > ATMOSPHERE_TOP_M) {
    return {
      density_kg_m3: 0,
      pressure_Pa: 0,
      temperature_K,
      soundSpeed_m_s: Math.sqrt(AIR_HEAT_CAPACITY_RATIO * AIR_GAS_CONSTANT_J_KG_K * temperature_K),
    };
  }
  const pressure_Pa = TOP_OF_LAYERS.pressure_Pa
    * Math.exp(-(altitude - ATMOSPHERE_LAYER_TOP_M) / UPPER_SCALE_HEIGHT_M);
  return sample(temperature_K, pressure_Pa);
}

/**
 * The atmosphere as the vehicle experiences it under an environment. `vacuum`
 * removes density and ambient pressure together; `densityScale` scales
 * aerodynamic density alone and leaves back-pressure intact. Temperature and
 * sound speed are never scaled — they are properties of the air, not a knob.
 */
export function ambientAtmosphere(altitude_m: number, environment: AscentEnvironment = STILL_AIR_ASCENT): Atmosphere {
  if (!Number.isFinite(environment.densityScale) || environment.densityScale < 0) {
    throw new RangeError('density scale must be finite and non-negative');
  }
  const base = standardAtmosphere(altitude_m);
  if (environment.vacuum === true) {
    return { ...base, density_kg_m3: 0, pressure_Pa: 0 };
  }
  return { ...base, density_kg_m3: base.density_kg_m3 * environment.densityScale };
}

// ---------------------------------------------------------------------------
// Phase 1b — ascent dynamics, events and terminal latch
// ---------------------------------------------------------------------------

export type AscentStage = VehicleStage;
export type EngineState = 'OFF' | 'ON' | 'BURNOUT';
export type ChuteState = 'STOWED' | 'DEPLOYED' | 'FAILED';
export type AscentStatus =
  | 'PAD' | 'FLYING'
  | 'RECOVERED' | 'CRASHED' | 'LOST' | 'PAD_NO_LIFTOFF' | 'TIMEOUT';

export type AscentEventKind =
  | 'LIFTOFF' | 'INSUFFICIENT_THRUST' | 'MAX_Q' | 'BURNOUT' | 'CUTOFF'
  | 'SEPARATION' | 'APOGEE' | 'CHUTE_DEPLOYED' | 'CHUTE_FAILED'
  | 'TOUCHDOWN' | 'OUT_OF_RANGE' | 'TIMEOUT';

export interface AscentEvent {
  kind: AscentEventKind;
  t_s: number;
  altitude_m: number;
  note?: string;
}

export interface AscentState {
  t_s: number;
  /** Launch-local NED position of the **active body's centre of mass**. */
  position_N_m: Vec3;
  velocity_N_m_s: Vec3;
  /** Rotates launch-local NED vectors into body axes. */
  q_BN: Quat;
  omega_B_rad_s: Vec3;
  prop_kg: number;
  stage: AscentStage;
  /** Set exactly once, at separation. */
  discarded: { mass_kg: number; t_s: number } | null;
  engine: EngineState;
  chute: ChuteState;
  status: AscentStatus;
  /** Peak air-relative dynamic pressure so far, which `MAX_Q` is detected against. */
  maxQ_Pa: number;
  /** Thrust actually applied at the end of the last step, not the family maximum. */
  appliedThrust_N: number;
  /** Body +x component of the non-gravitational specific force, in g, at that instant. */
  axialLoad_g: number;
  events: readonly AscentEvent[];
}

export interface AscentControls {
  /** Clamped to the engine family's throttle floor while burning. */
  throttle: number;
  /** Positive pitches the nose toward the azimuth direction (downrange). */
  gimbalPitch: number;
  /** Positive yaws the nose toward the body right axis. */
  gimbalYaw: number;
  /** Positive is right-wing-down about the body forward axis. */
  roll: number;
  ignite: boolean;
  cutoff: boolean;
  separate: boolean;
  deployChute: boolean;
}

export const NEUTRAL_CONTROLS: AscentControls = {
  throttle: 1, gimbalPitch: 0, gimbalYaw: 0, roll: 0,
  ignite: false, cutoff: false, separate: false, deployChute: false,
};

export const ASCENT_DT_S = 0.01;
export const MAX_GIMBAL_RAD = 5 * Math.PI / 180;
/** Every run terminates: this is the declared `TIMEOUT` bound. */
export const ASCENT_TIMEOUT_S = 900;
export const ASCENT_MAX_RANGE_M = 200_000;
export const ASCENT_MAX_ALTITUDE_M = 500_000;
export const RECOVERY_SPEED_LIMIT_M_S = 10;
export const CHUTE_INFLATION_S = 2;
/** Deploying above this dynamic pressure tears the canopy. */
export const CHUTE_MAX_DEPLOY_Q_PA = 6_000;
const MAX_Q_MIN_PA = 1_000;
const PITCH_YAW_DAMPING = 0.3;
const ROLL_DAMPING = 0.4;
/** Bare-body drag coefficient of the capsule once its fins are gone. */
const CAPSULE_BALLISTIC_CD = 1;

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function finite(values: readonly number[], name: string): void {
  if (values.some((v) => !Number.isFinite(v))) throw new RangeError(`${name} must be finite`);
}

/** Gravity magnitude at geometric altitude, directed along local down. */
export function gravityAt(altitudeMsl_m: number, environment: AscentEnvironment): number {
  if (environment.constantGravity_m_s2 !== undefined) return environment.constantGravity_m_s2;
  return MU_EARTH_M3_S2 / (R_EARTH_M + altitudeMsl_m) ** 2;
}

/**
 * Height of the active body's centre of mass above its own aft end, **for
 * upright pad placement only**. This is an axial station difference, so it is a
 * world-vertical distance only while the vehicle stands vertical. Ground contact
 * for a vehicle at any attitude uses `lowestContactDepth_m`.
 */
export function groundClearance_m(config: VehicleConfig, stage: AscentStage, prop_kg: number): number {
  const geometry = vehicleGeometry(config);
  const aft = stage === 'STACK'
    ? geometry.base_x_m
    : geometry.sections.find((section) => section.id === 'CAPSULE')!.x_aft_m;
  return stageProperties(config, stage, prop_kg).com_x_m - aft;
}

/**
 * Bounded contact proxy for the active body, in body axes relative to the centre
 * of mass: an axial offset and the radius of the disc at that station.
 *
 * The vehicle is a conical fairing followed by a full-radius cylinder, so three
 * stations are needed to bound it: the nose point, the **shoulder** where the
 * fairing reaches full radius, and the aft end. Omitting the shoulder would
 * bound a single cone spanning the whole length, which sits inside the real body
 * and lets a slightly nose-down vehicle penetrate the ground while every proxy
 * still reads clear. A finned stack adds the fin station at body radius plus
 * semispan. No mesh collision system is involved.
 */
export function contactProxies(config: VehicleConfig, stage: AscentStage, prop_kg: number): readonly { offset_x_m: number; radius_m: number }[] {
  const geometry = vehicleGeometry(config);
  const com_x_m = stageProperties(config, stage, prop_kg).com_x_m;
  const radius_m = config.stackDiameter_m / 2;
  const section = (id: 'FAIRING' | 'CAPSULE') => geometry.sections.find((entry) => entry.id === id)!;
  // The fairing's aft station is where full diameter begins, for either stage:
  // the capsule keeps the fairing when the booster is discarded.
  const shoulder = { offset_x_m: section('FAIRING').x_aft_m - com_x_m, radius_m };
  if (stage === 'CAPSULE') {
    return [
      { offset_x_m: -com_x_m, radius_m: 0 },
      shoulder,
      { offset_x_m: section('CAPSULE').x_aft_m - com_x_m, radius_m },
    ];
  }
  const proxies = [
    { offset_x_m: -com_x_m, radius_m: 0 },
    shoulder,
    { offset_x_m: geometry.base_x_m - com_x_m, radius_m },
  ];
  const fins = geometry.fins;
  if (fins !== null) {
    proxies.push({
      offset_x_m: fins.rootLeadingEdge_x_m - fins.rootChord_m / 2 - com_x_m,
      radius_m: radius_m + fins.semiSpan_m,
    });
  }
  return proxies;
}

/**
 * How far the lowest point of the active body sits **below** the pad plane;
 * negative means it is still clear of the ground. Each proxy disc is rotated
 * into launch-local NED, and its lowest rim point is found analytically: for a
 * disc normal to body +x, the extreme downward excursion of the rim is its
 * radius times the norm of the body y and z axes' down components.
 */
export function lowestContactDepth_m(
  state: Pick<AscentState, 'position_N_m' | 'q_BN' | 'stage' | 'prop_kg'>,
  config: VehicleConfig,
): number {
  const toNed = conjugateQuaternion(state.q_BN);
  const xDown = rotateVector(toNed, [1, 0, 0])[2];
  const rimDown = Math.hypot(rotateVector(toNed, [0, 1, 0])[2], rotateVector(toNed, [0, 0, 1])[2]);
  let lowest = Number.NEGATIVE_INFINITY;
  for (const proxy of contactProxies(config, state.stage, state.prop_kg)) {
    lowest = Math.max(lowest, state.position_N_m[2] + proxy.offset_x_m * xDown + proxy.radius_m * rimDown);
  }
  return lowest;
}

/**
 * Pad state at the prescribed vertical attitude. The azimuth is explicit
 * because neither the vehicle model nor `VehicleConfig` knows the flight plan;
 * the runner passes the plan's value.
 */
export function createAscentState(
  config: VehicleConfig,
  options: { azimuth_deg: number; attitude_q_BN?: Quat },
): AscentState {
  finite([options.azimuth_deg], 'launch azimuth');
  const prop_kg = tankCapacity(config).propellant_kg;
  return {
    t_s: 0,
    position_N_m: [0, 0, -groundClearance_m(config, 'STACK', prop_kg)],
    velocity_N_m_s: [0, 0, 0],
    q_BN: options.attitude_q_BN === undefined
      ? padAttitude(options.azimuth_deg)
      : normalizeQuaternion(options.attitude_q_BN),
    omega_B_rad_s: [0, 0, 0],
    prop_kg,
    stage: 'STACK',
    discarded: null,
    engine: 'OFF',
    chute: 'STOWED',
    status: 'PAD',
    maxQ_Pa: 0,
    appliedThrust_N: 0,
    axialLoad_g: 0,
    events: [],
  };
}

/**
 * Body triad for a desired pitch above the horizon and azimuth from north,
 * built from axes rather than Euler angles so the vertical pad pose is regular.
 * The roll reference is the horizontal right vector, which is what lets azimuth
 * fix roll at 90 degrees of pitch.
 */
export function attitudeFor(pitch_rad: number, azimuth_rad: number): Quat {
  finite([pitch_rad, azimuth_rad], 'attitude angles');
  const f: Vec3 = [
    Math.cos(pitch_rad) * Math.cos(azimuth_rad),
    Math.cos(pitch_rad) * Math.sin(azimuth_rad),
    -Math.sin(pitch_rad),
  ];
  const reference: Vec3 = [-Math.sin(azimuth_rad), Math.cos(azimuth_rad), 0];
  const projection = reference[0] * f[0] + reference[1] * f[1] + reference[2] * f[2];
  const raw = add(reference, scale(f, -projection));
  const norm = Math.hypot(...raw);
  if (!(norm > 1e-9)) throw new RangeError('attitude reference is degenerate');
  const r = scale(raw, 1 / norm);
  return quaternionFromBasis(f, r, cross(f, r));
}

/** Vertical pad attitude at the given azimuth. */
export function padAttitude(azimuth_deg: number): Quat {
  return attitudeFor(Math.PI / 2, azimuth_deg * Math.PI / 180);
}

/** Frozen-per-step properties. Mass varies analytically inside the step. */
interface StepFrame {
  mass0_kg: number;
  /** Throttle actually in force this step, already clamped to the engine floor. */
  throttle: number;
  /** Mass flow at that throttle, not the family's full-throttle value. */
  massFlow_kg_s: number;
  com_x_m: number;
  cp_x_m: number;
  cnAlpha: number;
  sRef_m2: number;
  inertia: Vec3;
  engineStation_x_m: number | null;
  thrustVacuum_N: number;
  exitArea_m2: number;
  rollAuthority_N_m: number;
  finArea_m2: number;
  diameter_m: number;
  chuteArea_m2: number;
  chuteCd: number;
}

/**
 * One resolved throttle drives thrust, mass flow and the burnout boundary
 * together. Deriving them from different values would break the declared
 * `ṁ = throttle · F_vac / (Isp · g0)` law and move the exhaustion instant.
 */
function stepFrame(state: AscentState, config: VehicleConfig, controls: AscentControls): StepFrame {
  const properties = stageProperties(config, state.stage, state.prop_kg);
  const engine = engineSpec(config);
  // Aerodynamic attachments belong to the ACTIVE stage: a separated capsule has
  // no fins, because they left with the booster.
  const fins = state.stage === 'STACK' ? vehicleGeometry(config).fins : null;
  const throttle = clamp(controls.throttle, engine.minThrottle, 1);
  return {
    mass0_kg: properties.mass_kg,
    throttle,
    massFlow_kg_s: engine.massFlow_kg_s * throttle,
    com_x_m: properties.com_x_m,
    cp_x_m: properties.cp_x_m,
    cnAlpha: properties.cnAlpha,
    sRef_m2: properties.sRef_m2,
    inertia: properties.inertia_kg_m2,
    engineStation_x_m: properties.engineStation_x_m,
    thrustVacuum_N: engine.thrustVacuum_N,
    exitArea_m2: engine.exitArea_m2,
    rollAuthority_N_m: rollControlAuthority(config),
    finArea_m2: fins === null ? 0 : fins.count * fins.areaEach_m2,
    diameter_m: config.stackDiameter_m,
    chuteArea_m2: properties.parachute?.area_m2 ?? 0,
    chuteCd: properties.parachute?.cd ?? 0,
  };
}

/** Air-relative velocity and dynamic pressure. Every consumer uses this one. */
export function airRelative(velocity_N_m_s: Vec3, altitudeMsl_m: number, environment: AscentEnvironment): {
  relative_N_m_s: Vec3; speed_m_s: number; dynamicPressure_Pa: number; mach: number | null; air: Atmosphere;
} {
  const air = ambientAtmosphere(altitudeMsl_m, environment);
  const relative_N_m_s = add(velocity_N_m_s, scale(environment.wind_N_m_s, -1));
  const speed_m_s = Math.hypot(...relative_N_m_s);
  return {
    relative_N_m_s,
    speed_m_s,
    dynamicPressure_Pa: 0.5 * air.density_kg_m3 * speed_m_s * speed_m_s,
    mach: air.density_kg_m3 > 0 && air.soundSpeed_m_s > 0 ? speed_m_s / air.soundSpeed_m_s : null,
    air,
  };
}

function padAltitudeOf(environment: AscentEnvironment): number {
  return environment.padAltitudeMsl_m ?? DEFAULT_PAD_ALTITUDE_MSL_M;
}

interface Motion {
  position_N_m: Vec3;
  velocity_N_m_s: Vec3;
  q_BN: Quat;
  omega_B_rad_s: Vec3;
}

interface Derivative {
  position: Vec3;
  velocity: Vec3;
  q: Quat;
  omega: Vec3;
}

/**
 * Thrust direction in body axes for the commanded gimbal angles. Pointing the
 * **thrust vector** toward body −z (the exhaust plume leaves the opposite way,
 * toward +z) torques the nose toward +z, which is the downrange direction at
 * the pad; likewise a thrust component toward −y yaws the nose toward +y.
 * Those two statements are the sign convention, and they are pinned by oracles:
 * positive gimbal pitch gives a negative body-y rate, positive gimbal yaw gives
 * a positive body-z rate, and positive roll gives a positive body-x rate.
 */
function thrustDirection(controls: AscentControls): Vec3 {
  const pitch = clamp(controls.gimbalPitch, -1, 1) * MAX_GIMBAL_RAD;
  const yaw = clamp(controls.gimbalYaw, -1, 1) * MAX_GIMBAL_RAD;
  const raw: Vec3 = [Math.cos(pitch) * Math.cos(yaw), -Math.sin(yaw), -Math.sin(pitch)];
  return scale(raw, 1 / Math.hypot(...raw));
}

function chuteDeployTime(state: AscentState): number {
  return state.events.find((entry) => entry.kind === 'CHUTE_DEPLOYED')?.t_s ?? state.t_s;
}

/** Everything acting on the vehicle except gravity, plus what an instrument would read. */
interface AppliedForces {
  /** Non-gravitational force in launch-local NED. */
  force_N: Vec3;
  moment_B: Vec3;
  /** Thrust magnitude actually applied, after throttle and back-pressure. */
  thrust_N: number;
  dynamicPressure_Pa: number;
}

/**
 * The single force model. `stepAscent` integrates it and also samples it once at
 * the end of the step to record what the vehicle actually experienced, so the
 * instruments report applied values rather than a parallel approximation.
 */
function appliedForces(
  motion: Motion,
  tau_s: number,
  state: AscentState,
  controls: AscentControls,
  frame: StepFrame,
  environment: AscentEnvironment,
  powered: boolean,
): AppliedForces {
  const altitudeMsl_m = launchAltitudeToMsl(motion.position_N_m[2], padAltitudeOf(environment));
  const { relative_N_m_s, speed_m_s, dynamicPressure_Pa, mach, air } =
    airRelative(motion.velocity_N_m_s, altitudeMsl_m, environment);

  let force_B: Vec3 = [0, 0, 0];
  let moment_B: Vec3 = [0, 0, 0];
  let thrust_N = 0;

  if (powered) {
    thrust_N = Math.max(0, frame.throttle * frame.thrustVacuum_N - air.pressure_Pa * frame.exitArea_m2);
    const thrust = scale(thrustDirection(controls), thrust_N);
    force_B = add(force_B, thrust);
    if (frame.engineStation_x_m !== null) {
      moment_B = add(moment_B, cross([frame.engineStation_x_m - frame.com_x_m, 0, 0], thrust));
    }
  }

  // Axial drag along the relative wind, plus a normal force at the centre of
  // pressure that weathercocks a statically stable vehicle.
  if (dynamicPressure_Pa > 0 && speed_m_s > 1e-6) {
    const relative_B = rotateVector(motion.q_BN, relative_N_m_s);
    const lateral: Vec3 = [0, relative_B[1], relative_B[2]];
    const lateralSpeed = Math.hypot(...lateral);
    const alpha = Math.atan2(lateralSpeed, relative_B[0]);
    const cd = state.stage === 'STACK' ? dragCoefficient(mach ?? 0) : CAPSULE_BALLISTIC_CD;
    force_B = add(force_B, scale(relative_B, -cd * dynamicPressure_Pa * frame.sRef_m2 / speed_m_s));
    if (lateralSpeed > 1e-9) {
      const normal = scale(lateral, -(frame.cnAlpha * alpha * dynamicPressure_Pa * frame.sRef_m2) / lateralSpeed);
      force_B = add(force_B, normal);
      moment_B = add(moment_B, cross([frame.cp_x_m - frame.com_x_m, 0, 0], normal));
    }
    const damping = 0.5 * air.density_kg_m3 * speed_m_s * frame.sRef_m2 * frame.diameter_m ** 2;
    moment_B = add(moment_B, [
      -ROLL_DAMPING * 0.5 * air.density_kg_m3 * speed_m_s * frame.finArea_m2
        * (frame.diameter_m / 2) ** 2 * motion.omega_B_rad_s[0],
      -PITCH_YAW_DAMPING * damping * motion.omega_B_rad_s[1],
      -PITCH_YAW_DAMPING * damping * motion.omega_B_rad_s[2],
    ]);
  }

  moment_B = add(moment_B, [clamp(controls.roll, -1, 1) * frame.rollAuthority_N_m, 0, 0]);

  // The canopy pulls through the centre of mass, so it adds no moment.
  let chuteForce_N: Vec3 = [0, 0, 0];
  if (state.chute === 'DEPLOYED' && speed_m_s > 1e-6) {
    const inflation = clamp((state.t_s + tau_s - chuteDeployTime(state)) / CHUTE_INFLATION_S, 0, 1);
    const magnitude = dynamicPressure_Pa * frame.chuteCd * frame.chuteArea_m2 * inflation;
    chuteForce_N = scale(relative_N_m_s, -magnitude / speed_m_s);
  }

  return {
    force_N: add(rotateVector(conjugateQuaternion(motion.q_BN), force_B), chuteForce_N),
    moment_B,
    thrust_N,
    dynamicPressure_Pa,
  };
}

function derivative(
  motion: Motion,
  tau_s: number,
  state: AscentState,
  controls: AscentControls,
  frame: StepFrame,
  environment: AscentEnvironment,
  powered: boolean,
  consumed_kg: number,
): Derivative {
  const altitudeMsl_m = launchAltitudeToMsl(motion.position_N_m[2], padAltitudeOf(environment));
  // Fuel burned before this sub-step stays burned: the unpowered remainder after
  // a burnout split must not recover the vehicle's original mass.
  const mass = Math.max(1e-6, frame.mass0_kg - consumed_kg - (powered ? frame.massFlow_kg_s * tau_s : 0));
  const { force_N, moment_B } = appliedForces(motion, tau_s, state, controls, frame, environment, powered);
  const spin: Quat = [0, ...motion.omega_B_rad_s];
  const angularMomentum: Vec3 = [
    frame.inertia[0] * motion.omega_B_rad_s[0],
    frame.inertia[1] * motion.omega_B_rad_s[1],
    frame.inertia[2] * motion.omega_B_rad_s[2],
  ];
  const torque = add(moment_B, scale(cross(motion.omega_B_rad_s, angularMomentum), -1));
  return {
    position: motion.velocity_N_m_s,
    velocity: add(scale(force_N, 1 / mass), [0, 0, gravityAt(altitudeMsl_m, environment)]),
    q: multiplyQuaternion(spin, motion.q_BN).map((v) => -0.5 * v) as Quat,
    omega: [torque[0] / frame.inertia[0], torque[1] / frame.inertia[1], torque[2] / frame.inertia[2]],
  };
}

function offset(motion: Motion, d: Derivative, dt: number): Motion {
  return {
    position_N_m: add(motion.position_N_m, scale(d.position, dt)),
    velocity_N_m_s: add(motion.velocity_N_m_s, scale(d.velocity, dt)),
    q_BN: motion.q_BN.map((v, i) => v + d.q[i]! * dt) as Quat,
    omega_B_rad_s: add(motion.omega_B_rad_s, scale(d.omega, dt)),
  };
}

/** One RK4 sub-step of duration `h`, with mass varying analytically when powered. */
function integrate(
  motion: Motion,
  h: number,
  state: AscentState,
  controls: AscentControls,
  frame: StepFrame,
  environment: AscentEnvironment,
  powered: boolean,
  tau0: number,
  consumed_kg = 0,
): Motion {
  const a = derivative(motion, tau0, state, controls, frame, environment, powered, consumed_kg);
  const b = derivative(offset(motion, a, h / 2), tau0 + h / 2, state, controls, frame, environment, powered, consumed_kg);
  const c = derivative(offset(motion, b, h / 2), tau0 + h / 2, state, controls, frame, environment, powered, consumed_kg);
  const d = derivative(offset(motion, c, h), tau0 + h, state, controls, frame, environment, powered, consumed_kg);
  const mix = (key: 'position' | 'velocity' | 'omega'): Vec3 => [0, 1, 2]
    .map((i) => (a[key][i]! + 2 * b[key][i]! + 2 * c[key][i]! + d[key][i]!) / 6) as Vec3;
  const next = offset(motion, {
    position: mix('position'),
    velocity: mix('velocity'),
    omega: mix('omega'),
    q: [0, 1, 2, 3].map((i) => (a.q[i]! + 2 * b.q[i]! + 2 * c.q[i]! + d.q[i]!) / 6) as Quat,
  }, h);
  next.q_BN = normalizeQuaternion(next.q_BN);
  return next;
}

const TERMINAL: readonly AscentStatus[] = ['RECOVERED', 'CRASHED', 'LOST', 'PAD_NO_LIFTOFF', 'TIMEOUT'];
export const isTerminal = (status: AscentStatus): boolean => TERMINAL.includes(status);

interface Draft extends Motion {
  t_s: number;
  prop_kg: number;
  stage: AscentStage;
  discarded: { mass_kg: number; t_s: number } | null;
  engine: EngineState;
  chute: ChuteState;
  status: AscentStatus;
  maxQ_Pa: number;
  appliedThrust_N: number;
  axialLoad_g: number;
  events: AscentEvent[];
}

function stamp(draft: Draft, kind: AscentEventKind, t_s: number, note?: string): void {
  draft.events.push({ kind, t_s, altitude_m: -draft.position_N_m[2], ...(note === undefined ? {} : { note }) });
}

/**
 * One deterministic 100 Hz truth step. **This function owns every event and
 * latch phase and runs them exactly once per call**, in this order:
 *
 * 1. a commanded `CUTOFF` is applied before integrating;
 * 2. the vehicle is integrated, splitting the step at propellant exhaustion;
 * 3. a commanded `SEPARATION` is applied, forcing the engine off first;
 * 4. a commanded chute deployment is applied;
 * 5. `APOGEE`, `CHUTE_*`, `TOUCHDOWN` and `OUT_OF_RANGE` are edge-detected;
 * 6. the terminal latch is set last.
 *
 * A caller supplies the inputs to one call. It does not re-order or re-implement
 * any of the above; that is what "single owner" means here.
 */
export function stepAscent(
  state: AscentState,
  controls: AscentControls,
  config: VehicleConfig,
  environment: AscentEnvironment = STILL_AIR_ASCENT,
): AscentState {
  finite([
    state.t_s, state.prop_kg, ...state.position_N_m, ...state.velocity_N_m_s,
    ...state.q_BN, ...state.omega_B_rad_s,
  ], 'ascent state');
  finite([controls.throttle, controls.gimbalPitch, controls.gimbalYaw, controls.roll], 'ascent controls');
  if (state.prop_kg < 0) throw new RangeError('propellant mass must be non-negative');
  // A latched run never moves again, however many times it is stepped.
  if (isTerminal(state.status)) return state;

  const dt = ASCENT_DT_S;
  const frame = stepFrame(state, config, controls);
  const draft: Draft = {
    t_s: state.t_s,
    position_N_m: [...state.position_N_m],
    velocity_N_m_s: [...state.velocity_N_m_s],
    q_BN: [...state.q_BN],
    omega_B_rad_s: [...state.omega_B_rad_s],
    prop_kg: state.prop_kg,
    stage: state.stage,
    discarded: state.discarded,
    engine: state.engine,
    chute: state.chute,
    status: state.status,
    maxQ_Pa: state.maxQ_Pa,
    appliedThrust_N: state.appliedThrust_N,
    axialLoad_g: state.axialLoad_g,
    events: [...state.events],
  };

  // Phase 0 — an engine that entered the step already empty publishes BURNOUT at
  // t. This runs BEFORE the cutoff phase on purpose: an empty tank is a physical
  // fact rather than a command, and letting a concurrent cutoff mask it would
  // destroy the event a delayed separation keys on. An engine that has burned
  // out cannot then be "cut off", so no CUTOFF is stamped for it.
  if (draft.engine === 'ON' && draft.prop_kg === 0) {
    draft.engine = 'BURNOUT';
    stamp(draft, 'BURNOUT', draft.t_s, 'engine entered the step with no propellant');
  }

  // Phase 1 — commanded cutoff, before any integration.
  if (controls.cutoff && draft.engine === 'ON') {
    draft.engine = 'OFF';
    stamp(draft, 'CUTOFF', draft.t_s);
  }

  // Phase 2 — the pad. Until the vehicle can lift its own weight it does not move.
  if (draft.status === 'PAD') {
    // A cutoff commanded in the same call dominates ignition. Otherwise a
    // combined input — which the runner's manual-override merge can produce —
    // would let the pad phase silently undo a pre-integration cutoff.
    if (controls.ignite && !controls.cutoff && draft.engine === 'OFF' && draft.prop_kg > 0) draft.engine = 'ON';
    if (draft.engine === 'ON') {
      const altitudeMsl_m = launchAltitudeToMsl(draft.position_N_m[2], padAltitudeOf(environment));
      const air = ambientAtmosphere(altitudeMsl_m, environment);
      const thrust_N = Math.max(0, frame.throttle * frame.thrustVacuum_N - air.pressure_Pa * frame.exitArea_m2);
      const weight_N = frame.mass0_kg * gravityAt(altitudeMsl_m, environment);
      if (thrust_N <= weight_N) {
        stamp(draft, 'INSUFFICIENT_THRUST', draft.t_s,
          `thrust ${thrust_N.toFixed(0)} N cannot lift ${weight_N.toFixed(0)} N`);
        draft.status = 'PAD_NO_LIFTOFF';
        draft.t_s += dt;
        return freeze(draft);
      }
      stamp(draft, 'LIFTOFF', draft.t_s);
      draft.status = 'FLYING';
    } else {
      // Waiting on the pad: the clock runs, nothing else does.
      draft.t_s += dt;
      return latchTimeout(freeze(draft));
    }
  }

  // Phase 3 — integrate, splitting the step at propellant exhaustion.
  const powered = draft.engine === 'ON';
  const burn_s = powered && frame.massFlow_kg_s > 0 ? draft.prop_kg / frame.massFlow_kg_s : Number.POSITIVE_INFINITY;
  let motion: Motion = draft;
  if (powered && burn_s <= dt) {
    // Inclusive bound: the equality case splits too, and stamps at t + dt.
    const consumed = draft.prop_kg;
    motion = integrate(motion, burn_s, state, controls, frame, environment, true, 0);
    draft.prop_kg = 0;
    draft.engine = 'BURNOUT';
    stampAt(draft, motion, 'BURNOUT', draft.t_s + burn_s);
    const remainder = dt - burn_s;
    // A zero-length remainder is skipped rather than integrated. The remainder
    // carries the consumed fuel forward so the vehicle stays light.
    if (remainder > 0) {
      motion = integrate(motion, remainder, state, controls, frame, environment, false, 0, consumed);
    }
  } else {
    motion = integrate(motion, dt, state, controls, frame, environment, powered, 0);
    if (powered) draft.prop_kg = Math.max(0, draft.prop_kg - frame.massFlow_kg_s * dt);
  }
  draft.position_N_m = motion.position_N_m;
  draft.velocity_N_m_s = motion.velocity_N_m_s;
  draft.q_BN = motion.q_BN;
  draft.omega_B_rad_s = motion.omega_B_rad_s;
  draft.t_s = state.t_s + dt;

  // Sample the same force model once at the end of the step, so instruments can
  // report what was applied rather than what was available.
  const observed = appliedForces(motion, dt, state, controls, frame, environment, draft.engine === 'ON');
  const observedMass = Math.max(1e-6, stageProperties(config, draft.stage, draft.prop_kg).mass_kg);
  const bodyForward_N = rotateVector(conjugateQuaternion(motion.q_BN), [1, 0, 0]);
  draft.appliedThrust_N = observed.thrust_N;
  draft.axialLoad_g = (observed.force_N[0] * bodyForward_N[0] + observed.force_N[1] * bodyForward_N[1]
    + observed.force_N[2] * bodyForward_N[2]) / (observedMass * STANDARD_GRAVITY_M_S2);

  // Phase 4 — commanded separation, after the physics step.
  if (controls.separate && draft.stage === 'STACK') {
    if (draft.engine === 'ON') {
      draft.engine = 'OFF';
      stamp(draft, 'CUTOFF', draft.t_s, 'forced by separation');
    }
    separate(draft, config);
  }

  // Phase 5 — commanded chute deployment.
  if (controls.deployChute && draft.chute === 'STOWED') deployChute(draft, config, environment);

  // Phase 6 — edge-detected events, then the terminal latch last.
  return latch(detectEdges(draft, state, config, environment), config, environment);
}

function stampAt(draft: Draft, motion: Motion, kind: AscentEventKind, t_s: number): void {
  draft.events.push({ kind, t_s, altitude_m: -motion.position_N_m[2] });
}

/**
 * Separation on the shared nose-tip station datum. The state position switches
 * reference from the stack's centre of mass to the capsule's, so it jumps by
 * design; the capsule's own material points stay continuous, which is what the
 * transform preserves.
 */
function separate(draft: Draft, config: VehicleConfig): void {
  const stack = stageProperties(config, 'STACK', draft.prop_kg);
  const capsule = stageProperties(config, 'CAPSULE', 0);
  const delta_B: Vec3 = [capsule.com_x_m - stack.com_x_m, 0, 0];
  const delta_N = rotateVector(conjugateQuaternion(draft.q_BN), delta_B);
  const lever_N = rotateVector(conjugateQuaternion(draft.q_BN), cross(draft.omega_B_rad_s, delta_B));
  draft.position_N_m = add(draft.position_N_m, delta_N);
  draft.velocity_N_m_s = add(draft.velocity_N_m_s, lever_N);
  draft.discarded = { mass_kg: stack.mass_kg - capsule.mass_kg, t_s: draft.t_s };
  draft.stage = 'CAPSULE';
  draft.prop_kg = 0;
  draft.engine = 'OFF';
  stamp(draft, 'SEPARATION', draft.t_s);
}

function deployChute(draft: Draft, config: VehicleConfig, environment: AscentEnvironment): void {
  // Air-relative, not ground-relative: a canopy tears on the airflow it meets,
  // and a vehicle hanging still in a gale is not in still air.
  const altitudeMsl_m = launchAltitudeToMsl(draft.position_N_m[2], padAltitudeOf(environment));
  const { dynamicPressure_Pa: q_Pa } = airRelative(draft.velocity_N_m_s, altitudeMsl_m, environment);
  if (q_Pa > CHUTE_MAX_DEPLOY_Q_PA) {
    draft.chute = 'FAILED';
    stamp(draft, 'CHUTE_FAILED', draft.t_s,
      `dynamic pressure ${q_Pa.toFixed(0)} Pa exceeded the ${CHUTE_MAX_DEPLOY_Q_PA} Pa limit`);
    return;
  }
  draft.chute = 'DEPLOYED';
  stamp(draft, 'CHUTE_DEPLOYED', draft.t_s);
}

function detectEdges(draft: Draft, previous: AscentState, config: VehicleConfig, environment: AscentEnvironment): Draft {
  const altitudeMsl_m = launchAltitudeToMsl(draft.position_N_m[2], padAltitudeOf(environment));
  const { dynamicPressure_Pa: q_Pa } = airRelative(draft.velocity_N_m_s, altitudeMsl_m, environment);
  if (q_Pa > draft.maxQ_Pa) {
    draft.maxQ_Pa = q_Pa;
  } else if (draft.maxQ_Pa > MAX_Q_MIN_PA && !draft.events.some((event) => event.kind === 'MAX_Q')) {
    stamp(draft, 'MAX_Q', draft.t_s, `${draft.maxQ_Pa.toFixed(0)} Pa`);
  }
  const rising = -previous.velocity_N_m_s[2];
  const falling = -draft.velocity_N_m_s[2];
  if (rising > 0 && falling <= 0 && !draft.events.some((event) => event.kind === 'APOGEE')) {
    stamp(draft, 'APOGEE', draft.t_s);
  }
  return draft;
}

function latchTimeout(state: AscentState): AscentState {
  if (state.t_s < ASCENT_TIMEOUT_S || isTerminal(state.status)) return state;
  return {
    ...state,
    status: 'TIMEOUT',
    events: [...state.events, { kind: 'TIMEOUT', t_s: state.t_s, altitude_m: -state.position_N_m[2] }],
  };
}

function latch(draft: Draft, config: VehicleConfig, environment: AscentEnvironment): AscentState {
  const altitude_m = -draft.position_N_m[2];
  const range_m = Math.hypot(draft.position_N_m[0], draft.position_N_m[1]);
  const speed = Math.hypot(...draft.velocity_N_m_s);
  if (range_m > ASCENT_MAX_RANGE_M || altitude_m > ASCENT_MAX_ALTITUDE_M) {
    stamp(draft, 'OUT_OF_RANGE', draft.t_s);
    draft.status = 'LOST';
    return freeze(draft);
  }
  // Attitude-aware: the lowest point of the active body, not a vertical
  // station difference that is only valid while the vehicle stands upright.
  if (lowestContactDepth_m(draft, config) >= 0) {
    stamp(draft, 'TOUCHDOWN', draft.t_s, `${speed.toFixed(2)} m/s`);
    draft.status = draft.chute === 'DEPLOYED' && speed <= RECOVERY_SPEED_LIMIT_M_S ? 'RECOVERED' : 'CRASHED';
    return freeze(draft);
  }
  return latchTimeout(freeze(draft));
}

function freeze(draft: Draft): AscentState {
  return {
    t_s: draft.t_s,
    position_N_m: draft.position_N_m,
    velocity_N_m_s: draft.velocity_N_m_s,
    q_BN: draft.q_BN,
    omega_B_rad_s: draft.omega_B_rad_s,
    prop_kg: draft.prop_kg,
    stage: draft.stage,
    discarded: draft.discarded,
    engine: draft.engine,
    chute: draft.chute,
    status: draft.status,
    maxQ_Pa: draft.maxQ_Pa,
    appliedThrust_N: draft.appliedThrust_N,
    axialLoad_g: draft.axialLoad_g,
    events: draft.events,
  };
}

/**
 * Truth-derived instrument frame. Guidance consumes **this**, never
 * `AscentState`: it carries the measured attitude quaternion and body rates the
 * controller needs, so there is no reason to reach for truth. The Euler angles
 * are display-only, and deriving attitude error from them would reintroduce
 * exactly the vertical-pose ambiguity the basis construction removes. In M1 the
 * measurement equals truth and no sensor model is applied; the seam exists so
 * noise can be inserted later without changing a signature.
 */
export interface AscentInstruments {
  t_s: number;
  altitude_m: number;
  altitudeMsl_m: number;
  verticalSpeed_m_s: number;
  groundSpeed_m_s: number;
  speed_m_s: number;
  downrange_m: number;
  mach: number | null;
  dynamicPressure_Pa: number;
  axialLoad_g: number;
  alpha_rad: number;
  mass_kg: number;
  propellant_kg: number;
  propellantFraction: number;
  /** Thrust actually applied by the force model at the end of the last step. */
  thrust_N: number;
  /** Maximum thrust the engine could produce here at full throttle. */
  availableThrust_N: number;
  /** Measured attitude, for guidance. */
  q_BN: Quat;
  /** Measured body rates, for guidance. */
  omega_B_rad_s: Vec3;
  /** Display-only. Guidance must not derive attitude error from these. */
  pitch_rad: number;
  heading_rad: number;
  roll_rad: number;
  stage: AscentStage;
  engine: EngineState;
  chute: ChuteState;
  status: AscentStatus;
  /** Vacuum ballistic estimate `h + v_up² / 2g`, labelled as an estimate. */
  apogeeEstimate_m: number;
  events: readonly AscentEvent[];
}

export function ascentInstruments(
  state: AscentState,
  config: VehicleConfig,
  environment: AscentEnvironment = STILL_AIR_ASCENT,
): AscentInstruments {
  const altitude_m = -state.position_N_m[2];
  const altitudeMsl_m = launchAltitudeToMsl(state.position_N_m[2], padAltitudeOf(environment));
  const air = ambientAtmosphere(altitudeMsl_m, environment);
  const properties = stageProperties(config, state.stage, state.prop_kg);
  const engine = engineSpec(config);
  const capacity = tankCapacity(config).propellant_kg;
  const { relative_N_m_s: relative, speed_m_s: speed, dynamicPressure_Pa, mach } =
    airRelative(state.velocity_N_m_s, altitudeMsl_m, environment);
  const relative_B = speed > 1e-9 ? rotateVector(state.q_BN, relative) : [1, 0, 0] as Vec3;
  // Applied, not available: `stepAscent` records what the force model actually
  // produced. `availableThrust_N` is the separate maximum, named as such.
  const thrust_N = state.appliedThrust_N;
  const availableThrust_N = state.engine === 'ON'
    ? Math.max(0, engine.thrustVacuum_N - air.pressure_Pa * engine.exitArea_m2)
    : 0;
  const forward = rotateVector(conjugateQuaternion(state.q_BN), [1, 0, 0]);
  const right = rotateVector(conjugateQuaternion(state.q_BN), [0, 1, 0]);
  const down = rotateVector(conjugateQuaternion(state.q_BN), [0, 0, 1]);
  const verticalSpeed = -state.velocity_N_m_s[2];
  const gravity = gravityAt(altitudeMsl_m, environment);
  return {
    t_s: state.t_s,
    altitude_m,
    altitudeMsl_m,
    verticalSpeed_m_s: verticalSpeed,
    groundSpeed_m_s: Math.hypot(state.velocity_N_m_s[0], state.velocity_N_m_s[1]),
    speed_m_s: Math.hypot(...state.velocity_N_m_s),
    downrange_m: Math.hypot(state.position_N_m[0], state.position_N_m[1]),
    // Above the atmosphere's hard cutoff there is no sound speed to divide by.
    mach,
    dynamicPressure_Pa,
    axialLoad_g: state.axialLoad_g,
    alpha_rad: Math.atan2(Math.hypot(relative_B[1], relative_B[2]), relative_B[0]),
    mass_kg: properties.mass_kg,
    propellant_kg: state.prop_kg,
    propellantFraction: capacity > 0 ? state.prop_kg / capacity : 0,
    thrust_N,
    availableThrust_N,
    q_BN: [...state.q_BN],
    omega_B_rad_s: [...state.omega_B_rad_s],
    pitch_rad: Math.asin(clamp(-forward[2], -1, 1)),
    heading_rad: (Math.atan2(forward[1], forward[0]) + 2 * Math.PI) % (2 * Math.PI),
    roll_rad: Math.atan2(right[2], down[2]),
    stage: state.stage,
    engine: state.engine,
    chute: state.chute,
    status: state.status,
    apogeeEstimate_m: verticalSpeed > 0 ? altitude_m + verticalSpeed ** 2 / (2 * gravity) : altitude_m,
    events: state.events,
  };
}
