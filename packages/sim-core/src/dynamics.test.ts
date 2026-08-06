import { describe, expect, it } from 'vitest';
import { propagateCW } from './cw.js';
import { MEAN_MOTION_RAD_S, ORBIT_RADIUS_M, stepTruth } from './dynamics.js';
import { TRUTH_HZ } from './constants.js';
import type { TruthState } from './types.js';

const initialState: TruthState = {
  t_s: 0,
  r_hill_m: [12, -250, 7],
  v_hill_mps: [0.02, 0.85, -0.05],
  q_BI: [1, 0, 0, 0],
  w_body_rps: [0, 0, MEAN_MOTION_RAD_S],
  prop_kg: 24,
};

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

  it('adds external specific force, depletes propellant, and preserves quaternion norm', () => {
    const next = stepTruth(initialState, {
      externalSpecificForce_hill_mps2: [0.1, 0, 0],
      propellantRate_kg_s: 2,
    });
    expect(next.v_hill_mps[0]).toBeGreaterThan(initialState.v_hill_mps[0]);
    expect(next.prop_kg).toBeCloseTo(24 - 2 / TRUTH_HZ, 12);
    expect(Math.hypot(...next.q_BI)).toBeCloseTo(1, 14);
    expect(next.w_body_rps).toEqual([0, 0, MEAN_MOTION_RAD_S]);
  });
});

