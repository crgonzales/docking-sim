import { describe, expect, it } from 'vitest';
import { createSimLoop, type SimConfig } from './sim.js';

const INITIAL_NAV_STATE: [number, number, number, number, number, number] = [0, -250, 0, 0, 0, 0];

function diagonal(values: number[]): number[][] {
  return values.map((value, row) => values.map((_, column) => row === column ? value : 0));
}

function config(initialVelocity: [number, number, number] = [0, 0, 0]): SimConfig {
  const initialState: [number, number, number, number, number, number] = [
    INITIAL_NAV_STATE[0], INITIAL_NAV_STATE[1], INITIAL_NAV_STATE[2],
    initialVelocity[0], initialVelocity[1], initialVelocity[2],
  ];
  return {
    initial: {
      r_hill_m: [0, -250, 0],
      v_hill_mps: initialVelocity,
      prop_kg: 24,
      q_BI: [1, 0, 0, 0],
    },
    fsw: {
      controller: 'LQR',
      massModel: { dryMass_kg: 976, initialProp_kg: 24 },
      guidanceConfig: { initialState: initialState },
      ekfConfig: {
        initialNavPrior: { state: initialState, covariance: diagonal([10_000, 10_000, 10_000, 10, 10, 10]) },
        q: diagonal([0, 0, 0, 0, 0, 0]),
      },
      allocatorConfig: { fswHz: 10, truthHz: 100 },
    },
    sensors: {
      range_sigma_floor_m: 0,
      range_sigma_scale: 0,
      bearing_sigma_rad: 0,
      gyro_sigma_rps: 0,
      gyro_bias_random_walk_rps_sqrt_s: 0,
      attitude_sigma_rad: 0,
    },
  };
}

function velocityNorm(velocity: [number, number, number]): number {
  return Math.hypot(...velocity);
}

describe('holdManualPosition', () => {
  it('captures only estimated state on the next FSW tick and brakes with real thrusters', () => {
    const sim = createSimLoop(config([0, 0.25, 0]), 1401);
    sim.setNavSource('BACKUP');
    sim.setControlMode('MANUAL');
    sim.setManualSubMode('PULSE');
    sim.setManualCommand({ translation: [0, 0, 0], rotation: [0, 0, 0] });
    sim.stepTo(0.2);

    const beforeHold = sim.getTruthState();
    sim.holdManualPosition();
    expect(sim.getTruthState()).toEqual(beforeHold);

    const firstHoldFrame = sim.stepTo(0.3).at(-1)!;
    expect(firstHoldFrame.manual_sub_mode).toBe('RATE');
    expect(Object.values(firstHoldFrame.thruster_duty).some((duty) => duty > 0)).toBe(true);

    sim.stepTo(1.3);
    const afterBraking = sim.getTruthState();
    expect(velocityNorm(afterBraking.v_hill_mps)).toBeLessThan(velocityNorm(beforeHold.v_hill_mps));
    expect(afterBraking.r_hill_m).not.toEqual(beforeHold.r_hill_m);
  }, 30_000);

  it.each(['PID', 'LQR'] as const)('resets a built-up %s RATE reference before braking', (controller) => {
    const holdConfig = config();
    holdConfig.fsw.controller = controller;
    // Exercise a responsive PID with integral state as well as the LQR.
    holdConfig.fsw.pidGains = { kp_N_per_m: 30, ki_N_per_m_s: 10, kd_N_s_per_m: 120 };
    const sim = createSimLoop(holdConfig, 1402);
    sim.setNavSource('BACKUP');
    sim.setControlMode('MANUAL');
    sim.setManualSubMode('RATE');
    sim.setManualCommand({ translation: [0, 1, 0], rotation: [0, 0, 0] });
    sim.stepTo(2);

    const beforeHold = sim.getTruthState();
    const beforeSpeed = velocityNorm(beforeHold.v_hill_mps);
    expect(beforeSpeed).toBeGreaterThan(0.05);
    sim.holdManualPosition();
    const holdFrame = sim.stepTo(2.1).at(-1)!;

    expect(holdFrame.manual_sub_mode).toBe('RATE');
    sim.stepTo(6);
    // A position hold can reverse to recapture the anchor after braking;
    // test loss of momentum along the original motion, not speed magnitude.
    const velocity = sim.getTruthState().v_hill_mps;
    const alongOriginalMotion = velocity.reduce((sum, v, i) => sum + v * beforeHold.v_hill_mps[i]!, 0) / beforeSpeed;
    expect(alongOriginalMotion).toBeLessThan(beforeSpeed * 0.8);
  }, 30_000);

  it('does not change AUTO and does not survive leaving MANUAL before consumption', () => {
    const auto = createSimLoop(config(), 1403);
    const unchanged = createSimLoop(config(), 1403);
    auto.holdManualPosition();
    expect(auto.stepTo(0.1)).toEqual(unchanged.stepTo(0.1));
    expect(auto.getTruthState()).toEqual(unchanged.getTruthState());

    const stale = createSimLoop(config(), 1404);
    const baseline = createSimLoop(config(), 1404);
    stale.setControlMode('MANUAL');
    stale.setManualSubMode('PULSE');
    stale.setManualCommand({ translation: [0, 1, 0], rotation: [0, 0, 0] });
    stale.holdManualPosition();
    stale.setControlMode('AUTO');
    stale.stepTo(0.1);

    baseline.setControlMode('AUTO');
    baseline.stepTo(0.1);
    stale.setControlMode('MANUAL');
    baseline.setControlMode('MANUAL');
    stale.setManualSubMode('PULSE');
    baseline.setManualSubMode('PULSE');
    stale.setManualCommand({ translation: [0, 1, 0], rotation: [0, 0, 0] });
    baseline.setManualCommand({ translation: [0, 1, 0], rotation: [0, 0, 0] });
    expect(stale.stepTo(0.2)).toEqual(baseline.stepTo(0.2));
  }, 30_000);

  it('ignores the command once the abort latch is active', () => {
    const sim = createSimLoop(config(), 1405);
    sim.commandAbort();
    expect(sim.stepTo(0.1).at(-1)!.outcome).toBe('ABORT');
    sim.setControlMode('MANUAL');
    sim.setManualSubMode('PULSE');
    sim.setManualCommand({ translation: [0, 1, 0], rotation: [0, 0, 0] });
    sim.holdManualPosition();

    expect(sim.stepTo(0.2).at(-1)!.manual_sub_mode).toBe('PULSE');
  }, 30_000);
});
