import { describe, expect, it } from 'vitest';
import {
  CD_TABLE,
  ENGINE_FAMILIES,
  ENGINE_FAMILY_IDS,
  G0_M_S2,
  MIN_LIFTOFF_THRUST_TO_WEIGHT,
  MIN_STATIC_MARGIN_CALIBRES,
  PROPELLANTS,
  PROPELLANT_IDS,
  SEA_LEVEL_DENSITY_KG_M3,
  STARTER_VEHICLE,
  dragCoefficient,
  engineSpec,
  finMassProperties,
  isEngineFamilyId,
  isPropellantId,
  liftoffThrustToWeight,
  parachuteSizing,
  rollControlAuthority,
  staticMargin,
  stageProperties,
  tankCapacity,
  validateVehicleConfig,
  vehicleGeometry,
  type VehicleConfig,
} from './vehicle.js';

const clone = (config: VehicleConfig): VehicleConfig => structuredClone(config);

const withTank = (length_m: number): VehicleConfig => {
  const config = clone(STARTER_VEHICLE);
  config.tank.length_m = length_m;
  return config;
};

describe('procedural vehicle configuration', () => {
  it('accepts the starter with no errors and no warnings', () => {
    const validation = validateVehicleConfig(STARTER_VEHICLE);
    expect(validation.errors).toEqual([]);
    expect(validation.warnings).toEqual([]);
  });

  it('keeps the starter launchable and passively stable at both ends of the burn', () => {
    expect(liftoffThrustToWeight(STARTER_VEHICLE)).toBeGreaterThanOrEqual(MIN_LIFTOFF_THRUST_TO_WEIGHT);
    const capacity = tankCapacity(STARTER_VEHICLE);
    expect(staticMargin(STARTER_VEHICLE, capacity.propellant_kg)).toBeGreaterThanOrEqual(MIN_STATIC_MARGIN_CALIBRES);
    expect(staticMargin(STARTER_VEHICLE, 0)).toBeGreaterThanOrEqual(MIN_STATIC_MARGIN_CALIBRES);
  });

  it('rejects a configuration whose engine cannot lift it, naming the control', () => {
    const config = clone(STARTER_VEHICLE);
    config.engine.thrustStep = 0;
    config.tank.length_m = 5;
    const validation = validateVehicleConfig(config);
    const liftoff = validation.errors.find((issue) => issue.code === 'LIFTOFF_THRUST');
    expect(liftoff).toBeDefined();
    expect(liftoff!.control).toBe('engine family');
    expect(liftoff!.message).toMatch(/cannot lift itself/);
  });

  it('flags a thin static margin as a warning, not an error, and suggests fins', () => {
    const config = clone(STARTER_VEHICLE);
    config.fins = 0;
    const validation = validateVehicleConfig(config);
    expect(validation.errors).toEqual([]);
    const margin = validation.warnings.find((issue) => issue.code === 'STATIC_MARGIN');
    expect(margin).toBeDefined();
    expect(margin!.control).toBe('fins');
    expect(margin!.message).toMatch(/fins/i);
  });

  it('derives stability from the computed margin, so fins are a remedy and never an exemption', () => {
    const withoutFins = clone(STARTER_VEHICLE);
    withoutFins.fins = 0;
    const capacity = tankCapacity(STARTER_VEHICLE);
    // Fins move the centre of pressure aft, which is what raises the margin.
    expect(staticMargin(withoutFins, capacity.propellant_kg))
      .toBeLessThan(staticMargin(STARTER_VEHICLE, capacity.propellant_kg));
    expect(stageProperties(withoutFins, 'STACK', 0).cp_x_m)
      .toBeGreaterThan(stageProperties(STARTER_VEHICLE, 'STACK', 0).cp_x_m);
  });

  it('enforces dimension, fit and step rules with one message each', () => {
    const tooWide = clone(STARTER_VEHICLE);
    tooWide.payload.envelope.diameter_m = 1.2;
    expect(validateVehicleConfig(tooWide).errors.map((issue) => issue.code)).toContain('ENVELOPE_FIT');

    const tooSlim = clone(STARTER_VEHICLE);
    tooSlim.engine.family = 'B_PUMP_FED';
    expect(validateVehicleConfig(tooSlim).errors.map((issue) => issue.code)).toContain('ENGINE_FIT');

    expect(validateVehicleConfig(withTank(0.5)).errors.map((issue) => issue.code)).toContain('TANK_ASPECT');
    expect(validateVehicleConfig(withTank(2.7)).errors.map((issue) => issue.code)).toContain('TANK_LENGTH_STEP');

    const offStep = clone(STARTER_VEHICLE);
    offStep.stackDiameter_m = 0.73;
    expect(validateVehicleConfig(offStep).errors.map((issue) => issue.code)).toContain('DIAMETER_STEP');

    const tooNarrow = clone(STARTER_VEHICLE);
    tooNarrow.stackDiameter_m = 0.3;
    expect(validateVehicleConfig(tooNarrow).errors.map((issue) => issue.code)).toContain('DIAMETER_RANGE');
  });

  it('offers no free thrust, specific impulse or mass input', () => {
    const family = ENGINE_FAMILIES.A_PRESSURE_FED;
    const spec = engineSpec(STARTER_VEHICLE);
    expect(spec.thrustVacuum_N).toBe(family.thrustVacuum_N[1]);
    expect(spec.ispVacuum_s).toBeCloseTo(family.ispVacuum_s * PROPELLANTS.LOX_RP1.ispFactor, 12);
    expect(spec.mass_kg).toBeCloseTo(spec.thrustVacuum_N / (G0_M_S2 * family.engineThrustToWeight), 12);
    // Mass flow is consistent with thrust and specific impulse, not independent.
    expect(spec.massFlow_kg_s).toBeCloseTo(spec.thrustVacuum_N / (spec.ispVacuum_s * G0_M_S2), 12);
  });
});

describe('stage mass accounting on the shared station datum', () => {
  it('conserves mass across stack, capsule and discarded booster', () => {
    const capacity = tankCapacity(STARTER_VEHICLE);
    for (const propellant of [capacity.propellant_kg, capacity.propellant_kg / 2, 0]) {
      const stack = stageProperties(STARTER_VEHICLE, 'STACK', propellant);
      const capsule = stageProperties(STARTER_VEHICLE, 'CAPSULE', propellant);
      const booster = stack.mass_kg - capsule.mass_kg;
      expect(booster).toBeGreaterThan(0);
      expect(capsule.mass_kg + booster).toBeCloseTo(stack.mass_kg, 9);
      // The capsule never carries propellant, whatever the stack is loaded with.
      expect(capsule.propellant_kg).toBe(0);
      expect(stack.propellant_kg).toBe(propellant);
      expect(stack.dry_kg).toBeCloseTo(stack.mass_kg - propellant, 9);
    }
  });

  it('reports cargo and the recovery assembly separately, and only cargo is the contract mass', () => {
    const capsule = stageProperties(STARTER_VEHICLE, 'CAPSULE', 0);
    expect(capsule.cargo_kg).toBe(STARTER_VEHICLE.payload.mass_kg);
    expect(capsule.recoveredAssembly_kg).toBeGreaterThan(0);
    expect(capsule.recoveredAssembly_kg).not.toBe(capsule.cargo_kg);
    // The capsule mass is the cargo plus the player's own recovery hardware.
    expect(capsule.mass_kg).toBeCloseTo(capsule.cargo_kg + capsule.recoveredAssembly_kg, 9);
  });

  it('places every station on one nose-tip datum that separation does not move', () => {
    const geometry = vehicleGeometry(STARTER_VEHICLE);
    expect(geometry.sections[0]!.x_forward_m).toBe(0);
    expect(geometry.base_x_m).toBeLessThan(0);
    expect(geometry.totalLength_m).toBeCloseTo(-geometry.base_x_m, 12);
    // Sections tile the vehicle without gaps or overlap, nose to base.
    geometry.sections.forEach((section, index) => {
      expect(section.x_aft_m).toBeLessThan(section.x_forward_m);
      if (index > 0) expect(section.x_forward_m).toBeCloseTo(geometry.sections[index - 1]!.x_aft_m, 12);
    });

    const capacity = tankCapacity(STARTER_VEHICLE);
    const stack = stageProperties(STARTER_VEHICLE, 'STACK', capacity.propellant_kg);
    const capsule = stageProperties(STARTER_VEHICLE, 'CAPSULE', 0);
    // Both stages report on the same datum, so the offset between them is meaningful.
    for (const properties of [stack, capsule]) {
      expect(properties.com_x_m).toBeLessThan(0);
      expect(properties.com_x_m).toBeGreaterThan(geometry.base_x_m);
    }
    // The capsule sits forward of the loaded stack, giving a positive body +x offset.
    expect(capsule.com_x_m - stack.com_x_m).toBeGreaterThan(0);
    expect(stack.engineStation_x_m).toBe(geometry.base_x_m);
    expect(capsule.engineStation_x_m).toBeNull();
  });

  it('moves the centre of mass aft as the tank drains, then forward once empty', () => {
    const capacity = tankCapacity(STARTER_VEHICLE);
    const full = stageProperties(STARTER_VEHICLE, 'STACK', capacity.propellant_kg).com_x_m;
    const half = stageProperties(STARTER_VEHICLE, 'STACK', capacity.propellant_kg / 2).com_x_m;
    const empty = stageProperties(STARTER_VEHICLE, 'STACK', 0).com_x_m;
    // Draining from the bottom lowers the propellant column's own centroid.
    expect(half).toBeLessThan(full);
    // With the propellant gone entirely, the dry stack's centre sits forward again.
    expect(empty).toBeGreaterThan(half);
  });

  it('gives positive diagonal inertia about each stage own centre of mass', () => {
    const capacity = tankCapacity(STARTER_VEHICLE);
    const stack = stageProperties(STARTER_VEHICLE, 'STACK', capacity.propellant_kg);
    stack.inertia_kg_m2.forEach((value) => expect(value).toBeGreaterThan(0));
    // A long thin rocket has far more transverse than axial inertia.
    expect(stack.inertia_kg_m2[1]).toBeGreaterThan(stack.inertia_kg_m2[0] * 10);
    expect(stack.inertia_kg_m2[1]).toBeCloseTo(stack.inertia_kg_m2[2], 12);
    const capsule = stageProperties(STARTER_VEHICLE, 'CAPSULE', 0);
    expect(capsule.inertia_kg_m2[1]).toBeLessThan(stack.inertia_kg_m2[1]);
  });

  it('gives the capsule nose-only aerodynamics and the stack fin-shifted aerodynamics', () => {
    const stack = stageProperties(STARTER_VEHICLE, 'STACK', 0);
    const capsule = stageProperties(STARTER_VEHICLE, 'CAPSULE', 0);
    expect(capsule.cnAlpha).toBeCloseTo(2, 12);
    expect(stack.cnAlpha).toBeGreaterThan(capsule.cnAlpha);
    // Fins drag the stack's centre of pressure aft of the bare nose value.
    expect(stack.cp_x_m).toBeLessThan(capsule.cp_x_m);
    expect(stack.sRef_m2).toBeCloseTo(Math.PI * (STARTER_VEHICLE.stackDiameter_m / 2) ** 2, 12);
    expect(stack.cdTable).toBe(CD_TABLE);
  });
});

describe('derived subsystems', () => {
  it('sizes the canopy for its declared sea-level descent speed, including its own mass', () => {
    const parachute = parachuteSizing(STARTER_VEHICLE);
    const capsule = stageProperties(STARTER_VEHICLE, 'CAPSULE', 0);
    const terminal = Math.sqrt(
      2 * capsule.mass_kg * G0_M_S2 / (SEA_LEVEL_DENSITY_KG_M3 * parachute.cd * parachute.area_m2),
    );
    expect(terminal).toBeCloseTo(parachute.designDescent_m_s, 6);
    expect(parachute.mass_kg).toBeGreaterThan(0);
  });

  it('scales the canopy with the mass it must carry', () => {
    const heavy = clone(STARTER_VEHICLE);
    heavy.payload.mass_kg = 200;
    expect(parachuteSizing(heavy).area_m2).toBeGreaterThan(parachuteSizing(STARTER_VEHICLE).area_m2);
  });

  it('derives tank capacity, wall area and dry mass from one geometry', () => {
    const capacity = tankCapacity(STARTER_VEHICLE);
    expect(capacity.propellant_kg).toBeCloseTo(
      capacity.volume_m3 * PROPELLANTS[STARTER_VEHICLE.tank.propellant].bulkDensity_kg_m3, 9);
    expect(capacity.dryMass_kg).toBeCloseTo(
      capacity.wallArea_m2 * ENGINE_FAMILIES[STARTER_VEHICLE.engine.family].tankWallAreal_kg_m2, 9);
    // A longer tank holds more and weighs more; the tradeoff is real.
    const longer = tankCapacity(withTank(3.5));
    expect(longer.propellant_kg).toBeGreaterThan(capacity.propellant_kg);
    expect(longer.dryMass_kg).toBeGreaterThan(capacity.dryMass_kg);
  });

  it('makes the propellant choice change capacity through bulk density alone', () => {
    const methane = clone(STARTER_VEHICLE);
    methane.tank.propellant = 'LOX_CH4';
    const dense = tankCapacity(STARTER_VEHICLE);
    const light = tankCapacity(methane);
    expect(light.volume_m3).toBeCloseTo(dense.volume_m3, 12);
    expect(light.propellant_kg).toBeLessThan(dense.propellant_kg);
    // Methane buys back a little specific impulse for that lost mass.
    expect(engineSpec(methane).ispVacuum_s).toBeGreaterThan(engineSpec(STARTER_VEHICLE).ispVacuum_s);
  });

  it('interpolates the drag table and clamps outside it', () => {
    expect(dragCoefficient(0)).toBeCloseTo(0.3, 12);
    expect(dragCoefficient(0.5)).toBeCloseTo(0.3, 12);
    expect(dragCoefficient(1.05)).toBeCloseTo(0.6, 12);
    expect(dragCoefficient(9)).toBeCloseTo(0.35, 12);
    expect(dragCoefficient(-2)).toBeCloseTo(dragCoefficient(2), 12);
    // The transonic peak really is a peak.
    expect(dragCoefficient(1.05)).toBeGreaterThan(dragCoefficient(0.8));
    expect(dragCoefficient(1.05)).toBeGreaterThan(dragCoefficient(2));
  });

  it('gives a roll authority that scales with the vehicle rather than a free slider', () => {
    expect(rollControlAuthority(STARTER_VEHICLE)).toBeGreaterThan(0);
    const wide = clone(STARTER_VEHICLE);
    wide.stackDiameter_m = 1.4;
    expect(rollControlAuthority(wide)).toBeGreaterThan(rollControlAuthority(STARTER_VEHICLE));
  });

  it('rejects structurally unusable input rather than returning nonsense', () => {
    const broken = clone(STARTER_VEHICLE);
    broken.payload.mass_kg = 0;
    expect(() => stageProperties(broken, 'STACK', 0)).toThrow(RangeError);
    expect(() => stageProperties(STARTER_VEHICLE, 'STACK', -1)).toThrow(RangeError);
    expect(() => stageProperties(STARTER_VEHICLE, 'STACK', Number.NaN)).toThrow(RangeError);
    expect(validateVehicleConfig(broken).errors.map((issue) => issue.code)).toContain('UNUSABLE');
  });
});

/**
 * A configuration arriving from `JSON.parse` is plain data, so the TypeScript
 * union guarantees nothing here. `in` would have accepted inherited names and
 * handed back a prototype member as a family.
 */
describe('family keys survive a JSON round trip', () => {
  const INHERITED = ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty'] as const;
  const serialized = (): VehicleConfig => JSON.parse(JSON.stringify(STARTER_VEHICLE)) as VehicleConfig;

  it('recognises only the declared propellant and engine family keys', () => {
    expect(PROPELLANT_IDS.every(isPropellantId)).toBe(true);
    expect(ENGINE_FAMILY_IDS.every(isEngineFamilyId)).toBe(true);
    for (const name of INHERITED) {
      expect(isPropellantId(name)).toBe(false);
      expect(isEngineFamilyId(name)).toBe(false);
    }
    for (const value of ['INVALID', '', 0, null, undefined, {}]) {
      expect(isPropellantId(value)).toBe(false);
      expect(isEngineFamilyId(value)).toBe(false);
    }
  });

  it('rejects an inherited propellant name structurally, with no NaN specification', () => {
    for (const name of INHERITED) {
      const config = serialized();
      (config.tank as { propellant: string }).propellant = name;
      // Derivation refuses deliberately, before any arithmetic.
      expect(() => engineSpec(config)).toThrow(RangeError);
      expect(() => tankCapacity(config)).toThrow(RangeError);
      expect(() => stageProperties(config, 'STACK', 0)).toThrow(RangeError);
      // Validation stays structured rather than throwing out of the guarded path.
      const validation = validateVehicleConfig(config);
      expect(validation.errors.map((issue) => issue.code)).toContain('UNUSABLE');
      expect(validation.errors[0]!.message).toContain(name);
    }
  });

  it('rejects an inherited engine family name structurally, with no stray TypeError', () => {
    for (const name of INHERITED) {
      const config = serialized();
      (config.engine as { family: string }).family = name;
      expect(() => engineSpec(config)).toThrow(RangeError);
      expect(() => liftoffThrustToWeight(config)).toThrow(RangeError);
      const validation = validateVehicleConfig(config);
      expect(validation.errors.map((issue) => issue.code)).toContain('UNUSABLE');
      expect(validation.warnings).toEqual([]);
    }
  });

  it('treats an ordinary unknown name exactly like an inherited one', () => {
    const unknown = serialized();
    (unknown.tank as { propellant: string }).propellant = 'INVALID';
    const inherited = serialized();
    (inherited.tank as { propellant: string }).propellant = 'toString';
    expect(validateVehicleConfig(unknown).errors.map((issue) => issue.code))
      .toEqual(validateVehicleConfig(inherited).errors.map((issue) => issue.code));
  });

  it('round-trips a valid configuration through JSON unchanged', () => {
    const config = serialized();
    expect(validateVehicleConfig(config).errors).toEqual([]);
    expect(stageProperties(config, 'STACK', 0).mass_kg)
      .toBeCloseTo(stageProperties(STARTER_VEHICLE, 'STACK', 0).mass_kg, 12);
  });
});

/**
 * The declared approximation is a point mass at the planform's AREA CENTROID.
 * A tapered fin's centroid is not at half span, and positivity or `Iyy === Izz`
 * cannot catch the difference.
 */
describe('fin mass properties follow the declared planform', () => {
  const finsOf = (config: VehicleConfig) => {
    const properties = finMassProperties(config);
    expect(properties).not.toBeNull();
    return properties!;
  };

  /** Independent numeric integration of the trapezoidal planform. */
  function integratedCentroidSpan(semiSpan: number, rootChord: number, tipChord: number): number {
    const steps = 200_000;
    let area = 0;
    let moment = 0;
    for (let i = 0; i < steps; i++) {
      const y = semiSpan * (i + 0.5) / steps;
      const chord = rootChord + (tipChord - rootChord) * (y / semiSpan);
      area += chord;
      moment += y * chord;
    }
    return moment / area;
  }

  it('matches an independently integrated area centroid, not half span', () => {
    const geometry = vehicleGeometry(STARTER_VEHICLE).fins!;
    const fins = finsOf(STARTER_VEHICLE);
    const integrated = integratedCentroidSpan(geometry.semiSpan_m, geometry.rootChord_m, geometry.tipChord_m);
    expect(fins.areaCentroidSpan_m).toBeCloseTo(integrated, 6);
    // The tapered planform's centroid sits inboard of half span.
    expect(fins.areaCentroidSpan_m).toBeLessThan(geometry.semiSpan_m / 2);
    expect(fins.massRadius_m).toBeCloseTo(STARTER_VEHICLE.stackDiameter_m / 2 + integrated, 6);
  });

  it('places the axial centroid per the centred-tip convention', () => {
    const geometry = vehicleGeometry(STARTER_VEHICLE).fins!;
    const fins = finsOf(STARTER_VEHICLE);
    expect(geometry.leadingEdgeSweep_m).toBeCloseTo((geometry.rootChord_m - geometry.tipChord_m) / 2, 12);
    // For this convention the general tapered result reduces to the root midpoint.
    expect(fins.axialCentroid_x_m)
      .toBeCloseTo(geometry.rootLeadingEdge_x_m - geometry.rootChord_m / 2, 9);
    // It lies within the root chord, aft of the leading edge.
    expect(fins.axialCentroid_x_m).toBeLessThan(geometry.rootLeadingEdge_x_m);
    expect(fins.axialCentroid_x_m).toBeGreaterThan(geometry.rootLeadingEdge_x_m - geometry.rootChord_m);
  });

  it('contributes exactly mass times centroid radius squared to axial inertia', () => {
    // Axial inertia about the roll axis does not depend on the centre of mass,
    // so differencing isolates the fin contribution cleanly.
    for (const count of [3, 4] as const) {
      const withFins = clone(STARTER_VEHICLE);
      withFins.fins = count;
      const bare = clone(STARTER_VEHICLE);
      bare.fins = 0;
      const fins = finsOf(withFins);
      const loaded = tankCapacity(withFins).propellant_kg;
      const contribution = stageProperties(withFins, 'STACK', loaded).inertia_kg_m2[0]
        - stageProperties(bare, 'STACK', loaded).inertia_kg_m2[0];
      expect(contribution).toBeCloseTo(fins.totalMass_kg * fins.massRadius_m ** 2, 9);
      // Half span would overstate this by about a quarter.
      const halfSpanRadius = withFins.stackDiameter_m / 2 + vehicleGeometry(withFins).fins!.semiSpan_m / 2;
      expect(fins.totalMass_kg * halfSpanRadius ** 2).toBeGreaterThan(contribution * 1.2);
    }
  });

  it('satisfies the parallel-axis relation about the active centre of mass', () => {
    const bare = clone(STARTER_VEHICLE);
    bare.fins = 0;
    const loaded = tankCapacity(STARTER_VEHICLE).propellant_kg;
    const withFins = stageProperties(STARTER_VEHICLE, 'STACK', loaded);
    const without = stageProperties(bare, 'STACK', loaded);
    const fins = finsOf(STARTER_VEHICLE);

    // Adding the fins moves the centre of mass, so the remaining parts must be
    // re-referenced by parallel axis before the fin term is added.
    const shift = withFins.com_x_m - without.com_x_m;
    const restTransverse = without.inertia_kg_m2[1] + without.mass_kg * shift ** 2;
    const finOffset = fins.axialCentroid_x_m - withFins.com_x_m;
    const finTransverse = fins.totalMass_kg * (finOffset ** 2 + fins.massRadius_m ** 2 / 2);
    expect(withFins.inertia_kg_m2[1]).toBeCloseTo(restTransverse + finTransverse, 6);
    expect(withFins.mass_kg).toBeCloseTo(without.mass_kg + fins.totalMass_kg, 9);
  });

  it('reports no fin properties when the design has none', () => {
    const bare = clone(STARTER_VEHICLE);
    bare.fins = 0;
    expect(finMassProperties(bare)).toBeNull();
    expect(vehicleGeometry(bare).fins).toBeNull();
  });
});

/**
 * Recomputed starter figures after the mass-property correction, printed so the
 * reviewer can compare them against the pre-correction values, plus the
 * mid-burn caveat: the approved rule checks liftoff and burnout only, so "no
 * warnings" is not a whole-burn stability proof.
 */
describe('starter summary and mid-burn stability caveat', () => {
  it('reports its derived figures and the worst margin across the burn', () => {
    const capacity = tankCapacity(STARTER_VEHICLE);
    const loaded = stageProperties(STARTER_VEHICLE, 'STACK', capacity.propellant_kg);
    const dry = stageProperties(STARTER_VEHICLE, 'STACK', 0);
    const capsule = stageProperties(STARTER_VEHICLE, 'CAPSULE', 0);
    const fins = finMassProperties(STARTER_VEHICLE)!;

    let worst = Number.POSITIVE_INFINITY;
    let worstFill = 0;
    const samples = 1000;
    for (let i = 0; i <= samples; i++) {
      const fill = i / samples;
      const margin = staticMargin(STARTER_VEHICLE, capacity.propellant_kg * fill);
      if (margin < worst) {
        worst = margin;
        worstFill = fill;
      }
    }

    // eslint-disable-next-line no-console
    console.log([
      `starter loaded mass ${loaded.mass_kg.toFixed(7)} kg`,
      `dry stack ${dry.mass_kg.toFixed(7)} kg`,
      `capsule ${capsule.mass_kg.toFixed(7)} kg (cargo ${capsule.cargo_kg} + recovery ${capsule.recoveredAssembly_kg.toFixed(7)})`,
      `propellant ${capacity.propellant_kg.toFixed(7)} kg`,
      `sea-level TWR ${liftoffThrustToWeight(STARTER_VEHICLE).toFixed(8)}`,
      `CP ${loaded.cp_x_m.toFixed(9)} m`,
      `loaded CoM ${loaded.com_x_m.toFixed(9)} m`,
      `liftoff margin ${staticMargin(STARTER_VEHICLE, capacity.propellant_kg).toFixed(8)} cal`,
      `burnout margin ${staticMargin(STARTER_VEHICLE, 0).toFixed(8)} cal`,
      `fin mass ${fins.totalMass_kg.toFixed(7)} kg at radius ${fins.massRadius_m.toFixed(10)} m`,
      `fin Ixx contribution ${(fins.totalMass_kg * fins.massRadius_m ** 2).toFixed(10)} kg m^2`,
      `minimum margin ${worst.toFixed(8)} cal at ${(worstFill * 100).toFixed(1)}% fill`,
    ].join('\n  '));

    expect(loaded.mass_kg).toBeGreaterThan(0);
    // The approved rule checks the two ends only; the interior can dip below it.
    expect(staticMargin(STARTER_VEHICLE, capacity.propellant_kg)).toBeGreaterThanOrEqual(1);
    expect(staticMargin(STARTER_VEHICLE, 0)).toBeGreaterThanOrEqual(1);
    expect(worst).toBeLessThan(1);
    expect(worst).toBeGreaterThan(0);
    expect(worstFill).toBeGreaterThan(0);
    expect(worstFill).toBeLessThan(1);
  });
});
