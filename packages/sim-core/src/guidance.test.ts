import { describe, expect, it } from 'vitest';
import { createGuidance } from './guidance.js';
import type { State6 } from './ekf.js';

describe('V-bar guidance', () => {
  it('starts at the configured state and approaches the 30 m hold point', () => {
    const initialState: State6 = [12, -250, 7, 0.02, 0.85, -0.05];
    const guidance = createGuidance({
      initialState,
      closingGain_s_inv: 0.01,
      maxClosingSpeed_mps: 0.5,
    });
    const start = guidance.reference(0);
    const later = guidance.reference(4_000);
    expect(start.state).toEqual(initialState);
    expect(later.r_hill_m[1]).toBeGreaterThan(initialState[1]);
    expect(later.r_hill_m[1]).toBeCloseTo(-30, 0);
    expect(later.r_hill_m[0]).toBeCloseTo(0, 0);
    expect(later.r_hill_m[2]).toBeCloseTo(0, 0);
    expect(later.v_hill_mps[1]).toBeGreaterThan(-0.01);
  });
});
