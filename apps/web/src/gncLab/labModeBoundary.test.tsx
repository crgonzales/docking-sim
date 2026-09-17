import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { GncMode } from './GncMode';
import { getGncSession, stopGncSession, stepGncSession } from '../telemetry/gncEmitter';
import { useTelemetryBus } from '../telemetry/bus';
import { SceneRoot } from '../scene/SceneRoot';
import { GncLab } from './ui/GncLab';

const effects = vi.hoisted(() => [] as (() => void | (() => void))[]);
vi.mock('react', async original => ({ ...await original<typeof React>(), useEffect: (effect: () => void | (() => void)) => effects.push(effect) }));
vi.mock('../scene/SceneRoot', () => ({ SceneRoot: () => null }));
vi.mock('./ui/GncLab', () => ({ GncLab: () => null }));
afterEach(() => { stopGncSession(); effects.length = 0; vi.useRealTimers(); });

it('composes the existing scene with the subscriber overlay and releases its sole publisher across remounts', () => {
  vi.useFakeTimers();
  const element = GncMode();
  expect(React.Children.toArray(element.props.children).map(child => (child as React.ReactElement).type)).toEqual([SceneRoot, GncLab]);
  expect(getGncSession()).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  const mount = effects[0];
  const cleanup = mount() as () => void;
  const old = useTelemetryBus.getState().gnc!;
  expect(getGncSession()).not.toBeNull(); expect(vi.getTimerCount()).toBe(1);
  cleanup(); expect(getGncSession()).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  expect(useTelemetryBus.getState().gnc).toBeNull(); expect(useTelemetryBus.getState().renderState).toBeNull();
  // React StrictMode's setup/cleanup/setup cycle must not multiply owners.
  const secondCleanup = mount() as () => void;
  expect(vi.getTimerCount()).toBe(1);
  const current = useTelemetryBus.getState().gnc!;
  expect(current.stamp.epoch).toBeGreaterThan(old.stamp.epoch);
  useTelemetryBus.getState().publishGncTick(old);
  expect(useTelemetryBus.getState().gnc).toBe(current);
  secondCleanup(); stepGncSession('TRUTH');
  expect(getGncSession()).toBeNull(); expect(vi.getTimerCount()).toBe(0);
});
