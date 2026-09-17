import { afterEach, expect, it, vi } from 'vitest';
import { createTracedSimLoop } from '@docking/sim-core';
import { useTelemetryBus } from '../../telemetry/bus';
import { useLabStore } from './labStore';
import { EXPORT_COLUMNS } from '../model/ports';
import { NOMINAL_CASE, type GncCase } from './demoRun';
import { createLabSession, type LabSession } from './labSession';
import { createLabRecorder } from './labRecorder';
import { exportRun, importRun, type RunArtifact } from './runExport';

const sessions: LabSession[] = [];
afterEach(() => { sessions.splice(0).forEach(s => s.dispose()); vi.restoreAllMocks(); });
const make = (gncCase: GncCase = { ...NOMINAL_CASE, maxTicks: 35 }) => {
  const s = createLabSession(gncCase, { runId: 'export-test', epoch: 4, poseEpoch: 2 }); sessions.push(s); return s;
};
function changeJson(artifact: RunArtifact, change: (value: any) => void) {
  const value = JSON.parse(artifact.runJson); change(value); return { ...artifact, runJson: JSON.stringify(value) };
}
function changeCell(artifact: RunArtifact, id: string, text: string, row = 0) {
  const lines = artifact.signalsCsv.split('\n'), cells = lines[row + 1].split(',');
  cells[EXPORT_COLUMNS.findIndex(c => c.id === id)] = text; lines[row + 1] = cells.join(',');
  return { ...artifact, signalsCsv: lines.join('\n') };
}

it('exports byte-stable artifacts and round-trips all 192 actual columns, source clocks and metadata without mutations', () => {
  const s = make({ ...NOMINAL_CASE, maxTicks: 35, schedule: [
    { tick: 10, command: { kind: 'INJECT_THRUSTER_STUCK', thrusterId: 'J6', state: 'OPEN' } },
    { tick: 25, command: { kind: 'ISOLATE_THRUSTER', thrusterId: 'J6' } },
  ] });
  s.advanceTo(35); const snapshot = s.snapshot(), state = s.state, bus = useTelemetryBus.getState(), ui = useLabStore.getState();
  const artifact = exportRun(s, 4); expect(exportRun(s, 4)).toEqual(artifact);
  const imported = importRun(artifact), m = imported.metadata;
  expect(new TextEncoder().encode(exportRun(s, 4).signalsCsv)).toEqual(new TextEncoder().encode(artifact.signalsCsv));
  expect(Object.keys(imported.columns)).toHaveLength(192);
  for (const c of EXPORT_COLUMNS) expect(imported.columns[c.id]).toEqual(s.recorder.column(c.id));
  expect(m.stamp).toEqual(snapshot.stamp); expect(m.rows).toBe(3); expect(m.state).toBe('COMPLETE');
  expect(m.gncCase).toEqual(s.gncCase); expect(m.gncCase.geometry).toBe('CREW_DRAGON'); expect(m.playbackRate).toBe(4);
  expect(m.identityNotice).toContain('not a cryptographic signature'); expect(m.graphHash).toMatch(/^fnv1a64:/);
  expect([...imported.columns.windowStart_tick]).toEqual([0, 10, 20]);
  expect([...imported.columns.commandStart_tick]).toEqual([10, 20, 30]);
  expect(imported.columns.sourceFswSequence[0]).toBeNaN(); expect(imported.columns.sourceFswSequence[2]).toBe(2);
  expect(imported.columns['plant.thrusters/out/activeTime/J6'][0]).toBe(0);
  expect(imported.columns['plant.thrusters/out/activeTime/J6'][1]).toBeCloseTo(.1, 12);
  expect(imported.columns['plant.thrusters/out/activeTime/J6'][2]).toBeCloseTo(.05, 12);
  expect(m.columns.filter(c => c.provenance === 'DELIVERED').every(c => c.trace.startsWith('plantWindow.'))).toBe(true);
  expect(m.metrics).toEqual(JSON.parse(artifact.runJson).metrics);
  expect(s.snapshot()).toEqual(snapshot); expect(s.state).toBe(state); expect(useTelemetryBus.getState()).toBe(bus); expect(useLabStore.getState()).toBe(ui);
  imported.columns.time_s[0] = 900; expect(s.recorder.column('time_s')[0]).toBeCloseTo(.1, 12);
});

it('recomputes summary metrics against independent integrated records and reconstructs the same run from exported case data', () => {
  const s = make(); let used = 0, peak = 0, excursions = 0, saturated = 0;
  for (const tick of [10, 20, 30]) {
    s.advanceTo(tick); const sample = s.snapshot();
    used += sample.plantWindow!.propellantUsed_kg;
    peak = Math.max(peak, Math.hypot(...sample.plantTickRecord!.truth.w_body_rps));
    excursions += Number(sample.fswTrace!.corridor.corridor_err_m > 0);
    saturated += Number(sample.fswTrace!.allocation.satFlag);
  }
  s.advanceTo(35); const artifact = exportRun(s, 1), imported = importRun(artifact);
  expect(imported.metadata.metrics).toEqual({ propellantUsed_kg: used, peakBodyRate_radps: peak,
    corridorExcursionSamples: excursions, saturatedFswTicks: saturated, timeToOutcome_s: null });
  const repeat = make(imported.metadata.gncCase); repeat.advanceTo(imported.metadata.stamp.plantTick);
  expect(exportRun(repeat, imported.metadata.playbackRate)).toEqual(artifact);
  expect(() => importRun(changeJson(artifact, m => { m.metrics.propellantUsed_kg += 1; }))).toThrow('metrics');
});

it('keeps startup and partial windows absent, preserves actual sensor dropout, and never manufactures REPLAY', () => {
  const s = make(); const startup = importRun(exportRun(s, 1));
  expect(startup.metadata.rows).toBe(0); expect(startup.metadata.outcome).toBeNull();
  expect(startup.metadata.metrics.peakBodyRate_radps).toBeNull(); expect(startup.columns.time_s).toHaveLength(0);
  s.advanceTo(5); expect(importRun(exportRun(s, 1)).metadata.rows).toBe(0);
  const { sim, trace } = createTracedSimLoop(s.gncCase.config, s.gncCase.seed), recorder = createLabRecorder(35);
  try {
    sim.setSensorDegrade({ dropout: true }); sim.stepTo(.1);
    recorder.append({ fsw: trace.latestFsw(), plantTick: trace.latestPlantTick(), sampledPlantTick: trace.latestPlantTick(),
      plantWindow: trace.latestPlantWindow(), pendingWindow: trace.pendingWindow(), previousFsw: null });
    s.advanceTo(10);
    const source: LabSession = { ...s, recorder, snapshot: () => ({ ...s.snapshot(), stamp: { ...s.snapshot().stamp, source: 'REPLAY' } }) };
    const result = importRun(exportRun(source, 1)); // Explicit session-adapter source; not assigned by exporter/importer.
    expect(result.metadata.stamp.source).toBe('REPLAY'); expect(s.snapshot().stamp.source).toBe('LIVE');
    expect(result.columns['sensors.suite/out/range'][0]).toBeNaN();
    expect(result.columns['guidance.vbar/out/frozen'][0]).toBe(0);
    expect(result.columns['fsw.modeSwitch/out/branch'][0]).toBe(2);
  } finally { recorder.dispose(); }
});

it('reports the real early outcome transition, not a fabricated window-end latch time', () => {
  const s = make({ ...NOMINAL_CASE, maxTicks: 20, config: { ...NOMINAL_CASE.config,
    initial: { ...NOMINAL_CASE.config.initial, r_hill_m: [0, -10.4, 0], v_hill_mps: [0, 0, 0] } } });
  s.advanceTo(20); const rows = s.recorder.rawTicks(), first = rows.find(r => r.outcome !== 'NONE')!;
  expect(first).toBeDefined(); const result = importRun(exportRun(s, 1));
  expect(result.metadata.outcome).toBe(first.outcome);
  expect(result.metadata.outcomeFirstObserved_tick).toBe(first.plantTick);
  expect(result.metadata.metrics.timeToOutcome_s).toBe(first.plantTick / 100);
  expect(result.metadata.stamp.plantTick).toBe(10); expect(first.plantTick).toBeLessThan(10);
  const clipped: LabSession = { ...s, recorder: { ...s.recorder, rawTicks: () => rows.filter(row => row.plantTick > 1) } };
  expect(importRun(exportRun(clipped, 1)).metadata.metrics.timeToOutcome_s).toBeNull(); // No fabricated time without the transition witness.
});

it('refuses invalid recorder values or changing column lengths and propagates missing metric inputs as null', () => {
  const s = make(); s.advanceTo(10);
  const column = s.recorder.column.bind(s.recorder);
  for (const invalid of [new Float64Array([Infinity]), new Float64Array(0)]) {
    const source: LabSession = { ...s, recorder: { ...s.recorder, column: id => id === 'sensors.suite/out/range' ? invalid : column(id) } };
    expect(() => exportRun(source, 1)).toThrow();
  }
  const source: LabSession = { ...s, recorder: { ...s.recorder,
    column: id => id === 'plant.truth/out/rate/0' ? new Float64Array([NaN]) : column(id) } };
  expect(importRun(exportRun(source, 1)).metadata.metrics.peakBodyRate_radps).toBeNull();
});

it('rejects changed schema, layout, clocks, dictionaries, row count and capacity instead of accepting corrupt evidence', () => {
  const s = make(); s.advanceTo(30); const artifact = exportRun(s, 1);
  for (const edit of [(m: any) => { m.columns[11].provenance = 'DELIVERED'; }, (m: any) => { m.schemaVersion++; },
    (m: any) => { m.gncCase.geometry = 'SYNTHETIC_DRACO'; }, (m: any) => { m.gncCase.seed = -1; },
    (m: any) => { m.gncCase.config.initial.prop_kg++; }, (m: any) => { m.stamp.source = 'FAKE'; },
    (m: any) => { m.stamp.samplePlantTick++; }, (m: any) => { m.rows++; },
    (m: any) => { m.outcomeFirstObserved_tick = 500; }, (m: any) => { m.gncCase.maxTicks = 1e9; },
    (m: any) => { m.gncCase.schedule = [{ tick: .5, command: { kind: 'ISOLATE_THRUSTER', thrusterId: 'J6' } }]; }]) {
    expect(() => importRun(changeJson(artifact, edit))).toThrow();
  }
  for (const [id, value] of [['time_s', '0'], ['sourceFswSequence', '0'], ['samplePlantTick', '20'],
    ['commandEnd_tick', '10'], ['guidance.vbar/out/frozen', '2'], ['fsw.modeSwitch/out/branch', '99'],
    ['sensors.suite/out/range', 'Infinity'], ['sensors.suite/out/range', ''], ['sensors.suite/out/range', 'null']]) {
    expect(() => importRun(changeCell(artifact, id, value))).toThrow();
  }
  expect(() => importRun({ ...artifact, signalsCsv: artifact.signalsCsv + '\n' })).toThrow();
  expect(() => importRun({ ...artifact, signalsCsv: artifact.signalsCsv.replace('time_s,', 'fake,') })).toThrow();
  expect(() => exportRun({ ...s, gncCase: { ...s.gncCase, geometry: 'SYNTHETIC_DRACO' } }, 1)).toThrow('jet-layout');
  s.dispose(); expect(() => exportRun(s, 1)).toThrow('stopped');
});

it('serializes the full default row budget with one copy per column and round-trips signed zero', () => {
  const s = make(NOMINAL_CASE); s.advanceTo(10);
  const rowCount = NOMINAL_CASE.maxTicks / 10, sample = s.snapshot();
  const clock = (id: string, i: number) => ({ time_s: (i + 1) / 10, windowIndex: i + 1, windowStart_tick: i * 10,
    windowEnd_tick: (i + 1) * 10, sourceFswSequence: i || NaN, sourceSamplePlantTick: i ? i * 10 : NaN,
    fswSequence: i + 1, samplePlantTick: (i + 1) * 10, sampleTime_s: (i + 1) / 10,
    commandStart_tick: (i + 1) * 10, commandEnd_tick: (i + 2) * 10 } as Record<string, number>)[id];
  const column = vi.fn((id: string) => {
    const template = s.recorder.column(id)[0];
    return Float64Array.from({ length: rowCount }, (_, i) => clock(id, i) ?? (id === 'plant.truth/out/rate/0' ? -0 : template));
  });
  const adapter: LabSession = { ...s, state: 'COMPLETE', recorder: { ...s.recorder, length: rowCount, column },
    snapshot: () => ({ ...sample, stamp: { ...sample.stamp, plantTick: 120000, plantTime_s: 1200,
      fswSequence: rowCount, samplePlantTick: 120000, sampleTime_s: 1200 } }) };
  const artifact = exportRun(adapter, 16); expect(column).toHaveBeenCalledTimes(192);
  const imported = importRun(artifact);
  expect(imported.metadata.rows).toBe(rowCount);
  expect(imported.columns.time_s.at(-1)).toBe(1200);
  expect(Object.is(imported.columns['plant.truth/out/rate/0'][0], -0)).toBe(true);
  expect(Object.values(imported.columns).reduce((sum, c) => sum + c.byteLength, 0)).toBe(rowCount * 192 * 8);
});
