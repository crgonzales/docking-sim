import { describe, expect, it } from 'vitest';
import { createSimLoop } from '@docking/sim-core';
import { SIM_CONFIG, SIM_SEED } from './simEmitter';

describe('sim emitter configuration', () => {
  it('produces identical first-50 frame sequences for fresh loops with the fixed seed', () => {
    const first = createSimLoop(SIM_CONFIG, SIM_SEED).stepTo(5);
    const second = createSimLoop(SIM_CONFIG, SIM_SEED).stepTo(5);
    expect(first).toHaveLength(50);
    expect(second).toEqual(first);
  });
});
