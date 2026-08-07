import { describe, expect, it } from 'vitest';
import { CAPTURE_ENVELOPE, CORRIDOR } from './corridor.js';
import { createMpc } from './mpc.js';
import type { State6 } from './ekf.js';

const AUTHORITY: [number, number, number] = [0.5, 0.5, 0.5];
const TOLERANCE = 1e-4;

function facetValue(state: State6, facet: number): number {
  const angle = facet * Math.PI / 4;
  const slope = Math.tan(CORRIDOR.halfAngle_rad) * Math.cos(Math.PI / 8);
  return Math.cos(angle) * state[0]
    + slope * (state[1] - CORRIDOR.apex_hill_m[1])
    + Math.sin(angle) * state[2];
}

function assertAuthority(accel: number[]): void {
  for (let axis = 0; axis < accel.length; axis += 3) {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      expect(sx * accel[axis]! / AUTHORITY[0]
        + sy * accel[axis + 1]! / AUTHORITY[1]
        + sz * accel[axis + 2]! / AUTHORITY[2]).toBeLessThanOrEqual(1 + TOLERANCE);
    }
  }
}

describe('createMpc', () => {
  it('uses the default 30-stage, one-second specific-force horizon', () => {
    const mpc = createMpc({ authority_mps2: AUTHORITY });
    expect(mpc.horizonSteps).toBe(30);
    expect(mpc.dt_s).toBe(1);
    expect(mpc.authority_mps2).toEqual(AUTHORITY);
  });

  it('solves a feasible near-port trajectory with zero soft violations', () => {
    const mpc = createMpc({ horizonSteps: 8, authority_mps2: AUTHORITY, maxIterations: 150 });
    const result = mpc.step([0, -10.2, 0, 0, 0.03, 0], 0);

    expect(result.status).toBe('optimal');
    expect(result.diagnostics.slacks.corridor_m).toBeLessThan(TOLERANCE);
    expect(result.diagnostics.slacks.terminalPosition_m).toBeLessThan(TOLERANCE);
    expect(result.diagnostics.slacks.terminalVelocity_mps).toBeLessThan(TOLERANCE);
    result.diagnostics.engagedStages.forEach((stage) => {
      for (let facet = 0; facet < 8; facet += 1) expect(facetValue(result.predictedStates[stage]!, facet)).toBeLessThanOrEqual(TOLERANCE);
    });
    assertAuthority(result.stackedAccel_hill_mps2);
    const terminal = result.predictedStates.at(-1)!;
    expect(Math.abs(terminal[0])).toBeLessThanOrEqual(CAPTURE_ENVELOPE.lateral_m + TOLERANCE);
    expect(Math.abs(terminal[2])).toBeLessThanOrEqual(CAPTURE_ENVELOPE.lateral_m + TOLERANCE);
  });

  it('recaptures a start outside the inner cone with positive slack', () => {
    const mpc = createMpc({ horizonSteps: 8, authority_mps2: AUTHORITY, maxIterations: 150 });
    const result = mpc.step([20, -50, 0, 0, 0, 0], 0);

    expect(result.status).toBe('optimal');
    expect(result.diagnostics.slacks.corridor_m).toBeGreaterThan(0);
  });

  it('keeps an unreachable terminal set optimal and reports terminal slack', () => {
    const mpc = createMpc({ horizonSteps: 2, authority_mps2: [0.001, 0.001, 0.001], maxIterations: 150 });
    const result = mpc.step([0, -10, 0, 0, 0, 0], 0);

    expect(result.status).toBe('optimal');
    expect(result.diagnostics.slacks.terminalVelocity_mps).toBeGreaterThan(0);
  });

  it('returns zero effort at the port reference', () => {
    const mpc = createMpc({ horizonSteps: 4, authority_mps2: AUTHORITY, maxIterations: 150, effortWeight: 1e6 });
    const result = mpc.step([0, CORRIDOR.apex_hill_m[1], 0, 0, 0.05, 0], 0);

    expect(result.status).toBe('optimal');
    expect(result.accel_hill_mps2.every((value) => Math.abs(value) < TOLERANCE)).toBe(true);
  });

  it('holds the last solved command between one-second MPC ticks', () => {
    const mpc = createMpc({ horizonSteps: 4, authority_mps2: AUTHORITY, maxIterations: 150 });
    const first = mpc.step([3, -20, 0, 0, 0.03, 0], 0);
    const held = mpc.step([30, -80, 5, 0, 0, 0], 0.1);

    expect(held.accel_hill_mps2).toEqual(first.accel_hill_mps2);
    expect(held.status).toBe(first.status);
  });

  it('propagates an iteration cap without falling back internally', () => {
    const mpc = createMpc({ horizonSteps: 4, authority_mps2: AUTHORITY, maxIterations: 1 });
    const result = mpc.step([0, -20, 0, 0, 0, 0], 0);

    expect(result.status).toBe('iteration_capped');
  });

  it('is deterministic across identical controllers and inputs', () => {
    const first = createMpc({ horizonSteps: 6, authority_mps2: AUTHORITY, maxIterations: 150 });
    const second = createMpc({ horizonSteps: 6, authority_mps2: AUTHORITY, maxIterations: 150 });
    const state: State6 = [3, -20, -1, 0, 0.03, 0];

    expect(second.step(state, 0)).toEqual(first.step(state, 0));
  });
});
