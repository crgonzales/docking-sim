import { describe, expect, it } from 'vitest';
import {
  conjugateQuaternion, createSimLoop, rotateVector,
  type ManualCommand, type TelemetryFrame, type Vec3,
} from '@docking/sim-core';
import {
  FIRST_DOCKING_01,
  FINAL_APPROACH_01,
  createFirstDockingConfig,
  createFirstDockingScenario,
  createScenarioDirector,
  scenarioToSimConfig,
  validateScenario,
  type Scenario,
  type ScenarioSimPort,
} from './index.js';

const FINE_FORWARD: ManualCommand = { translation: [0, 0.14, 0], rotation: [0, 0, 0] };

function approachPilot() {
  let correction: Vec3 | null = null;
  let start_s = 0;
  return (frame: TelemetryFrame | null): ManualCommand => {
    if (frame === null) return { translation: [0, 0, 0], rotation: [0, 0, 0] };
    if (correction === null) {
      start_s = frame.t_s;
      const port = rotateVector(conjugateQuaternion(frame.q_BH_est), [0, 1.7, 0]);
      // A five-second sideways tap offsets the displayed port error at LOW's
      // 0.5 m/s full-scale RATE setting, then neutral lets the existing hold settle.
      correction = rotateVector(frame.q_BH_est, [
        -(frame.nav_r_hill_m[0] + port[0]) / (5 * 0.5),
        0,
        -(frame.nav_r_hill_m[2] + port[2]) / (5 * 0.5),
      ]);
    }
    const elapsed_s = frame.t_s - start_s;
    return {
      translation: [elapsed_s < 5 ? correction[0] : 0, elapsed_s < 8 ? 0.5 : 0.14,
        elapsed_s < 5 ? correction[2] : 0],
      rotation: [0, 0, 0],
    };
  };
}

function fly(scenario: Scenario, pilot?: (frame: TelemetryFrame | null) => ManualCommand) {
  // The pilot has estimated telemetry and manual commands only, never truth access.
  const sim: ScenarioSimPort = createSimLoop(createFirstDockingConfig(scenario), scenario.seed);
  const director = createScenarioDirector(scenario, sim);
  const frames: TelemetryFrame[] = [];
  let state = director.launch();
  for (let tick = 1; tick <= scenario.clock.duration_s * 10 && state.outcome === null; tick += 1) {
    if (pilot) sim.setManualCommand(pilot(state.telemetry));
    state = director.tick(tick / 10);
    if (state.telemetry) frames.push(state.telemetry);
  }
  return { frames, state };
}

describe('first docking', () => {
  it.each(['APPROACH', 'FINAL'] as const)('validates the prepared %s start and unchanged capture criteria', (start) => {
    const scenario = createFirstDockingScenario(start);
    expect(validateScenario(scenario)).toBe(scenario);
    expect(scenario).toMatchObject({
      id: 'FIRST_DOCKING_01', title: 'First docking', seed: 20260911,
      clock: { duration_s: 1200 }, beats: [],
      initial: {
        rel_position_m: start === 'FINAL' ? [0, -12.4, 0] : [0.25, -16.4, 0.15],
        rel_velocity_mps: [0, 0, 0], attitude_error_deg: [0, 0, 0], body_rates_dps: [0, 0, 0],
        control_mode: 'MANUAL', controller: 'LQR', nav_source: 'PRIMARY', prop_kg: 24,
      },
    });
    expect(scenario.monitors).toEqual(FINAL_APPROACH_01.monitors);
    const shared = scenarioToSimConfig(scenario.initial);
    expect(createFirstDockingConfig(scenario)).toEqual({ ...shared, fsw: { ...shared.fsw,
      attitudeControllerConfig: { ...shared.fsw.attitudeControllerConfig, manualKd_Nms_per_rad: [1200, 800, 1200] },
    } });
    expect(createFirstDockingConfig(scenario).sensors).toBeUndefined();
  });

  it('exports the approach by default and gives retries independent mutable data', () => {
    const first = createFirstDockingScenario();
    expect(first).toEqual(FIRST_DOCKING_01);
    first.initial.rel_position_m[0] = 999;
    first.monitors.capture_envelope.closing_mps[0] = 999;
    first.outcomes.DOCKED.title = 'changed';
    first.beats.push(...FINAL_APPROACH_01.beats);
    expect(createFirstDockingScenario()).toEqual(FIRST_DOCKING_01);
    expect(FIRST_DOCKING_01.monitors).toEqual(FINAL_APPROACH_01.monitors);
  });

  it.each(['APPROACH', 'FINAL'] as const)('%s never docks without pilot input over the full practice limit', (start) => {
    const { frames, state } = fly(createFirstDockingScenario(start));
    expect(state.outcome).toBe('WINDOW_MISSED');
    expect(state.clock.elapsed_s).toBe(1200);
    expect(frames.every((frame) => frame.outcome === 'NONE')).toBe(true);
    expect(frames.every((frame) => frame.control_mode === 'MANUAL' && frame.manual_sub_mode === 'RATE'
      && frame.manual_authority === 'LOW')).toBe(true);
  }, 30_000);

  it('docks FINAL using only fixed fine forward input with default seeded sensors', () => {
    const { frames, state } = fly(createFirstDockingScenario('FINAL'), () => FINE_FORWARD);
    expect(state.outcome).toBe('DOCKED');
    expect(state.telemetry?.outcome).toBe('DOCKED');
    expect(state.clock.elapsed_s).toBeGreaterThan(20);
    expect(state.clock.elapsed_s).toBeLessThan(60);
    expect(frames.every((frame) => frame.control_mode === 'MANUAL' && frame.manual_sub_mode === 'RATE'
      && frame.manual_authority === 'LOW' && frame.nav_source === 'PRIMARY')).toBe(true);
  }, 30_000);

  it('docks APPROACH with an estimated alignment tap, regular approach and fine forward input', () => {
    const { frames, state } = fly(createFirstDockingScenario(), approachPilot());
    expect(state.outcome).toBe('DOCKED');
    expect(state.telemetry?.outcome).toBe('DOCKED');
    expect(state.clock.elapsed_s).toBeGreaterThan(40);
    expect(state.clock.elapsed_s).toBeLessThan(120);
    expect(frames.every((frame) => frame.control_mode === 'MANUAL' && frame.manual_sub_mode === 'RATE'
      && frame.manual_authority === 'LOW' && frame.nav_source === 'PRIMARY')).toBe(true);
  }, 30_000);

  it('rejects contact when regular forward input is held through FINAL capture', () => {
    const { state } = fly(createFirstDockingScenario('FINAL'), () => ({
      translation: [0, 0.5, 0], rotation: [0, 0, 0],
    }));
    expect(state.outcome).toBe('COLLISION');
    expect(state.telemetry?.outcome).toBe('COLLISION');
  }, 30_000);

  it.each(['APPROACH', 'FINAL'] as const)('reproduces the complete %s trajectory on a prepared retry', (start) => {
    const first = fly(createFirstDockingScenario(start), start === 'FINAL' ? () => FINE_FORWARD : approachPilot());
    const retry = fly(createFirstDockingScenario(start), start === 'FINAL' ? () => FINE_FORWARD : approachPilot());
    expect(first.state.outcome).toBe('DOCKED');
    expect(retry.state).toEqual(first.state);
    expect(retry.frames).toEqual(first.frames);
  }, 30_000);
});


it.each([0.5, 2, 5, 15])('lets a pilot wait %s seconds before starting the final approach', (delay) => {
  const result = fly(createFirstDockingScenario('FINAL'), frame => frame && frame.t_s >= delay
    ? FINE_FORWARD : { translation: [0, 0, 0], rotation: [0, 0, 0] });
  expect(result.state.outcome, JSON.stringify(result.state.telemetry?.docking)).toBe('DOCKED');
}, 30_000);
