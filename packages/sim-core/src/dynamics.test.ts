import { describe, expect, it } from 'vitest';
import { conjugateQuaternion, rotateVector } from './attitude.js';
import { propagateCW } from './cw.js';
import { MEAN_MOTION_RAD_S, ORBIT_RADIUS_M, stepTruth } from './dynamics.js';
import { TRUTH_HZ } from './constants.js';
import type { TruthState, Vec3 } from './types.js';

const initialState: TruthState = {
  t_s: 0,
  r_hill_m: [12, -250, 7],
  v_hill_mps: [0.02, 0.85, -0.05],
  q_BI: [1, 0, 0, 0],
  w_body_rps: [0, 0, MEAN_MOTION_RAD_S],
  prop_kg: 24,
};

function zeroTranslationState(w_body_rps: Vec3, q_BI: [number, number, number, number] = [1, 0, 0, 0]): TruthState {
  return {
    t_s: 0,
    r_hill_m: [0, 0, 0],
    v_hill_mps: [0, 0, 0],
    q_BI,
    w_body_rps,
    prop_kg: 24,
  };
}

describe('truth dynamics', () => {
  it('uses the 400 km orbit radius and matches the CW oracle over multiple orbits', () => {
    expect(ORBIT_RADIUS_M).toBe(6_771_000);
    const duration_s = 2 * 2 * Math.PI / MEAN_MOTION_RAD_S;
    const steps = Math.round(duration_s * TRUTH_HZ);
    let state = initialState;
    for (let i = 0; i < steps; i += 1) state = stepTruth(state);

    const oracle = propagateCW(initialState.r_hill_m, initialState.v_hill_mps, MEAN_MOTION_RAD_S, steps / TRUTH_HZ);
    state.r_hill_m.forEach((value, index) => expect(value).toBeCloseTo(oracle.r[index]!, 5));
    state.v_hill_mps.forEach((value, index) => expect(value).toBeCloseTo(oracle.v[index]!, 7));
  });

  it('matches the closed form for a torque-free single-axis spin', () => {
    const rate_rps = 0.37;
    const dt_s = 0.01;
    const steps = 1_000;
    let state = zeroTranslationState([0, 0, rate_rps]);
    for (let i = 0; i < steps; i += 1) state = stepTruth(state, { dt_s });
    const angle = rate_rps * steps * dt_s / 2;
    expect(state.w_body_rps).toEqual([0, 0, rate_rps]);
    expect(state.q_BI[0]).toBeCloseTo(Math.cos(angle), 12);
    expect(state.q_BI[3]).toBeCloseTo(-Math.sin(angle), 12);
  });

  it('conserves the full inertial angular-momentum vector during asymmetric torque-free spin', () => {
    const inertia = [600, 400, 500] as Vec3;
    const initialRate: Vec3 = [0.013, -0.021, 0.017];
    let state = zeroTranslationState(initialRate, [0.91, 0.12, -0.23, 0.31]);
    const initialMomentumBody: Vec3 = [
      inertia[0] * initialRate[0], inertia[1] * initialRate[1], inertia[2] * initialRate[2],
    ];
    const initialMomentumInertial = rotateVector(conjugateQuaternion(state.q_BI), initialMomentumBody);
    for (let i = 0; i < 10_000; i += 1) state = stepTruth(state, { dt_s: 0.01, inertia_kg_m2: inertia });
    const finalMomentumBody: Vec3 = [
      inertia[0] * state.w_body_rps[0], inertia[1] * state.w_body_rps[1], inertia[2] * state.w_body_rps[2],
    ];
    const finalMomentumInertial = rotateVector(conjugateQuaternion(state.q_BI), finalMomentumBody);
    finalMomentumInertial.forEach((value, index) => expect(value).toBeCloseTo(initialMomentumInertial[index]!, 10));
  });

  it('keeps quaternion norm drift below 1e-9 over 1e4 steps', () => {
    let state = zeroTranslationState([0.013, -0.021, 0.017]);
    for (let i = 0; i < 10_000; i += 1) state = stepTruth(state, { dt_s: 0.01 });
    expect(Math.abs(Math.hypot(...state.q_BI) - 1)).toBeLessThan(1e-9);
  });

  it('rotates body force into Hill axes and still handles zero-force CW drift', () => {
    const next = stepTruth(initialState, {
      externalSpecificForce_body_mps2: [0.1, 0, 0],
      torque_body_Nm: [0, 0, 0],
      propellantRate_kg_s: 2,
    });
    expect(next.v_hill_mps[0]).toBeGreaterThan(initialState.v_hill_mps[0]);
    expect(next.prop_kg).toBeCloseTo(24 - 2 / TRUTH_HZ, 12);
    expect(Math.hypot(...next.q_BI)).toBeCloseTo(1, 14);

    const duration_s = 30;
    const steps = duration_s * TRUTH_HZ;
    let free = initialState;
    for (let i = 0; i < steps; i += 1) free = stepTruth(free);
    const oracle = propagateCW(initialState.r_hill_m, initialState.v_hill_mps, MEAN_MOTION_RAD_S, duration_s);
    free.r_hill_m.forEach((value, index) => expect(value).toBeCloseTo(oracle.r[index]!, 9));
    free.v_hill_mps.forEach((value, index) => expect(value).toBeCloseTo(oracle.v[index]!, 11));
  });
});
