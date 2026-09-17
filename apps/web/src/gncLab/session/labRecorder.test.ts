import { expect, it } from 'vitest';
import { createTracedSimLoop } from '@docking/sim-core';
import { EXPORT_COLUMNS } from '../model/ports';
import type { TraceRecords } from '../model/tracePaths';
import { NOMINAL_CASE } from './demoRun';
import { createLabRecorder, recorderCapacity, RECORDER_BYTE_LIMIT } from './labRecorder';

it('encodes real bootstrap, dropout, enum, clock and delivered values without treating null as zero', () => {
  const { sim, trace } = createTracedSimLoop(NOMINAL_CASE.config, NOMINAL_CASE.seed);
  const recorder = createLabRecorder(21);
  const records = (): TraceRecords => ({ fsw: trace.latestFsw(), plantTick: trace.latestPlantTick(),
    sampledPlantTick: trace.latestPlantTick(), plantWindow: trace.latestPlantWindow(),
    pendingWindow: trace.pendingWindow(), previousFsw: null });
  expect(() => recorder.append(records())).toThrow('completed');
  sim.setSensorDegrade({ dropout: true }); sim.stepTo(0.1);
  recorder.append(records());
  expect(recorder.column('sourceFswSequence')[0]).toBeNaN();
  expect(recorder.column('sourceSamplePlantTick')[0]).toBeNaN();
  expect(recorder.column('sensors.suite/out/range')[0]).toBeNaN();
  expect(recorder.column('sensors.suite/out/starTracker/0')[0]).toBeNaN();
  expect(recorder.column('fsw.modeSwitch/out/branch')[0]).toBe(2); // AUTO dictionary index
  expect(recorder.column('guidance.vbar/out/frozen')[0]).toBe(0);
  expect(recorder.column('plant.thrusters/out/activeTime/J1')[0]).toBe(0);
  expect(() => recorder.append(records())).toThrow('consecutive');
  sim.clearSensorDegrade(); sim.stepTo(0.2);
  const actual = records(); recorder.append(actual);
  expect([...recorder.column('samplePlantTick')]).toEqual([10, 20]);
  expect([...recorder.column('commandStart_tick')]).toEqual([10, 20]);
  expect([...recorder.column('windowStart_tick')]).toEqual([0, 10]);
  expect(recorder.column('sourceFswSequence')[1]).toBe(1);
  expect(recorder.column('sourceSamplePlantTick')[1]).toBe(10);
  expect(recorder.column('sensors.suite/out/range')[1]).toBe(actual.fsw!.sensor.range_m);
  expect(recorder.column('plant.thrusters/out/impulseHill/1')[1]).toBe(actual.plantWindow!.impulse_hill_Ns[1]);
  expect(recorder.column('alloc.jets/out/onTimes/J6')[1]).toBe(actual.fsw!.allocation.onTimes.J6);
  for (const c of EXPORT_COLUMNS) expect(recorder.column(c.id)).toHaveLength(2);
  const copy = recorder.column('samplePlantTick'); copy[0] = 900;
  expect(recorder.column('samplePlantTick')[0]).toBe(10);
  sim.stepTo(0.21); expect(() => recorder.append(records())).toThrow('boundary');
  expect(recorder.length).toBe(2); recorder.dispose();
  expect(() => recorder.column('time_s')).toThrow('disposed');
});

it('rejects invalid scalar bindings atomically and derives bounded capacity for partial final windows', () => {
  const { sim, trace } = createTracedSimLoop(NOMINAL_CASE.config, NOMINAL_CASE.seed); sim.stepTo(0.1);
  const records: TraceRecords = { fsw: trace.latestFsw(), plantTick: trace.latestPlantTick(),
    plantWindow: trace.latestPlantWindow(), pendingWindow: trace.pendingWindow(), previousFsw: null, sampledPlantTick: trace.latestPlantTick() };
  const recorder = createLabRecorder(15);
  records.fsw!.sensor.range_m = Infinity;
  expect(() => recorder.append(records)).toThrow('range'); expect(recorder.length).toBe(0);
  records.fsw = trace.latestFsw(); recorder.append(records); expect(recorder.length).toBe(1);
  expect(recorderCapacity(15).rows).toBe(2);
  expect(recorderCapacity(NOMINAL_CASE.maxTicks).bytes).toBeLessThan(RECORDER_BYTE_LIMIT);
  for (const max of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER]) expect(() => recorderCapacity(max)).toThrow();
  expect(() => recorder.column('invented')).toThrow('Unknown'); recorder.dispose();
});
