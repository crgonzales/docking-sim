import type { State6 } from './ekf.js';
import type { Vec3 } from './types.js';

export interface GuidanceConfig {
  initialState: State6;
  holdPoint_m?: number;
  closingGain_s_inv?: number;
  maxClosingSpeed_mps?: number;
}

export interface GuidanceReference {
  t_s: number;
  r_hill_m: Vec3;
  v_hill_mps: Vec3;
  state: State6;
}

export interface GuidanceProfile {
  readonly closingRate_s_inv: number;
  reference(t_s: number): GuidanceReference;
}

function validateConfig(config: GuidanceConfig): void {
  const holdPoint_m = config.holdPoint_m ?? 30;
  const closingGain_s_inv = config.closingGain_s_inv ?? 0.01;
  const maxClosingSpeed_mps = config.maxClosingSpeed_mps ?? 0.5;
  if (![holdPoint_m, closingGain_s_inv, maxClosingSpeed_mps].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new RangeError('guidance parameters must be finite and non-negative');
  }
  if (config.initialState.length !== 6 || config.initialState.some((value) => !Number.isFinite(value))) {
    throw new RangeError('guidance initialState must be a finite six-state vector');
  }
}

/**
 * Create a V-bar glideslope profile. Position error follows a critically
 * damped exponential toward [0, -holdPoint_m, 0], with closing speed capped
 * at the configured approach limit and proportional near the hold point.
 */
export function createGuidance(config: GuidanceConfig): GuidanceProfile {
  validateConfig(config);
  const holdPoint_m = config.holdPoint_m ?? 30;
  const closingGain_s_inv = config.closingGain_s_inv ?? 0.01;
  const maxClosingSpeed_mps = config.maxClosingSpeed_mps ?? 0.5;
  const initialState = [...config.initialState] as State6;
  const holdPosition: Vec3 = [0, -holdPoint_m, 0];
  const initialError: Vec3 = [
    initialState[0] - holdPosition[0],
    initialState[1] - holdPosition[1],
    initialState[2] - holdPosition[2],
  ];
  const initialRangeToHold_m = Math.hypot(...initialError);
  const closingRate_s_inv = initialRangeToHold_m > 0
    ? Math.min(closingGain_s_inv, maxClosingSpeed_mps / initialRangeToHold_m)
    : 0;

  return {
    closingRate_s_inv,
    reference(t_s) {
      if (t_s < 0 || !Number.isFinite(t_s)) throw new RangeError('t_s must be finite and non-negative');
      const decay = Math.exp(-closingRate_s_inv * t_s);
      const position: Vec3 = [0, 0, 0];
      const velocity: Vec3 = [0, 0, 0];
      for (let axis = 0; axis < 3; axis += 1) {
        const initialVelocity = initialState[axis + 3]!;
        const c = initialVelocity + closingRate_s_inv * initialError[axis]!;
        position[axis] = holdPosition[axis]! + (initialError[axis]! + c * t_s) * decay;
        velocity[axis] = (initialVelocity - closingRate_s_inv * c * t_s) * decay;
      }
      const state: State6 = [position[0], position[1], position[2], velocity[0], velocity[1], velocity[2]];
      return { t_s, r_hill_m: position, v_hill_mps: velocity, state };
    },
  };
}

/** Stateless convenience wrapper for one guidance reference. */
export function vBarReference(config: GuidanceConfig, t_s: number): GuidanceReference {
  return createGuidance(config).reference(t_s);
}

