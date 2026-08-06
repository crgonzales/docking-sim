import { describe, expect, it } from 'vitest';
import { createSimLoop, type SimConfig } from './sim.js';

const initialState: [number, number, number, number, number, number] = [0, -250, 12, 0, 0, 0];

function diagonal(values: number[]): number[][] {
  return values.map((value, row) => values.map((_, column) => row === column ? value : 0));
}

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
        initialNavPrior: { state: [...initialState], covariance: diagonal([10_000, 10_000, 10_000, 10, 10, 10]) },
      },
      allocatorConfig: { fswHz: 10, truthHz: 100 },
    },
    sensors: {
      range_sigma_floor_m: 0,
      range_sigma_scale: 0,
      bearing_sigma_rad: 0,
      gyro_sigma_rps: 0,
      attitude_sigma_rad: 0,
    },
  };
}

function holdDistance(state: ReturnType<ReturnType<typeof createSimLoop>['getTruthState']>): number {
  return Math.hypot(state.r_hill_m[0], state.r_hill_m[1] + 30, state.r_hill_m[2]);
}

describe('SimLoop', () => {
  it('is deterministic and returns exactly the crossed FSW frames', () => {
    const first = createSimLoop(config(), 20260806);
    const second = createSimLoop(config(), 20260806);
    expect(first.stepTo(0.05)).toEqual([]);
    expect(first.stepTo(0.1)).toHaveLength(1);
    expect(first.stepTo(0.35)).toHaveLength(2);
    expect(first.stepTo(0.35)).toEqual([]);
    expect(second.stepTo(0.05)).toEqual([]);
    expect(second.stepTo(0.1)).toHaveLength(1);
    expect(second.stepTo(0.35)).toHaveLength(2);
    expect(second.stepTo(0.35)).toEqual(first.stepTo(0.35));

    const runA = createSimLoop(config(), 77);
    const runB = createSimLoop(config(), 77);
    const framesA = runA.stepTo(60);
    const framesB = runB.stepTo(60);
    expect(framesA).toHaveLength(600);
    expect(framesA).toEqual(framesB);
    expect(runA.getTruthState()).toEqual(runB.getTruthState());
  }, 30_000);

  it('populates finite truth-privileged NEES and approaches the hold point within prop budget', () => {
    const sim = createSimLoop(config(), 123);
    const initialDistance_m = holdDistance(sim.getTruthState());
    const frames = sim.stepTo(60);
    const finalTruth = sim.getTruthState();
    expect(frames.every((frame) => frame.nees !== null && Number.isFinite(frame.nees))).toBe(true);
    expect(holdDistance(finalTruth)).toBeLessThan(initialDistance_m);
    expect(finalTruth.prop_kg).toBeGreaterThan(0);
    // Regression (review finding): nominal jets must actually fire in truth —
    // free CW drift can shrink the hold distance, but it cannot burn prop.
    expect(finalTruth.prop_kg).toBeLessThan(24);
    // Regression: telemetry prop is the truth tank level, not FSW's estimate.
    expect(frames[frames.length - 1]!.prop_kg).toBeCloseTo(finalTruth.prop_kg, 12);
  }, 30_000);

  it('keeps a stuck-open jet truth-only until isolation and then removes it from FSW commands', () => {
    const nominal = createSimLoop(config(), 321);
    const failed = createSimLoop(config(), 321);
    nominal.stepTo(10);
    failed.injectThrusterStuck('J1', 'OPEN');
    failed.stepTo(10);
    expect(failed.getTruthState()).not.toEqual(nominal.getTruthState());

    failed.isolateThruster('J1');
    const frames = failed.stepTo(10.2);
    expect(frames.every((frame) => frame.thruster_duty.J1 === 0)).toBe(true);
    expect(frames.some((frame) => Object.entries(frame.thruster_duty)
      .some(([id, duty]) => id !== 'J1' && duty > 0))).toBe(true);
    expect(failed.getTruthState().prop_kg).toBeLessThan(24);
    // Regression (review finding): even with a truth-only stuck jet burning
    // prop the FSW never commanded, the emitted gauge must track the tank.
    expect(frames[frames.length - 1]!.prop_kg).toBeCloseTo(failed.getTruthState().prop_kg, 12);
  }, 30_000);
});
