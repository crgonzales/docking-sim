import { createSimLoop, deriveSeed } from '@docking/sim-core';
import type { OutcomeId, Scenario } from './schema.js';
import { createScenarioDirector, type ScenarioUiState } from './director.js';
import { createPerfectOperatorBot } from './perfectOperatorBot.js';
import { scenarioToSimConfig } from './scenarioToSimConfig.js';

export interface MonteCarloRunResult {
  seed: number;
  outcome: OutcomeId;
  prop_consumed_kg: number;
  time_margin_s: number;
  corridor_violation_count: number;
  score: number;
  grade: 'A' | 'B' | 'C' | 'F';
}

export interface MonteCarloScoreInputs {
  outcome: OutcomeId;
  prop_consumed_kg: number;
  time_margin_s: number;
  corridor_violation_count: number;
}

export interface MonteCarloScore {
  score: number;
  grade: 'A' | 'B' | 'C' | 'F';
}

/** Apply the scenario's exact completion-only score and grade formula. */
export function scoreMonteCarloResult(
  scenario: Scenario,
  inputs: MonteCarloScoreInputs,
): MonteCarloScore {
  if (inputs.outcome !== 'DOCKED') return { score: 0, grade: 'F' };
  const score = 100
    + scenario.scoring.weights.prop_kg * inputs.prop_consumed_kg
    + scenario.scoring.weights.time_margin_s * inputs.time_margin_s
    + scenario.scoring.weights.corridor_violations * inputs.corridor_violation_count;
  const bounds = scenario.scoring.grade_bounds;
  const grade = score >= bounds.A ? 'A'
    : score >= bounds.B ? 'B'
      : score >= bounds.C ? 'C' : 'F';
  return { score, grade };
}

function driveRun(scenario: Scenario, seed: number): ScenarioUiState {
  const sim = createSimLoop(scenarioToSimConfig(scenario.initial), seed);
  const director = createScenarioDirector(scenario, sim);
  const bot = createPerfectOperatorBot(scenario, director, sim);
  director.launch();

  let state = director.getState();
  bot.step(state, state.telemetry);
  // Ten-Hz stepping matches sim-core's telemetry cadence and keeps all
  // operator actions sim-time driven; there is no wall-clock pacing here.
  const tick_s = 0.1;
  for (let t_s = tick_s; t_s <= scenario.clock.duration_s && state.outcome === null; t_s += tick_s) {
    state = director.tick(Math.min(t_s, scenario.clock.duration_s));
    bot.step(state, state.telemetry);
  }
  if (state.outcome === null) state = director.tick(scenario.clock.duration_s);
  return state;
}

/** Run one deterministic scenario instance with the perfect operator. */
export function runMonteCarloRun(
  scenario: Scenario,
  globalIndex: number,
  masterSeed: number,
): MonteCarloRunResult {
  const seed = deriveSeed(masterSeed, `run-${globalIndex}`);
  const finalState = driveRun(scenario, seed);
  const outcome = finalState.outcome ?? scenario.clock.expiry_outcome;
  const finalProp_kg = finalState.telemetry?.prop_kg ?? scenario.initial.prop_kg;
  const prop_consumed_kg = scenario.initial.prop_kg - finalProp_kg;
  const time_margin_s = outcome === 'DOCKED'
    ? Math.max(0, scenario.clock.duration_s - finalState.clock.elapsed_s)
    : 0;
  const scoreInputs: MonteCarloScoreInputs = {
    outcome,
    prop_consumed_kg,
    time_margin_s,
    corridor_violation_count: finalState.score_inputs.corridor_violations,
  };
  const { score, grade } = scoreMonteCarloResult(scenario, scoreInputs);
  return {
    seed,
    outcome,
    prop_consumed_kg,
    time_margin_s,
    corridor_violation_count: scoreInputs.corridor_violation_count,
    score,
    grade,
  };
}

/** Run disjoint/global indices in caller-provided order. */
export function runMonteCarloBatch(
  scenario: Scenario,
  runIndices: number[],
  masterSeed: number,
): MonteCarloRunResult[] {
  return runIndices.map((globalIndex) => runMonteCarloRun(scenario, globalIndex, masterSeed));
}
