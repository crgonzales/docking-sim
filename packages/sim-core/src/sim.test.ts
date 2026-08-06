import { describe, expect, it } from 'vitest';
import { hillToBody, rotateVector, smallAngleExp } from './attitude.js';
import { createSimLoop, type SimConfig } from './sim.js';
import { MEAN_MOTION_RAD_S } from './dynamics.js';

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

  it('applies scripted manual commands deterministically and exposes truth render state', () => {
    const manualConfig: SimConfig = {
      ...config(),
      initial: { ...config().initial, q_BI: smallAngleExp([0.2, -0.1, 0.15]) },
    };
    const first = createSimLoop(manualConfig, 991);
    const second = createSimLoop(manualConfig, 991);
    const script = [
      { t_s: 0.1, mode: 'MANUAL' as const, subMode: 'PULSE' as const, command: { translation: [1, 0, 0] as [number, number, number], rotation: [0, 0.5, 0] as [number, number, number] } },
      { t_s: 0.2, mode: 'MANUAL' as const, subMode: 'RATE' as const, command: { translation: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] } },
      { t_s: 0.5, mode: 'AUTO' as const, subMode: 'RATE' as const, command: { translation: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] } },
    ];
    let framesFirst: ReturnType<typeof first.stepTo> = [];
    let framesSecond: ReturnType<typeof second.stepTo> = [];
    for (const entry of script) {
      first.setControlMode(entry.mode);
      second.setControlMode(entry.mode);
      first.setManualSubMode(entry.subMode);
      second.setManualSubMode(entry.subMode);
      first.setManualCommand(entry.command);
      second.setManualCommand(entry.command);
      framesFirst = framesFirst.concat(first.stepTo(entry.t_s));
      framesSecond = framesSecond.concat(second.stepTo(entry.t_s));
    }
    expect(framesFirst).toEqual(framesSecond);
    expect(first.getTruthState()).toEqual(second.getTruthState());
    const render = first.getRenderState();
    const truth = first.getTruthState();
    expect(render.t_s).toBe(truth.t_s);
    expect(render.r_hill_m).toEqual(truth.r_hill_m);
    expect(render.v_hill_mps).toEqual(truth.v_hill_mps);
    expect(render.q_BH).toEqual(hillToBody(truth.q_BI, truth.t_s));
    expect(framesFirst.every((frame) => frame.att_nees !== null && Number.isFinite(frame.att_nees))).toBe(true);
  });

  it('damps a tumbling start toward LVLH rate under closed-loop AUTO attitude control', () => {
    const tumblingConfig: SimConfig = {
      ...config(),
      initial: {
        ...config().initial,
        q_BI: smallAngleExp([0.25, -0.2, 0.15]),
        w_body_rps: [0.04, -0.03, 0.025],
      },
      fsw: {
        ...config().fsw,
        attitudeControllerConfig: { maxTorque_Nm: 40 },
      },
    };
    const sim = createSimLoop(tumblingConfig, 992);
    const initial = sim.getTruthState();
    expect(Math.hypot(...initial.w_body_rps)).toBeGreaterThan(0.05);
    sim.stepTo(60);
    const truth = sim.getTruthState();
    const q_BH = hillToBody(truth.q_BI, truth.t_s);
    const rateReference = rotateVector(q_BH, [0, 0, MEAN_MOTION_RAD_S]);
    const rateError = Math.hypot(
      truth.w_body_rps[0] - rateReference[0],
      truth.w_body_rps[1] - rateReference[1],
      truth.w_body_rps[2] - rateReference[2],
    );
    expect(Math.hypot(q_BH[1], q_BH[2], q_BH[3])).toBeLessThan(0.08);
    expect(rateError).toBeLessThan(0.01);
  }, 30_000);
});
