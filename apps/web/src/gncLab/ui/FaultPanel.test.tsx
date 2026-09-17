import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { getGncSession, startGncSession, stopGncSession } from '../../telemetry/gncEmitter';
import { useTelemetryBus, type GncStamp } from '../../telemetry/bus';
import { DEMO_CASES, NOMINAL_CASE, RCS_STUCK_OPEN_CASE } from '../session/demoRun';
import { useLabStore } from '../session/labStore';
import { FaultPanel, isComparisonPreset, type FaultContext, type FaultPanelBoundary,
  type FaultPanelProps, type FaultRebuildRequest } from './FaultPanel';

afterEach(() => { stopGncSession(); vi.restoreAllMocks(); vi.useRealTimers(); });
function current(): FaultContext | null {
  const session = getGncSession(), tick = useTelemetryBus.getState().gnc;
  if (!session || session.state === 'STOPPED' || !tick) return null;
  const actual = session.snapshot().stamp;
  if (actual.runId !== tick.stamp.runId || actual.epoch !== tick.stamp.epoch) return null;
  return { stamp: tick.stamp, state: session.state, gncCase: session.gncCase };
}
const view = (): FaultPanelProps['view'] => {
  const context = current();
  return context && { ...context, outcome: useTelemetryBus.getState().gnc?.plantTickRecord?.outcome ?? null };
};

/** Real emitter/session adapter illustrates the parent-owned second guard and evidence copy. */
function parent() {
  let previous: { context: FaultContext; stamp: GncStamp; time: Float64Array; activeJ6: Float64Array } | null = null;
  const rebuild = vi.fn((request: FaultRebuildRequest) => {
    const now = current();
    if (!now || now.stamp.source !== 'LIVE' || request.expected.source !== 'LIVE'
      || !['RUNNING', 'PAUSED', 'COMPLETE'].includes(now.state)
      || now.stamp.runId !== request.expected.runId || now.stamp.epoch !== request.expected.epoch
      || now.stamp.configHash !== request.expected.configHash) return false;
    const preset = DEMO_CASES.find(c => c.id === request.caseId)!;
    if (request.seed !== preset.seed || (request.retainPrevious && !isComparisonPreset(now))) return false;
    const session = getGncSession()!, recorder = session.recorder;
    const retained = request.retainPrevious ? { context: now, stamp: session.snapshot().stamp,
      time: recorder.column('time_s'), activeJ6: recorder.column('plant.thrusters/out/activeTime/J6') } : null;
    startGncSession(preset, { paused: true }); // Sole publisher replaces/disposes the prior run.
    previous = retained;
    return true;
  });
  return { boundary: { readCurrent: current, rebuild } satisfies FaultPanelBoundary, rebuild, previous: () => previous };
}
function buttons(boundary: FaultPanelBoundary, shown = view()) {
  const result: Record<string, () => void> = {};
  const visit = (node: React.ReactNode): void => React.Children.forEach(node, child => {
    if (!React.isValidElement<{ children?: React.ReactNode; onClick?: () => void }>(child)) return;
    if (child.type === 'button') result[React.Children.toArray(child.props.children).join('')] = child.props.onClick!;
    else visit(child.props.children);
  });
  visit(FaultPanel({ view: shown, boundary }));
  return {
    all: Object.values(result), nominal: result[`Restart NOMINAL · seed ${NOMINAL_CASE.seed}`],
    fault: result[`Restart RCS_STUCK_OPEN · seed ${RCS_STUCK_OPEN_CASE.seed}`],
    compare: Object.entries(result).find(([label]) => label.startsWith('Keep evidence'))![1],
  };
}
const begin = () => { vi.useFakeTimers(); startGncSession(NOMINAL_CASE, { paused: true }); };

it('rebuilds the exact existing cases through actual button callbacks and retains a reproducible same-seed prefix', () => {
  begin(); const p = parent();
  const first = getGncSession()!; first.advanceTo(20);
  const firstSnapshot = first.snapshot(), old = buttons(p.boundary);
  old.compare();
  const fault = getGncSession()!;
  expect(first.state).toBe('STOPPED'); expect(fault).not.toBe(first); expect(fault.tick).toBe(0);
  expect(fault.gncCase).toEqual(RCS_STUCK_OPEN_CASE);
  expect(p.rebuild.mock.lastCall![0]).toMatchObject({ caseId: 'RCS_STUCK_OPEN', seed: NOMINAL_CASE.seed, retainPrevious: true });
  expect([...p.previous()!.time]).toEqual([firstSnapshot.previousFsw!.sampleTime_s, firstSnapshot.fswTrace!.sampleTime_s]);
  expect(p.previous()!.context.stamp.runId).toBe(firstSnapshot.stamp.runId);
  expect(p.previous()!.stamp).toEqual(firstSnapshot.stamp);
  fault.advanceTo(20);
  expect(fault.snapshot().fswTrace).toEqual(firstSnapshot.fswTrace);
  expect(fault.snapshot().plantWindow).toEqual(firstSnapshot.plantWindow); // Same seed/config, before the scheduled fault.
  buttons(p.boundary).nominal();
  expect(fault.state).toBe('STOPPED'); expect(getGncSession()!.gncCase).toEqual(NOMINAL_CASE);
  expect(p.previous()).toBeNull();
  buttons(p.boundary).fault();
  expect(getGncSession()!.gncCase.schedule).toEqual([
    { tick: 30000, command: { kind: 'INJECT_THRUSTER_STUCK', thrusterId: 'J6', state: 'OPEN' } },
    { tick: 34000, command: { kind: 'ISOLATE_THRUSTER', thrusterId: 'J6' } },
  ]);
});

it('retained callbacks cannot touch a replacement run or presentation state', () => {
  begin(); const p = parent(), old = buttons(p.boundary);
  startGncSession(RCS_STUCK_OPEN_CASE, { paused: true });
  const session = getGncSession()!, before = useLabStore.getState();
  for (const call of old.all) call();
  expect(p.rebuild).not.toHaveBeenCalled(); expect(getGncSession()).toBe(session);
  expect(session.tick).toBe(0); expect(useLabStore.getState()).toBe(before);
});

it('independently guards captured/current source, run, epoch, config and STOPPED state at invocation', () => {
  begin(); const p = parent(), shown = view()!, original = current()!;
  for (const stamp of [{ ...shown.stamp, source: 'REPLAY' as const }, { ...shown.stamp, runId: 'other' },
    { ...shown.stamp, epoch: shown.stamp.epoch + 1 }, { ...shown.stamp, configHash: 'other' }]) {
    for (const call of buttons(p.boundary, { ...shown, stamp }).all) call();
  }
  const old = buttons(p.boundary), tick = useTelemetryBus.getState().gnc!;
  useTelemetryBus.setState({ gnc: { ...tick, stamp: { ...tick.stamp, source: 'REPLAY' } } });
  for (const call of old.all) call(); // Underlying live session still exists, but current source changed.
  expect(p.rebuild).not.toHaveBeenCalled();
  useTelemetryBus.setState({ gnc: tick });
  const stoppedBoundary = { ...p.boundary, readCurrent: () => ({ ...original, state: 'STOPPED' as const }) };
  for (const call of buttons(stoppedBoundary).all) call();
  stopGncSession(); const before = useLabStore.getState();
  for (const call of old.all) call();
  expect(p.rebuild).not.toHaveBeenCalled(); expect(useLabStore.getState()).toBe(before);
});

it('allows a matching COMPLETE restart and rejects an edited case for comparison', () => {
  begin(); const p = parent();
  startGncSession({ ...NOMINAL_CASE, maxTicks: 10 }, { paused: true });
  const run = getGncSession()!, controls = buttons(p.boundary);
  expect(isComparisonPreset(current()!)).toBe(false); controls.compare(); expect(p.rebuild).not.toHaveBeenCalled();
  run.advanceTo(10); expect(run.state).toBe('COMPLETE');
  controls.nominal(); expect(run.state).toBe('STOPPED'); expect(getGncSession()!.gncCase).toEqual(NOMINAL_CASE);
  const standard = current()!;
  for (const gncCase of [{ ...standard.gncCase, seed: 4 }, { ...standard.gncCase, schedule: RCS_STUCK_OPEN_CASE.schedule },
    { ...standard.gncCase, config: { ...standard.gncCase.config, initial: { ...standard.gncCase.config.initial, prop_kg: 99 } } }]) {
    expect(isComparisonPreset({ ...standard, gncCase })).toBe(false);
  }
});

it('captures scalar identity and leaves the parent final guard authoritative', () => {
  begin(); const p = parent(), shown = { ...view()!, stamp: { ...view()!.stamp } }, old = buttons(p.boundary, shown);
  startGncSession(RCS_STUCK_OPEN_CASE, { paused: true }); Object.assign(shown.stamp, current()!.stamp);
  old.nominal(); expect(p.rebuild).not.toHaveBeenCalled();
  const expected = current()!.stamp;
  startGncSession(NOMINAL_CASE, { paused: true });
  expect(p.boundary.rebuild({ expected, caseId: 'RCS_STUCK_OPEN', seed: NOMINAL_CASE.seed, retainPrevious: false })).toBe(false);
  expect(getGncSession()!.gncCase.id).toBe('NOMINAL');
});

it('labels schedules and baseline separately from observed outcomes without inferring successful departure', () => {
  begin(); const p = parent(), shown = view()!;
  const html = renderToStaticMarkup(React.createElement(FaultPanel, { view: shown, boundary: p.boundary }));
  expect(html).toContain('Observed outcome: UNAVAILABLE');
  expect(html).toContain('Tick 30000 (300.00 s)'); expect(html).toContain('operator isolates J6');
  expect(html).toContain('Tick 34000 (340.00 s)'); expect(html).toContain('Recorded baseline at seed 1004: ABORT');
  expect(html).toContain('Isolation is scripted operator action');
  expect(html).not.toMatch(/safe departure|autonomous FDI|recovery successful|successful departure/i);
  const aborted = renderToStaticMarkup(React.createElement(FaultPanel, { view: { ...shown, outcome: 'ABORT' }, boundary: p.boundary }));
  expect(aborted).toContain('Observed outcome: ABORT'); expect(p.rebuild).not.toHaveBeenCalled();
});
