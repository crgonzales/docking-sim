import {
  DEFAULT_DRY_MASS_KG,
  smallAngleExp,
  type SimConfig,
} from '@docking/sim-core';
import type { InitialConditions } from './schema.js';

const DEG_TO_RAD = Math.PI / 180;
const SANDBOX_NAV_COVARIANCE: number[][] = [
  [10_000, 0, 0, 0, 0, 0],
  [0, 10_000, 0, 0, 0, 0],
  [0, 0, 10_000, 0, 0, 0],
  [0, 0, 0, 10, 0, 0],
  [0, 0, 0, 0, 10, 0],
  [0, 0, 0, 0, 0, 10],
];

function cloneMatrix(matrix: number[][]): number[][] {
  return matrix.map((row) => [...row]);
}

/** Convert schema-bound degrees and scenario initial conditions into SimConfig SI units. */
export function scenarioToSimConfig(initial: InitialConditions): SimConfig {
  const initialState = [
    ...initial.rel_position_m,
    ...initial.rel_velocity_mps,
  ] as [number, number, number, number, number, number];
  const attitudeError_rad = initial.attitude_error_deg.map((value) => value * DEG_TO_RAD) as [number, number, number];
  const bodyRates_rps = initial.body_rates_dps.map((value) => value * DEG_TO_RAD) as [number, number, number];
  // At scenario epoch t=0, Hill and inertial axes coincide and the nominal
  // docking-port-forward LVLH hold is q_BH = identity.
  const q_BI = smallAngleExp(attitudeError_rad);

  return {
    initial: {
      r_hill_m: [...initial.rel_position_m],
      v_hill_mps: [...initial.rel_velocity_mps],
      q_BI,
      w_body_rps: bodyRates_rps,
      prop_kg: initial.prop_kg,
    },
    fsw: {
      controller: initial.controller,
      massModel: {
        dryMass_kg: DEFAULT_DRY_MASS_KG,
        initialProp_kg: initial.prop_kg,
      },
      guidanceConfig: { initialState },
      ekfConfig: {
        initialNavPrior: {
          state: [...initialState],
          covariance: cloneMatrix(SANDBOX_NAV_COVARIANCE),
        },
      },
      // Keep scenario normalized manual commands on the legacy LOW preset.
      // Pin the level only so a mission operator can still switch to HIGH;
      // manual limit overrides would outrank the authority presets.
      attitudeControllerConfig: {
        initialManualAuthority: 'LOW',
      },
      // No mekfConfig: like the sandbox config, the MEKF lazy-initializes
      // from the first star-tracker sample rather than a truth-known prior.
    },
  };
}
