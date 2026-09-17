import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GncTick } from '../../telemetry/bus';
import { GNC_GRAPH } from '../model/graph';
import { readPort, type PortDescriptor } from '../model/ports';
import { resolveTracePath } from '../model/tracePaths';
import { NOMINAL_CASE } from '../session/demoRun';
import { createLabSession } from '../session/labSession';
import { traceRecords } from './BlockDiagram';
import { Inspector, inspectorPreview, inspectorReading, inspectorSample, type InspectorSelection } from './Inspector';

const identity = { runId: 'inspector', epoch: 1, poseEpoch: 1 };
const port = (id: string) => GNC_GRAPH.ports.find(p => p.id === id)!;
const selection = (tick: GncTick, blockIds = ['nav.ekf']): InspectorSelection => ({ stamp: tick.stamp, blockIds });
const markup = (tick: GncTick | null, selected: InspectorSelection | null) => renderToStaticMarkup(createElement(Inspector, { tick, selection: selected }));

describe('stamped inspector', () => {
  it('opens only on selection and rejects independent run, epoch and source mismatches', () => {
    const run = createLabSession({ ...NOMINAL_CASE, maxTicks: 30 }, identity);
    try {
      run.advanceTo(20); const tick = run.snapshot(), selected = selection(tick);
      expect(markup(tick, null)).toBe('');
      for (const next of [null, { ...tick, stamp: { ...tick.stamp, runId: 'replacement' } },
        { ...tick, stamp: { ...tick.stamp, epoch: 2 } }, { ...tick, stamp: { ...tick.stamp, source: 'REPLAY' as const } }]) {
        const html = markup(next, selected);
        expect(html).toContain('Selection unavailable'); expect(html).not.toContain('data-port-id');
      }
      const replay: GncTick = { ...tick, stamp: { ...tick.stamp, source: 'REPLAY' } };
      expect(markup(replay, selection(replay))).toContain('REPLAY · Run inspector · epoch 1');
      expect(markup(tick, selection(tick, ['not-a-block']))).toContain('Unknown graph selection');
    } finally { run.dispose(); }
  });

  it('resolves every input, output and state path from the existing graph without changing records', () => {
    const run = createLabSession({ ...NOMINAL_CASE, maxTicks: 30 }, identity);
    try {
      run.advanceTo(21); const tick = run.snapshot(), before = JSON.stringify(tick);
      const html = markup(tick, selection(tick, GNC_GRAPH.blocks.map(b => b.id)));
      expect(html).not.toMatch(/INVALID BINDING|NaN|Infinity/);
      expect(html.match(/data-port-id=/g)).toHaveLength(GNC_GRAPH.ports.length);
      for (const p of GNC_GRAPH.ports) {
        const value = readPort(traceRecords(tick), p);
        expect(value, p.id).not.toBeUndefined();
        if (typeof value === 'number') expect(inspectorReading(tick, p)).toBe(value.toFixed(3));
        if (typeof value === 'boolean') expect(inspectorReading(tick, p)).toBe(String(value));
      }
      for (const block of GNC_GRAPH.blocks) for (const path of block.inspect) {
        expect(resolveTracePath(traceRecords(tick), path), path).not.toBeUndefined();
        expect(html).toContain(`data-trace-path="${path}"`);
      }
      expect(inspectorReading(tick, port('nav.ekf/out/velocity'))).toBe(tick.fswTrace!.nav.state.slice(3).map((v, i) => `${i + 3}: ${v.toFixed(3)}`).join(' · '));
      expect(html).toContain('rad/s'); expect(html).toContain('scalar-first [w, x, y, z]');
      expect(html).toContain('States and errors'); expect(html).toContain('ALLOCATED · MODEL');
      expect(html).toContain('DELIVERED · PLANT'); expect(html).toContain('TRUTH · COMPARISON');
      expect(html.match(/style="color:var\(--gnc-truth\)"/g)?.length).toBeGreaterThan(0);
      expect(JSON.stringify(tick)).toBe(before);
    } finally { run.dispose(); }
  });

  it('retains each source clock, preceding FSW, sensor boundary, completed and pending windows', () => {
    const run = createLabSession({ ...NOMINAL_CASE, maxTicks: 30 }, identity);
    try {
      const startup = run.snapshot();
      expect(inspectorReading(startup, port('sensors.suite/out/range'))).toBe('UNAVAILABLE');
      expect(markup(startup, selection(startup, ['sensors.suite']))).not.toContain('DROPOUT');
      run.advanceTo(21); const tick = run.snapshot();
      expect(inspectorSample(tick, 'previousFsw.allocation.onTimes')).toContain('t 0.10 s · HELD · age 110 ms · FSW 1');
      expect(inspectorSample(tick, 'fsw.command.force_body_N')).toContain('t 0.20 s · HELD · age 10 ms · FSW 2');
      expect(inspectorSample(tick, 'sampledPlantTick.truth.r_hill_m')).toContain('plant tick 20 · age 10 ms');
      expect(inspectorSample(tick, 'plantTick.truth.r_hill_m')).toContain('plant tick 21 · age 0 ms');
      expect(inspectorSample(tick, 'plantWindow.activeTime_s')).toContain('Completed (0.10, 0.20] s · (10, 20] ticks · source FSW 1');
      expect(inspectorSample(tick, 'pendingWindow.activeTime_s')).toContain('PENDING (0.20, 0.21] s');
      const html = markup(tick, selection(tick, ['plant.thrusters']));
      expect(html).toContain('PENDING · PARTIAL PLANT');
      expect(inspectorReading(tick, port('plant.thrusters/out/activeTime'))).toContain(`J6: ${tick.plantWindow!.activeTime_s.J6.toFixed(3)}`);
    } finally { run.dispose(); }
  });

  it('distinguishes real dropout, inactive controllers, exact zero and false', () => {
    const run = createLabSession({ ...NOMINAL_CASE, maxTicks: 20,
      config: { ...NOMINAL_CASE.config, sensors: { ...NOMINAL_CASE.config.sensors, degrade: { dropout: true } },
        fsw: { ...NOMINAL_CASE.config.fsw, controller: 'PID' } } }, identity);
    try {
      run.advanceTo(10); const tick = run.snapshot();
      expect(tick.fswTrace!.sensor.range_m).toBeNull();
      expect(inspectorReading(tick, port('sensors.suite/out/range'))).toBe('DROPOUT');
      expect(inspectorReading(tick, port('control.lqr/out/force'))).toBe('INACTIVE');
      expect(inspectorReading(tick, port('guidance.vbar/out/frozen'))).toBe('false');
      expect(inspectorReading(tick, port('plant.thrusters/out/activeTime'))).toContain('J6: 0.000');
      expect(markup(tick, selection(tick, ['control.mpc']))).toContain('INACTIVE — current branch AUTO, selected controller PID');
      const invalid = { ...port('sensors.suite/out/range'), trace: 'fsw.sensor.missing' } as PortDescriptor;
      expect(inspectorReading(tick, invalid)).toBe('INVALID BINDING');
    } finally { run.dispose(); }
  });

  it('bounds optional native-record previews and imports no lifecycle, store or scene', () => {
    const preview = inspectorPreview({ values: Array.from({ length: 128 }, (_, i) => i), zero: 0, missing: null, invalid: NaN });
    expect(preview).toContain('112 more entries (preview limit)'); expect(preview).not.toContain('127');
    expect(preview).toContain('"zero": 0'); expect(preview).toContain('UNAVAILABLE');
    const source = readFileSync(new URL('./Inspector.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/gncEmitter|labStore|createLabSession|createSimLoop|useEffect|useState|setInterval|requestAnimationFrame|Date\.now|performance\.now|three|<canvas/);
  });
});
