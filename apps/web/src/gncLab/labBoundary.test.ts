import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { createTracedSimLoop } from '@docking/sim-core';
import { GNC_GRAPH } from './model/graph';
import { readField, resolveTracePath, traceProvenance } from './model/tracePaths';
import { createLabSession } from './session/labSession';
import { NOMINAL_CASE } from './session/demoRun';
import { getGncSession, startGncSession, stopGncSession, stepGncSession, retryGncSession } from '../telemetry/gncEmitter';
import { useTelemetryBus, type GncTick } from '../telemetry/bus';
import { useLabStore } from './session/labStore';
import { BlockDiagram, CHAIN_STAGES, stageView, traceRecords } from './ui/BlockDiagram';
import { BlockNode } from './ui/BlockNode';
import { SignalEdge } from './ui/SignalEdge';
import { GncLab, GncLabView } from './ui/GncLab';
import { formatReading } from './ui/format';

const identity = { runId: 'boundary', epoch: 1, poseEpoch: 1 };
const session = () => createLabSession({ ...NOMINAL_CASE, maxTicks: 30 }, identity);
const stage = (title: string) => CHAIN_STAGES.find(s => s.title === title)!;
afterEach(() => { stopGncSession(); vi.useRealTimers(); });

it('projects only real graph ports, with seven classes and at most three resolvable signals per stage', () => {
  const run = session();
  try {
    run.advanceTo(20); const tick = run.snapshot(), records = traceRecords(tick);
    const classes = CHAIN_STAGES.map(s => stageView(s, tick).provenance);
    expect(classes).toEqual(['MEASUREMENT', 'ESTIMATE', 'REFERENCE', 'COMMAND', 'ALLOCATED', 'DELIVERED', 'TRUTH']);
    for (const s of CHAIN_STAGES) {
      expect(s.signals.length).toBeGreaterThanOrEqual(2); expect(s.signals.length).toBeLessThanOrEqual(3);
      const view = stageView(s, tick);
      s.signals.forEach(({ port, component }, i) => {
        expect(GNC_GRAPH.ports).toContain(port);
        expect(traceProvenance(port.trace)).toBe(view.provenance);
        if (view.provenance === 'DELIVERED') expect(port.trace).toMatch(/^plantWindow\./);
        // Resolve the raw record component independently of the UI's readPort projection.
        const rawComponent = component !== undefined && port.components ? port.components[Number(component)] : component;
        const raw = resolveTracePath(records, port.trace);
        const expected = rawComponent === undefined ? raw : readField(raw, rawComponent);
        expect(expected).not.toBeUndefined(); expect(typeof expected).toBe('number');
        expect(view.readings[i]).toMatchObject({ value: expected, unit: port.unit, frame: port.frame });
      });
    }
    expect(stageView(stage('Estimate'), tick).readings[1].value).toBe(tick.fswTrace!.nav.state[4]);
    expect(stageView(stage('Allocated'), tick).readings[1].value).toBe(tick.fswTrace!.allocation.onTimes.J6);
    expect(stageView(stage('Delivered'), tick).readings[1].value).toBe(tick.plantWindow!.activeTime_s.J6);
  } finally { run.dispose(); }
});

it('keeps startup missing, sample clocks distinct, and completed delivery separate from pending slices', () => {
  const run = session();
  try {
    let tick = run.snapshot();
    CHAIN_STAGES.forEach(s => {
      expect(stageView(s, tick).readings.every(r => r.value === null)).toBe(true);
      expect(stageView(s, tick).sample.t_s).toBeNull();
    });
    expect(renderToStaticMarkup(createElement(BlockDiagram, { tick }))).not.toContain('DROPOUT');
    run.advanceTo(10); const boundary = run.snapshot(); run.singleStep('TRUTH'); tick = run.snapshot();
    expect(stageView(stage('Measurement'), tick).sample).toMatchObject({ t_s: boundary.fswTrace!.sampleTime_s, age_s: .01, hold: 'HELD' });
    expect(stageView(stage('Response'), tick).sample.t_s).toBe(tick.plantTickRecord!.t_s);
    expect(stageView(stage('Delivered'), tick).readings).toEqual(stageView(stage('Delivered'), boundary).readings);
    expect(stageView(stage('Delivered'), tick).sample.detail).toContain('Completed (0.00, 0.10] s · source FSW BOOTSTRAP');
    const html = renderToStaticMarkup(createElement(BlockDiagram, { tick }));
    expect(html.match(/data-provenance=/g)).toHaveLength(7);
    expect(html).toContain('PENDING'); expect(html).toContain('last completed window');
    expect(html).toContain('LAYOUT ONLY'); expect(html).toContain('age 10 ms');
    expect(html).not.toContain('Selected stage connections'); expect(html).not.toContain('<canvas');
  } finally { run.dispose(); }
});

it('renders real sensor dropout as DROPOUT and real unavailable MPC fallback as LQR', () => {
  const traced = createTracedSimLoop(NOMINAL_CASE.config, NOMINAL_CASE.seed);
  traced.sim.setSensorDegrade({ dropout: true }); const frames = traced.sim.stepTo(.1);
  const fsw = traced.trace.latestFsw()!, plant = traced.trace.latestPlantTick()!;
  const tick: GncTick = { stamp: { ...identity, plantTick: plant.plantTick, plantTime_s: .1,
    fswSequence: fsw.fswSequence, samplePlantTick: fsw.samplePlantTick, sampleTime_s: fsw.sampleTime_s, source: 'LIVE', configHash: 'test' },
    poseEpoch: 1, fswTrace: fsw, plantTickRecord: plant, plantWindow: traced.trace.latestPlantWindow(),
    pendingWindow: traced.trace.pendingWindow(), previousFsw: null, sampledPlantTick: plant,
    renderState: traced.sim.getRenderState(), frame: frames[0] };
  const view = stageView(stage('Measurement'), tick);
  expect(fsw.sensor.range_m).toBeNull(); expect(view.readings[0].unavailableStatus).toBe('DROPOUT');
  expect(view.readings[1].value).toBe(fsw.sensor.gyro_mean_rps![0]);
  expect(renderToStaticMarkup(createElement(BlockNode, { ...view, selected: false, onSelect() {} }))).toContain('DROPOUT');
  const isolated = createLabSession({ ...NOMINAL_CASE, maxTicks: 10, schedule: Array.from({ length: 16 }, (_, i) =>
    ({ tick: 0, command: { kind: 'ISOLATE_THRUSTER' as const, thrusterId: `J${i + 1}` } })) }, identity);
  try {
    isolated.advanceTo(10);
    expect(isolated.snapshot().fswTrace!.mpc.unavailable).toBe(true);
    expect(stageView(stage('Command'), isolated.snapshot()).condition?.text).toBe('MPC UNAVAILABLE → LQR');
  } finally { isolated.dispose(); }

  // FSW retains the preceding MPC status during abort; it is no longer the
  // active command source. Drive the real transition rather than patching a trace.
  for (let i = 1; i <= 16; i++) traced.sim.isolateThruster(`J${i}`);
  traced.sim.stepTo(.2);
  expect(traced.trace.latestFsw()!.mpc.fallback).toBe(true);
  traced.sim.commandAbort(); traced.sim.stepTo(.3);
  const abort = traced.trace.latestFsw()!;
  expect(abort.mode.branch).toBe('ABORT_BURN');
  expect(abort.mpc.fallback).toBe(true);
  expect(stageView(stage('Command'), { ...tick, fswTrace: abort }).condition).toBeUndefined();
});

it('draws model edges with actual hold/delay semantics and supports keyboard-native selection buttons', () => {
  const edge = GNC_GRAPH.edges.find(e => e.to === 'plant.thrusters/in/heldCommand')!;
  const html = renderToStaticMarkup(createElement(SignalEdge, { edge }));
  expect(html).toContain('HELD'); expect(html).toContain(edge.id.replaceAll('>', '&gt;'));
  expect(html).toContain('not the preceding delivered window');
  const selected: string[] = [];
  const node = BlockNode({ ...stageView(stage('Response'), null), selected: true, onSelect: id => selected.push(id) });
  expect(node.type).toBe('button'); expect(node.props['aria-pressed']).toBe(true);
  node.props.onClick(); expect(selected).toEqual(['plant.truth']);
});

it('keeps chain angular values in SI and distinguishes unavailable from real zero', () => {
  expect(formatReading({ value: 1, unit: 'rad/s', si: true }).text).toBe('1.00 rad/s');
  expect(formatReading({ value: 0, unit: 'N', si: true }).text).toBe('0.00 N');
  expect(formatReading({ value: null, unit: 'N', si: true }).text).toBe('—');
});

it('shows actual session identity, clocks and control availability without relabelling a retired run', () => {
  vi.useFakeTimers(); startGncSession({ ...NOMINAL_CASE, maxTicks: 30 }, { paused: true, playbackRate: 4 });
  const render = (tick = useTelemetryBus.getState().gnc) => renderToStaticMarkup(createElement(GncLabView, {
    tick, presentation: useLabStore.getState(),
  }));
  expect(render()).toContain(NOMINAL_CASE.label); expect(render()).toContain(NOMINAL_CASE.geometry);
  expect(render()).toContain('FSW —'); expect(render()).toContain('PAUSED'); expect(render()).not.toContain('disabled');
  stepGncSession('TRUTH'); stepGncSession('FSW');
  const old = useTelemetryBus.getState().gnc!;
  const html = render(); expect(html).toContain('Plant 11'); expect(html).toContain('FSW 1');
  expect(html).toContain('t 0.11 s'); expect(html).toContain('t 0.10 s');
  expect(html).toContain('1 Hz re-solve / 10 Hz call');
  retryGncSession(); expect(render(old)).toContain('No active case'); expect(render(old)).toContain('disabled');
  expect(render()).toContain(NOMINAL_CASE.label);
  getGncSession()!.advanceTo(30); // Emitter publishes the real completed state on the next explicit action.
  stepGncSession('TRUTH');
  expect(render()).toContain('COMPLETE'); expect(render()).toMatch(/disabled=""[^>]*>Resume/);
  expect(render()).toMatch(/<button>Retry<\/button>/);
  stopGncSession(); expect(render()).toContain('NO RUN'); expect(vi.getTimerCount()).toBe(0);
});

it('is a subscriber overlay with no simulation startup or extra canvas and only one added colour token', () => {
  vi.useFakeTimers(); expect(getGncSession()).toBeNull();
  const html = renderToStaticMarkup(createElement(GncLab));
  expect(html).toContain('NO RUN'); expect(html).toContain('disabled');
  expect(html).not.toContain('<canvas'); expect(getGncSession()).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  const files = ['GncLab.tsx', 'BlockDiagram.tsx', 'BlockNode.tsx', 'SignalEdge.tsx', 'format.ts'];
  for (const file of files) {
    const text = readFileSync(new URL(`./ui/${file}`, import.meta.url), 'utf8');
    expect(text).not.toMatch(/(?:from\s*|import\s*)['"](?:three|@react-three\/|@docking\/sim-core\/)/);
    expect(text).not.toMatch(/<(?:Canvas|canvas)\b|create(?:Traced)?SimLoop\s*\(/);
  }
  const css = readFileSync(new URL('./ui/gnc.css', import.meta.url), 'utf8');
  expect([...css.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1])).toEqual(['--gnc-truth']);
});
