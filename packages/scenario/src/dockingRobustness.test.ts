import { expect, it } from 'vitest';
import { createSimLoop, conjugateQuaternion, rotateVector, hillToBody, MEAN_MOTION_RAD_S, type ManualCommand } from '@docking/sim-core';
import { createFirstDockingScenario, createFirstDockingConfig, createScenarioDirector } from './index.js';

it.each([0, 30, 60, 90, 120])('captures after %s seconds of attitude hold', (delay) => {
  const scenario = createFirstDockingScenario('FINAL');
  const config = createFirstDockingConfig(scenario);
  const sim = createSimLoop(config, scenario.seed);
  const director = createScenarioDirector(scenario, sim);
  let state = director.launch();
  for (let tick = 1; tick < (delay + 60) * 10 && state.outcome === null; tick++) {
    const command: ManualCommand = { translation: [0, tick / 10 > delay ? 0.14 : 0, 0], rotation: [0, 0, 0] };
    sim.setManualCommand(command);
    state = director.tick(tick / 10);
  }
  expect(state.outcome, JSON.stringify(state.telemetry?.docking)).toBe('DOCKED');
}, 30_000);

it.each([0, 2, 5, 10, 30])('flies a corrected six-metre approach after %s seconds', (delay) => {
  // Reproduces the live mouse-nudge/slow-approach sequence. The former LOW
  // damping failed the zero-delay run at 0.169 deg/s, with only 2 mm port error.
  const scenario = createFirstDockingScenario();
  const sim = createSimLoop(createFirstDockingConfig(scenario), scenario.seed);
  const director = createScenarioDirector(scenario, sim);
  let state = director.launch();
  for (let tick = 1; tick < 2000 && state.outcome === null; tick++) {
    const t = tick / 10 - delay;
    sim.setManualCommand({ translation: [t >= 17 && t < 20 ? -0.14 : t >= 95 && t < 95.6 ? -0.14 : 0,
      t >= 43 ? 0.14 : 0, t >= 40 && t < 42 ? -0.14 : 0], rotation: [0, 0, 0] });
    state = director.tick(tick / 10);
  }
  const truth = sim.getTruthState();
  const q = hillToBody(truth.q_BI, truth.t_s);
  const port = rotateVector(conjugateQuaternion(q), [0, 1.7, 0]);
  const baseRate = rotateVector(q, [0, 0, MEAN_MOTION_RAD_S]);
  const actual = { lateral: Math.hypot(truth.r_hill_m[0] + port[0], truth.r_hill_m[2] + port[2]),
    spin: Math.hypot(...truth.w_body_rps.map((w, i) => w - baseRate[i]!)) * 180 / Math.PI };
  expect(state.outcome, JSON.stringify(actual)).toBe('DOCKED');
}, 30_000);
