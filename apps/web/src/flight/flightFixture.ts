import type { FlightControls, FlightEnvironment, FlightState } from '@docking/sim-core';

export interface FlightFixture {
  readonly name: 'cloud-base';
  readonly state: FlightState;
  readonly controls: FlightControls;
  readonly environment: FlightEnvironment;
  readonly camera: 'CHASE' | 'NOSE';
}

/** Captured from .evidence.local/cloud-grain-flight-state.json. */
export const CLOUD_BASE_FLIGHT_FIXTURE: FlightFixture = {
  name: 'cloud-base',
  state: {
    time_s: 91.92000000001012,
    position_N_m: [16919.246756102955, -3313.6198603322237, -2830.04619757017],
    velocity_N_m_s: [236.31836020788631, -149.9073753966238, -4.097947063644549],
    q_BN: [0.9275885354504654, 0.24243753238034757, -0.0888771326637007, 0.2700081611427094],
    omega_B_rad_s: [0.004372817117905823, 0.04724816426893771, -0.018056449379367755],
    engine: 0.9453308639072342,
    status: 'FLYING',
  },
  controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.9453308645903385, trim: 0.03850735576592985 },
  environment: { wind_N_m_s: [0, 0, 0], gravity_m_s2: 9.80665, densityScale: 1 },
  camera: 'CHASE',
};
