import { describe, expect, it } from 'vitest';
import { hillToBody, rotateVector, smallAngleExp } from './attitude.js';
import { createSimLoop, type SimConfig } from './sim.js';
import { propagateCW } from './cw.js';
import { MEAN_MOTION_RAD_S, stepTruth } from './dynamics.js';
import { computeSafingBurn } from './monitors.js';

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

  it('exposes navigation and guidance injections and applies a one-shot truth velocity bias', () => {
    const first = createSimLoop(config(), 20260807);
    const second = createSimLoop(config(), 20260807);
    first.setNavSource('BACKUP');
    second.setNavSource('BACKUP');
    first.injectGuidanceFault();
    second.injectGuidanceFault();

    const firstFaultFrames = first.stepTo(0.1);
    const secondFaultFrames = second.stepTo(0.1);
    expect(firstFaultFrames).toEqual(secondFaultFrames);
    expect(firstFaultFrames.at(-1)!.nav_source).toBe('BACKUP');
    expect(firstFaultFrames.at(-1)!.guidance_frozen).toBe(true);

    first.clearGuidanceFault();
    second.clearGuidanceFault();
    const firstClearFrames = first.stepTo(0.2);
    const secondClearFrames = second.stepTo(0.2);
    expect(firstClearFrames).toEqual(secondClearFrames);
    expect(firstClearFrames.at(-1)!.guidance_frozen).toBe(false);

    const biased = createSimLoop(config(), 20260808);
    const deterministicBiased = createSimLoop(config(), 20260808);
    const before = biased.getTruthState();
    const dv_mps: [number, number, number] = [0.12, -0.04, 0.07];
    const nudged = {
      ...before,
      v_hill_mps: before.v_hill_mps.map((value, axis) => value + dv_mps[axis]!) as [number, number, number],
    };
    const expectedAfter = stepTruth(nudged, { dt_s: 0.01 });
    biased.injectVelocityBias(dv_mps);
    deterministicBiased.injectVelocityBias(dv_mps);
    biased.stepTo(0.01);
    deterministicBiased.stepTo(0.01);
    expect(biased.getTruthState()).toEqual(deterministicBiased.getTruthState());
    expect(biased.getTruthState()).toEqual(expectedAfter);

    const expectedNext = stepTruth(expectedAfter, { dt_s: 0.01 });
    biased.stepTo(0.02);
    expect(biased.getTruthState()).toEqual(expectedNext);
  });

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
    const dutyBeforeMutation = render.thruster_duty.J1;
    render.thruster_duty.J1 = dutyBeforeMutation === undefined ? 1 : dutyBeforeMutation + 1;
    expect(first.getRenderState().thruster_duty.J1).toBe(dutyBeforeMutation);
    expect(framesFirst.every((frame) => frame.att_nees !== null && Number.isFinite(frame.att_nees))).toBe(true);
  });

  it('accumulates a short truth-side pulse into a stable FSW-window duty', () => {
    const pulseConfig: SimConfig = {
      ...config(),
      fsw: {
        ...config().fsw,
        attitudeControllerConfig: { meanMotionRadS: 0 },
      },
    };
    const sim = createSimLoop(pulseConfig, 1007);
    sim.setControlMode('MANUAL');
    sim.setManualSubMode('PULSE');
    sim.setManualCommand({ translation: [0, 0, 0], rotation: [1, 0, 0] });

    sim.stepTo(0.1);
    expect(Object.values(sim.getRenderState().thruster_duty).every((duty) => duty === 0)).toBe(true);
    sim.stepTo(0.4);
    const duty = Object.values(sim.getRenderState().thruster_duty);
    expect(duty.some((value) => value > 0 && value < 1)).toBe(true);
  });

  it('reports a stuck-open truth jet even while FSW commands that jet closed', () => {
    const closedCommandConfig: SimConfig = {
      ...config(),
      fsw: {
        ...config().fsw,
        attitudeControllerConfig: { meanMotionRadS: 0 },
      },
    };
    const sim = createSimLoop(closedCommandConfig, 1008);
    sim.setControlMode('MANUAL');
    sim.setManualSubMode('PULSE');
    sim.setManualCommand({ translation: [0, 0, 0], rotation: [0, 0, 0] });
    sim.injectThrusterStuck('J1', 'OPEN');

    const frame = sim.stepTo(0.1).at(-1)!;
    expect(frame.thruster_duty.J1).toBe(0);
    expect(sim.getRenderState().thruster_duty.J1).toBeCloseTo(1, 12);
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

  it('latches DOCKED for a contact inside the truth capture envelope', () => {
    const dockingConfig: SimConfig = {
      ...config(),
      initial: {
        ...config().initial,
        r_hill_m: [0, -10.44, 0],
        v_hill_mps: [0, 0.05, 0],
      },
      fsw: {
        ...config().fsw,
        guidanceConfig: { initialState: [0, -10.44, 0, 0, 0.05, 0] },
        ekfConfig: {
          initialNavPrior: { state: [0, -10.44, 0, 0, 0.05, 0], covariance: diagonal([10_000, 10_000, 10_000, 10, 10, 10]) },
        },
      },
    };
    const sim = createSimLoop(dockingConfig, 1001);
    const frames = sim.stepTo(0.1);

    expect(frames.at(-1)!.outcome).toBe('DOCKED');
    expect(sim.getTruthState().v_hill_mps).toEqual([0, 0, 0]);
  });

  it('latches COLLISION for hot contact outside the capture envelope', () => {
    const collisionConfig: SimConfig = {
      ...config(),
      initial: {
        ...config().initial,
        r_hill_m: [0, -10.4, 0],
        v_hill_mps: [0, 0.5, 0],
      },
      fsw: {
        ...config().fsw,
        controller: 'PID',
        guidanceConfig: { initialState: [0, -10.4, 0, 0, 0.5, 0] },
        ekfConfig: {
          initialNavPrior: { state: [0, -10.4, 0, 0, 0.5, 0], covariance: diagonal([10_000, 10_000, 10_000, 10, 10, 10]) },
        },
      },
    };
    const sim = createSimLoop(collisionConfig, 1002);

    expect(sim.stepTo(0.1).at(-1)!.outcome).toBe('COLLISION');
  });

  it('lets contact win arbitration when an abort was commanded first', () => {
    const dockingConfig: SimConfig = {
      ...config(),
      initial: {
        ...config().initial,
        r_hill_m: [0, -10.44, 0],
        v_hill_mps: [0, 0.05, 0],
      },
      fsw: {
        ...config().fsw,
        guidanceConfig: { initialState: [0, -10.44, 0, 0, 0.05, 0] },
        ekfConfig: {
          initialNavPrior: { state: [0, -10.44, 0, 0, 0.05, 0], covariance: diagonal([10_000, 10_000, 10_000, 10, 10, 10]) },
        },
      },
    };
    const sim = createSimLoop(dockingConfig, 1003);
    sim.commandAbort();

    expect(sim.stepTo(0.1).at(-1)!.outcome).toBe('DOCKED');
  });

  it('flies the headline MPC approach to a captured dock', () => {
    const headline: SimConfig = {
      ...config(),
      initial: {
        ...config().initial,
        r_hill_m: [0, -250, 12],
        v_hill_mps: [0, 0.1, 0],
      },
      fsw: {
        ...config().fsw,
        controller: 'MPC',
        guidanceConfig: { initialState: [0, -250, 12, 0, 0.1, 0] },
        ekfConfig: {
          initialNavPrior: { state: [0, -250, 12, 0, 0.1, 0], covariance: diagonal([10_000, 10_000, 10_000, 10, 10, 10]) },
        },
        mpcConfig: {
          horizonSteps: 10,
          maxIterations: 250,
          terminalTarget_hill_m: [0, -10.4, 0],
        },
      },
    };
    const sim = createSimLoop(headline, 1004);
    const frames = sim.stepTo(1200);
    const outcomeFrame = frames.find((frame) => frame.outcome !== 'NONE');
    expect(outcomeFrame?.outcome).toBe('DOCKED');
    expect(sim.getTruthState().v_hill_mps).toEqual([0, 0, 0]);
  }, 120_000);

  it('latches ABORT for an AUTO trajectory that leaves the hard corridor', () => {
    const abortConfig: SimConfig = {
      ...config(),
      initial: {
        ...config().initial,
        r_hill_m: [100, -50, 0],
        v_hill_mps: [0, 0.1, 0],
      },
      fsw: {
        ...config().fsw,
        controller: 'LQR',
        guidanceConfig: { initialState: [100, -50, 0, 0, 0.1, 0] },
        ekfConfig: {
          initialNavPrior: { state: [100, -50, 0, 0, 0.1, 0], covariance: diagonal([10_000, 10_000, 10_000, 10, 10, 10]) },
        },
      },
    };
    const sim = createSimLoop(abortConfig, 1005);
    const abortFrame = sim.stepTo(0.1).find((frame) => frame.outcome === 'ABORT');

    expect(abortFrame?.outcome).toBe('ABORT');
    const abortEpoch = sim.getTruthState();
    const burn = computeSafingBurn([
      ...abortEpoch.r_hill_m,
      ...abortEpoch.v_hill_mps,
    ], MEAN_MOTION_RAD_S);
    const postBurn = [
      ...abortEpoch.r_hill_m,
      abortEpoch.v_hill_mps[0] + burn.deltaV_hill_mps[0],
      abortEpoch.v_hill_mps[1] + burn.deltaV_hill_mps[1],
      abortEpoch.v_hill_mps[2] + burn.deltaV_hill_mps[2],
    ] as [number, number, number, number, number, number];
    const epochRange_m = Math.hypot(...abortEpoch.r_hill_m);
    for (let t_s = 0; t_s <= 4 * Math.PI / MEAN_MOTION_RAD_S; t_s += 60) {
      const propagated = propagateCW(
        [postBurn[0], postBurn[1], postBurn[2]],
        [postBurn[3], postBurn[4], postBurn[5]],
        MEAN_MOTION_RAD_S,
        t_s,
      );
      expect(Math.hypot(...propagated.r)).toBeGreaterThanOrEqual(0.8 * epochRange_m);
    }
  });

  it('keeps a DOCKED outcome and latch time deterministic for identical seeds', () => {
    const dockingConfig: SimConfig = {
      ...config(),
      initial: {
        ...config().initial,
        r_hill_m: [0, -10.44, 0],
        v_hill_mps: [0, 0.05, 0],
      },
      fsw: {
        ...config().fsw,
        guidanceConfig: { initialState: [0, -10.44, 0, 0, 0.05, 0] },
        ekfConfig: {
          initialNavPrior: { state: [0, -10.44, 0, 0, 0.05, 0], covariance: diagonal([10_000, 10_000, 10_000, 10, 10, 10]) },
        },
      },
    };
    const first = createSimLoop(dockingConfig, 1006);
    const second = createSimLoop(dockingConfig, 1006);
    const firstFrames = first.stepTo(0.1);
    const secondFrames = second.stepTo(0.1);

    expect(firstFrames).toEqual(secondFrames);
    expect(firstFrames.find((frame) => frame.outcome !== 'NONE')?.t_s)
      .toBe(secondFrames.find((frame) => frame.outcome !== 'NONE')?.t_s);
    expect(first.getTruthState()).toEqual(second.getTruthState());
  });
});
