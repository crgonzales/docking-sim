import { CORRIDOR, corridorError_m, corridorErrorOuter_m } from './corridor.js';
import type { State6 } from './ekf.js';
import type { Vec3 } from './types.js';

export type AbortState = 'ARMED' | 'BURNING' | 'COASTING';

export interface CorridorMonitorConfig {
  abortDuration_s?: number;
  hysteresis_m?: number;
  dt_s?: number;
}

export interface CorridorMonitorResult {
  corridor_err_m: number;
  corridor_outer_err_m: number;
  caution: boolean;
  abortTrigger: boolean;
  sustainedViolation: boolean;
  outerViolation: boolean;
  violationDuration_s: number;
}

export interface CorridorMonitor {
  corridorMonitor(navState: State6, dt_s?: number): CorridorMonitorResult;
  reset(): void;
}

export interface SafingBurn {
  deltaV_hill_mps: Vec3;
  targetVelocity_hill_mps: Vec3;
}

/**
 * Create the stateful two-level corridor monitor. Caution uses a 0.5 m
 * engage/release band; the sustained timer only runs while the excursion is
 * continuously nonzero, while the hard outer surface is an immediate trigger.
 */
export function createCorridorMonitor(config: CorridorMonitorConfig = {}): CorridorMonitor {
  const abortDuration_s = config.abortDuration_s ?? 15;
  const hysteresis_m = config.hysteresis_m ?? 0.5;
  const defaultDt_s = config.dt_s ?? 0.1;
  if (!(abortDuration_s > 0) || !Number.isFinite(abortDuration_s)) throw new RangeError('abortDuration_s must be positive and finite');
  if (!(hysteresis_m >= 0) || !Number.isFinite(hysteresis_m)) throw new RangeError('hysteresis_m must be finite and non-negative');
  if (!(defaultDt_s > 0) || !Number.isFinite(defaultDt_s)) throw new RangeError('dt_s must be positive and finite');
  let caution = false;
  let violationDuration_s = 0;

  return {
    corridorMonitor(navState, dt_s = defaultDt_s) {
      if (navState.length !== 6 || navState.some((value) => !Number.isFinite(value))) throw new RangeError('navState must be a finite six-state vector');
      if (!(dt_s > 0) || !Number.isFinite(dt_s)) throw new RangeError('dt_s must be positive and finite');
      const position: Vec3 = [navState[0], navState[1], navState[2]];
      // The corridor only exists inside the engagement range: a vehicle at
      // far range (or on the wrong side of the station) is not "violating"
      // an approach corridor it hasn't entered — evaluating the cones there
      // would abort every mission at the far-range starting point.
      const rangeFromPort_m = Math.hypot(
        position[0] - CORRIDOR.apex_hill_m[0],
        position[1] - CORRIDOR.apex_hill_m[1],
        position[2] - CORRIDOR.apex_hill_m[2],
      );
      const engaged = position[1] < CORRIDOR.apex_hill_m[1] && rangeFromPort_m <= CORRIDOR.engagementRange_m;
      if (!engaged) {
        caution = false;
        violationDuration_s = 0;
        return {
          corridor_err_m: 0,
          corridor_outer_err_m: 0,
          caution: false,
          abortTrigger: false,
          sustainedViolation: false,
          outerViolation: false,
          violationDuration_s: 0,
        };
      }
      const corridor_err_m = corridorError_m(position);
      const corridor_outer_err_m = corridorErrorOuter_m(position);
      if (caution) {
        if (corridor_err_m <= 0) caution = false;
      } else if (corridor_err_m > hysteresis_m) {
        caution = true;
      }
      if (corridor_err_m > 0) violationDuration_s += dt_s;
      else violationDuration_s = 0;
      const outerViolation = corridor_outer_err_m > 0;
      const sustainedViolation = violationDuration_s >= abortDuration_s;
      return {
        corridor_err_m,
        corridor_outer_err_m,
        caution,
        abortTrigger: sustainedViolation || outerViolation,
        sustainedViolation,
        outerViolation,
        violationDuration_s,
      };
    },
    reset() {
      caution = false;
      violationDuration_s = 0;
    },
  };
}

/**
 * Compute the desired ΔV for passive safety. The target imposes the CW
 * non-drift condition v_y = -2 n x and adds 0.02 m/s radially away from the
 * station, making d(range)/dt positive at the abort epoch.
 */
export function computeSafingBurn(navState: State6, meanMotionRadS: number): SafingBurn {
  if (navState.length !== 6 || navState.some((value) => !Number.isFinite(value))) throw new RangeError('navState must be a finite six-state vector');
  if (!Number.isFinite(meanMotionRadS) || meanMotionRadS < 0) throw new RangeError('meanMotionRadS must be finite and non-negative');
  const rangeVector: Vec3 = [navState[0], navState[1], navState[2]];
  const range_m = Math.hypot(...rangeVector);
  const awayDirection: Vec3 = range_m > 1e-9
    ? [rangeVector[0] / range_m, rangeVector[1] / range_m, rangeVector[2] / range_m]
    : [0, -1, 0];
  const targetVelocity_hill_mps: Vec3 = [
    0.02 * awayDirection[0],
    -2 * meanMotionRadS * navState[0] + 0.02 * awayDirection[1],
    0.02 * awayDirection[2],
  ];
  const deltaV_hill_mps: Vec3 = [
    targetVelocity_hill_mps[0] - navState[3],
    targetVelocity_hill_mps[1] - navState[4],
    targetVelocity_hill_mps[2] - navState[5],
  ];
  return { deltaV_hill_mps, targetVelocity_hill_mps };
}
