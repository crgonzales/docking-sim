import { describe, expect, it } from 'vitest';
import { createFsw } from './fsw.js';
import { stepTruth } from './dynamics.js';
import { createRng } from './rng.js';
import { createSensorModel } from './sensors.js';
import { applyThrusterCommand } from './thrusters.js';
import type { TruthState } from './types.js';

const TARGET_RATE_DPS = 1.5;
const diagonal = (values: number[]): number[][] => values.map((value, row) => values.map((_, column) => row === column ? value : 0));

describe('manual rate control', () => {
  it('reaches and sustains at least 80% of full pitch rate within 3 seconds', () => {
    const fsw = createFsw({
      controller: 'LQR',
      massModel: { dryMass_kg: 976, initialProp_kg: 24 },
      guidanceConfig: { initialState: [0, -220, 12, 0, 0, 0] },
      ekfConfig: {
        initialNavPrior: { state: [0, -220, 12, 0, 0, 0], covariance: diagonal([10_000, 10_000, 10_000, 10, 10, 10]) },
        q: diagonal([0, 0, 0, 0, 0, 0]),
      },
      allocatorConfig: { fswHz: 10, truthHz: 100 },
    });
    const sensors = createSensorModel({
      range_sigma_floor_m: 0,
      range_sigma_scale: 0,
      bearing_sigma_rad: 0,
      gyro_sigma_rps: 0,
      attitude_sigma_rad: 0,
    }, createRng(20260806));
    let truth: TruthState = {
      t_s: 0,
      r_hill_m: [0, -220, 12],
      v_hill_mps: [0, 0, 0],
      q_BI: [1, 0, 0, 0],
      w_body_rps: [0, 0, 0],
      prop_kg: 24,
    };
    fsw.setControlMode('MANUAL');
    fsw.setManualSubMode('RATE');
    fsw.setManualCommand({ translation: [0, 0, 0], rotation: [1, 0, 0] });
    const pitchRates_dps: number[] = [];
    for (let tick = 0; tick < 40; tick += 1) {
      const output = fsw(sensors.sample({ ...truth, t_s: tick * 0.1 }));
      const application = applyThrusterCommand(output.thrusters, { prop_kg: truth.prop_kg, window_s: 0.1, truthHz: 100 });
      for (let truthTick = 0; truthTick < 10; truthTick += 1) {
        truth = stepTruth(truth, {
          dt_s: 0.01,
          externalSpecificForce_body_mps2: application.specificForce_body_mps2,
          torque_body_Nm: application.torque_Nm,
          propellantRate_kg_s: application.propellantRate_kg_s,
        });
      }
      pitchRates_dps.push(truth.w_body_rps[0] * 180 / Math.PI);
    }

    const minimumAcceptedRate_dps = 0.8 * TARGET_RATE_DPS;
    expect(pitchRates_dps[29]).toBeGreaterThanOrEqual(minimumAcceptedRate_dps);
    expect(pitchRates_dps.slice(30).every((rate) => rate >= minimumAcceptedRate_dps && rate <= 1.8)).toBe(true);
  });
});
