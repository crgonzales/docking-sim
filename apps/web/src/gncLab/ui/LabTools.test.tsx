import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { useTelemetryBus } from '../../telemetry/bus';
import { getGncSession, startGncSession, stopGncSession } from '../../telemetry/gncEmitter';
import { useLabStore } from '../session/labStore';
import { NOMINAL_CASE } from '../session/demoRun';
import { LabTools, EvidenceLabel, observePlotWidth } from './LabTools';
import { createLabEvidence, readLabContext } from './labEvidence';
import { SignalPlots } from './SignalPlots';
import { FaultPanel } from './FaultPanel';
import { GncLabView } from './GncLab';
import { BlockDiagram } from './BlockDiagram';
import { BlockNode } from './BlockNode';
import { Inspector } from './Inspector';

// Only local selection/layout hooks are replaced; components, callbacks, stores and runs are real.
const local = vi.hoisted(() => ({ selection: null as unknown, previous: false }));
vi.mock('react', async original => ({ ...await original<typeof React>(),
  useState: (initial: unknown) => initial === false ? [local.previous, (value: boolean) => { local.previous = value; }]
    : initial === null ? [local.selection, (value: unknown) => { local.selection = value; }] : [initial, () => {}],
  useRef: () => ({ current: null }), useEffect: () => {},
}));
let disconnect: (() => void) | undefined;
afterEach(() => { disconnect?.(); disconnect = undefined; stopGncSession(); local.selection = null; local.previous = false;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function elements(root: React.ReactNode): React.ReactElement[] {
  const result: React.ReactElement[] = [];
  React.Children.forEach(root, child => {
    if (React.isValidElement<{ children?: React.ReactNode }>(child)) result.push(child, ...elements(child.props.children));
  });
  return result;
}

it('measures real host width, follows content resizing and rejects late deliveries after cleanup', () => {
  let callback: ResizeObserverCallback;
  const observe = vi.fn(), disconnectObserver = vi.fn(), update = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(next: ResizeObserverCallback) { callback = next; }
    observe = observe; disconnect = disconnectObserver;
  });
  const host = { clientWidth: 641 } as HTMLElement;
  const stop = observePlotWidth(host, update);
  expect(update).toHaveBeenLastCalledWith(641); expect(observe).toHaveBeenCalledWith(host);
  const resized = (width: number) => callback([{ target: host, contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
  resized(317.8); expect(update).toHaveBeenLastCalledWith(317);
  resized(0); expect(update).toHaveBeenLastCalledWith(0); // No guessed width for a hidden host.
  stop(); resized(800); expect(update).toHaveBeenCalledTimes(3); expect(disconnectObserver).toHaveBeenCalledOnce();
});

it('mounts tools only inside the selected inspector while preserving its close behavior', () => {
  const tools = <span data-testid="tools">Evidence tools</span>;
  const props = { tick: null, presentation: useLabStore.getState(), tools };
  const diagram = elements(GncLabView(props)).find(el => el.type === BlockDiagram)!;
  expect(diagram.props.tools).toBe(tools);
  expect(elements(BlockDiagram(diagram.props))).not.toContain(tools);
  vi.useFakeTimers(); startGncSession(NOMINAL_CASE, { paused: true });
  const tick = useTelemetryBus.getState().gnc!;
  const node = elements(BlockDiagram({ tick, tools })).find(el => el.type === BlockNode)!;
  node.props.onSelect(node.props.id);
  const opened = elements(BlockDiagram({ tick, tools }));
  expect(opened).toContain(tools); expect(opened.some(el => el.type === Inspector)).toBe(true);
  opened.find(el => el.props['aria-label'] === 'Close stage connections')!.props.onClick();
  expect(elements(BlockDiagram({ tick, tools }))).not.toContain(tools);
});

it('retained header controls consult the current bus source even while the original live session survives', () => {
  vi.useFakeTimers(); startGncSession(NOMINAL_CASE, { paused: true });
  const tick = useTelemetryBus.getState().gnc!, session = getGncSession()!;
  const controls = elements(GncLabView({ tick, presentation: useLabStore.getState() }))
    .filter(el => el.type === 'button');
  const before = useLabStore.getState();
  useTelemetryBus.setState({ gnc: { ...tick, stamp: { ...tick.stamp, source: 'REPLAY' } } });
  controls.forEach(button => button.props.onClick());
  expect(getGncSession()).toBe(session); expect(session.tick).toBe(0); expect(session.state).toBe('PAUSED');
  expect(useLabStore.getState()).toBe(before);
});

it('switches one three-plot group between correctly stamped current/previous evidence while controls stay current', () => {
  vi.useFakeTimers(); startGncSession(NOMINAL_CASE, { paused: true });
  const model = createLabEvidence(); disconnect = model.connect();
  getGncSession()!.advanceTo(25);
  model.boundary.rebuild({ expected: readLabContext()!.stamp, caseId: 'RCS_STUCK_OPEN', seed: NOMINAL_CASE.seed, retainPrevious: true });
  const state = model.getSnapshot(), tick = useTelemetryBus.getState().gnc!;
  const render = () => elements(LabTools({ model, state, tick }));
  let tree = render();
  expect(tree.filter(el => el.type === SignalPlots)).toHaveLength(1);
  expect(tree.find(el => el.type === SignalPlots)!.props.current).toBe(tick.stamp);
  tree.find(el => el.type === 'button' && el.props.children === 'Previous recorded prefix / run')!.props.onClick();
  tree = render();
  const chart = tree.find(el => el.type === SignalPlots)!;
  expect(chart.props.data).toBe(state.previous!.data); expect(chart.props.current).toBe(state.previous!.data.stamp);
  expect(tree.filter(el => el.type === SignalPlots)).toHaveLength(1);
  const controls = tree.find(el => el.type === FaultPanel)!;
  expect(controls.props.view.stamp.runId).toBe(tick.stamp.runId);
  expect(controls.props.view.outcome).toBeNull(); expect(controls.props.boundary).toBe(model.boundary);
  const label = renderToStaticMarkup(<EvidenceLabel evidence={state.previous!} previous />);
  expect(label).toContain('Previous recorded evidence'); expect(label).toContain('Recorded prefix — not a completed run');
  expect(label).toContain('plant tick 25 (0.25 s)'); expect(label).toContain('sampled 0.20 s');
  expect(label).toContain('2 completed windows through 0.20 s'); expect(label).toContain('Frozen evidence captured from LIVE');
  expect(label).not.toContain('REPLAY');
  startGncSession(NOMINAL_CASE, { paused: true });
  const stale = elements(LabTools({ model, state, tick: useTelemetryBus.getState().gnc }));
  expect(stale.find(el => el.type === SignalPlots)!.props.data).toBeNull(); // Old pair cannot attach to another current run.
});
