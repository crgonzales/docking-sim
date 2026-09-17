import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as simCore from '@docking/sim-core';
import { buildDemoConfig, DEMO_SEED } from '../session/demoRun';
import { BLOCKS, RATE_LABELS } from './blocks';
import { GNC_GRAPH } from './graph';
import { EXPORT_COLUMNS, EXPORT_COLUMN_COUNT, EXPORT_SCHEMA_VERSION, JET_IDS, OUTPUT_PORTS, readPort } from './ports';
import { readField, resolveTracePath, traceProvenance, type TraceRecords } from './tracePaths';

function fixture() {
  const { sim, trace } = simCore.createTracedSimLoop(buildDemoConfig('CREW_DRAGON'), DEMO_SEED);
  const records: TraceRecords = { fsw: null, previousFsw: null, plantTick: null, sampledPlantTick: null,
    plantWindow: null, pendingWindow: trace.pendingWindow() };
  trace.subscribePlantTick(record => { records.plantTick = record; });
  trace.subscribePlantWindow(record => { records.plantWindow = record; });
  trace.subscribeFsw(record => {
    records.previousFsw = records.fsw; records.fsw = record;
    records.sampledPlantTick = records.plantTick;
  });
  return { sim, records, step(tick: number) { sim.stepTo(tick / simCore.TRUTH_HZ); records.pendingWindow = trace.pendingWindow(); return records; } };
}
const port = (id: string) => GNC_GRAPH.ports.find(p => p.id === id)!;
function verifyRecords(records: TraceRecords) {
  for (const p of GNC_GRAPH.ports) {
    expect(resolveTracePath(records, p.trace), p.id).not.toBeUndefined();
    expect(traceProvenance(p.trace), p.id).toBe(p.provenance);
    const value = readPort(records, p);
    if (value === null) continue; // actual dropout, bootstrap or inactive algorithm
    const values = Array.isArray(value) ? value.flat(Infinity) : [value];
    expect(values.length, p.id).toBe(p.dims.reduce((a, b) => a * b, 1));
    for (const scalar of values) {
      if (p.dataType === 'enum') expect(p.enumValues, p.id).toContain(scalar);
      else if (p.dataType === 'boolean') expect(typeof scalar, p.id).toBe('boolean');
      else expect(typeof scalar === 'number' && Number.isFinite(scalar), p.id).toBe(true);
    }
  }
  for (const block of BLOCKS) for (const path of block.inspect) expect(resolveTracePath(records, path), `${block.id}: ${path}`).not.toBeUndefined();
}

describe('GNC descriptors against real trace records', () => {
  it('names all 18 implemented blocks, real exports and the two allowed private symbols', () => {
    expect(BLOCKS).toHaveLength(18);
    expect(new Set(BLOCKS.map(b => b.id)).size).toBe(18);
    const run = fixture();
    for (const block of BLOCKS) {
      const file = readFileSync(new URL(`../../../../../packages/sim-core/src/${block.source.module}`, import.meta.url), 'utf8');
      expect(file).toContain(block.source.symbol);
      if (block.source.kind === 'export') expect(typeof simCore[block.source.symbol as keyof typeof simCore]).toBe('function');
      else expect(['plant.contact', 'fsw.modeSwitch']).toContain(block.id);
      if (block.source.member) expect(typeof run.sim[block.source.member as keyof simCore.SimLoop]).toBe('function');
    }
    expect(BLOCKS.find(b => b.id === 'control.mpc')!.rate).toBe('MPC_1HZ_IN_10HZ');
    expect(RATE_LABELS.MPC_1HZ_IN_10HZ).toBe('1 Hz re-solve / 10 Hz call');
    expect(BLOCKS.find(b => b.id === 'pilot.manual')!.rate).toBe('EVENT');
    expect(port('pilot.manual/out/translation').rate).toBe('FSW_10HZ');
  });
  it('resolves every port and inspector on bounded nominal, PID, LQR and manual records', () => {
    const run = fixture();
    verifyRecords(run.step(0)); verifyRecords(run.step(1)); verifyRecords(run.step(10));
    verifyRecords(run.step(20)); verifyRecords(run.step(21));
    expect(run.records.fsw!.mpc.result).not.toBeNull();
    expect(readPort(run.records, port('control.pid/out/force'))).toBeNull();
    run.sim.setController('PID'); verifyRecords(run.step(30));
    expect(readPort(run.records, port('control.pid/out/force'))).toEqual(run.records.fsw!.command.force_hill_N);
    expect(readPort(run.records, port('control.lqr/out/force'))).toBeNull();
    run.sim.setController('LQR'); verifyRecords(run.step(40));
    expect(readPort(run.records, port('control.lqr/out/force'))).toEqual(run.records.fsw!.command.force_hill_N);
    run.sim.setControlMode('MANUAL'); run.sim.setManualSubMode('RATE');
    run.sim.setManualCommand({ translation: [0, 0.2, 0], rotation: [0.1, 0, 0] }); verifyRecords(run.step(50));
    expect(run.records.fsw!.manual.rateReference).not.toBeNull();
    expect(readPort(run.records, port('control.lqr/out/force'))).toBeNull();
    run.sim.setManualSubMode('PULSE'); verifyRecords(run.step(60));
    expect(run.records.fsw!.mode.branch).toBe('MANUAL_PULSE');
  });
  it('keeps prior-command, current-command, sample and integrated-window clocks distinct', () => {
    const run = fixture(); run.step(20); run.step(21);
    expect(run.records.plantTick!.plantTick).toBe(21);
    expect(run.records.sampledPlantTick!.plantTick).toBe(20);
    expect(run.records.previousFsw!.fswSequence).toBe(1);
    expect(run.records.fsw!.fswSequence).toBe(2);
    expect(run.records.plantWindow!.sourceFswSequence).toBe(1);
    expect(run.records.pendingWindow.slicesIntegrated).toBe(1);
    expect(readPort(run.records, port('nav.feedforward/in/previousOnTimes'))).toEqual(JET_IDS.map(id => run.records.previousFsw!.allocation.onTimes[id]));
    expect(readPort(run.records, port('sensors.suite/in/truthSample'))).toEqual(run.records.sampledPlantTick!.truth.r_hill_m);
    expect(readPort(run.records, port('nav.ekf/out/position'))).toEqual(run.records.fsw!.nav.state.slice(0, 3));
    expect(readPort(run.records, port('nav.ekf/out/velocity'))).toEqual(run.records.fsw!.nav.state.slice(3));
    expect(port('nav.ekf/out/position').unit).toBe('m');
    expect(port('nav.ekf/out/velocity').unit).toBe('m/s');
    expect(readPort(run.records, port('nav.ekf/out/positionVariance'))).toEqual([0, 1, 2].map(i => run.records.fsw!.nav.covariance[i][i]));
    expect(readPort(run.records, port('plant.thrusters/out/impulseHill'))).toEqual(run.records.plantWindow!.impulse_hill_Ns);
    expect(port('plant.thrusters/out/impulseHill').unit).toBe('N*s');
    expect(port('plant.thrusters/out/impulseHill').frame).toBe('HILL');
    expect(simCore.rotateVector(run.records.fsw!.q_BH, run.records.fsw!.command.force_hill_N)).toEqual(run.records.fsw!.command.force_body_N);
  });
  it('preserves real dropout and distinguishes stuck-open plant actuation from allocation', () => {
    const run = fixture(); run.step(20);
    run.sim.setSensorDegrade({ dropout: true }); verifyRecords(run.step(30));
    expect(readPort(run.records, port('sensors.suite/out/range'))).toBeNull();
    expect(readPort(run.records, port('sensors.suite/out/starTracker'))).toBeNull();
    run.sim.clearSensorDegrade(); run.step(40);
    const jet = JET_IDS.find(id => run.records.fsw!.allocation.onTimes[id] < 0.1)!;
    expect(jet).toBeDefined();
    run.sim.injectThrusterStuck(jet, 'OPEN'); verifyRecords(run.step(50));
    expect(run.records.plantWindow!.activeTime_s[jet]).toBeCloseTo(0.1, 12);
    expect(run.records.previousFsw!.allocation.onTimes[jet]).toBeLessThan(0.1);
    expect(port('alloc.jets/out/forcePredicted').provenance).toBe('ALLOCATED');
    expect(port('plant.thrusters/out/activeTime').provenance).toBe('DELIVERED');
    run.sim.isolateThruster(jet); verifyRecords(run.step(60));
    expect(run.records.plantWindow!.activeTime_s[jet]).toBe(0);
  });
  it('fixes scalar export identities and metadata without exporting slices or horizons', () => {
    const run = fixture(); run.step(20);
    expect(EXPORT_SCHEMA_VERSION).toBe(1);
    expect(EXPORT_COLUMN_COUNT).toBe(192);
    expect(EXPORT_COLUMNS[0]).toMatchObject({ id: 'time_s', trace: 'plantWindow.bounds_s.1', unit: 's' });
    expect(new Set(EXPORT_COLUMNS.map(c => c.id)).size).toBe(EXPORT_COLUMN_COUNT);
    expect(JET_IDS).toEqual(Array.from({ length: 16 }, (_, i) => `J${i + 1}`));
    for (const c of EXPORT_COLUMNS) {
      expect(c.trace).not.toMatch(/pendingWindow|\.slice\.|predictedStates|referenceStates/);
      expect(c.rate).toBe('FSW_10HZ');
      if (c.provenance === 'DELIVERED') expect(c.trace).toMatch(/^plantWindow\./);
      const base = resolveTracePath(run.records, c.trace);
      const value = c.component === undefined || base === null ? base : readField(base, c.component);
      expect(value, c.id).not.toBeUndefined();
      expect(value === null || ['number', 'boolean', 'string'].includes(typeof value), c.id).toBe(true);
      if (c.portId) expect(OUTPUT_PORTS.some(p => p.id === c.portId)).toBe(true);
    }
    console.info(`B3 schema: ${BLOCKS.length} blocks, ${GNC_GRAPH.ports.length} ports, ${GNC_GRAPH.edges.length} edges, ${EXPORT_COLUMN_COUNT} export columns`);
  });
  it('deep-freezes descriptors and does not resolve inherited or nonexistent values', () => {
    const check = (value: unknown): void => {
      if (value && typeof value === 'object') { expect(Object.isFrozen(value)).toBe(true); Object.values(value).forEach(check); }
    };
    check(GNC_GRAPH); check(EXPORT_COLUMNS);
    expect(Reflect.set(port('nav.ekf/out/position').dims, '0', 4)).toBe(false);
    const run = fixture(); run.step(10);
    expect(resolveTracePath(run.records, 'fsw.sensor.fakeRange')).toBeUndefined();
    expect(resolveTracePath(run.records, 'fsw.constructor')).toBeUndefined();
  });
});
