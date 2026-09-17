import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AIR_GAS_CONSTANT_J_KG_K,
  AIR_HEAT_CAPACITY_RATIO,
  ASCENT_DT_S,
  ASCENT_TIMEOUT_S,
  MAX_GIMBAL_RAD,
  ATMOSPHERE_CUTOFF_RATIO,
  ATMOSPHERE_LAYER_TOP_M,
  ATMOSPHERE_TOP_M,
  CHUTE_MAX_DEPLOY_Q_PA,
  DEFAULT_PAD_ALTITUDE_MSL_M,
  NEUTRAL_CONTROLS,
  RECOVERY_SPEED_LIMIT_M_S,
  STANDARD_GRAVITY_M_S2,
  STILL_AIR_ASCENT,
  UPPER_SCALE_HEIGHT_M,
  VACUUM_ASCENT,
  ambientAtmosphere,
  ascentInstruments,
  attitudeFor,
  contactProxies,
  createAscentState,
  lowestContactDepth_m,
  geopotentialAltitude,
  groundClearance_m,
  isTerminal,
  launchAltitudeToMsl,
  padAttitude,
  standardAtmosphere,
  stepAscent,
  type AscentControls,
  type AscentState,
} from './ascent.js';
import { conjugateQuaternion, rotateVector } from './attitude.js';
import { STARTER_VEHICLE, engineSpec, stageProperties, tankCapacity, vehicleGeometry, type VehicleConfig } from './vehicle.js';
import type { Vec3 } from './types.js';

/**
 * Published US Standard Atmosphere 1976 layer boundaries. `geometric_m` is the
 * geometric altitude of each geopotential layer base, which is what the public
 * function takes. These are independent physical anchors: they are not derived
 * from the implementation.
 */
const LAYER_BOUNDARIES = [
  { geometric_m: 0, temperature_K: 288.15, pressure_Pa: 101325, density_kg_m3: 1.2250 },
  { geometric_m: 11_019.1, temperature_K: 216.65, pressure_Pa: 22632.06, density_kg_m3: 0.363918 },
  { geometric_m: 20_063.1, temperature_K: 216.65, pressure_Pa: 5474.889, density_kg_m3: 0.0880349 },
  { geometric_m: 32_161.9, temperature_K: 228.65, pressure_Pa: 868.0187, density_kg_m3: 0.0132250 },
  { geometric_m: 47_350.4, temperature_K: 270.65, pressure_Pa: 110.9063, density_kg_m3: 0.00142753 },
  { geometric_m: 51_412.5, temperature_K: 270.65, pressure_Pa: 66.93887, density_kg_m3: 0.000861604 },
  { geometric_m: 71_802.0, temperature_K: 214.65, pressure_Pa: 3.956420, density_kg_m3: 0.0000642110 },
  { geometric_m: 86_000, temperature_K: 186.946, pressure_Pa: 0.3733834, density_kg_m3: 0.000006957517 },
] as const;

const relativeError = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);

describe('standard atmosphere', () => {
  it('matches the published layer boundaries within 1 percent', () => {
    for (const boundary of LAYER_BOUNDARIES) {
      const air = standardAtmosphere(boundary.geometric_m);
      expect(relativeError(air.temperature_K, boundary.temperature_K)).toBeLessThan(0.01);
      expect(relativeError(air.pressure_Pa, boundary.pressure_Pa)).toBeLessThan(0.01);
      expect(relativeError(air.density_kg_m3, boundary.density_kg_m3)).toBeLessThan(0.01);
    }
  });

  it('returns all four fields consistently, with sound speed from temperature', () => {
    for (const altitude of [0, 5_000, 30_000, 86_000, 120_000, 250_000]) {
      const air = standardAtmosphere(altitude);
      expect(air.temperature_K).toBeGreaterThan(0);
      expect(air.soundSpeed_m_s).toBeCloseTo(
        Math.sqrt(AIR_HEAT_CAPACITY_RATIO * AIR_GAS_CONSTANT_J_KG_K * air.temperature_K), 9);
      // Density and pressure agree with the ideal gas law wherever there is air.
      if (air.pressure_Pa > 0) {
        expect(air.density_kg_m3).toBeCloseTo(air.pressure_Pa / (AIR_GAS_CONSTANT_J_KG_K * air.temperature_K), 12);
      }
    }
  });

  it('is continuous in all four fields across the 86 km layer top', () => {
    const below = standardAtmosphere(ATMOSPHERE_LAYER_TOP_M - 0.001);
    const at = standardAtmosphere(ATMOSPHERE_LAYER_TOP_M);
    const above = standardAtmosphere(ATMOSPHERE_LAYER_TOP_M + 0.001);
    for (const field of ['density_kg_m3', 'pressure_Pa', 'temperature_K', 'soundSpeed_m_s'] as const) {
      expect(relativeError(at[field], below[field])).toBeLessThan(1e-6);
      expect(relativeError(above[field], at[field])).toBeLessThan(1e-6);
    }
  });

  it('continues exponentially up to and including exactly 200 km', () => {
    const top = standardAtmosphere(ATMOSPHERE_LAYER_TOP_M);
    const cutoff = standardAtmosphere(ATMOSPHERE_TOP_M);
    expect(cutoff.pressure_Pa).toBeGreaterThan(0);
    expect(cutoff.density_kg_m3).toBeGreaterThan(0);
    expect(relativeError(cutoff.pressure_Pa, top.pressure_Pa * ATMOSPHERE_CUTOFF_RATIO)).toBeLessThan(1e-9);
    const midway = standardAtmosphere(120_000);
    expect(relativeError(
      midway.pressure_Pa,
      top.pressure_Pa * Math.exp(-(120_000 - ATMOSPHERE_LAYER_TOP_M) / UPPER_SCALE_HEIGHT_M),
    )).toBeLessThan(1e-9);
  });

  it('reports an exact hard vacuum strictly above 200 km, with a declared bounded jump', () => {
    const cutoff = standardAtmosphere(ATMOSPHERE_TOP_M);
    const above = standardAtmosphere(ATMOSPHERE_TOP_M + 1e-6);
    expect(above.pressure_Pa).toBe(0);
    expect(above.density_kg_m3).toBe(0);
    expect(standardAtmosphere(400_000).pressure_Pa).toBe(0);
    expect(standardAtmosphere(400_000).density_kg_m3).toBe(0);

    // Temperature and sound speed remain continuous across the cutoff.
    expect(above.temperature_K).toBeCloseTo(cutoff.temperature_K, 12);
    expect(above.soundSpeed_m_s).toBeCloseTo(cutoff.soundSpeed_m_s, 12);

    // The jump is intentional; it is bounded by the module's own 86 km values,
    // not by a hard-coded pascal figure.
    const top = standardAtmosphere(ATMOSPHERE_LAYER_TOP_M);
    expect(ATMOSPHERE_CUTOFF_RATIO).toBeCloseTo(8.456762847378328e-8, 20);
    expect(cutoff.pressure_Pa).toBeLessThanOrEqual(top.pressure_Pa * ATMOSPHERE_CUTOFF_RATIO * (1 + 1e-9));
    expect(cutoff.density_kg_m3).toBeLessThanOrEqual(top.density_kg_m3 * ATMOSPHERE_CUTOFF_RATIO * (1 + 1e-9));
  });

  it('decreases monotonically in pressure and density through the whole profile', () => {
    let previous = standardAtmosphere(0);
    for (let altitude = 500; altitude <= 220_000; altitude += 500) {
      const air = standardAtmosphere(altitude);
      expect(air.pressure_Pa).toBeLessThanOrEqual(previous.pressure_Pa);
      expect(air.density_kg_m3).toBeLessThanOrEqual(previous.density_kg_m3);
      previous = air;
    }
  });

  it('clamps below sea level and rejects non-finite input', () => {
    expect(standardAtmosphere(-50)).toEqual(standardAtmosphere(0));
    expect(() => standardAtmosphere(Number.NaN)).toThrow(RangeError);
    expect(() => standardAtmosphere(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('launch altitude datum', () => {
  it('adds the pad elevation to launch-local height before any lookup', () => {
    // On the pad, launch-local down is zero and the air is the pad's, not sea level's.
    expect(launchAltitudeToMsl(0)).toBe(DEFAULT_PAD_ALTITUDE_MSL_M);
    expect(launchAltitudeToMsl(-1_000)).toBe(DEFAULT_PAD_ALTITUDE_MSL_M + 1_000);
    expect(launchAltitudeToMsl(0, 0)).toBe(0);

    const padAir = standardAtmosphere(launchAltitudeToMsl(0));
    const seaLevelAir = standardAtmosphere(0);
    expect(padAir.pressure_Pa).toBeLessThan(seaLevelAir.pressure_Pa);
    // A 105 m datum error is roughly 1.2 percent of pressure: it does not cancel.
    expect(relativeError(padAir.pressure_Pa, seaLevelAir.pressure_Pa)).toBeGreaterThan(0.01);
  });

  it('uses geopotential altitude internally, which differs from geometric with height', () => {
    expect(geopotentialAltitude(0)).toBe(0);
    expect(geopotentialAltitude(11_019.1)).toBeCloseTo(11_000, 0);
    expect(geopotentialAltitude(86_000)).toBeLessThan(86_000);
  });
});

describe('ascent environment', () => {
  it('scales aerodynamic density only, leaving ambient pressure intact', () => {
    const altitude = launchAltitudeToMsl(0);
    const full = standardAtmosphere(altitude);
    const scaled = ambientAtmosphere(altitude, { densityScale: 0.5, wind_N_m_s: [0, 0, 0] });
    expect(scaled.density_kg_m3).toBeCloseTo(full.density_kg_m3 * 0.5, 12);
    expect(scaled.pressure_Pa).toBeCloseTo(full.pressure_Pa, 12);
    expect(scaled.temperature_K).toBeCloseTo(full.temperature_K, 12);
  });

  it('removes density AND back-pressure under the vacuum option', () => {
    const altitude = launchAltitudeToMsl(0);
    const vacuum = ambientAtmosphere(altitude, VACUUM_ASCENT);
    expect(vacuum.density_kg_m3).toBe(0);
    expect(vacuum.pressure_Pa).toBe(0);
    // Air properties are not a knob: temperature and sound speed survive.
    expect(vacuum.temperature_K).toBeCloseTo(standardAtmosphere(altitude).temperature_K, 12);

    // A density-only zero is NOT a vacuum burn: back-pressure would still bite.
    const densityOnly = ambientAtmosphere(altitude, { densityScale: 0, wind_N_m_s: [0, 0, 0] });
    expect(densityOnly.density_kg_m3).toBe(0);
    expect(densityOnly.pressure_Pa).toBeGreaterThan(100_000);
  });

  it('defaults to still air at full density and rejects a negative scale', () => {
    const altitude = 1_000;
    expect(ambientAtmosphere(altitude)).toEqual(standardAtmosphere(altitude));
    expect(ambientAtmosphere(altitude, STILL_AIR_ASCENT).density_kg_m3)
      .toBeCloseTo(standardAtmosphere(altitude).density_kg_m3, 12);
    expect(() => ambientAtmosphere(altitude, { densityScale: -1, wind_N_m_s: [0, 0, 0] })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Phase 1b — step, events, latch, separation, instruments
// ---------------------------------------------------------------------------

const clone = (config: VehicleConfig): VehicleConfig => structuredClone(config);
const controls = (overrides: Partial<AscentControls> = {}): AscentControls => ({ ...NEUTRAL_CONTROLS, ...overrides });
const expectVec = (actual: Vec3, expected: Vec3, precision = 9): void =>
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, precision));

/** Zero gravity and true vacuum, for closed-form oracles. */
const OracleVacuum = { densityScale: 0, vacuum: true, wind_N_m_s: [0, 0, 0] as Vec3, constantGravity_m_s2: 0 };

function run(
  state: AscentState,
  config: VehicleConfig,
  command: (state: AscentState, index: number) => AscentControls,
  environment = STILL_AIR_ASCENT,
  maxSteps = 200_000,
): AscentState {
  let current = state;
  for (let i = 0; i < maxSteps && !isTerminal(current.status); i++) {
    current = stepAscent(current, command(current, i), config, environment);
  }
  return current;
}

describe('pad initialisation and attitude', () => {
  it('starts vertical on the pad with its centre of mass above the ground', () => {
    const state = createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 });
    expect(state.status).toBe('PAD');
    expect(state.engine).toBe('OFF');
    expect(state.prop_kg).toBeCloseTo(tankCapacity(STARTER_VEHICLE).propellant_kg, 9);
    expect(-state.position_N_m[2]).toBeCloseTo(groundClearance_m(STARTER_VEHICLE, 'STACK', state.prop_kg), 9);
    // Body forward is local up: the rocket points at the sky.
    expectVec(rotateVector(state.q_BN, [0, 0, -1]), [1, 0, 0], 12);
  });

  it('accepts an explicit nonzero azimuth and keeps the vertical pose regular', () => {
    for (const azimuth_deg of [0, 45, 135, 270]) {
      const state = createAscentState(STARTER_VEHICLE, { azimuth_deg });
      expectVec(rotateVector(state.q_BN, [0, 0, -1]), [1, 0, 0], 12);
      const azimuth_rad = azimuth_deg * Math.PI / 180;
      // Azimuth fixes roll at 90 degrees of pitch through the horizontal reference.
      expectVec(rotateVector(state.q_BN, [-Math.sin(azimuth_rad), Math.cos(azimuth_rad), 0]), [0, 1, 0], 12);
      expect(Math.hypot(...state.q_BN)).toBeCloseTo(1, 12);
    }
  });

  it('uses an explicit attitude override when one is supplied', () => {
    const level = attitudeFor(0, 0);
    const state = createAscentState(STARTER_VEHICLE, { azimuth_deg: 0, attitude_q_BN: level });
    expectVec(rotateVector(state.q_BN, [1, 0, 0]), [1, 0, 0], 12);
    expect(padAttitude(0)).not.toEqual(level);
  });
});

describe('pad hold and the PAD_NO_LIFTOFF latch', () => {
  it('holds an under-powered rocket on the pad and latches, without moving it', () => {
    const heavy = clone(STARTER_VEHICLE);
    heavy.engine.thrustStep = 0;
    heavy.tank.length_m = 5;
    const start = createAscentState(heavy, { azimuth_deg: 0 });
    const next = stepAscent(start, controls({ ignite: true }), heavy);
    expect(next.status).toBe('PAD_NO_LIFTOFF');
    expect(isTerminal(next.status)).toBe(true);
    expect(next.events.map((event) => event.kind)).toContain('INSUFFICIENT_THRUST');
    // A held pad never propagates position.
    expectVec(next.position_N_m, start.position_N_m, 12);
    expectVec(next.velocity_N_m_s, [0, 0, 0], 12);
    // A latched run never moves again, however many times it is stepped.
    expect(stepAscent(next, controls({ ignite: true }), heavy)).toBe(next);
  });

  it('runs the clock but nothing else while waiting unignited on the pad', () => {
    const start = createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 });
    const next = stepAscent(start, controls(), STARTER_VEHICLE);
    expect(next.status).toBe('PAD');
    expect(next.t_s).toBeCloseTo(ASCENT_DT_S, 12);
    expectVec(next.position_N_m, start.position_N_m, 12);
  });

  it('lifts off when thrust exceeds weight', () => {
    const start = createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 });
    const next = stepAscent(start, controls({ ignite: true }), STARTER_VEHICLE);
    expect(next.status).toBe('FLYING');
    expect(next.engine).toBe('ON');
    expect(next.events.map((event) => event.kind)).toContain('LIFTOFF');
    expect(-next.position_N_m[2]).toBeGreaterThan(-start.position_N_m[2]);
    expect(next.prop_kg).toBeLessThan(start.prop_kg);
  });
});

describe('burnout boundary', () => {
  const flying = (prop_kg: number): AscentState => ({
    ...createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 }),
    status: 'FLYING',
    engine: 'ON',
    prop_kg,
    position_N_m: [0, 0, -10_000],
  });
  const massFlow = engineSpec(STARTER_VEHICLE).massFlow_kg_s;

  it('splits an interior exhaustion at 37 percent of the step', () => {
    const start = flying(0.37 * massFlow * ASCENT_DT_S);
    const next = stepAscent(start, controls(), STARTER_VEHICLE);
    const burnout = next.events.filter((event) => event.kind === 'BURNOUT');
    expect(burnout).toHaveLength(1);
    expect(burnout[0]!.t_s).toBeCloseTo(start.t_s + 0.37 * ASCENT_DT_S, 12);
    expect(next.prop_kg).toBe(0);
    expect(next.engine).toBe('BURNOUT');
  });

  it('splits inclusively at exactly 100 percent of the step, stamping at t + dt', () => {
    const start = flying(massFlow * ASCENT_DT_S);
    const next = stepAscent(start, controls(), STARTER_VEHICLE);
    const burnout = next.events.filter((event) => event.kind === 'BURNOUT');
    expect(burnout).toHaveLength(1);
    expect(burnout[0]!.t_s).toBeCloseTo(start.t_s + ASCENT_DT_S, 12);
    expect(next.prop_kg).toBe(0);
    expect(next.engine).toBe('BURNOUT');
    expect(next.t_s).toBeCloseTo(start.t_s + ASCENT_DT_S, 12);
  });

  it('publishes burnout before a separation commanded at the same boundary', () => {
    const start = flying(massFlow * ASCENT_DT_S);
    const next = stepAscent(start, controls({ separate: true }), STARTER_VEHICLE);
    const kinds = next.events.map((event) => event.kind);
    expect(kinds.filter((kind) => kind === 'BURNOUT')).toHaveLength(1);
    expect(kinds.indexOf('BURNOUT')).toBeLessThan(kinds.indexOf('SEPARATION'));
    expect(next.stage).toBe('CAPSULE');
  });

  it('publishes burnout for an already-empty engine, and a cutoff cannot mask it', () => {
    const empty: AscentState = { ...flying(0), engine: 'ON' };
    const plain = stepAscent(empty, controls(), STARTER_VEHICLE);
    expect(plain.events.filter((event) => event.kind === 'BURNOUT')).toHaveLength(1);
    expect(plain.events[0]!.t_s).toBeCloseTo(empty.t_s, 12);

    // The event a delayed separation keys on must survive a concurrent cutoff.
    const masked = stepAscent(empty, controls({ cutoff: true }), STARTER_VEHICLE);
    expect(masked.events.filter((event) => event.kind === 'BURNOUT')).toHaveLength(1);
    expect(masked.events.map((event) => event.kind)).not.toContain('CUTOFF');
    expect(masked.engine).toBe('BURNOUT');
  });

  it('stamps only one burnout however long the run continues', () => {
    const start = flying(0.5 * massFlow * ASCENT_DT_S);
    let current = start;
    for (let i = 0; i < 50 && !isTerminal(current.status); i++) {
      current = stepAscent(current, controls(), STARTER_VEHICLE);
    }
    expect(current.events.filter((event) => event.kind === 'BURNOUT')).toHaveLength(1);
  });

  it('honours a commanded cutoff before integrating, leaving the propellant untouched', () => {
    const start = flying(100);
    const next = stepAscent(start, controls({ cutoff: true }), STARTER_VEHICLE);
    expect(next.engine).toBe('OFF');
    expect(next.prop_kg).toBe(100);
    expect(next.events.map((event) => event.kind)).toContain('CUTOFF');
  });
});

describe('separation on the shared station datum', () => {
  it('reproduces the worked frame example at a north-facing vertical pad', () => {
    // delta_B = [2,0,0] is 2 m toward the nose, which is straight up on the pad.
    const q_BN = padAttitude(0);
    const toNed = (v: Vec3): Vec3 => rotateVector(conjugateQuaternion(q_BN), v);
    expectVec(toNed([2, 0, 0]), [0, 0, -2], 12);
    // omega_B = [0,0,1] about body +z, which is local north here.
    const omega: Vec3 = [0, 0, 1];
    const delta: Vec3 = [2, 0, 0];
    const lever: Vec3 = [
      omega[1] * delta[2] - omega[2] * delta[1],
      omega[2] * delta[0] - omega[0] * delta[2],
      omega[0] * delta[1] - omega[1] * delta[0],
    ];
    expectVec(toNed(lever), [0, 2, 0], 12);
  });

  it('keeps a capsule material point continuous across separation', () => {
    const start: AscentState = {
      ...createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 }),
      status: 'FLYING',
      engine: 'OFF',
      prop_kg: 0,
      position_N_m: [0, 0, -50_000],
      velocity_N_m_s: [10, -5, -200],
      omega_B_rad_s: [0.02, 0.05, -0.03],
    };
    const before = stageProperties(STARTER_VEHICLE, 'STACK', 0);
    const after = stepAscent(start, controls({ separate: true }), STARTER_VEHICLE, VACUUM_ASCENT);
    expect(after.stage).toBe('CAPSULE');
    const capsule = stageProperties(STARTER_VEHICLE, 'CAPSULE', 0);

    // Track one fixed material point of the capsule: its own centre of mass,
    // expressed through the shared datum, immediately before and after.
    const previous = stepAscent(start, controls(), STARTER_VEHICLE, VACUUM_ASCENT);
    const offset_B: Vec3 = [capsule.com_x_m - before.com_x_m, 0, 0];
    const toNed = conjugateQuaternion(previous.q_BN);
    const lever_N = rotateVector(toNed, offset_B);
    const materialBefore = previous.position_N_m.map((value, index) => value + lever_N[index]!) as Vec3;
    expectVec(after.position_N_m, materialBefore, 9);

    // Velocity continuity matters as much as position: a rotating stack carries
    // the capsule's material point at v + omega x lever, and that must survive.
    const omega = previous.omega_B_rad_s;
    const tangential_B: Vec3 = [
      omega[1] * offset_B[2] - omega[2] * offset_B[1],
      omega[2] * offset_B[0] - omega[0] * offset_B[2],
      omega[0] * offset_B[1] - omega[1] * offset_B[0],
    ];
    const tangential_N = rotateVector(toNed, tangential_B);
    const materialVelocity = previous.velocity_N_m_s.map((value, index) => value + tangential_N[index]!) as Vec3;
    expectVec(after.velocity_N_m_s, materialVelocity, 9);

    // Mass is conserved: the capsule plus exactly one discarded booster.
    expect(after.discarded).not.toBeNull();
    expect(after.discarded!.mass_kg).toBeCloseTo(before.mass_kg - capsule.mass_kg, 6);
    expect(after.prop_kg).toBe(0);
    expect(after.engine).toBe('OFF');
    // Attitude and rate are retained through the event.
    expectVec(after.omega_B_rad_s, previous.omega_B_rad_s, 9);
  });

  it('discards the booster exactly once', () => {
    const start: AscentState = {
      ...createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 }),
      status: 'FLYING', engine: 'OFF', prop_kg: 0, position_N_m: [0, 0, -50_000],
    };
    const first = stepAscent(start, controls({ separate: true }), STARTER_VEHICLE, VACUUM_ASCENT);
    const second = stepAscent(first, controls({ separate: true }), STARTER_VEHICLE, VACUUM_ASCENT);
    expect(second.events.filter((event) => event.kind === 'SEPARATION')).toHaveLength(1);
    expect(second.discarded!.t_s).toBeCloseTo(first.discarded!.t_s, 12);
  });
});

describe('vacuum burn reproduces the Tsiolkovsky oracle', () => {
  it('matches Isp g0 ln(m0/mf) with back-pressure and gravity removed', () => {
    const start = createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 });
    const engine = engineSpec(STARTER_VEHICLE);
    const m0 = stageProperties(STARTER_VEHICLE, 'STACK', start.prop_kg).mass_kg;
    const mf = m0 - start.prop_kg;
    const expected = engine.ispVacuum_s * STANDARD_GRAVITY_M_S2 * Math.log(m0 / mf);

    const burnt = run(start, STARTER_VEHICLE, (state) =>
      controls({ ignite: true, throttle: 1 }), OracleVacuum, 200_000);
    // The run ends by leaving the range box, not before the tank empties.
    const speed = Math.hypot(...burnt.velocity_N_m_s);
    expect(burnt.events.map((event) => event.kind)).toContain('BURNOUT');

    // Re-run and stop exactly at burnout to compare the delta-v cleanly.
    let current = start;
    while (current.engine !== 'BURNOUT' && !isTerminal(current.status)) {
      current = stepAscent(current, controls({ ignite: true, throttle: 1 }), STARTER_VEHICLE, OracleVacuum);
    }
    expect(current.prop_kg).toBe(0);
    const achieved = Math.hypot(...current.velocity_N_m_s);
    expect(Math.abs(achieved - expected) / expected).toBeLessThan(1e-4);
    expect(speed).toBeGreaterThan(0);
  });
});

describe('terminal statuses are all reachable and declared', () => {
  it('latches LOST beyond the range box', () => {
    const start: AscentState = {
      ...createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 }),
      status: 'FLYING', engine: 'OFF', prop_kg: 0,
      position_N_m: [199_999, 0, -100_000], velocity_N_m_s: [500, 0, 0],
    };
    const next = stepAscent(start, controls(), STARTER_VEHICLE, VACUUM_ASCENT);
    expect(next.status).toBe('LOST');
    expect(next.events.map((event) => event.kind)).toContain('OUT_OF_RANGE');
  });

  it('latches TIMEOUT at the declared bound', () => {
    const start: AscentState = {
      ...createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 }),
      status: 'FLYING', engine: 'OFF', prop_kg: 0,
      t_s: ASCENT_TIMEOUT_S - ASCENT_DT_S,
      position_N_m: [0, 0, -50_000], velocity_N_m_s: [0, 0, 0],
    };
    const next = stepAscent(start, controls(), STARTER_VEHICLE, VACUUM_ASCENT);
    expect(next.status).toBe('TIMEOUT');
    expect(next.events.map((event) => event.kind)).toContain('TIMEOUT');
    expect(isTerminal(next.status)).toBe(true);
  });

  it('latches CRASHED on a fast touchdown with no canopy', () => {
    const start: AscentState = {
      ...createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 }),
      status: 'FLYING', engine: 'OFF', prop_kg: 0, stage: 'CAPSULE',
      position_N_m: [0, 0, -40], velocity_N_m_s: [0, 0, 60],
    };
    const end = run(start, STARTER_VEHICLE, () => controls(), STILL_AIR_ASCENT, 5_000);
    expect(end.status).toBe('CRASHED');
    const touchdown = end.events.find((event) => event.kind === 'TOUCHDOWN');
    expect(touchdown).toBeDefined();
  });

  it('latches RECOVERED under a canopy within the speed limit', () => {
    const start: AscentState = {
      ...createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 }),
      status: 'FLYING', engine: 'OFF', prop_kg: 0, stage: 'CAPSULE',
      position_N_m: [0, 0, -600], velocity_N_m_s: [0, 0, 40],
    };
    const end = run(start, STARTER_VEHICLE, (state, index) =>
      controls({ deployChute: index === 0 }), STILL_AIR_ASCENT, 60_000);
    expect(end.chute).toBe('DEPLOYED');
    expect(end.status).toBe('RECOVERED');
    expect(Math.hypot(...end.velocity_N_m_s)).toBeLessThanOrEqual(RECOVERY_SPEED_LIMIT_M_S);
  });

  it('tears the canopy when deployed above the dynamic-pressure limit', () => {
    const start: AscentState = {
      ...createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 }),
      status: 'FLYING', engine: 'OFF', prop_kg: 0, stage: 'CAPSULE',
      position_N_m: [0, 0, -5_000], velocity_N_m_s: [0, 0, 400],
    };
    const next = stepAscent(start, controls({ deployChute: true }), STARTER_VEHICLE);
    expect(next.chute).toBe('FAILED');
    const failure = next.events.find((event) => event.kind === 'CHUTE_FAILED');
    expect(failure).toBeDefined();
    expect(failure!.note).toContain('limit');
    // A torn canopy provides no drag, so the capsule cannot be recovered.
    const end = run(next, STARTER_VEHICLE, () => controls(), STILL_AIR_ASCENT, 60_000);
    expect(end.status).toBe('CRASHED');
    expect(CHUTE_MAX_DEPLOY_Q_PA).toBeGreaterThan(0);
  });

  it('refuses to integrate a state that has already latched', () => {
    const start: AscentState = {
      ...createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 }), status: 'CRASHED',
    };
    expect(stepAscent(start, controls({ ignite: true }), STARTER_VEHICLE)).toBe(start);
  });
});

describe('apogee and max dynamic pressure edges', () => {
  it('stamps apogee once, when the vertical speed crosses zero', () => {
    const start: AscentState = {
      ...createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 }),
      status: 'FLYING', engine: 'OFF', prop_kg: 0, stage: 'CAPSULE',
      position_N_m: [0, 0, -100_000], velocity_N_m_s: [0, 0, -50],
    };
    const end = run(start, STARTER_VEHICLE, () => controls(), VACUUM_ASCENT, 2_000);
    const apogee = end.events.filter((event) => event.kind === 'APOGEE');
    expect(apogee).toHaveLength(1);
    expect(apogee[0]!.altitude_m).toBeGreaterThan(100_000);
  });

  it('records the peak dynamic pressure and stamps max-q once', () => {
    const start = createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 });
    let current = start;
    for (let i = 0; i < 12_000 && !isTerminal(current.status); i++) {
      current = stepAscent(current, controls({ ignite: true }), STARTER_VEHICLE);
    }
    expect(current.maxQ_Pa).toBeGreaterThan(0);
    expect(current.events.filter((event) => event.kind === 'MAX_Q').length).toBeLessThanOrEqual(1);
  });
});

describe('instruments are a complete feedback interface', () => {
  it('carries measured attitude and body rates, with Euler angles alongside', () => {
    const state: AscentState = {
      ...createAscentState(STARTER_VEHICLE, { azimuth_deg: 30 }),
      status: 'FLYING', engine: 'ON', omega_B_rad_s: [0.01, -0.02, 0.03],
      position_N_m: [100, -50, -20_000], velocity_N_m_s: [30, 10, -400],
    };
    const instruments = ascentInstruments(state, STARTER_VEHICLE);
    expectVec(instruments.omega_B_rad_s, state.omega_B_rad_s, 12);
    expect(instruments.q_BN).toEqual(state.q_BN);
    expect(instruments.altitude_m).toBeCloseTo(20_000, 9);
    expect(instruments.altitudeMsl_m).toBeCloseTo(20_000 + DEFAULT_PAD_ALTITUDE_MSL_M, 9);
    expect(instruments.verticalSpeed_m_s).toBeCloseTo(400, 9);
    expect(instruments.downrange_m).toBeCloseTo(Math.hypot(100, 50), 9);
    // This state was hand-built and never stepped, so nothing has been applied
    // yet; the engine's available thrust is a separate, separately named value.
    expect(instruments.thrust_N).toBe(0);
    expect(instruments.availableThrust_N).toBeGreaterThan(0);
    expect(instruments.apogeeEstimate_m).toBeGreaterThan(instruments.altitude_m);
    // Euler angles are present for display but are not the feedback path.
    expect(Number.isFinite(instruments.pitch_rad)).toBe(true);
    expect(Number.isFinite(instruments.heading_rad)).toBe(true);
    expect(Number.isFinite(instruments.roll_rad)).toBe(true);
  });

  it('reports Mach as null above the atmosphere cutoff rather than infinity', () => {
    const state: AscentState = {
      ...createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 }),
      status: 'FLYING', engine: 'OFF', prop_kg: 0,
      position_N_m: [0, 0, -300_000], velocity_N_m_s: [0, 0, -100],
    };
    expect(ascentInstruments(state, STARTER_VEHICLE).mach).toBeNull();
    const low: AscentState = { ...state, position_N_m: [0, 0, -5_000] };
    expect(ascentInstruments(low, STARTER_VEHICLE).mach).toBeGreaterThan(0);
  });

  it('gives guidance no reason to reach for truth state', () => {
    // The interface carries everything a controller needs, so when the guidance
    // module lands it can be a pure function of instruments.
    const instruments = ascentInstruments(createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 }), STARTER_VEHICLE);
    for (const field of ['q_BN', 'omega_B_rad_s', 'altitude_m', 'verticalSpeed_m_s', 'apogeeEstimate_m'] as const) {
      expect(instruments[field]).toBeDefined();
    }
    // Forward-looking purity check: the guidance module, once written, must not
    // import AscentState. It does not exist yet, which this asserts explicitly.
    const guidancePath = new URL('./ascentGuidance.ts', import.meta.url).pathname;
    if (existsSync(guidancePath)) {
      const source = readFileSync(guidancePath, 'utf8');
      expect(source).not.toMatch(/AscentState/);
    } else {
      expect(readdirSync(new URL('.', import.meta.url).pathname)).not.toContain('ascentGuidance.ts');
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 1b corrections R1–R6
// ---------------------------------------------------------------------------

const massFlowFull = engineSpec(STARTER_VEHICLE).massFlow_kg_s;
const flyingStack = (overrides: Partial<AscentState> = {}): AscentState => ({
  ...createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 }),
  status: 'FLYING', engine: 'ON', position_N_m: [0, 0, -1_000], ...overrides,
});

describe('R1 throttle scales fuel flow, mass and the burnout boundary', () => {
  // The starter's engine family has a 0.6 throttling floor, so a command below
  // it is clamped up. Flow must follow the throttle actually in force.
  it.each([
    ['full', 1, 1],
    ['partial', 0.8, 0.8],
    ['floor', 0.6, 0.6],
    ['below the floor', 0.1, engineSpec(STARTER_VEHICLE).minThrottle],
  ])('consumes fuel at the %s commanded throttle', (_label, commanded, effective) => {
    const start = flyingStack({ prop_kg: 5 });
    const next = stepAscent(start, controls({ throttle: commanded }), STARTER_VEHICLE, OracleVacuum);
    expect(start.prop_kg - next.prop_kg).toBeCloseTo(effective * massFlowFull * ASCENT_DT_S, 12);
  });

  it('locates the inclusive burnout boundary using the throttled flow, not the full-throttle flow', () => {
    // Throttling to 0.8 slows the flow, so this load lasts the whole step
    // instead of the 0.8 of a step the full-throttle flow would imply.
    const start = flyingStack({ prop_kg: 0.8 * massFlowFull * ASCENT_DT_S });
    const next = stepAscent(start, controls({ throttle: 0.8 }), STARTER_VEHICLE, OracleVacuum);
    const burnout = next.events.filter((event) => event.kind === 'BURNOUT');
    expect(burnout).toHaveLength(1);
    expect(burnout[0]!.t_s).toBeCloseTo(ASCENT_DT_S, 12);
    expect(next.prop_kg).toBe(0);
  });

  it('splits at 37 percent of the step at reduced throttle too', () => {
    const start = flyingStack({ prop_kg: 0.37 * 0.8 * massFlowFull * ASCENT_DT_S });
    const next = stepAscent(start, controls({ throttle: 0.8 }), STARTER_VEHICLE, OracleVacuum);
    const burnout = next.events.filter((event) => event.kind === 'BURNOUT');
    expect(burnout).toHaveLength(1);
    expect(burnout[0]!.t_s).toBeCloseTo(0.37 * ASCENT_DT_S, 12);
  });

  it.each([1, 0.8, 0.6])('reproduces the Tsiolkovsky oracle at throttle %s', (throttle) => {
    const start = createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 });
    const engine = engineSpec(STARTER_VEHICLE);
    const m0 = stageProperties(STARTER_VEHICLE, 'STACK', start.prop_kg).mass_kg;
    const expected = engine.ispVacuum_s * STANDARD_GRAVITY_M_S2 * Math.log(m0 / (m0 - start.prop_kg));
    let current = start;
    while (current.engine !== 'BURNOUT' && !isTerminal(current.status)) {
      current = stepAscent(current, controls({ ignite: true, throttle }), STARTER_VEHICLE, OracleVacuum);
    }
    expect(current.prop_kg).toBe(0);
    // Exhaust velocity is a property of the engine, so the achieved delta-v is
    // the same however slowly the tank is emptied.
    expect(Math.abs(Math.hypot(...current.velocity_N_m_s) - expected) / expected).toBeLessThan(1e-4);
  });

  /**
   * Durable version of the reviewer's analytic remainder check. After a
   * mid-step burnout the unpowered remainder must integrate at the DEPLETED
   * mass; restoring the pre-burn mass leaves the vehicle about 2.18e-6 m/s
   * fast here, which this tolerance rejects. The expected value is the
   * reviewer's independently derived closed-form drag solution
   * `vEnd = vBurn / (1 + k·vBurn·h/mDry)`, not a recording of our output.
   */
  it('integrates the post-burnout remainder at the depleted mass', () => {
    const air = { densityScale: 1, wind_N_m_s: [0, 0, 0] as Vec3, constantGravity_m_s2: 0 };
    const start: AscentState = {
      ...createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 }),
      status: 'FLYING', engine: 'ON', prop_kg: massFlowFull * 0.005,
      q_BN: [1, 0, 0, 0], position_N_m: [0, 0, -1_000], velocity_N_m_s: [100, 0, 0],
      omega_B_rad_s: [0, 0, 0],
    };
    const next = stepAscent(start, controls(), STARTER_VEHICLE, air);
    expect(next.engine).toBe('BURNOUT');
    expect(next.prop_kg).toBe(0);
    expect(Math.hypot(...next.velocity_N_m_s)).toBeCloseTo(100.36074076810277, 7);
  });

  it('leaves the vehicle at its depleted mass after a split step', () => {
    const start = flyingStack({ prop_kg: 0.5 * massFlowFull * ASCENT_DT_S });
    const next = stepAscent(start, controls(), STARTER_VEHICLE, OracleVacuum);
    expect(next.prop_kg).toBe(0);
    const depleted = stageProperties(STARTER_VEHICLE, 'STACK', 0).mass_kg;
    expect(ascentInstruments(next, STARTER_VEHICLE, OracleVacuum).mass_kg).toBeCloseTo(depleted, 12);
  });
});

describe('R2 instruments report applied propulsion, not available performance', () => {
  const thrustAfterStep = (throttle: number): number => {
    const next = stepAscent(flyingStack({ prop_kg: 50 }), controls({ throttle }), STARTER_VEHICLE, OracleVacuum);
    return ascentInstruments(next, STARTER_VEHICLE, OracleVacuum).thrust_N;
  };

  it('scales the reported thrust with the throttle actually in force', () => {
    const full = thrustAfterStep(1);
    expect(full).toBeCloseTo(engineSpec(STARTER_VEHICLE).thrustVacuum_N, 6);
    expect(thrustAfterStep(0.8)).toBeCloseTo(full * 0.8, 6);
    // Below the family's floor the engine holds its minimum, and the reading follows.
    expect(thrustAfterStep(0.1)).toBeCloseTo(full * engineSpec(STARTER_VEHICLE).minThrottle, 6);
  });

  it('reports zero applied thrust after cutoff and after burnout', () => {
    const cut = stepAscent(flyingStack({ prop_kg: 50 }), controls({ cutoff: true }), STARTER_VEHICLE, OracleVacuum);
    expect(ascentInstruments(cut, STARTER_VEHICLE, OracleVacuum).thrust_N).toBe(0);
    const burnt = stepAscent(flyingStack({ prop_kg: 0.5 * massFlowFull * ASCENT_DT_S }), controls(), STARTER_VEHICLE, OracleVacuum);
    expect(burnt.engine).toBe('BURNOUT');
    expect(ascentInstruments(burnt, STARTER_VEHICLE, OracleVacuum).thrust_N).toBe(0);
  });

  it('shows a nonzero axial load from drag alone with the engine off', () => {
    const start = flyingStack({ engine: 'OFF', prop_kg: 0, velocity_N_m_s: [0, 0, -300], q_BN: padAttitude(0) });
    const next = stepAscent(start, controls(), STARTER_VEHICLE, { densityScale: 1, wind_N_m_s: [0, 0, 0] });
    const instruments = ascentInstruments(next, STARTER_VEHICLE, { densityScale: 1, wind_N_m_s: [0, 0, 0] });
    expect(instruments.thrust_N).toBe(0);
    // Climbing nose-first, drag pushes aft along the body axis.
    expect(instruments.axialLoad_g).toBeLessThan(0);
    expect(Math.abs(instruments.axialLoad_g)).toBeGreaterThan(0.01);
  });

  it('matches the propulsive axial load to thrust over mass in vacuum', () => {
    const next = stepAscent(flyingStack({ prop_kg: 50 }), controls({ throttle: 1 }), STARTER_VEHICLE, OracleVacuum);
    const instruments = ascentInstruments(next, STARTER_VEHICLE, OracleVacuum);
    expect(instruments.axialLoad_g)
      .toBeCloseTo(instruments.thrust_N / (instruments.mass_kg * STANDARD_GRAVITY_M_S2), 6);
  });
});

describe('R3 dynamic pressure is air-relative everywhere', () => {
  const gale = { densityScale: 1, wind_N_m_s: [200, 0, 0] as Vec3, constantGravity_m_s2: 0 };
  const stationary = (): AscentState => ({
    ...createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 }),
    status: 'FLYING', engine: 'OFF', prop_kg: 0, stage: 'CAPSULE',
    q_BN: [1, 0, 0, 0], position_N_m: [0, 0, -1_000], velocity_N_m_s: [0, 0, 0],
  });

  it('refuses a canopy in a gale even though the ground speed is nil', () => {
    const start = stationary();
    const q_Pa = ascentInstruments(start, STARTER_VEHICLE, gale).dynamicPressure_Pa;
    expect(q_Pa).toBeGreaterThan(CHUTE_MAX_DEPLOY_Q_PA);
    const next = stepAscent(start, controls({ deployChute: true }), STARTER_VEHICLE, gale);
    expect(next.chute).toBe('FAILED');
    expect(next.events.map((event) => event.kind)).toContain('CHUTE_FAILED');
  });

  it('records the air-relative peak, not the ground-relative one', () => {
    const next = stepAscent(stationary(), controls(), STARTER_VEHICLE, gale);
    const instruments = ascentInstruments(next, STARTER_VEHICLE, gale);
    expect(next.maxQ_Pa).toBeCloseTo(instruments.dynamicPressure_Pa, 6);
    expect(next.maxQ_Pa).toBeGreaterThan(1_000);
  });

  it('reports still air when the vehicle moves with the air mass', () => {
    const comoving = { densityScale: 1, wind_N_m_s: [120, 0, 0] as Vec3, constantGravity_m_s2: 0 };
    const start = { ...stationary(), velocity_N_m_s: [120, 0, 0] as Vec3 };
    expect(ascentInstruments(start, STARTER_VEHICLE, comoving).dynamicPressure_Pa).toBeCloseTo(0, 9);
    const next = stepAscent(start, controls({ deployChute: true }), STARTER_VEHICLE, comoving);
    // Co-moving with the air is calm, whatever the ground speed says.
    expect(next.chute).toBe('DEPLOYED');
    expect(next.maxQ_Pa).toBeCloseTo(0, 6);
  });
});

describe('R4 a separated capsule keeps no part of the discarded booster', () => {
  const capsuleState = (config: VehicleConfig): AscentState => ({
    ...createAscentState(config, { azimuth_deg: 0 }),
    status: 'FLYING', engine: 'OFF', prop_kg: 0, stage: 'CAPSULE',
    q_BN: [1, 0, 0, 0], position_N_m: [0, 0, -1_000],
    velocity_N_m_s: [100, 0, 0], omega_B_rad_s: [1, 0, 0],
  });
  const air = { densityScale: 1, wind_N_m_s: [0, 0, 0] as Vec3, constantGravity_m_s2: 0 };

  it('evolves identically whatever fin count the discarded stack had', () => {
    const finless = clone(STARTER_VEHICLE);
    finless.fins = 0;
    const withFins = stepAscent(capsuleState(STARTER_VEHICLE), controls(), STARTER_VEHICLE, air);
    const without = stepAscent(capsuleState(finless), controls(), finless, air);
    expect(withFins.omega_B_rad_s[0]).toBeCloseTo(without.omega_B_rad_s[0], 12);
    // No fins are attached, so nothing damps the roll.
    expect(withFins.omega_B_rad_s[0]).toBeCloseTo(1, 9);
  });

  it('still damps the roll of an assembled finned stack', () => {
    const stack: AscentState = { ...capsuleState(STARTER_VEHICLE), stage: 'STACK' };
    const finless = clone(STARTER_VEHICLE);
    finless.fins = 0;
    const damped = stepAscent(stack, controls(), STARTER_VEHICLE, air);
    const undamped = stepAscent({ ...capsuleState(finless), stage: 'STACK' }, controls(), finless, air);
    expect(damped.omega_B_rad_s[0]).toBeLessThan(1);
    expect(damped.omega_B_rad_s[0]).toBeLessThan(undamped.omega_B_rad_s[0]);
  });
});

describe('R5 ground contact is attitude-aware', () => {
  const finless = (): VehicleConfig => { const config = clone(STARTER_VEHICLE); config.fins = 0; return config; };

  it('does not crash a horizontal body whose lowest point is above ground', () => {
    const config = finless();
    const start: AscentState = {
      ...createAscentState(config, { azimuth_deg: 0 }),
      status: 'FLYING', engine: 'OFF', prop_kg: 0,
      q_BN: [1, 0, 0, 0], position_N_m: [0, 0, -1], velocity_N_m_s: [0, 0, 0],
    };
    // Lying horizontally, only the body radius hangs below the centre of mass.
    expect(lowestContactDepth_m(start, config)).toBeCloseTo(-1 + config.stackDiameter_m / 2, 9);
    const next = stepAscent(start, controls(), config, OracleVacuum);
    expect(next.status).toBe('FLYING');
    expect(next.events.map((event) => event.kind)).not.toContain('TOUCHDOWN');
  });

  it('still rests exactly on the pad when upright', () => {
    const start = createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 });
    expect(lowestContactDepth_m(start, STARTER_VEHICLE)).toBeCloseTo(0, 9);
    // One metre higher is clear of the ground by exactly one metre.
    expect(lowestContactDepth_m({ ...start, position_N_m: [0, 0, start.position_N_m[2] - 1] }, STARTER_VEHICLE))
      .toBeCloseTo(-1, 9);
  });

  it('touches down on the nose when inverted', () => {
    const config = finless();
    const upright = createAscentState(config, { azimuth_deg: 0 });
    const inverted = { ...upright, q_BN: attitudeFor(-Math.PI / 2, 0) };
    // Inverted, the nose is the lowest point, so the clearance differs.
    expect(lowestContactDepth_m(inverted, config)).not.toBeCloseTo(lowestContactDepth_m(upright, config), 6);
    const geometry = vehicleGeometry(config);
    const com = stageProperties(config, 'STACK', upright.prop_kg).com_x_m;
    expect(lowestContactDepth_m(inverted, config)).toBeCloseTo(upright.position_N_m[2] + (0 - com), 9);
    expect(geometry.base_x_m).toBeLessThan(com);
  });

  it('uses the capsule body after separation, not the assembled stack', () => {
    const capsule: AscentState = {
      ...createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 }),
      stage: 'CAPSULE', prop_kg: 0, status: 'FLYING', engine: 'OFF',
    };
    const stackDepth = lowestContactDepth_m({ ...capsule, stage: 'STACK' }, STARTER_VEHICLE);
    expect(lowestContactDepth_m(capsule, STARTER_VEHICLE)).not.toBeCloseTo(stackDepth, 6);
  });

  /**
   * A nose point plus an aft disc alone bounds a single cone over the whole
   * length, which sits inside the real fairing-plus-cylinder body. A slightly
   * nose-down vehicle then penetrates the ground while every proxy reads clear.
   */
  it.each([-5, -10, -15])('detects the full-radius shoulder touching at %s degrees nose-down', (pitch_deg) => {
    const config = finless();
    const geometry = vehicleGeometry(config);
    const shoulder_x_m = geometry.sections.find((section) => section.id === 'FAIRING')!.x_aft_m;
    const com_x_m = stageProperties(config, 'STACK', 0).com_x_m;
    const pitch_rad = pitch_deg * Math.PI / 180;
    const radius_m = config.stackDiameter_m / 2;

    // Place the centre of mass so the shoulder rim sits exactly on the ground,
    // derived from geometry rather than from the proxy list being tested.
    const positionDown = -((shoulder_x_m - com_x_m) * Math.sin(-pitch_rad) + radius_m * Math.cos(pitch_rad));
    const grounded: AscentState = {
      ...createAscentState(config, { azimuth_deg: 0 }),
      status: 'FLYING', engine: 'OFF', prop_kg: 0,
      q_BN: attitudeFor(pitch_rad, 0), position_N_m: [0, 0, positionDown], velocity_N_m_s: [0, 0, 0],
    };
    expect(lowestContactDepth_m(grounded, config)).toBeCloseTo(0, 9);
    expect(stepAscent(grounded, controls(), config, OracleVacuum).status).toBe('CRASHED');

    // Lifting the same pose clear by a decimetre must not touch down.
    const clear: AscentState = { ...grounded, position_N_m: [0, 0, positionDown - 0.1] };
    expect(lowestContactDepth_m(clear, config)).toBeCloseTo(-0.1, 9);
    expect(stepAscent(clear, controls(), config, OracleVacuum).status).toBe('FLYING');
  });

  it("reproduces the reviewer's exact shoulder-penetration fixture", () => {
    // Verbatim from the Phase 1b corrections rereview, so the numbers that
    // exposed the defect are pinned rather than paraphrased.
    const config = finless();
    const state: AscentState = {
      ...createAscentState(config, { azimuth_deg: 0 }),
      status: 'FLYING', engine: 'OFF', prop_kg: 0,
      q_BN: attitudeFor(-10 * Math.PI / 180, 0),
      position_N_m: [0, 0, -0.5623626358913577],
      velocity_N_m_s: [0, 0, 0],
    };
    // The old nose-plus-aft list reported -0.08117606350199796 m, i.e. clear.
    // The shoulder rim is in fact this far UNDER the ground plane.
    expect(lowestContactDepth_m(state, config)).toBeCloseTo(0.08117606350199791, 12);
    expect(stepAscent(state, controls(), config, OracleVacuum).status).toBe('CRASHED');
    // The declared shoulder station and radius the expectation is built from.
    expect(vehicleGeometry(config).sections.find((section) => section.id === 'FAIRING')!.x_aft_m)
      .toBeCloseTo(-1.05, 12);
  });

  it('bounds the capsule shoulder after separation too', () => {
    const config = finless();
    const geometry = vehicleGeometry(config);
    const shoulder_x_m = geometry.sections.find((section) => section.id === 'FAIRING')!.x_aft_m;
    const com_x_m = stageProperties(config, 'CAPSULE', 0).com_x_m;
    const pitch_rad = -10 * Math.PI / 180;
    const radius_m = config.stackDiameter_m / 2;
    const positionDown = -((shoulder_x_m - com_x_m) * Math.sin(-pitch_rad) + radius_m * Math.cos(pitch_rad));
    const grounded: AscentState = {
      ...createAscentState(config, { azimuth_deg: 0 }),
      status: 'FLYING', engine: 'OFF', prop_kg: 0, stage: 'CAPSULE',
      q_BN: attitudeFor(pitch_rad, 0), position_N_m: [0, 0, positionDown], velocity_N_m_s: [0, 0, 0],
    };
    expect(lowestContactDepth_m(grounded, config)).toBeCloseTo(0, 9);
    expect(stepAscent(grounded, controls(), config, OracleVacuum).status).toBe('CRASHED');
    expect(lowestContactDepth_m({ ...grounded, position_N_m: [0, 0, positionDown - 0.1] }, config))
      .toBeCloseTo(-0.1, 9);
  });

  it('bounds the body at every proxy station, not just the selected minimum', () => {
    // Guard against the proxy list being checked only against itself: the
    // shoulder radius must equal the body radius at the fairing junction.
    for (const stage of ['STACK', 'CAPSULE'] as const) {
      const proxies = contactProxies(STARTER_VEHICLE, stage, 0);
      const com = stageProperties(STARTER_VEHICLE, stage, 0).com_x_m;
      const shoulder = vehicleGeometry(STARTER_VEHICLE).sections.find((s) => s.id === 'FAIRING')!.x_aft_m;
      const match = proxies.find((proxy) => Math.abs(proxy.offset_x_m - (shoulder - com)) < 1e-12);
      expect(match).toBeDefined();
      expect(match!.radius_m).toBeCloseTo(STARTER_VEHICLE.stackDiameter_m / 2, 12);
    }
  });

  it('keeps a finned stack clear when every proxy is above ground', () => {
    const start: AscentState = {
      ...createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 }),
      status: 'FLYING', engine: 'OFF', prop_kg: 0,
      q_BN: [1, 0, 0, 0], position_N_m: [0, 0, -50], velocity_N_m_s: [0, 0, 0],
    };
    for (const proxy of contactProxies(STARTER_VEHICLE, 'STACK', 0)) expect(proxy.radius_m).toBeGreaterThanOrEqual(0);
    expect(lowestContactDepth_m(start, STARTER_VEHICLE)).toBeLessThan(0);
    expect(stepAscent(start, controls(), STARTER_VEHICLE, OracleVacuum).status).toBe('FLYING');
  });
});

describe('R6 a commanded cutoff dominates ignition in the same call', () => {
  it('refuses to ignite a pad vehicle when cutoff is commanded together', () => {
    const start = createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 });
    const next = stepAscent(start, controls({ ignite: true, cutoff: true }), STARTER_VEHICLE, OracleVacuum);
    expect(next.engine).toBe('OFF');
    expect(next.status).toBe('PAD');
    expect(next.events.map((event) => event.kind)).not.toContain('LIFTOFF');
    expect(next.prop_kg).toBe(start.prop_kg);
    expectVec(next.position_N_m, start.position_N_m, 12);
  });

  it('cuts off an already-running pad engine and does not re-ignite it', () => {
    const running: AscentState = { ...createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 }), engine: 'ON' };
    const next = stepAscent(running, controls({ ignite: true, cutoff: true }), STARTER_VEHICLE, OracleVacuum);
    expect(next.engine).toBe('OFF');
    expect(next.events.map((event) => event.kind)).toContain('CUTOFF');
    expect(next.events.map((event) => event.kind)).not.toContain('LIFTOFF');
  });

  it('ignites normally on a later call once cutoff is released', () => {
    const start = createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 });
    const held = stepAscent(start, controls({ ignite: true, cutoff: true }), STARTER_VEHICLE, OracleVacuum);
    const released = stepAscent(held, controls({ ignite: true }), STARTER_VEHICLE, OracleVacuum);
    expect(released.engine).toBe('ON');
    expect(released.status).toBe('FLYING');
    expect(released.events.map((event) => event.kind)).toContain('LIFTOFF');
  });

  it('keeps the already-empty burnout ahead of both, as ruled', () => {
    const empty: AscentState = { ...flyingStack({ prop_kg: 0 }), engine: 'ON' };
    const next = stepAscent(empty, controls({ ignite: true, cutoff: true }), STARTER_VEHICLE, OracleVacuum);
    expect(next.events.filter((event) => event.kind === 'BURNOUT')).toHaveLength(1);
    expect(next.events.map((event) => event.kind)).not.toContain('CUTOFF');
  });
});

describe('gimbal and roll sign oracles', () => {
  const rates = (overrides: Partial<AscentControls>): Vec3 => stepAscent(
    flyingStack({ prop_kg: 1 }), controls(overrides), STARTER_VEHICLE, OracleVacuum).omega_B_rad_s;

  it('pitches the nose downrange, yaws it toward body right, and rolls right-wing-down', () => {
    // Thrust toward body -z torques the nose toward +z, which is downrange.
    expect(rates({ gimbalPitch: 1 })[1]).toBeLessThan(0);
    expect(rates({ gimbalYaw: 1 })[2]).toBeGreaterThan(0);
    expect(rates({ roll: 1 })[0]).toBeGreaterThan(0);
    expect(rates({ gimbalPitch: -1 })[1]).toBeGreaterThan(0);
    expect(rates({ gimbalYaw: -1 })[2]).toBeLessThan(0);
  });

  it('matches the engine-arm impulse for a pure pitch input', () => {
    const start = flyingStack({ prop_kg: 1 });
    const next = stepAscent(start, controls({ gimbalPitch: 1 }), STARTER_VEHICLE, OracleVacuum);
    const properties = stageProperties(STARTER_VEHICLE, 'STACK', 1);
    const arm = properties.engineStation_x_m! - properties.com_x_m;
    const thrust = engineSpec(STARTER_VEHICLE).thrustVacuum_N;
    // torque_y = arm * F * sin(gimbal); the arm is negative because the engine
    // sits aft of the centre of mass, which is why the rate comes out negative.
    const expected = arm * Math.sin(MAX_GIMBAL_RAD) * thrust / properties.inertia_kg_m2[1] * ASCENT_DT_S;
    // One step of r x F / I, to the accuracy of the mass change over the step.
    expect(next.omega_B_rad_s[1]).toBeCloseTo(expected, 3);
  });
});

describe('determinism', () => {
  it('produces an identical trajectory for identical inputs', () => {
    const command = (state: AscentState, index: number): AscentControls =>
      controls({ ignite: true, gimbalPitch: index > 300 ? 0.2 : 0, separate: index === 1_200 });
    const first = run(createAscentState(STARTER_VEHICLE, { azimuth_deg: 20 }), STARTER_VEHICLE, command, STILL_AIR_ASCENT, 2_000);
    const second = run(createAscentState(STARTER_VEHICLE, { azimuth_deg: 20 }), STARTER_VEHICLE, command, STILL_AIR_ASCENT, 2_000);
    expect(second.position_N_m).toEqual(first.position_N_m);
    expect(second.velocity_N_m_s).toEqual(first.velocity_N_m_s);
    expect(second.q_BN).toEqual(first.q_BN);
    expect(second.events.map((event) => event.kind)).toEqual(first.events.map((event) => event.kind));
  });

  it('never lets propellant go negative or mass grow', () => {
    let current = createAscentState(STARTER_VEHICLE, { azimuth_deg: 0 });
    let previousMass = stageProperties(STARTER_VEHICLE, current.stage, current.prop_kg).mass_kg;
    for (let i = 0; i < 3_000 && !isTerminal(current.status); i++) {
      current = stepAscent(current, controls({ ignite: true }), STARTER_VEHICLE);
      expect(current.prop_kg).toBeGreaterThanOrEqual(0);
      const mass = stageProperties(STARTER_VEHICLE, current.stage, current.prop_kg).mass_kg;
      expect(mass).toBeLessThanOrEqual(previousMass + 1e-9);
      previousMass = mass;
    }
  });
});
