import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSimLoop } from '@docking/sim-core';
import { useAppModeStore } from '../appModeStore';
import { useTelemetryBus } from './bus';
import { inspectThruster, SIM_CONFIG, SIM_SEED, stopSimEmitter } from './simEmitter';

describe('sim emitter configuration', () => {
  it('produces identical first-50 frame sequences for fresh loops with the fixed seed', () => {
    const first = createSimLoop(SIM_CONFIG, SIM_SEED).stepTo(5);
    const second = createSimLoop(SIM_CONFIG, SIM_SEED).stepTo(5);
    expect(first).toHaveLength(50);
    expect(second).toEqual(first);
  });
});

beforeEach(() => { vi.useFakeTimers(); useTelemetryBus.setState({ frame: null, renderState: null }); });
afterEach(() => { stopSimEmitter(); useAppModeStore.setState({ mode: 'SANDBOX' }); vi.useRealTimers(); });

it.each(['MISSION', 'FLIGHT', 'ANALYSIS'] as const)('does not let inspection start a sandbox publisher in %s', mode => {
  useAppModeStore.setState({ mode });
  const before = useTelemetryBus.getState();
  inspectThruster('J1');
  expect(vi.getTimerCount()).toBe(0);
  expect(useTelemetryBus.getState()).toBe(before);
});

it('keeps real inspection available in sandbox and stops its publisher on cleanup', () => {
  useAppModeStore.setState({ mode: 'SANDBOX' });
  inspectThruster('J1');
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(100);
  expect(useTelemetryBus.getState().renderState?.thruster_duty.J1).toBeCloseTo(1, 12);
  inspectThruster(null);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(100);
  expect(Object.values(useTelemetryBus.getState().renderState!.thruster_duty).every(duty => duty === 0)).toBe(true);
  stopSimEmitter();
  expect(vi.getTimerCount()).toBe(0);
});
