import { describe, expect, it } from 'vitest';
import { CORRIDOR, corridorError_m } from './corridor.js';
import { propagateCW } from './cw.js';
import { DEFAULT_MEAN_MOTION_RAD_S } from './attitude.js';
import { computeSafingBurn, createCorridorMonitor } from './monitors.js';
import type { State6 } from './ekf.js';

const N = DEFAULT_MEAN_MOTION_RAD_S;

function outsidePoint(angle_deg: number, axialDistance_m = 20): State6 {
  return [
    axialDistance_m * Math.tan(angle_deg * Math.PI / 180),
    CORRIDOR.apex_hill_m[1] - axialDistance_m,
    0,
    0,
    0,
    0,
  ];
}

describe('corridor monitor', () => {
  it('raises caution with hysteresis and clears only after re-entry', () => {
    const monitor = createCorridorMonitor({ dt_s: 0.1, hysteresis_m: 0.5 });
    expect(monitor.corridorMonitor([0, -50, 0, 0, 0, 0]).caution).toBe(false);
    expect(monitor.corridorMonitor(outsidePoint(10.2)).caution).toBe(false);
    expect(monitor.corridorMonitor(outsidePoint(14)).caution).toBe(true);
    expect(monitor.corridorMonitor(outsidePoint(10.2)).caution).toBe(true);
    expect(monitor.corridorMonitor([0, -50, 0, 0, 0, 0]).caution).toBe(false);
  });

  it('triggers only after fifteen seconds of continuous violation', () => {
    const monitor = createCorridorMonitor({ dt_s: 0.1, abortDuration_s: 15 });
    const state = outsidePoint(11);
    let result = monitor.corridorMonitor(state);
    for (let tick = 1; tick < 150; tick += 1) result = monitor.corridorMonitor(state);
    expect(result.sustainedViolation).toBe(false);
    result = monitor.corridorMonitor(state);
    expect(result.sustainedViolation).toBe(true);
    expect(result.abortTrigger).toBe(true);
  });

  it('triggers immediately on the hard outer cone', () => {
    const result = createCorridorMonitor().corridorMonitor(outsidePoint(20));
    expect(result.outerViolation).toBe(true);
    expect(result.abortTrigger).toBe(true);
  });
});

describe('safing burn passive-safety oracle', () => {
  it('keeps a violating state outside the abort keep-out radius for two orbits', () => {
    const initial: State6 = [20, -100, 5, 0, 0.5, 0];
    const burn = computeSafingBurn(initial, N);
    const postBurn: State6 = [
      initial[0], initial[1], initial[2],
      initial[3] + burn.deltaV_hill_mps[0],
      initial[4] + burn.deltaV_hill_mps[1],
      initial[5] + burn.deltaV_hill_mps[2],
    ];
    const epochRange_m = Math.hypot(postBurn[0], postBurn[1], postBurn[2]);
    const twoOrbit_s = 4 * Math.PI / N;
    for (let t_s = 0; t_s <= twoOrbit_s; t_s += 60) {
      const propagated = propagateCW(
        [postBurn[0], postBurn[1], postBurn[2]],
        [postBurn[3], postBurn[4], postBurn[5]],
        N,
        t_s,
      );
      expect(Math.hypot(...propagated.r)).toBeGreaterThanOrEqual(0.8 * epochRange_m);
    }
  });
});
