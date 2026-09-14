import type { SimConfig } from '@docking/sim-core';
import type { Scenario } from '../schema.js';
import { scenarioToSimConfig } from '../scenarioToSimConfig.js';
import { FINAL_APPROACH_01 } from './finalApproach01.js';

/** Each retry is a fresh prepared scenario, including the final two-metre practice. */
export function createFirstDockingScenario(start: 'APPROACH' | 'FINAL' = 'APPROACH'): Scenario {
  return {
    schema_version: 1,
    id: 'FIRST_DOCKING_01',
    title: 'First docking',
    briefing: start === 'FINAL'
      ? 'Practise the final two metres from a stationary, aligned start. ' +
        'Use precision forward input to approach the port and make a gentle capture.'
      : 'Dock with the station from six metres away. Align with the port, ' +
        'approach slowly, and use precision input for the final capture.',
    seed: 20260911,
    clock: { duration_s: 1200, label: 'PRACTICE T-', expiry_outcome: 'WINDOW_MISSED' },
    initial: {
      rel_position_m: start === 'FINAL' ? [0, -12.4, 0] : [0.25, -16.4, 0.15],
      rel_velocity_mps: [0, 0, 0],
      attitude_error_deg: [0, 0, 0],
      body_rates_dps: [0, 0, 0],
      controller: 'LQR',
      control_mode: 'MANUAL',
      nav_source: 'PRIMARY',
      prop_kg: 24,
    },
    monitors: {
      ...FINAL_APPROACH_01.monitors,
      capture_envelope: {
        ...FINAL_APPROACH_01.monitors.capture_envelope,
        closing_mps: [...FINAL_APPROACH_01.monitors.capture_envelope.closing_mps],
      },
    },
    beats: [],
    outcomes: {
      DOCKED: { id: 'DOCKED', title: 'DOCKING COMPLETE',
        debrief: 'Capture confirmed inside the docking envelope.' },
      PASSIVE_ABORT: { id: 'PASSIVE_ABORT', title: 'APPROACH ABORTED',
        debrief: 'The approach left the safe corridor. Retry and keep the port aligned.' },
      COLLISION: { id: 'COLLISION', title: 'CONTACT OUTSIDE ENVELOPE',
        debrief: 'Retry with a slower closing speed and check alignment before contact.' },
      WINDOW_MISSED: { id: 'WINDOW_MISSED', title: 'PRACTICE TIME COMPLETE',
        debrief: 'The practice limit was reached. Retry the approach or the final two metres.' },
    },
    scoring: {
      weights: { ...FINAL_APPROACH_01.scoring.weights },
      grade_bounds: { ...FINAL_APPROACH_01.scoring.grade_bounds },
    },
    assist_default: 'GUIDED',
  };
}

export const FIRST_DOCKING_01: Scenario = createFirstDockingScenario();

/** The introductory RATE hold prioritizes angular-rate damping. The shared
 * LOW gains were underdamped for this vehicle: quantized translation pulses
 * excited >0.15 deg/s rotation with no pilot rotation input. For I=[600,400,600]
 * and quaternion-vector Kp=[120,80,120], critical Kd=2*sqrt(I*Kp/2), about
 * [380,253,380]. Overdamping at [1200,800,1200] makes the angular velocity
 * response faster (I/Kd = 0.5 s) while attitude alignment settles gradually.
 * This damps the pulse-induced rotation during precision translation. Vehicle, pulse sizes,
 * sensor noise and physical capture limits remain shared and unchanged.
 */
export function createFirstDockingConfig(scenario: Scenario): SimConfig {
  const config = scenarioToSimConfig(scenario.initial);
  config.fsw.attitudeControllerConfig = {
    ...config.fsw.attitudeControllerConfig,
    manualKd_Nms_per_rad: [1200, 800, 1200],
  };
  return config;
}
