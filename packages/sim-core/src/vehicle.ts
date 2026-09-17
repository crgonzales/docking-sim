/**
 * Procedural launch-vehicle model (F_0.20.0 Phase 1a).
 *
 * One `VehicleConfig` is the single source of geometry, mass properties and
 * aerodynamic reference data. Rendering, the planner's readouts and the physics
 * all read the same derivations here; duplicating any of them elsewhere is a
 * review defect.
 *
 * **Station datum.** Axial stations are scalars on the body +x axis measured
 * from the nose tip of the assembled stack, positive toward +x (the nose).
 * Everything aft of the nose therefore has a negative station. The datum is
 * fixed by the configuration and does **not** move at separation, which is what
 * makes `capsule.com_x_m - stack.com_x_m` a meaningful body-frame offset.
 *
 * Inertia, by contrast, is reported about each active stage's own centre of
 * mass, as the rigid-body integrator requires.
 *
 * SI units throughout. Pure TypeScript: no DOM, React or Three.js.
 *
 * These are documented engineering approximations for a game, not a validated
 * vehicle dataset. Coefficients and mass laws are first-order and are tuned by
 * test rather than measured.
 */
import type { Vec3 } from './types.js';

export type PropellantId = 'LOX_RP1' | 'LOX_CH4';
export type EngineFamilyId = 'A_PRESSURE_FED' | 'B_PUMP_FED';
export type ThrustStep = 0 | 1 | 2;
export type FinCount = 0 | 3 | 4;
export type VehicleStage = 'STACK' | 'CAPSULE';

export interface PayloadSpec {
  id: string;
  mass_kg: number;
  envelope: { diameter_m: number; length_m: number };
}

export interface VehicleConfig {
  version: 1;
  stackDiameter_m: number;
  /**
   * `length_m` is the tank's **overall** length: a cylindrical barrel plus two
   * hemispherical end domes. The barrel is therefore `length_m - diameter`,
   * which is why the minimum aspect ratio is 1. Reading this as barrel length
   * alone would silently overstate propellant volume.
   */
  tank: { length_m: number; propellant: PropellantId };
  engine: { family: EngineFamilyId; thrustStep: ThrustStep };
  fins: FinCount;
  payload: PayloadSpec;
}

/** One entry of the generic subsonic/transonic/supersonic drag table. */
export interface DragPoint { mach: number; cd: number }

export interface EngineSpec {
  family: EngineFamilyId;
  label: string;
  thrustVacuum_N: number;
  ispVacuum_s: number;
  exitArea_m2: number;
  minThrottle: number;
  mass_kg: number;
  massFlow_kg_s: number;
  minStackDiameter_m: number;
  tankWallAreal_kg_m2: number;
}

export interface ParachuteSpec {
  area_m2: number;
  cd: number;
  mass_kg: number;
  /** Sea-level terminal speed the area was sized for. */
  designDescent_m_s: number;
}

export interface StageProperties {
  stage: VehicleStage;
  mass_kg: number;
  com_x_m: number;
  /** Diagonal `[Ixx, Iyy, Izz]` about this stage's own centre of mass. */
  inertia_kg_m2: Vec3;
  propellant_kg: number;
  dry_kg: number;
  recoveredAssembly_kg: number;
  cargo_kg: number;
  sRef_m2: number;
  cdTable: readonly DragPoint[];
  cnAlpha: number;
  cp_x_m: number;
  engineStation_x_m: number | null;
  parachute: ParachuteSpec | null;
}

export interface VehicleSection {
  id: 'FAIRING' | 'CAPSULE' | 'RING' | 'TANK' | 'PROPULSION';
  /** Forward (less negative) station. */
  x_forward_m: number;
  /** Aft (more negative) station. */
  x_aft_m: number;
  radius_m: number;
}

export interface FinGeometry {
  count: FinCount;
  semiSpan_m: number;
  rootChord_m: number;
  tipChord_m: number;
  rootLeadingEdge_x_m: number;
  areaEach_m2: number;
  /**
   * Leading-edge sweep: how far aft the tip leading edge sits relative to the
   * root leading edge, measured parallel to the body axis. See
   * `FIN_PLANFORM_CONVENTION`.
   */
  leadingEdgeSweep_m: number;
  /** Spanwise station of the planform's area centroid, measured from the root. */
  areaCentroidSpan_m: number;
}

/** Fin mass properties on the shared station datum, for the point-mass approximation. */
export interface FinMassProperties {
  count: FinCount;
  totalMass_kg: number;
  areaCentroidSpan_m: number;
  /** Radius from the roll axis to the area centroid: body radius + centroid span. */
  massRadius_m: number;
  /** Axial station of the planform's area centroid. */
  axialCentroid_x_m: number;
}

export interface VehicleGeometry {
  stackDiameter_m: number;
  totalLength_m: number;
  base_x_m: number;
  sections: readonly VehicleSection[];
  fins: FinGeometry | null;
  engineStation_x_m: number;
}

export interface VehicleIssue {
  code: string;
  message: string;
  /** The designer or planner control that addresses this issue. */
  control: string;
}

export interface VehicleValidation {
  errors: readonly VehicleIssue[];
  warnings: readonly VehicleIssue[];
}

export const G0_M_S2 = 9.80665;
export const SEA_LEVEL_PRESSURE_PA = 101325;
export const SEA_LEVEL_DENSITY_KG_M3 = 1.225;

/** Bulk densities are mixture-ratio weighted averages, not component densities. */
export const PROPELLANTS: Readonly<Record<PropellantId, {
  label: string; bulkDensity_kg_m3: number; ispFactor: number;
}>> = {
  LOX_RP1: { label: 'LOX / RP-1', bulkDensity_kg_m3: 1030, ispFactor: 1 },
  LOX_CH4: { label: 'LOX / methane', bulkDensity_kg_m3: 830, ispFactor: 1.02 },
};

/** The declared family keys. Membership is checked against these, never with `in`. */
export const PROPELLANT_IDS: readonly PropellantId[] = ['LOX_RP1', 'LOX_CH4'];
export const ENGINE_FAMILY_IDS: readonly EngineFamilyId[] = ['A_PRESSURE_FED', 'B_PUMP_FED'];

/**
 * A configuration that has been through `JSON.parse` carries plain strings, so
 * TypeScript's union guarantees nothing at this boundary. `in` would accept
 * inherited names — `toString`, `constructor`, `__proto__` — and hand back a
 * prototype member as if it were a family, producing NaN specifications or a
 * stray `TypeError` far from the cause. Membership is therefore checked against
 * the declared key list *and* own-property presence.
 */
export function isPropellantId(value: unknown): value is PropellantId {
  return typeof value === 'string'
    && (PROPELLANT_IDS as readonly string[]).includes(value)
    && Object.hasOwn(PROPELLANTS, value);
}

export function isEngineFamilyId(value: unknown): value is EngineFamilyId {
  return typeof value === 'string'
    && (ENGINE_FAMILY_IDS as readonly string[]).includes(value)
    && Object.hasOwn(ENGINE_FAMILIES, value);
}

/**
 * Two engine families with three bounded thrust steps each. A family fixes
 * specific impulse, nozzle exit area, throttling floor, an engine
 * thrust-to-weight used as its mass law, the smallest stack it fits, and the
 * tank wall areal density its feed pressure demands. There is deliberately no
 * free thrust, specific-impulse or mass input: performance cannot be dialled in
 * without paying for it somewhere.
 */
export const ENGINE_FAMILIES: Readonly<Record<EngineFamilyId, {
  label: string;
  thrustVacuum_N: readonly [number, number, number];
  ispVacuum_s: number;
  exitArea_m2: readonly [number, number, number];
  minThrottle: number;
  engineThrustToWeight: number;
  minStackDiameter_m: number;
  tankWallAreal_kg_m2: number;
}>> = {
  A_PRESSURE_FED: {
    label: 'A · pressure-fed',
    thrustVacuum_N: [20_000, 30_000, 45_000],
    ispVacuum_s: 250,
    exitArea_m2: [0.055, 0.08, 0.12],
    minThrottle: 0.6,
    engineThrustToWeight: 60,
    minStackDiameter_m: 0.6,
    tankWallAreal_kg_m2: 12,
  },
  B_PUMP_FED: {
    label: 'B · pump-fed',
    thrustVacuum_N: [60_000, 90_000, 135_000],
    ispVacuum_s: 300,
    exitArea_m2: [0.16, 0.24, 0.36],
    minThrottle: 0.5,
    engineThrustToWeight: 100,
    minStackDiameter_m: 1,
    tankWallAreal_kg_m2: 5,
  },
};

export const STACK_DIAMETER_RANGE_M = { min: 0.6, max: 2 } as const;
export const STACK_DIAMETER_STEP_M = 0.1;
export const TANK_ASPECT_RATIO_RANGE = { min: 1, max: 8 } as const;
export const TANK_LENGTH_STEP_M = 0.25;
export const MIN_LIFTOFF_THRUST_TO_WEIGHT = 1.2;
export const MIN_STATIC_MARGIN_CALIBRES = 1;

const FAIRING_FINENESS = 1.5;
const CAPSULE_LENGTH_MARGIN_M = 0.3;
const SHELL_AREAL_DENSITY_KG_M2 = 6;
const AVIONICS_MASS_KG = 25;
const RING_LENGTH_M = 0.1;
const RING_MASS_PER_DIAMETER_KG_M = 8;
const PROPULSION_LENGTH_FACTOR = 0.6;
const TANK_USABLE_FRACTION = 0.92;
const FIN_SPAN_FACTOR = 1.4;
const FIN_ROOT_FACTOR = 1.4;
const FIN_TIP_FACTOR = 0.4;
const FIN_AREAL_DENSITY_KG_M2 = 8;
const PARACHUTE_CD = 1.5;
const PARACHUTE_DESIGN_DESCENT_M_S = 7;
const PARACHUTE_CANOPY_AREAL_KG_M2 = 0.05;
const ROLL_AUTHORITY_PER_DIAMETER_N_M = 60;
const NOSE_CN_ALPHA = 2;

/**
 * **Fin planform convention.** Each fin is a uniform trapezoid whose tip chord
 * is centred on the root chord. The leading edge therefore sweeps aft by
 * `(rootChord − tipChord) / 2` from root to tip, the trailing edge sweeps
 * forward by the same amount, and the **mid-chord line has zero sweep**.
 *
 * Everything downstream follows from this one statement, and it is stated
 * because it is not inferable from the chord and span constants alone:
 *
 * - Barrowman's centre-of-pressure term takes the **leading-edge** sweep.
 * - The normal-force denominator takes the **mid-chord** line length, which is
 *   the semispan exactly, since that line is unswept here.
 * - The planform's area centroid lies at spanwise
 *   `s·(cr + 2·ct) / (3·(cr + ct))` and, for this centred-tip convention only,
 *   at the root chord's axial midpoint. The general axial expression is used in
 *   code so the value stays correct if the convention is ever changed.
 */
export const FIN_PLANFORM_CONVENTION =
  'uniform trapezoid, tip chord centred on the root chord, unswept mid-chord line';

/**
 * Generic blunt-nosed cylinder drag: flat subsonic, a transonic peak, then a
 * supersonic decay. One documented curve, not a measured vehicle dataset.
 */
export const CD_TABLE: readonly DragPoint[] = [
  { mach: 0, cd: 0.3 },
  { mach: 0.8, cd: 0.3 },
  { mach: 1.05, cd: 0.6 },
  { mach: 1.3, cd: 0.55 },
  { mach: 2, cd: 0.4 },
  { mach: 5, cd: 0.35 },
];

/** Piecewise-linear lookup into `CD_TABLE`, clamped outside its ends. */
export function dragCoefficient(mach: number): number {
  if (!Number.isFinite(mach)) throw new RangeError('Mach number must be finite');
  const m = Math.abs(mach);
  const first = CD_TABLE[0]!;
  const last = CD_TABLE[CD_TABLE.length - 1]!;
  if (m <= first.mach) return first.cd;
  if (m >= last.mach) return last.cd;
  for (let i = 1; i < CD_TABLE.length; i++) {
    const hi = CD_TABLE[i]!;
    if (m <= hi.mach) {
      const lo = CD_TABLE[i - 1]!;
      const t = (m - lo.mach) / (hi.mach - lo.mach);
      return lo.cd + t * (hi.cd - lo.cd);
    }
  }
  return last.cd;
}

interface MassElement {
  mass_kg: number;
  /** Centroid station on the shared datum. */
  x_m: number;
  radius_m: number;
  length_m: number;
  /** Fins sit off-axis; their axial inertia uses this radius instead. */
  offAxisRadius_m?: number;
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function requirePositive(value: number, name: string): void {
  requireFinite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

/** Throws only on structurally unusable input; product rules live in `validateVehicleConfig`. */
function assertUsable(config: VehicleConfig): void {
  if (config.version !== 1) throw new RangeError('vehicle config version must be 1');
  requirePositive(config.stackDiameter_m, 'stack diameter');
  requirePositive(config.tank.length_m, 'tank length');
  requirePositive(config.payload.mass_kg, 'payload mass');
  requirePositive(config.payload.envelope.diameter_m, 'payload envelope diameter');
  requirePositive(config.payload.envelope.length_m, 'payload envelope length');
  if (!isPropellantId(config.tank.propellant)) throw new RangeError(`unknown propellant: ${String(config.tank.propellant)}`);
  if (!isEngineFamilyId(config.engine.family)) throw new RangeError(`unknown engine family: ${String(config.engine.family)}`);
  if (![0, 1, 2].includes(config.engine.thrustStep)) throw new RangeError('thrust step must be 0, 1 or 2');
  if (![0, 3, 4].includes(config.fins)) throw new RangeError('fin count must be 0, 3 or 4');
}

export function engineSpec(config: VehicleConfig): EngineSpec {
  assertUsable(config);
  const family = ENGINE_FAMILIES[config.engine.family];
  const thrustVacuum_N = family.thrustVacuum_N[config.engine.thrustStep]!;
  const exitArea_m2 = family.exitArea_m2[config.engine.thrustStep]!;
  const ispVacuum_s = family.ispVacuum_s * PROPELLANTS[config.tank.propellant].ispFactor;
  return {
    family: config.engine.family,
    label: `${family.label} · ${(thrustVacuum_N / 1000).toFixed(0)} kN`,
    thrustVacuum_N,
    ispVacuum_s,
    exitArea_m2,
    minThrottle: family.minThrottle,
    mass_kg: thrustVacuum_N / (G0_M_S2 * family.engineThrustToWeight),
    massFlow_kg_s: thrustVacuum_N / (ispVacuum_s * G0_M_S2),
    minStackDiameter_m: family.minStackDiameter_m,
    tankWallAreal_kg_m2: family.tankWallAreal_kg_m2,
  };
}

/**
 * Fin planform per `FIN_PLANFORM_CONVENTION`. The area centroid is the exact
 * first-moment result for a linearly tapered chord,
 * `∫y·c(y)dy / ∫c(y)dy = s(cr + 2ct) / (3(cr + ct))`.
 */
function finGeometry(config: VehicleConfig, base_x_m: number): FinGeometry {
  const d = config.stackDiameter_m;
  const semiSpan_m = FIN_SPAN_FACTOR * d;
  const rootChord_m = FIN_ROOT_FACTOR * d;
  const tipChord_m = FIN_TIP_FACTOR * d;
  const chordSum = rootChord_m + tipChord_m;
  return {
    count: config.fins,
    semiSpan_m,
    rootChord_m,
    tipChord_m,
    // The fin root trailing edge sits at the vehicle base.
    rootLeadingEdge_x_m: base_x_m + rootChord_m,
    areaEach_m2: 0.5 * chordSum * semiSpan_m,
    leadingEdgeSweep_m: (rootChord_m - tipChord_m) / 2,
    areaCentroidSpan_m: semiSpan_m * (rootChord_m + 2 * tipChord_m) / (3 * chordSum),
  };
}

/**
 * Mass properties of the whole fin set under the declared point-mass
 * approximation: the set's mass concentrated at the planform's area centroid.
 *
 * The axial centroid uses the general tapered-trapezoid result
 * `rootLE − [m(cr + 2ct) + (cr² + cr·ct + ct²)] / (3(cr + ct))`, with `m` the
 * leading-edge sweep. Under the centred-tip convention that simplifies exactly
 * to the root chord midpoint, but the general form is computed so the value
 * stays right if the planform convention changes.
 */
export function finMassProperties(config: VehicleConfig): FinMassProperties | null {
  assertUsable(config);
  const fins = vehicleGeometry(config).fins;
  if (fins === null) return null;
  const { rootChord_m: cr, tipChord_m: ct, leadingEdgeSweep_m: sweep } = fins;
  const chordSum = cr + ct;
  return {
    count: fins.count,
    totalMass_kg: fins.count * fins.areaEach_m2 * FIN_AREAL_DENSITY_KG_M2,
    areaCentroidSpan_m: fins.areaCentroidSpan_m,
    massRadius_m: config.stackDiameter_m / 2 + fins.areaCentroidSpan_m,
    axialCentroid_x_m: fins.rootLeadingEdge_x_m
      - (sweep * (cr + 2 * ct) + (cr * cr + cr * ct + ct * ct)) / (3 * chordSum),
  };
}

export function vehicleGeometry(config: VehicleConfig): VehicleGeometry {
  assertUsable(config);
  const d = config.stackDiameter_m;
  const radius_m = d / 2;
  const fairing_m = FAIRING_FINENESS * d;
  const capsule_m = config.payload.envelope.length_m + CAPSULE_LENGTH_MARGIN_M;
  const tank_m = config.tank.length_m;
  const propulsion_m = PROPULSION_LENGTH_FACTOR * d;
  const fairingAft = -fairing_m;
  const capsuleAft = fairingAft - capsule_m;
  const ringAft = capsuleAft - RING_LENGTH_M;
  const tankAft = ringAft - tank_m;
  const base_x_m = tankAft - propulsion_m;
  const rootChord_m = FIN_ROOT_FACTOR * d;
  return {
    stackDiameter_m: d,
    totalLength_m: -base_x_m,
    base_x_m,
    sections: [
      { id: 'FAIRING', x_forward_m: 0, x_aft_m: fairingAft, radius_m },
      { id: 'CAPSULE', x_forward_m: fairingAft, x_aft_m: capsuleAft, radius_m },
      { id: 'RING', x_forward_m: capsuleAft, x_aft_m: ringAft, radius_m },
      { id: 'TANK', x_forward_m: ringAft, x_aft_m: tankAft, radius_m },
      { id: 'PROPULSION', x_forward_m: tankAft, x_aft_m: base_x_m, radius_m },
    ],
    fins: config.fins === 0 ? null : finGeometry(config, base_x_m),
    engineStation_x_m: base_x_m,
  };
}

/** Usable propellant volume: 92 % of a cylinder with two hemispherical domes. */
export function tankCapacity(config: VehicleConfig): { volume_m3: number; propellant_kg: number; wallArea_m2: number; dryMass_kg: number } {
  assertUsable(config);
  const r = config.stackDiameter_m / 2;
  const cylinder_m = Math.max(0, config.tank.length_m - 2 * r);
  const volume_m3 = TANK_USABLE_FRACTION * (Math.PI * r * r * cylinder_m + (4 / 3) * Math.PI * r ** 3);
  const wallArea_m2 = 2 * Math.PI * r * cylinder_m + 4 * Math.PI * r * r;
  const areal = ENGINE_FAMILIES[config.engine.family].tankWallAreal_kg_m2;
  return {
    volume_m3,
    propellant_kg: volume_m3 * PROPELLANTS[config.tank.propellant].bulkDensity_kg_m3,
    wallArea_m2,
    dryMass_kg: wallArea_m2 * areal,
  };
}

/**
 * Canopy sized so the fully recovered assembly descends at 7 m/s at sea level.
 * Closed form rather than iteration: canopy mass is itself part of the mass the
 * canopy must carry, so `A = C·m_base / (1 − C·k)`.
 */
export function parachuteSizing(config: VehicleConfig): ParachuteSpec {
  assertUsable(config);
  const coefficient = 2 * G0_M_S2 / (SEA_LEVEL_DENSITY_KG_M3 * PARACHUTE_CD * PARACHUTE_DESIGN_DESCENT_M_S ** 2);
  const base_kg = fairingMass(config) + capsuleShellMass(config) + config.payload.mass_kg;
  const denominator = 1 - coefficient * PARACHUTE_CANOPY_AREAL_KG_M2;
  if (denominator <= 0) throw new RangeError('parachute sizing does not converge for this canopy density');
  const area_m2 = coefficient * base_kg / denominator;
  return {
    area_m2,
    cd: PARACHUTE_CD,
    mass_kg: area_m2 * PARACHUTE_CANOPY_AREAL_KG_M2,
    designDescent_m_s: PARACHUTE_DESIGN_DESCENT_M_S,
  };
}

/** Constant roll torque from the documented roll thrusters; fins cannot roll in vacuum. */
export function rollControlAuthority(config: VehicleConfig): number {
  assertUsable(config);
  return ROLL_AUTHORITY_PER_DIAMETER_N_M * config.stackDiameter_m;
}

function fairingMass(config: VehicleConfig): number {
  const r = config.stackDiameter_m / 2;
  const length = FAIRING_FINENESS * config.stackDiameter_m;
  const slant = Math.hypot(r, length);
  return Math.PI * r * slant * SHELL_AREAL_DENSITY_KG_M2;
}

function capsuleShellMass(config: VehicleConfig): number {
  const r = config.stackDiameter_m / 2;
  const length = config.payload.envelope.length_m + CAPSULE_LENGTH_MARGIN_M;
  const area = 2 * Math.PI * r * length + Math.PI * r * r;
  return area * SHELL_AREAL_DENSITY_KG_M2 + AVIONICS_MASS_KG;
}

function finMass(config: VehicleConfig): number {
  return finMassProperties(config)?.totalMass_kg ?? 0;
}

function elements(config: VehicleConfig, stage: VehicleStage, propellant_kg: number): MassElement[] {
  const geometry = vehicleGeometry(config);
  const r = config.stackDiameter_m / 2;
  const section = (id: VehicleSection['id']): VehicleSection => geometry.sections.find((s) => s.id === id)!;
  const fairing = section('FAIRING');
  const capsule = section('CAPSULE');
  const parachute = parachuteSizing(config);
  const capsuleCentre = (capsule.x_forward_m + capsule.x_aft_m) / 2;
  const capsuleLength = capsule.x_forward_m - capsule.x_aft_m;
  const list: MassElement[] = [
    // A conical shell's centroid sits two thirds of the way from the tip.
    { mass_kg: fairingMass(config), x_m: (2 / 3) * fairing.x_aft_m, radius_m: r, length_m: -fairing.x_aft_m },
    { mass_kg: capsuleShellMass(config), x_m: capsuleCentre, radius_m: r, length_m: capsuleLength },
    { mass_kg: parachute.mass_kg, x_m: capsuleCentre, radius_m: r, length_m: capsuleLength },
    { mass_kg: config.payload.mass_kg, x_m: capsuleCentre, radius_m: config.payload.envelope.diameter_m / 2, length_m: config.payload.envelope.length_m },
  ];
  if (stage === 'CAPSULE') return list;

  const ring = section('RING');
  const tank = section('TANK');
  const propulsion = section('PROPULSION');
  const capacity = tankCapacity(config);
  list.push({ mass_kg: RING_MASS_PER_DIAMETER_KG_M * config.stackDiameter_m, x_m: (ring.x_forward_m + ring.x_aft_m) / 2, radius_m: r, length_m: RING_LENGTH_M });
  list.push({ mass_kg: capacity.dryMass_kg, x_m: (tank.x_forward_m + tank.x_aft_m) / 2, radius_m: r, length_m: config.tank.length_m });
  if (propellant_kg > 0) {
    // Propellant is drawn from the bottom, so the remaining column sits against
    // the aft dome and its centroid lowers toward the tank floor as it drains.
    const fill = capacity.propellant_kg > 0 ? Math.min(1, propellant_kg / capacity.propellant_kg) : 0;
    const column_m = fill * config.tank.length_m;
    list.push({ mass_kg: propellant_kg, x_m: tank.x_aft_m + column_m / 2, radius_m: r, length_m: column_m });
  }
  list.push({ mass_kg: engineSpec(config).mass_kg, x_m: (propulsion.x_forward_m + propulsion.x_aft_m) / 2, radius_m: r, length_m: propulsion.x_forward_m - propulsion.x_aft_m });
  const fins = finMassProperties(config);
  if (fins !== null) {
    // Point mass at the planform's area centroid, axially and radially. Half
    // span is NOT the centroid of a tapered fin and overstates the roll inertia.
    list.push({
      mass_kg: fins.totalMass_kg,
      x_m: fins.axialCentroid_x_m,
      radius_m: r,
      length_m: geometry.fins!.rootChord_m,
      offAxisRadius_m: fins.massRadius_m,
    });
  }
  return list;
}

function centreOfMass(list: readonly MassElement[]): { mass_kg: number; com_x_m: number } {
  const mass_kg = list.reduce((sum, element) => sum + element.mass_kg, 0);
  if (mass_kg <= 0) throw new RangeError('stage mass must be positive');
  const moment = list.reduce((sum, element) => sum + element.mass_kg * element.x_m, 0);
  return { mass_kg, com_x_m: moment / mass_kg };
}

/**
 * Diagonal inertia about the stage centre of mass. Each part is approximated as
 * a uniform cylinder on the roll axis, with fins treated as point masses at
 * their area centroid radius; products of inertia are neglected, which the
 * three- and four-fin layouts make reasonable by symmetry.
 */
function inertia(list: readonly MassElement[], com_x_m: number): Vec3 {
  let axial = 0;
  let transverse = 0;
  for (const element of list) {
    const offset = element.x_m - com_x_m;
    if (element.offAxisRadius_m !== undefined) {
      axial += element.mass_kg * element.offAxisRadius_m ** 2;
      transverse += element.mass_kg * (offset ** 2 + element.offAxisRadius_m ** 2 / 2);
      continue;
    }
    axial += element.mass_kg * element.radius_m ** 2 / 2;
    transverse += element.mass_kg * ((3 * element.radius_m ** 2 + element.length_m ** 2) / 12 + offset ** 2);
  }
  return [axial, transverse, transverse];
}

/**
 * Barrowman-style normal-force slope and centre of pressure. The nose cone
 * contributes a fixed slope at two thirds of its length; the cylindrical body
 * contributes nothing; fins carry the interference factor and their swept
 * mid-chord. Fin effects are therefore already inside the centre of pressure,
 * which is why fins are a remedy for a thin static margin and never an
 * exemption from checking it.
 */
function aerodynamics(config: VehicleConfig, stage: VehicleStage): { cnAlpha: number; cp_x_m: number } {
  const geometry = vehicleGeometry(config);
  const fairing = geometry.sections.find((s) => s.id === 'FAIRING')!;
  const noseCp_x_m = (2 / 3) * fairing.x_aft_m;
  const fins = geometry.fins;
  if (stage === 'CAPSULE' || fins === null) return { cnAlpha: NOSE_CN_ALPHA, cp_x_m: noseCp_x_m };
  const d = config.stackDiameter_m;
  const r = d / 2;
  const s = fins.semiSpan_m;
  const cr = fins.rootChord_m;
  const ct = fins.tipChord_m;
  // Barrowman's centre-of-pressure term takes the LEADING-edge sweep, while the
  // normal-force denominator takes the MID-chord line length. Under
  // FIN_PLANFORM_CONVENTION the mid-chord line is unswept, so that length is the
  // semispan; computing it from the stated convention keeps the two consistent.
  const leadingEdgeSweep = fins.leadingEdgeSweep_m;
  const midChordSweep = leadingEdgeSweep - (cr - ct) / 2;
  const midChordLength = Math.hypot(s, midChordSweep);
  const interference = 1 + r / (s + r);
  const cnFins = interference * (4 * fins.count * (s / d) ** 2)
    / (1 + Math.sqrt(1 + (2 * midChordLength / (cr + ct)) ** 2));
  const finCp_x_m = fins.rootLeadingEdge_x_m
    - (leadingEdgeSweep * (cr + 2 * ct) / (3 * (cr + ct)) + ((cr + ct) - cr * ct / (cr + ct)) / 6);
  const cnAlpha = NOSE_CN_ALPHA + cnFins;
  return { cnAlpha, cp_x_m: (NOSE_CN_ALPHA * noseCp_x_m + cnFins * finCp_x_m) / cnAlpha };
}

/**
 * Mass, centre of mass, inertia and aerodynamic reference data for one stage at
 * a given propellant load. This is the only source of those quantities; the
 * renderer and the planner read it too.
 */
export function stageProperties(config: VehicleConfig, stage: VehicleStage, propellant_kg: number): StageProperties {
  assertUsable(config);
  requireFinite(propellant_kg, 'propellant mass');
  if (propellant_kg < 0) throw new RangeError('propellant mass must be non-negative');
  const load = stage === 'CAPSULE' ? 0 : propellant_kg;
  const list = elements(config, stage, load);
  const { mass_kg, com_x_m } = centreOfMass(list);
  const parachute = parachuteSizing(config);
  const geometry = vehicleGeometry(config);
  const { cnAlpha, cp_x_m } = aerodynamics(config, stage);
  const recoveredAssembly_kg = fairingMass(config) + capsuleShellMass(config) + parachute.mass_kg;
  return {
    stage,
    mass_kg,
    com_x_m,
    inertia_kg_m2: inertia(list, com_x_m),
    propellant_kg: load,
    dry_kg: mass_kg - load,
    recoveredAssembly_kg,
    cargo_kg: config.payload.mass_kg,
    sRef_m2: Math.PI * (config.stackDiameter_m / 2) ** 2,
    cdTable: CD_TABLE,
    cnAlpha,
    cp_x_m,
    engineStation_x_m: stage === 'STACK' ? geometry.engineStation_x_m : null,
    parachute,
  };
}

/** Static margin in calibres; positive means the centre of pressure is aft of the centre of mass. */
export function staticMargin(config: VehicleConfig, propellant_kg: number): number {
  const stack = stageProperties(config, 'STACK', propellant_kg);
  return (stack.com_x_m - stack.cp_x_m) / config.stackDiameter_m;
}

/** Sea-level thrust-to-weight at liftoff, including nozzle back-pressure losses. */
export function liftoffThrustToWeight(config: VehicleConfig): number {
  const engine = engineSpec(config);
  const stack = stageProperties(config, 'STACK', tankCapacity(config).propellant_kg);
  const seaLevelThrust_N = Math.max(0, engine.thrustVacuum_N - SEA_LEVEL_PRESSURE_PA * engine.exitArea_m2);
  return seaLevelThrust_N / (stack.mass_kg * G0_M_S2);
}

const nearlyMultipleOf = (value: number, step: number): boolean =>
  Math.abs(value / step - Math.round(value / step)) < 1e-6;

/**
 * Product rules, each with one plain-language message naming the control that
 * fixes it. Only an unusable configuration or an inadequate thrust-to-weight is
 * an error; a thin static margin is a warning, because flying a marginal design
 * and seeing what happens is the lesson, not a thing to forbid.
 */
export function validateVehicleConfig(config: VehicleConfig): VehicleValidation {
  const errors: VehicleIssue[] = [];
  const warnings: VehicleIssue[] = [];
  const push = (list: VehicleIssue[], code: string, message: string, control: string): void => {
    list.push({ code, message, control });
  };
  try {
    assertUsable(config);
  } catch (error) {
    push(errors, 'UNUSABLE', error instanceof Error ? error.message : 'vehicle configuration is unusable', 'designer');
    return { errors, warnings };
  }
  const d = config.stackDiameter_m;
  if (d < STACK_DIAMETER_RANGE_M.min || d > STACK_DIAMETER_RANGE_M.max) {
    push(errors, 'DIAMETER_RANGE', `The stack diameter must be between ${STACK_DIAMETER_RANGE_M.min} m and ${STACK_DIAMETER_RANGE_M.max} m.`, 'stack diameter');
  }
  if (!nearlyMultipleOf(d, STACK_DIAMETER_STEP_M)) {
    push(errors, 'DIAMETER_STEP', `The stack diameter comes in ${STACK_DIAMETER_STEP_M} m steps.`, 'stack diameter');
  }
  if (!nearlyMultipleOf(config.tank.length_m, TANK_LENGTH_STEP_M)) {
    push(errors, 'TANK_LENGTH_STEP', `The fuel section comes in ${TANK_LENGTH_STEP_M} m steps.`, 'tank length');
  }
  const aspect = config.tank.length_m / d;
  if (aspect < TANK_ASPECT_RATIO_RANGE.min || aspect > TANK_ASPECT_RATIO_RANGE.max) {
    push(errors, 'TANK_ASPECT', `The fuel section must be between ${TANK_ASPECT_RATIO_RANGE.min} and ${TANK_ASPECT_RATIO_RANGE.max} times the stack diameter; this one is ${aspect.toFixed(2)}.`, 'tank length');
  }
  const engine = engineSpec(config);
  if (d < engine.minStackDiameter_m - 1e-9) {
    push(errors, 'ENGINE_FIT', `Engine family ${ENGINE_FAMILIES[config.engine.family].label} needs a stack at least ${engine.minStackDiameter_m} m across.`, 'engine family');
  }
  if (config.payload.envelope.diameter_m > d + 1e-9) {
    push(errors, 'ENVELOPE_FIT', `The cargo is ${config.payload.envelope.diameter_m} m across and will not fit a ${d} m stack.`, 'stack diameter');
  }
  if (errors.length > 0) return { errors, warnings };

  const twr = liftoffThrustToWeight(config);
  if (twr < MIN_LIFTOFF_THRUST_TO_WEIGHT) {
    push(errors, 'LIFTOFF_THRUST', `This rocket cannot lift itself: thrust is ${twr.toFixed(2)} times its weight, and it needs at least ${MIN_LIFTOFF_THRUST_TO_WEIGHT}.`, 'engine family');
  }
  const capacity = tankCapacity(config);
  const marginLiftoff = staticMargin(config, capacity.propellant_kg);
  const marginBurnout = staticMargin(config, 0);
  const worst = Math.min(marginLiftoff, marginBurnout);
  if (worst < MIN_STATIC_MARGIN_CALIBRES) {
    push(warnings, 'STATIC_MARGIN', `This rocket may fly unsteadily: the centre of pressure is only ${worst.toFixed(2)} calibres behind the centre of mass, and ${MIN_STATIC_MARGIN_CALIBRES} is the comfortable minimum. Larger or more fins would settle it.`, 'fins');
  }
  return { errors, warnings };
}

/**
 * The tested starter: a 0.7 m stack on the 30 kN pressure-fed step, carrying a
 * 100 kg research package. Its numbers are fixed by `vehicle.test.ts` and by the
 * later feasibility test, never adjusted at runtime to flatter a player.
 */
export const STARTER_VEHICLE: VehicleConfig = {
  version: 1,
  stackDiameter_m: 0.7,
  tank: { length_m: 2.75, propellant: 'LOX_RP1' },
  engine: { family: 'A_PRESSURE_FED', thrustStep: 1 },
  fins: 4,
  payload: {
    id: 'research-100',
    mass_kg: 100,
    envelope: { diameter_m: 0.6, length_m: 0.8 },
  },
};
