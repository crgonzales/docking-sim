import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { getGncSession, startGncSession, stopGncSession, retryGncSession } from '../../telemetry/gncEmitter';
import { useTelemetryBus } from '../../telemetry/bus';
import { useLabStore } from '../session/labStore';
import { NOMINAL_CASE, RCS_STUCK_OPEN_CASE } from '../session/demoRun';
import { FaultPanel, type FaultRebuildRequest } from './FaultPanel';
import { PLOT_COLUMN_IDS, alignPlotColumns } from './SignalPlots';
import { createLabEvidence, readLabContext, type LabEvidence } from './labEvidence';

let disconnect: (() => void) | undefined;
afterEach(() => { disconnect?.(); disconnect = undefined; stopGncSession(); vi.restoreAllMocks(); vi.useRealTimers(); });
function begin() {
  vi.useFakeTimers();
  startGncSession(NOMINAL_CASE, { paused: true, playbackRate: 4, publishHz: 5 });
  const model = createLabEvidence(); disconnect = model.connect(); return model;
}
const publish = () => useTelemetryBus.getState().publishGncTick(getGncSession()!.snapshot());
const request = (retainPrevious = true): FaultRebuildRequest => ({ expected: { ...readLabContext()!.stamp },
  caseId: getGncSession()!.gncCase.id === 'NOMINAL' ? 'RCS_STUCK_OPEN' : 'NOMINAL', seed: NOMINAL_CASE.seed, retainPrevious });
function compareButton(model: LabEvidence) {
  const callbacks: (() => void)[] = [];
  const visit = (node: React.ReactNode) => React.Children.forEach(node, child => {
    if (!React.isValidElement<{ children?: React.ReactNode; onClick?: () => void }>(child)) return;
    if (child.type === 'button' && React.Children.toArray(child.props.children).join('').startsWith('Keep evidence')) callbacks.push(child.props.onClick!);
    else visit(child.props.children);
  });
  visit(FaultPanel({ view: { ...readLabContext()!, outcome: null }, boundary: model.boundary }));
  return callbacks[0];
}

it('caches detached populated columns only at published completed boundaries and waits for an ahead session', () => {
  const model = begin(), session = getGncSession()!;
  const copy = vi.spyOn(session.recorder, 'column');
  session.advanceTo(10); publish();
  const first = model.getSnapshot().current!;
  expect(copy).toHaveBeenCalledTimes(PLOT_COLUMN_IDS.length);
  expect(first.data.stamp).toEqual(session.snapshot().stamp);
  session.advanceTo(11); publish();
  expect(model.getSnapshot().current).toBe(first);
  expect(copy).toHaveBeenCalledTimes(PLOT_COLUMN_IDS.length);
  session.advanceTo(30); // Session ahead of the atomic bus, as before a coalesced publication.
  useTelemetryBus.setState({ gnc: { ...useTelemetryBus.getState().gnc! } });
  expect(model.getSnapshot().current).toBe(first);
  publish();
  expect([...model.getSnapshot().current!.data.columns.time_s]).toEqual([
    expect.closeTo(.1, 12), expect.closeTo(.2, 12), expect.closeTo(.3, 12)]);
  expect(copy).toHaveBeenCalledTimes(PLOT_COLUMN_IDS.length * 2);
  expect([...first.data.columns.time_s]).toEqual([expect.closeTo(.1, 12)]);
  first.data.columns.time_s[0] = 999;
  expect(session.recorder.column('time_s')[0]).toBeCloseTo(.1, 12); // No recorder corruption via a detached copy.
});

it('integrates the actual comparison callback, captures the invoke-time prefix, and replaces the sole publisher', () => {
  const model = begin(), first = getGncSession()!, compare = compareButton(model);
  first.advanceTo(25); // Deliberately leave the displayed clock at startup.
  const stamp = first.snapshot().stamp;
  const expected = Object.fromEntries(PLOT_COLUMN_IDS.map(id => [id, first.recorder.column(id)]));
  compare();
  const second = getGncSession()!, previous = model.getSnapshot().previous!;
  expect(first.state).toBe('STOPPED'); expect(second.tick).toBe(0);
  expect(second.gncCase).toEqual(RCS_STUCK_OPEN_CASE);
  expect(second.state).toBe('PAUSED'); expect(vi.getTimerCount()).toBe(1);
  expect(useLabStore.getState()).toMatchObject({ playbackRate: 4, publishHz: 5 });
  expect(previous.data.stamp).toEqual(stamp); expect(previous.complete).toBe(false);
  expect(previous.data.columns).toEqual(expected);
  expect(alignPlotColumns(previous.data).map(row => row.time_s)).toEqual([...expected.time_s]);
  expect(Object.values(previous.data.columns).reduce((n, c) => n + c.byteLength, 0)).toBe(2 * PLOT_COLUMN_IDS.length * 8);
  second.advanceTo(20); publish();
  expect(model.getSnapshot().current!.data.columns).toEqual(previous.data.columns); // Real same-seed, pre-fault records.
  const before = model.getSnapshot(), presentation = useLabStore.getState();
  compare(); // Retained button cannot rebuild the replacement or clear comparison/error state.
  expect(model.getSnapshot()).toBe(before); expect(useLabStore.getState()).toBe(presentation);
  expect(getGncSession()).toBe(second);
  const secondStamp = second.snapshot().stamp;
  compareButton(model)();
  expect(model.getSnapshot().previous!.data.stamp.runId).toBe(secondStamp.runId);
});

it('keeps one previous buffer, clears it on ordinary replacement/source change, and cleans up without stopping the owner', () => {
  const model = begin(); getGncSession()!.advanceTo(10); publish();
  expect(model.boundary.rebuild(request())).toBe(true);
  const retained = model.getSnapshot().previous;
  getGncSession()!.advanceTo(10); publish();
  expect(model.boundary.rebuild(request())).toBe(true);
  expect(model.getSnapshot().previous).not.toBe(retained);
  retryGncSession(); expect(model.getSnapshot().previous).toBeNull();
  model.boundary.rebuild(request());
  const live = useTelemetryBus.getState().gnc!, stale = request(false);
  useTelemetryBus.setState({ gnc: { ...live, stamp: { ...live.stamp, source: 'REPLAY' } } });
  expect(model.getSnapshot()).toEqual({ current: null, previous: null, error: null });
  expect(model.boundary.rebuild(stale)).toBe(false);
  useTelemetryBus.setState({ gnc: live });
  const session = getGncSession()!;
  disconnect!(); expect(getGncSession()).toBe(session); expect(vi.getTimerCount()).toBe(1);
  expect(model.getSnapshot().current).toBeNull(); expect(model.boundary.rebuild(request(false))).toBe(false);
  publish(); expect(model.getSnapshot().current).toBeNull();
});

it('preserves healthy evidence and session on public-API refusal, and does not clear errors on rejected requests', () => {
  const model = begin(); getGncSession()!.advanceTo(10); publish(); model.boundary.rebuild(request());
  getGncSession()!.advanceTo(20); publish();
  const session = getGncSession(), before = model.getSnapshot();
  useLabStore.setState({ publishHz: 21 }); // Actual emitter validation refuses before replacement.
  expect(model.boundary.rebuild(request())).toBe(false);
  const refused = model.getSnapshot();
  expect(getGncSession()).toBe(session); expect(refused.current).toBe(before.current); expect(refused.previous).toBe(before.previous);
  expect(refused.error!.stamp).toEqual(readLabContext()!.stamp); expect(refused.error!.message).toContain('2–20 Hz');
  const valid = request();
  for (const expected of [{ ...valid.expected, source: 'REPLAY' as const }, { ...valid.expected, runId: 'other' },
    { ...valid.expected, epoch: valid.expected.epoch + 1 }, { ...valid.expected, configHash: 'other' }]) {
    expect(model.boundary.rebuild({ ...valid, expected })).toBe(false); expect(model.getSnapshot()).toBe(refused);
  }
  useLabStore.setState({ publishHz: 5 });
  expect(model.boundary.rebuild(request(false))).toBe(true);
  expect(model.getSnapshot().previous).toBeNull(); expect(model.getSnapshot().error).toBeNull();
});

it('rejects invalid preset comparisons but allows an actual COMPLETE run to restart', () => {
  const model = begin();
  expect(model.boundary.rebuild({ ...request(), caseId: 'NOMINAL' })).toBe(false);
  expect(model.boundary.rebuild({ ...request(), seed: 999 })).toBe(false);
  startGncSession({ ...NOMINAL_CASE, maxTicks: 10 }, { paused: true });
  getGncSession()!.advanceTo(10); publish();
  expect(model.getSnapshot().current!.complete).toBe(true);
  expect(model.boundary.rebuild(request())).toBe(false);
  expect(model.boundary.rebuild(request(false))).toBe(true);
  const stale = request(); stopGncSession();
  expect(model.boundary.rebuild(stale)).toBe(false); expect(model.getSnapshot().current).toBeNull();
});
