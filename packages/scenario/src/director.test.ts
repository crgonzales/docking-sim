import { describe, expect, it, vi } from 'vitest';
import type { SimLoop, TelemetryFrame } from '@docking/sim-core';
import { FINAL_APPROACH_01 } from './scenarios/finalApproach01.js';
import { createScenarioDirector, type ScenarioSimPort } from './director.js';
import type { Beat, Scenario } from './schema.js';

function frame(t_s: number, overrides: Partial<TelemetryFrame> = {}): TelemetryFrame {
  return {
    t_s,
    nav_r_hill_m: [0, -20, 0],
    nav_cov_pos_m2: [1, 1, 1],
    nees: 1,
    corridor_err_m: 0.5,
    range_m: 20,
    body_rate_dps: 0.5,
    controller: 'LQR',
    mpc_fallback: false,
    outcome: 'NONE',
    abort: 'ARMED',
    control_mode: 'AUTO',
    nav_source: 'PRIMARY',
    guidance_frozen: false,
    corridor_level: 'NOMINAL',
    prop_kg: 24,
    thruster_duty: {},
    sat_flag: false,
    q_BH_est: [1, 0, 0, 0],
    body_rate_dps_est: [0, 0, 0],
    att_sigma_deg: 0.1,
    manual_sub_mode: null,
    docking: null,
    att_nees: 1,
    ...overrides,
  };
}

function makePort(nextFrame: (t_s: number) => TelemetryFrame): ScenarioSimPort & { velocityBiases: number; aborts: number } {
  const port: ScenarioSimPort & { velocityBiases: number; aborts: number } = {
    velocityBiases: 0,
    aborts: 0,
    stepTo: vi.fn((t_s: number) => [nextFrame(t_s)]),
    setController: vi.fn(),
    commandAbort: vi.fn(() => { port.aborts += 1; }),
    setControlMode: vi.fn(),
    setNavSource: vi.fn(),
    injectGuidanceFault: vi.fn(),
    clearGuidanceFault: vi.fn(),
    setManualSubMode: vi.fn(),
    setManualCommand: vi.fn(),
    isolateThruster: vi.fn(),
    injectThrusterStuck: vi.fn(),
    injectVelocityBias: vi.fn(() => { port.velocityBiases += 1; }),
    setSensorDegrade: vi.fn(),
    clearSensorDegrade: vi.fn(),
  };
  return port;
}

function scenarioWithBeat(beat: Beat): Scenario {
  return {
    ...FINAL_APPROACH_01,
    clock: { ...FINAL_APPROACH_01.clock, duration_s: 10 },
    beats: [beat],
  };
}

const guaranteeBeat: Beat = {
  id: 'B3_TEST',
  t_start_s: 1,
  trigger: { kind: 'NONE' },
  guarantee: { kind: 'VEL_BIAS', dv_mps: [0.04, 0, 0.06] },
  required_action: { kind: 'SET_CONTROLLER', to: 'MPC' },
  response_window_s: 5,
  clears_when: { kind: 'TELEMETRY', check: { signal: 'CORRIDOR_ERR_M', below: 1, hold_s: 8 } },
  prompts: { callout: 'TEST', hint_control: 'CTRL_MODE', alarm: null },
  debrief_if_causal: 'test',
};

describe('ScenarioDirector', () => {
  it('fires a NONE guarantee when its instantaneous telemetry check is met at t_start', () => {
    const port = makePort((t_s) => frame(t_s, { corridor_err_m: 0.5 }));
    const director = createScenarioDirector(scenarioWithBeat(guaranteeBeat), port);
    director.launch();
    director.tick(0.5);
    director.tick(1);
    expect(port.velocityBiases).toBe(1);
  });

  it('does not fire a NONE guarantee when the check is not met at t_start', () => {
    const port = makePort((t_s) => frame(t_s, { corridor_err_m: t_s >= 1 ? 0.5 : 2 }));
    const director = createScenarioDirector(scenarioWithBeat(guaranteeBeat), port);
    director.launch();
    director.tick(0.5);
    director.tick(1);
    expect(port.velocityBiases).toBe(0);
  });

  it('merges an escalation sensor degrade with the active one instead of replacing it', () => {
    const biasBeat: Beat = {
      id: 'B1_TEST',
      t_start_s: 1,
      trigger: { kind: 'NAV_DEGRADE', sensor: 'STAR_TRACKER', mode: 'BIAS_RAMP',
                 params: { deg_per_min: 0.8 } },
      required_action: { kind: 'SET_NAV_SOURCE', to: 'BACKUP' },
      response_window_s: 2,
      escalation: {
        secondary: { kind: 'NAV_DEGRADE', sensor: 'RANGE', mode: 'NOISE_X10' },
        note: 'test',
      },
      clears_when: { kind: 'ACTION' },
      prompts: { callout: 'TEST', hint_control: 'NAV_SRC', alarm: 'CAUTION' },
      debrief_if_causal: 'test',
    };
    const port = makePort((t_s) => frame(t_s));
    const director = createScenarioDirector(scenarioWithBeat(biasBeat), port);
    director.launch();
    director.tick(1);   // beat fires: attitude bias ramp injected
    director.tick(4);   // response window expires: range NOISE_X10 escalation
    const setDegrade = port.setSensorDegrade as ReturnType<typeof vi.fn>;
    expect(setDegrade).toHaveBeenCalledTimes(2);
    const lastConfig = setDegrade.mock.calls.at(-1)![0];
    // The escalation must carry BOTH the original bias ramp and the new noise.
    expect(lastConfig.biasRamp?.attitudeBiasRatePerMin_rad).toBeDefined();
    expect(lastConfig.noiseMultiplier).toBe(10);
    expect(lastConfig.channel).toBe('RANGE');
    // Original start time preserved so the continuous ramp keeps its elapsed time.
    expect(lastConfig.start_t_s).toBe(1);
  });

  it('does not latch DOCKED from capture-envelope telemetry without a truth outcome', () => {
    const port = makePort((t_s) => frame(t_s, {
      docking: { closing_mps: 0.05, lateral_m: 0.01, misalign_deg: 0.5, rate_dps: 0.05 },
    }));
    const director = createScenarioDirector({
      ...FINAL_APPROACH_01,
      clock: { ...FINAL_APPROACH_01.clock, duration_s: 10 },
      beats: [],
    }, port);
    director.launch();
    expect(director.tick(1).outcome).toBeNull();
  });
});

