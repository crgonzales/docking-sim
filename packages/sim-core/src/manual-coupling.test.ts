import { describe, expect, it } from 'vitest';
import { hillToBody, smallAngleLog } from './attitude.js';
import { createSimLoop, type SimConfig } from './sim.js';

const DEG_PER_RAD = 180 / Math.PI;
const initialState: [number, number, number, number, number, number] = [0, -250, 12, 0, 0, 0];

function config(): SimConfig {
  return {
    initial: {
      r_hill_m: [0, -250, 12],
      v_hill_mps: [0, 0, 0],
      prop_kg: 24,
      q_BI: [1, 0, 0, 0],
    },
    fsw: {
      controller: 'LQR',
      massModel: { dryMass_kg: 976, initialProp_kg: 24 },
      guidanceConfig: { initialState },
      ekfConfig: {
        initialNavPrior: {
          state: [...initialState],
          covariance: [
            [10_000, 0, 0, 0, 0, 0],
            [0, 10_000, 0, 0, 0, 0],
            [0, 0, 10_000, 0, 0, 0],
            [0, 0, 0, 10, 0, 0],
            [0, 0, 0, 0, 10, 0],
            [0, 0, 0, 0, 0, 10],
          ],
        },
      },
    },
  };
}

/**
 * Regression for the "pressing W pitches the ship" defect: a pure manual
 * translation command must not produce a significant attitude excursion —
 * the canted-jet force/torque coupling has to be absorbed by the 6-target
 * allocator and the attitude hold, in both RATE and PULSE sub-modes.
 */
describe('manual translation / attitude coupling', () => {
  for (const subMode of ['RATE', 'PULSE'] as const) {
    it(`${subMode}: 20 s of pure forward translation keeps attitude within 2 deg`, () => {
      const sim = createSimLoop(config(), 424_242);
      sim.stepTo(5); // settle AUTO hold first
      sim.setControlMode('MANUAL');
      sim.setManualSubMode(subMode);
      sim.setManualCommand({ translation: [0, 1, 0], rotation: [0, 0, 0] });
      let maxExcursion_deg = 0;
      for (let t = 5.5; t <= 25; t += 0.5) {
        sim.stepTo(t);
        const truth = sim.getTruthState();
        const q_BH = hillToBody(truth.q_BI, truth.t_s);
        const excursion_deg = Math.hypot(...smallAngleLog(q_BH)) * DEG_PER_RAD;
        maxExcursion_deg = Math.max(maxExcursion_deg, excursion_deg);
      }
      console.log(`${subMode} max attitude excursion: ${maxExcursion_deg.toFixed(2)} deg`);
      expect(maxExcursion_deg).toBeLessThan(2);
    }, 30_000);
  }
});
