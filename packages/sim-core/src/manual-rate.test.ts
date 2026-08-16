import { describe, expect, it } from 'vitest';
import { createFsw } from './fsw.js';
import { hillToBody, smallAngleLog } from './attitude.js';
import { stepTruth } from './dynamics.js';
import { createRng } from './rng.js';
import { createSensorModel } from './sensors.js';
import { applyThrusterCommand } from './thrusters.js';
import type { ManualAuthority } from './control.js';
import type { TruthState, Vec3 } from './types.js';

const TARGET_RATE_DPS = 1.5;
const HIGH_TARGET_RATE_DPS = 8;
const diagonal = (values: number[]): number[][] => values.map((value, row) => values.map((_, column) => row === column ? value : 0));

describe('manual rate control', () => {
  interface ManualRateRun {
    rates_dps: Vec3[];
    offAxisRates_dps: Vec3[];
    offAxisExcursions_deg: number[];
  }

  function runManualRate(authority: ManualAuthority, translation: Vec3 = [0, 0, 0], duration_s = 10): ManualRateRun {
    const fsw = createFsw({
      controller: 'LQR',
      massModel: { dryMass_kg: 976, initialProp_kg: 24 },
      guidanceConfig: { initialState: [0, -220, 12, 0, 0, 0] },
      ekfConfig: {
        initialNavPrior: { state: [0, -220, 12, 0, 0, 0], covariance: diagonal([10_000, 10_000, 10_000, 10, 10, 10]) },
        q: diagonal([0, 0, 0, 0, 0, 0]),
      },
      allocatorConfig: { fswHz: 10, truthHz: 100 },
      attitudeControllerConfig: { initialManualAuthority: authority },
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
    fsw.setManualCommand({ translation, rotation: [1, 0, 0] });
    const rates_dps: Vec3[] = [];
    const offAxisRates_dps: Vec3[] = [];
    const offAxisExcursions_deg: number[] = [];
    for (let tick = 0; tick < duration_s * 10; tick += 1) {
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
      rates_dps.push(truth.w_body_rps.map((value) => value * 180 / Math.PI) as Vec3);
      offAxisRates_dps.push([rates_dps.at(-1)![1], rates_dps.at(-1)![2], 0]);
      const offAxisAttitude_rad = smallAngleLog(hillToBody(truth.q_BI, truth.t_s));
      offAxisExcursions_deg.push(Math.hypot(offAxisAttitude_rad[1], offAxisAttitude_rad[2]) * 180 / Math.PI);
    }
    return { rates_dps, offAxisRates_dps, offAxisExcursions_deg };
  }

  it('preserves LOW manual rate behavior and reaches the commanded rate', () => {
    const run = runManualRate('LOW', [0, 0, 0], 4);
    const minimumAcceptedRate_dps = 0.8 * TARGET_RATE_DPS;
    expect(run.rates_dps[29]![0]).toBeGreaterThanOrEqual(minimumAcceptedRate_dps);
    expect(run.rates_dps.every((rate) => rate[0] <= 1.8)).toBe(true);
  });

  it('reaches and holds the HIGH commanded rate within the acceptance bounds', () => {
    const run = runManualRate('HIGH', [0, 0, 0], 10);
    const minimumAcceptedRate_dps = 0.9 * HIGH_TARGET_RATE_DPS;
    expect(run.rates_dps.slice(0, 15).some((rate) => rate[0] >= minimumAcceptedRate_dps)).toBe(true);
    expect(Math.max(...run.rates_dps.map((rate) => rate[0]))).toBeLessThanOrEqual(1.1 * HIGH_TARGET_RATE_DPS);
    expect(run.rates_dps.slice(29).every((rate) => Math.abs(rate[0] - HIGH_TARGET_RATE_DPS) <= 0.05 * HIGH_TARGET_RATE_DPS)).toBe(true);
  });

  it('preserves torque tracking and avoids tumble with HIGH translation demand', () => {
    const baseline = runManualRate('HIGH', [0, 0, 0], 20);
    const combined = runManualRate('HIGH', [0, 1, 0], 20);
    expect(combined.rates_dps[29]![0]).toBeGreaterThanOrEqual(0.85 * baseline.rates_dps[29]![0]!);
    expect(combined.offAxisRates_dps.flatMap((rate) => rate.slice(0, 2)).every((rate) => Math.abs(rate) < 1)).toBe(true);
    expect(Math.max(...combined.offAxisExcursions_deg)).toBeLessThan(15);
  });
});
