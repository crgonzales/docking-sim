import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DRY_MASS_KG,
  DEFAULT_ISP_S,
  DEFAULT_MIN_ON_TIME_S,
  DRACO_THRUSTER_SPECS,
  G0_MPS2,
  applyThrusterCommand,
  quantizeOnTime,
} from './thrusters.js';
import type { TruthState } from './types.js';
import { applyThrusterCommandToTruth } from './thrusters.js';

describe('Draco-like thruster model', () => {
  it('contains four canted four-jet clusters with SI geometry', () => {
    expect(DRACO_THRUSTER_SPECS).toHaveLength(16);
    expect(new Set(DRACO_THRUSTER_SPECS.map((jet) => jet.id)).size).toBe(16);
    for (const jet of DRACO_THRUSTER_SPECS) {
      expect(jet.thrust_N).toBe(25);
      expect(Math.hypot(...jet.direction_body)).toBeCloseTo(1, 14);
      expect(jet.direction_body.some((component) => Math.abs(component) > 0 && Math.abs(component) < 1)).toBe(true);
    }
  });

  it('enforces the 20 ms minimum and quantizes to 100 Hz truth ticks', () => {
    expect(quantizeOnTime(0.019)).toBe(0);
    expect(quantizeOnTime(0.020)).toBeCloseTo(0.02, 14);
    expect(quantizeOnTime(0.025)).toBeCloseTo(0.03, 14);
    const command = { J1: 0.025 };
    const application = applyThrusterCommand(command, { window_s: 0.1 });
    expect(application.quantizedOnTime_s.J1).toBeCloseTo(0.03, 14);
    expect(application.activeOnTime_s.J1).toBeCloseTo(0.03, 14);
  });

  it('depletes propellant from summed thrust at mdot = F/(Isp*g0)', () => {
    const application = applyThrusterCommand({ J1: 0.02 }, { window_s: 0.02, prop_kg: 24 });
    const expectedUsed = 25 * DEFAULT_MIN_ON_TIME_S / (DEFAULT_ISP_S * G0_MPS2);
    expect(application.propellantUsed_kg).toBeCloseTo(expectedUsed, 14);
    expect(application.propellantRate_kg_s).toBeCloseTo(expectedUsed / 0.02, 14);
    expect(application.force_N[0]).not.toBe(0);
    expect(application.specificForce_hill_mps2[0]).toBeCloseTo(
      application.force_N[0] / (DEFAULT_DRY_MASS_KG + 24),
      14,
    );
  });

  it('honors isolated, closed, and open failure states during truth application', () => {
    const command = { J1: 0, J2: 0, J3: 0, J4: 0 };
    const application = applyThrusterCommand(command, {
      window_s: 0.1,
      states: { J1: 'stuck_open', J2: 'isolated', J3: 'stuck_closed' },
    });
    expect(application.activeOnTime_s.J1).toBeCloseTo(0.1, 14);
    expect(application.activeOnTime_s.J2).toBe(0);
    expect(application.activeOnTime_s.J3).toBe(0);

    const state: TruthState = {
      t_s: 0,
      r_hill_m: [0, 0, 0],
      v_hill_mps: [0, 0, 0],
      q_BI: [1, 0, 0, 0],
      w_body_rps: [0, 0, 0],
      prop_kg: 24,
    };
    const truthResult = applyThrusterCommandToTruth(state, command, {
      window_s: 0.01,
      states: { J1: 'stuck_open' },
    });
    expect(truthResult.state.t_s).toBeCloseTo(0.01, 14);
    expect(truthResult.state.prop_kg).toBeLessThan(24);
  });
});
