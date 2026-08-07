// @ts-ignore The package intentionally has no Node type dependency; Vitest supplies this test-only runtime module.
import { readdirSync, readFileSync } from 'node:fs';
// @ts-ignore The package intentionally has no Node type dependency; Vitest supplies this test-only runtime module.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSimLoop } from '@docking/sim-core';
import { FINAL_APPROACH_01 } from './scenarios/finalApproach01.js';
import { createScenarioDirector } from './director.js';
import { createPerfectOperatorBot } from './perfectOperatorBot.js';
import { runMonteCarloRun } from './monteCarlo.js';
import { scenarioToSimConfig } from './scenarioToSimConfig.js';
import { validateScenario } from './schema.js';
import type { TelemetryFrame } from '@docking/sim-core';

declare const process: { cwd(): string };

interface ScriptedRun {
  frames: TelemetryFrame[];
  outcome: string | null;
}

function runWithoutInputs(seed: number): ScriptedRun {
  const sim = createSimLoop(scenarioToSimConfig(FINAL_APPROACH_01.initial), seed);
  const director = createScenarioDirector(FINAL_APPROACH_01, sim);
  director.launch();
  const frames: TelemetryFrame[] = [];
  let state = director.getState();
  for (let t_s = 1; t_s <= FINAL_APPROACH_01.clock.duration_s && state.outcome === null; t_s += 1) {
    state = director.tick(t_s);
    if (state.telemetry !== null) frames.push(state.telemetry);
  }
  return { frames, outcome: state.outcome };
}

describe('scenario Section 7 acceptance', () => {
  it('is deterministic for identical seeds and scripted inputs', () => {
    const first = runWithoutInputs(20260805);
    const second = runWithoutInputs(20260805);
    expect(first.frames).toEqual(second.frames);
    expect(first.outcome).toEqual(second.outcome);
  }, 30_000);

  it('zero-input operation ends safely without docking or collision', () => {
    const result = runWithoutInputs(20260805);
    expect(['PASSIVE_ABORT', 'WINDOW_MISSED']).toContain(result.outcome);
  }, 30_000);

  it('the perfect operator bot completes FINAL_APPROACH_01', () => {
    const result = runMonteCarloRun(FINAL_APPROACH_01, 0, FINAL_APPROACH_01.seed);
    expect(result.outcome).toBe('DOCKED');
  }, 120_000);

  it('validates the shipped scenario and rejects unknown fields', () => {
    expect(() => validateScenario(FINAL_APPROACH_01)).not.toThrow();
    const invalid = JSON.parse(JSON.stringify(FINAL_APPROACH_01)) as Record<string, unknown>;
    invalid.unknown = true;
    expect(() => validateScenario(invalid)).toThrow();
  });

  it('keeps scenario production code honest about the sim boundary', () => {
    const sourceRoot = join(process.cwd(), 'src');
    const files: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path);
      }
    };
    visit(sourceRoot);
    const production = files.map((path) => readFileSync(path, 'utf8')).join('\n')
      .replace(/export type ScenarioSimPort = Omit<SimLoop, 'getTruthState' \| 'getRenderState'>;/g, '');
    expect(production).not.toMatch(/@docking\/sim-core\//);
    expect(production).not.toMatch(/sim-core\/src/);
    expect(production).not.toMatch(/getTruthState|getRenderState/);
  });
});
