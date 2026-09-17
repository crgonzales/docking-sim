import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { GncLabView } from './ui/GncLab';
import { NOMINAL_CASE } from './session/demoRun';
import { useLabStore } from './session/labStore';
import { useTelemetryBus, type GncTick } from '../telemetry/bus';
import { getGncSession, startGncSession, stopGncSession, retryGncSession,
  pauseGncSession, resumeGncSession } from '../telemetry/gncEmitter';

vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof React>(),
  useState: (initial: unknown) => [initial, () => {}],
}));

afterEach(() => { stopGncSession(); vi.restoreAllMocks(); vi.useRealTimers(); });

/** Only the component's local error hook is stubbed. The returned callbacks,
 * telemetry bus, session replacement, pacing store and simulation are real. */
function controls(tick: GncTick | null = useTelemetryBus.getState().gnc) {
  const result: Record<string, () => void> = {};
  const visit = (node: React.ReactNode): void => {
    React.Children.forEach(node, child => {
      if (!React.isValidElement<{ children?: React.ReactNode; onClick?: () => void }>(child)) return;
      if (child.type === 'button' && child.props.onClick)
        result[React.Children.toArray(child.props.children).join('')] = child.props.onClick;
      else visit(child.props.children);
    });
  };
  visit(GncLabView({ tick, presentation: useLabStore.getState() }));
  return result;
}

const begin = () => {
  vi.useFakeTimers();
  startGncSession({ ...NOMINAL_CASE, maxTicks: 30 }, { paused: true });
};

it.each(['retry', 'replacement'] as const)('retained callbacks cannot mutate a new run after %s', replacement => {
  begin();
  const old = controls();
  resumeGncSession(); old.Pause = controls().Pause;
  if (replacement === 'retry') retryGncSession();
  else startGncSession({ ...NOMINAL_CASE, maxTicks: 30 }, { paused: true });
  const current = getGncSession()!, stamp = current.snapshot().stamp, state = current.state;
  const presentation = useLabStore.getState();
  for (const callback of Object.values(old)) callback();
  expect(getGncSession()).toBe(current);
  expect(current.snapshot().stamp).toEqual(stamp);
  expect(current.state).toBe(state);
  expect(useLabStore.getState()).toEqual(presentation);
});

it('rejects replay, mismatched run/epoch and stopped callbacks at invocation', () => {
  begin();
  const live = useTelemetryBus.getState().gnc!;
  for (const stamp of [{ ...live.stamp, source: 'REPLAY' as const },
    { ...live.stamp, runId: 'another-run' }, { ...live.stamp, epoch: live.stamp.epoch + 1 }]) {
    const before = useLabStore.getState();
    for (const callback of Object.values(controls({ ...live, stamp }))) callback();
    expect(getGncSession()!.snapshot().stamp).toEqual(live.stamp);
    expect(useLabStore.getState()).toEqual(before);
  }
  const old = controls(); stopGncSession(); const stopped = useLabStore.getState();
  for (const callback of Object.values(old)) callback();
  expect(getGncSession()).toBeNull(); expect(useLabStore.getState()).toEqual(stopped);
});

it('checks current state while keeping matching live controls and completed Retry usable', () => {
  begin();
  const paused = controls(); paused.Resume();
  expect(getGncSession()!.state).toBe('RUNNING');
  const running = controls(); running.Pause();
  expect(getGncSession()!.state).toBe('PAUSED');
  const beforePause = useLabStore.getState(); running.Pause();
  expect(useLabStore.getState()).toBe(beforePause); // Already paused, stale action is inert.
  paused['Step 0.01 s'](); expect(getGncSession()!.tick).toBe(1);
  paused['Step 0.10 s'](); expect(getGncSession()!.tick).toBe(11);
  paused['4×'](); expect(useLabStore.getState().playbackRate).toBe(4);
  const current = getGncSession()!; current.advanceTo(30);
  for (const [label, callback] of Object.entries(paused)) if (label !== 'Retry') callback();
  expect(current.state).toBe('COMPLETE'); expect(current.tick).toBe(30);
  expect(useLabStore.getState().playbackRate).toBe(4);
  paused.Retry(); expect(getGncSession()).not.toBe(current);
  expect(getGncSession()!.tick).toBe(0);
  pauseGncSession();
});
