import { describe, expect, it } from 'vitest';
import { conjugateQuaternion, rotateVector, smallAngleExp } from './attitude.js';
import { createTrimmedFlight, flightAtmosphere, flightInstruments, flightLoads, FLIGHT_DT_S, FLIGHT_GRAVITY_M_S2, HORNET_PROTOTYPE, stepFlight, STILL_AIR, type FlightControls, type FlightEnvironment, type FlightParameters, type FlightState } from './flight.js';
import type { Vec3 } from './types.js';

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function run(state: FlightState, controls: FlightControls, seconds: number, env = STILL_AIR): FlightState {
  for (let i = 0; i < Math.round(seconds / FLIGHT_DT_S); i++) state = stepFlight(state, controls, HORNET_PROTOTYPE, env);
  return state;
}
describe('flight physical oracles', () => {
  it('matches dry standard atmosphere reference points and joins continuously at 11 km', () => {
    expect(flightAtmosphere(0).density_kg_m3).toBeCloseTo(1.225, 5);
    expect(flightAtmosphere(11000).density_kg_m3).toBeCloseTo(0.363918, 5);
    expect(flightAtmosphere(20000).density_kg_m3).toBeCloseTo(0.0880347, 5);
    expect(flightAtmosphere(0).soundSpeed_m_s).toBeCloseTo(340.294, 2);
    expect(Math.abs(flightAtmosphere(11000.001).density_kg_m3 - flightAtmosphere(10999.999).density_kg_m3)).toBeLessThan(1e-6);
  });
  it('agrees with the analytic ballistic solution in vacuum', () => {
    const { state, controls } = createTrimmedFlight();
    const end = run(state, controls, 8, { ...STILL_AIR, densityScale: 0 });
    expect(end.position_N_m[0]).toBeCloseTo(180 * 8, 8);
    expect(end.position_N_m[2]).toBeCloseTo(-1500 + 0.5 * FLIGHT_GRAVITY_M_S2 * 64, 8);
    expect(end.velocity_N_m_s[2]).toBeCloseTo(FLIGHT_GRAVITY_M_S2 * 8, 8);
  });
  it('aerodynamic work is exactly minus drag times airspeed at nonzero alpha and beta', () => {
    const { state, controls } = createTrimmedFlight();
    state.q_BN = smallAngleExp([0.2, -0.1, 0.07]);
    state.velocity_N_m_s = [170, 25, 10];
    const loads = flightLoads(state, controls);
    expect(dot(loads.aeroForce_B_N, loads.airVelocity_B_m_s)).toBeCloseTo(-loads.drag_N * loads.airspeed_m_s, 6);
  });
  it('is Galilean invariant under equal wind and ground-velocity offsets', () => {
    const { state, controls } = createTrimmedFlight();
    const baseline = flightLoads(state, controls);
    const shifted = flightLoads({ ...state, velocity_N_m_s: [200, -12, 3] }, controls, HORNET_PROTOTYPE, { ...STILL_AIR, wind_N_m_s: [20, -12, 3] });
    expect(shifted).toEqual(baseline);
  });
  it('conserves inertial angular momentum and rotational energy with no torque', () => {
    const { state, controls } = createTrimmedFlight();
    state.omega_B_rad_s = [0.31, -0.23, 0.17];
    const env: FlightEnvironment = { ...STILL_AIR, densityScale: 0, gravity_m_s2: 0 };
    const momentum = (s: FlightState): Vec3 => s.omega_B_rad_s.map((v, i) => v * HORNET_PROTOTYPE.inertia_kgm2[i]!) as Vec3;
    const energy = (s: FlightState) => 0.5 * dot(s.omega_B_rad_s, momentum(s));
    const initialWorld = rotateVector(conjugateQuaternion(state.q_BN), momentum(state));
    const end = run(state, controls, 60, env);
    const finalWorld = rotateVector(conjugateQuaternion(end.q_BN), momentum(end));
    expect(Math.abs(energy(end) / energy(state) - 1)).toBeLessThan(1e-8);
    finalWorld.forEach((v, i) => expect(v).toBeCloseTo(initialWorld[i]!, 3));
    expect(Math.hypot(...end.q_BN)).toBeCloseTo(1, 13);
  });
  it('rate damping removes rotational energy at zero alpha and beta', () => {
    const { state, controls } = createTrimmedFlight();
    state.q_BN = [1, 0, 0, 0]; state.omega_B_rad_s = [0.2, -0.3, 0.1];
    const loads = flightLoads(state, { ...controls, trim: 0 });
    expect(dot(loads.moment_B_Nm, state.omega_B_rad_s)).toBeLessThan(0);
  });
  it('starts in a force/moment equilibrium and holds level flight without attitude resets', () => {
    const { state, controls } = createTrimmedFlight();
    const loads = flightLoads(state, controls);
    const forceN = rotateVector(conjugateQuaternion(state.q_BN), loads.force_B_N);
    expect(forceN[0]).toBeCloseTo(0, 7);
    expect(forceN[2] + HORNET_PROTOTYPE.mass_kg * FLIGHT_GRAVITY_M_S2).toBeCloseTo(0, 7);
    expect(Math.hypot(...loads.moment_B_Nm)).toBeLessThan(1e-7);
    const end = run(state, controls, 90);
    expect(end.status).toBe('FLYING');
    expect(end.position_N_m[2]).toBeCloseTo(-1500, 5);
    expect(end.velocity_N_m_s[0]).toBeCloseTo(180, 6);
  });
  it('pilot commands produce the documented pitch, roll and yaw moments', () => {
    const { state, controls } = createTrimmedFlight();
    for (const [axis, index] of [['roll', 0], ['pitch', 1], ['yaw', 2]] as const) {
      const positive = stepFlight(state, { ...controls, [axis]: 0.5 });
      const negative = stepFlight(state, { ...controls, [axis]: -0.5 });
      expect(positive.omega_B_rad_s[index]).toBeGreaterThan(0);
      expect(negative.omega_B_rad_s[index]).toBeLessThan(0);
    }
    expect(flightInstruments(run(state, { ...controls, pitch: 0.5 }, 2), controls).pitch_rad).toBeGreaterThan(flightInstruments(state, controls).pitch_rad);
  });
  it('throttle has lag, increases thrust and accelerates forward', () => {
    const { state, controls } = createTrimmedFlight();
    const end = run(state, { ...controls, throttle: 1 }, 1);
    expect(end.engine).toBeCloseTo(1 + (state.engine - 1) * Math.exp(-1 / HORNET_PROTOTYPE.spoolTime_s), 9);
    expect(end.engine).toBeLessThan(1);
    expect(end.velocity_N_m_s[0]).toBeGreaterThan(state.velocity_N_m_s[0]);
  });
  it('wind and lower density change aerodynamic authority and thrust', () => {
    const { state, controls } = createTrimmedFlight();
    const low = flightLoads(state, controls);
    const high = flightLoads({ ...state, position_N_m: [0, 0, -10000] }, controls);
    expect(high.lift_N).toBeLessThan(low.lift_N);
    expect(high.thrust_N).toBeLessThan(low.thrust_N);
    expect(flightLoads(state, controls, HORNET_PROTOTYPE, { ...STILL_AIR, wind_N_m_s: [-20, 0, 0] }).airspeed_m_s).toBeCloseTo(200, 10);
  });
  it('stays finite at zero airspeed and reverse flow; stall reduces lift and adds drag', () => {
    const { state, controls } = createTrimmedFlight();
    for (const v of [[0, 0, 0], [-10, 0, 0], [0, 30, 0]] as Vec3[]) {
      const loads = flightLoads({ ...state, velocity_N_m_s: v }, controls);
      expect([...loads.force_B_N, ...loads.moment_B_Nm]).toSatisfy((values: number[]) => values.every(Number.isFinite));
    }
    const attached = flightLoads({ ...state, q_BN: smallAngleExp([0, -0.35, 0]) }, controls);
    const stalled = flightLoads({ ...state, q_BN: smallAngleExp([0, -0.7, 0]) }, controls);
    expect(stalled.lift_N).toBeLessThan(attached.lift_N);
    expect(stalled.drag_N).toBeGreaterThan(attached.drag_N);
  });
  it('is deterministic, nonmutating, and latches sea contact and domain exits', () => {
    const { state, controls } = createTrimmedFlight();
    const saved = structuredClone(state);
    expect(run(state, controls, 1)).toEqual(run(state, controls, 1));
    expect(state).toEqual(saved);
    const contact = stepFlight({ ...state, position_N_m: [0, 0, -2.01], velocity_N_m_s: [180, 0, 20] }, controls);
    expect(contact.status).toBe('CONTACT');
    expect(stepFlight(contact, controls)).toBe(contact);
    expect(stepFlight({ ...state, position_N_m: [50001, 0, -1500] }, controls).status).toBe('ENVELOPE');
    expect(stepFlight({ ...state, velocity_N_m_s: [400, 0, 0] }, controls).status).toBe('ENVELOPE');
    expect(() => stepFlight(state, { ...controls, roll: NaN })).toThrow();
    expect(() => stepFlight(state, controls, { ...HORNET_PROTOTYPE, mass_kg: NaN })).toThrow();
    expect(() => stepFlight(state, controls, { ...HORNET_PROTOTYPE, span_m: 0 })).toThrow();
    expect(() => createTrimmedFlight(1500, 50)).toThrow(/trim/);
  });
});

describe('flight trim public boundary', () => {
  it('rejects invalid scalar, vector and physical parameters at creation as well as stepping', () => {
    const baseline = createTrimmedFlight();
    const invalid: Partial<FlightParameters>[] = [
      { mass_kg: NaN }, { inertia_kgm2: [23000, Infinity, 160000] },
      { wingArea_m2: 0 }, { cmTrim: NaN }, { spoolTime_s: -1 },
    ];
    for (const change of invalid) {
      const p = { ...HORNET_PROTOTYPE, ...change };
      expect(() => createTrimmedFlight(1500, 180, p)).toThrow(/invalid flight parameters/);
      expect(() => stepFlight(baseline.state, baseline.controls, p)).toThrow(/invalid flight parameters/);
    }
  });

  it('returns finite neutral trim when zero pitch authority is already balanced', () => {
    const p = { ...HORNET_PROTOTYPE, cmAlpha: 0, cmTrim: 0 };
    const { state, controls } = createTrimmedFlight(1500, 180, p);
    expect(controls.trim).toBe(0);
    expect(Object.values(controls).every(Number.isFinite)).toBe(true);
    const loads = flightLoads(state, controls, p);
    expect(loads.moment_B_Nm).toEqual([0, 0, 0]);
    const force = rotateVector(conjugateQuaternion(state.q_BN), loads.force_B_N);
    expect(force[0]).toBeCloseTo(0, 7);
    expect(force[2] + p.mass_kg * FLIGHT_GRAVITY_M_S2).toBeCloseTo(0, 7);
    let end = state;
    for (let i = 0; i < 100; i++) end = stepFlight(end, controls, p);
    expect(end.status).toBe('FLYING');
    expect(end.position_N_m[2]).toBeCloseTo(state.position_N_m[2], 8);
    expect(end.omega_B_rad_s).toEqual([0, 0, 0]);
  });

  it('admits bisection roundoff for balanced zero-alpha flight with zero trim authority', () => {
    const qs = 0.5 * flightAtmosphere(1500).density_kg_m3 * 180 ** 2 * HORNET_PROTOTYPE.wingArea_m2;
    const p = { ...HORNET_PROTOTYPE, cmTrim: 0, cl0: HORNET_PROTOTYPE.mass_kg * FLIGHT_GRAVITY_M_S2 / qs };
    const { state, controls } = createTrimmedFlight(1500, 180, p);
    expect(controls.trim).toBe(0);
    expect(Math.abs(flightLoads(state, controls, p).moment_B_Nm[1])).toBeLessThan(1e-7);
    expect(stepFlight(state, controls, p).status).toBe('FLYING');
  });

  it('rejects zero authority with an unbalanced pitch moment and insufficient nonzero authority', () => {
    expect(() => createTrimmedFlight(1500, 180, { ...HORNET_PROTOTYPE, cmTrim: 0 })).toThrow(/no pitch trim authority/);
    expect(() => createTrimmedFlight(1500, 180, { ...HORNET_PROTOTYPE, cmTrim: 1e-5 })).toThrow(/control authority/);
  });

  it('rejects nonfinite intermediate calculations and overflowing trim results', () => {
    expect(() => createTrimmedFlight(1500, 180, { ...HORNET_PROTOTYPE, mass_kg: Number.MAX_VALUE })).toThrow(/finite/);
    expect(() => createTrimmedFlight(1500, 180, { ...HORNET_PROTOTYPE, cmTrim: Number.MIN_VALUE })).toThrow(/control authority/);
  });

  it('keeps throttle bounded and supports equal dry/max thrust without division by zero', () => {
    const p = { ...HORNET_PROTOTYPE, maxThrust_N: HORNET_PROTOTYPE.dryThrust_N };
    const { state, controls } = createTrimmedFlight(1500, 180, p);
    expect(Number.isFinite(controls.throttle)).toBe(true);
    expect(controls.throttle).toBeGreaterThan(0);
    expect(controls.throttle).toBeLessThan(0.8);
    expect(stepFlight(state, controls, p).status).toBe('FLYING');
    expect(() => createTrimmedFlight(1500, 180, { ...p, dryThrust_N: 1000, maxThrust_N: 1000 })).toThrow(/thrust authority/);
    expect(() => createTrimmedFlight(1500, 180, { ...p, cd0: -0.1 })).toThrow(/thrust authority/);
  });
});
