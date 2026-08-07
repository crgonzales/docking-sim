import { describe, expect, it } from 'vitest';
import { FINAL_APPROACH_01 } from './scenarios/finalApproach01.js';
import {
  runMonteCarloBatch,
  runMonteCarloRun,
  scoreMonteCarloResult,
} from './monteCarlo.js';

describe('Monte Carlo scenario runner', () => {
  it('is deterministic for the same master seed and run index', () => {
    expect(runMonteCarloRun(FINAL_APPROACH_01, 3, 12345))
      .toEqual(runMonteCarloRun(FINAL_APPROACH_01, 3, 12345));
  }, 120_000);

  it('applies the hand-computed DOCKED scoring formula and grade bounds', () => {
    const scored = scoreMonteCarloResult(FINAL_APPROACH_01, {
      outcome: 'DOCKED',
      prop_consumed_kg: 2,
      time_margin_s: 10,
      corridor_violation_count: 1,
    });
    expect(scored.score).toBe(81);
    expect(scored.grade).toBe('B');
    expect(scoreMonteCarloResult(FINAL_APPROACH_01, {
      outcome: 'WINDOW_MISSED',
      prop_consumed_kg: 0,
      time_margin_s: 0,
      corridor_violation_count: 0,
    })).toEqual({ score: 0, grade: 'F' });
  });

  it('derives unique seeds across disjoint run-index shards', () => {
    const firstShard = runMonteCarloBatch(FINAL_APPROACH_01, [0, 2], 7788);
    const secondShard = runMonteCarloBatch(FINAL_APPROACH_01, [1, 3], 7788);
    const firstSeeds = new Set(firstShard.map((result) => result.seed));
    expect(secondShard.every((result) => !firstSeeds.has(result.seed))).toBe(true);
  }, 240_000);
});

