import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type uPlot from 'uplot';
import { EXPORT_COLUMNS } from '../model/ports';
import { DEMO_MAX_TICKS, NOMINAL_CASE } from '../session/demoRun';
import { createLabSession } from '../session/labSession';
import { recorderCapacity } from '../session/labRecorder';
import { alignPlotColumns, copyPlotColumns, decimatePlotWindows, PLOT_COLUMN_IDS, plotRange,
  SIGNAL_PLOTS, SignalPlots, signalPlotOptions, updateSignalPlot, type PlotColumns, type PlotWindow } from './SignalPlots';

const identity = { runId: 'plot-test', epoch: 3, poseEpoch: 3 };
function fixture() {
  const run = createLabSession({ ...NOMINAL_CASE, maxTicks: 50, schedule: [
    { tick: 10, command: { kind: 'INJECT_THRUSTER_STUCK', thrusterId: 'J6', state: 'OPEN' } },
    { tick: 30, command: { kind: 'ISOLATE_THRUSTER', thrusterId: 'J6' } },
  ] }, identity);
  try {
    const ticks = [10, 20, 30, 40, 50].map(t => { run.advanceTo(t); return run.snapshot(); });
    return { data: copyPlotColumns(run), ticks };
  } finally { run.dispose(); }
}
function reordered(data: PlotColumns, indices: number[]): PlotColumns {
  return { ...data, columns: Object.fromEntries(PLOT_COLUMN_IDS.map(id => [id, Float64Array.from(indices.map(i => data.columns[id][i]))])) };
}
const html = (data: PlotColumns | null, current = data?.stamp ?? null, widthPx = 640) =>
  renderToStaticMarkup(createElement(SignalPlots, { data, current, widthPx }));

describe('source-aligned signal plots', () => {
  it('copies only declared columns with the actual session stamp and leaves recorder evidence detached', () => {
    const run = createLabSession({ ...NOMINAL_CASE, maxTicks: 30 }, identity);
    try {
      const empty = copyPlotColumns(run);
      expect(alignPlotColumns(empty)).toEqual([]); expect(html(empty)).toContain('Awaiting completed windows');
      run.advanceTo(20); const copied = copyPlotColumns(run);
      expect(copied.stamp).toEqual(run.snapshot().stamp);
      expect(Object.keys(copied.columns)).toEqual(PLOT_COLUMN_IDS);
      expect(PLOT_COLUMN_IDS).toHaveLength(19);
      for (const id of PLOT_COLUMN_IDS) expect(EXPORT_COLUMNS.some(c => c.id === id)).toBe(true);
      copied.columns.time_s[0] = 999;
      expect(run.recorder.column('time_s')[0]).toBeCloseTo(.1);
      run.advanceTo(30); expect(copied.columns.time_s).toHaveLength(2);
      expect(empty.columns.time_s).toHaveLength(0);
    } finally { run.dispose(); }
  });

  it('joins real source FSW/window identities, converting duration and exposing stuck-open/isolation delivery', () => {
    const { data, ticks } = fixture(), rows = alignPlotColumns(data);
    const fsw = new Map(ticks.map(t => [t.fswTrace!.fswSequence, t.fswTrace!]));
    for (let i = 0; i < ticks.length; i++) {
      const window = ticks[i].plantWindow!, command = fsw.get(window.sourceFswSequence!);
      const duration = (window.bounds_tick[1] - window.bounds_tick[0]) / 100;
      expect(rows[i].sourceSampleTime_s).toBe(command?.sampleTime_s ?? null);
      expect(rows[i].values).toEqual([
        command ? command.allocation.onTimes.J6 / duration : null, window.activeTime_s.J6 / duration,
        command?.command.force_body_N[1] ?? null, command?.allocation.achievedQuantizedForce_N[1] ?? null, window.impulse_body_Ns[1] / duration,
        command?.command.torque_body_Nm[1] ?? null, command?.allocation.achievedQuantizedTorque_Nm[1] ?? null, window.angularImpulse_body_Nms[1] / duration,
      ]);
    }
    expect(rows[0].values).toEqual([null, 0, null, null, 0, null, null, 0]); // Real bootstrap zero, no invented command.
    expect(rows[1].values[1]).toBeCloseTo(1); expect(rows[2].values[1]).toBeCloseTo(1);
    expect(rows[3].values[1]).toBe(0); // Scheduled isolation first affects (30,40].
    expect(rows[1].values[0]).not.toBe(rows[1].values[1]);
    expect(rows[1].values[2]).not.toBe(ticks[1].fswTrace!.command.force_body_N[1]); // Adjacent-current-row negative control.
    expect(alignPlotColumns(reordered(data, [4, 1, 3, 0, 2]))).toEqual(rows);
  });

  it('does not substitute an adjacent command for missing or mismatched source metadata', () => {
    const { data } = fixture();
    const missing = alignPlotColumns(reordered(data, [0, 2, 3, 4]));
    expect(missing[1].values[2]).toBeNull(); expect(missing[1].values[1]).toBeCloseTo(1);
    for (const field of ['sourceFswSequence', 'sourceSamplePlantTick', 'commandEnd_tick', 'sampleTime_s']) {
      const changed = reordered(data, [0, 1, 2, 3, 4]);
      changed.columns[field][field.startsWith('source') ? 1 : 0] += 1;
      const row = alignPlotColumns(changed)[1];
      expect(row.sourceSampleTime_s).toBeNull(); expect(row.values[0]).toBeNull();
      expect(row.values[1]).toBeCloseTo(1); // Delivery does not depend on a valid FSW join.
    }
    const absent = reordered(data, [0, 1, 2, 3, 4]);
    absent.columns['fsw.modeSwitch/out/forceBody/1'][0] = NaN;
    expect(alignPlotColumns(absent)[1].values[2]).toBeNull();
  });

  it('rejects invalid intervals, duplicate identities, unequal columns and unsupported schemas', () => {
    const { data } = fixture();
    for (const invalid of [
      { ...data, schemaVersion: 999 }, { ...data, columns: { ...data.columns, time_s: new Float64Array(0) } },
    ]) expect(() => alignPlotColumns(invalid)).toThrow();
    for (const field of ['windowStart_tick', 'windowIndex', 'time_s']) {
      const invalid = reordered(data, [0, 1, 2, 3, 4]); invalid.columns[field][1] = NaN;
      expect(() => alignPlotColumns(invalid)).toThrow('window');
    }
    const duplicate = reordered(data, [0, 1, 2, 3, 4]);
    for (const id of ['fswSequence', 'samplePlantTick', 'sampleTime_s', 'commandStart_tick', 'commandEnd_tick']) duplicate.columns[id][1] = duplicate.columns[id][0];
    expect(() => alignPlotColumns(duplicate)).toThrow('duplicate source FSW');
    const zeroDuration = reordered(data, [0, 1, 2, 3, 4]); zeroDuration.columns.windowStart_tick[1] = zeroDuration.columns.windowEnd_tick[1];
    expect(() => alignPlotColumns(zeroDuration)).toThrow('window');
  });

  it('suppresses stale identity/source/config/future captures and labels every plot including REPLAY', () => {
    const { data } = fixture();
    for (const current of [null, { ...data.stamp, runId: 'next' }, { ...data.stamp, epoch: 4 },
      { ...data.stamp, source: 'REPLAY' as const }, { ...data.stamp, configHash: 'other' }, { ...data.stamp, plantTick: 40 }]) {
      expect(html(data, current)).toContain('Plots unavailable'); expect(html(data, current)).not.toContain('<figure');
    }
    expect(html(data, data.stamp, 0)).toContain('awaiting layout');
    const replay = { ...data, stamp: { ...data.stamp, source: 'REPLAY' as const } };
    const rendered = html(replay);
    expect(rendered.match(/<figure/g)).toHaveLength(3);
    expect(rendered.match(/REPLAY/g)).toHaveLength(4); // Group and each individual plot.
    expect(rendered).toContain('N·s/s'); expect(rendered).toContain('N·m·s/s'); expect(rendered).toContain('s/s');
    expect(rendered).toContain('ALLOCATED · MODEL'); expect(rendered).toContain('DELIVERED · PLANT');
    expect(rendered).toContain('First-window command is unavailable');
  });
});

describe('pixel-bounded decimation', () => {
  const budget = recorderCapacity(DEMO_MAX_TICKS).rows;
  const full: PlotWindow[] = Array.from({ length: budget }, (_, i) => ({ time_s: (i + 1) / 10,
    start_tick: i * 10, end_tick: (i + 1) * 10, windowIndex: i + 1,
    sourceSampleTime_s: i / 10, values: Array.from({ length: 8 }, (_, j) => i * (j + 1)) }));

  it.each([1, 17, 320, 640, 1920, 12001])('uses at most one actual sample per pixel across all %i columns and the full default row budget', width => {
    expect(budget).toBe(12001);
    const points = decimatePlotWindows(full, width), [min, max] = plotRange(full);
    expect(points.length).toBeLessThanOrEqual(width);
    const pixels = points.map(p => Math.min(width - 1, Math.floor((p.time_s - min) / (max - min) * width)));
    expect(new Set(pixels).size).toBe(points.length);
    points.forEach(point => expect(point).toEqual(full[point.windowIndex - 1]));
    expect(points.at(-1)!.time_s).toBe(full.at(-1)!.time_s);
  });

  it('propagates any missing value across its bucket, never averages it away or bridges missing windows', () => {
    const rows = full.slice(0, 5).map(row => ({ ...row, values: [...row.values] }));
    rows[1].values[2] = null;
    const single = decimatePlotWindows(rows, 1)[0];
    expect(single.values[2]).toBeNull(); expect(single.values[0]).toBe(4);
    rows[1].values[2] = Infinity;
    expect(decimatePlotWindows(rows, 1)[0].values[2]).toBeNull();
    const gap = decimatePlotWindows([rows[0], rows[2], rows[3], rows[4]], 100);
    expect(gap[1].values.every(v => v === null)).toBe(true); expect(gap[2].values).toEqual(rows[3].values);
    expect(decimatePlotWindows(rows, 0)).toEqual([]); expect(decimatePlotWindows([], 10)).toEqual([]);
  });

  it('feeds the chart its actual plotting-area pixel budget and disables gap spanning', () => {
    const data = vi.fn(), scale = vi.fn();
    const chart = { over: { clientWidth: 137 }, setData: data, setScale: scale, batch: (fn: () => void) => fn() } as unknown as Pick<uPlot, 'over' | 'setData' | 'setScale' | 'batch'>;
    for (const plot of SIGNAL_PLOTS) {
      updateSignalPlot(chart, plot, full);
      const aligned = data.mock.lastCall![0] as uPlot.AlignedData;
      expect(aligned[0].length).toBeLessThanOrEqual(137);
      expect(aligned).toHaveLength(plot.series.length + 1);
      expect(scale).toHaveBeenCalledWith('x', { min: 0, max: full.at(-1)!.time_s });
      const options = signalPlotOptions(plot, 640, '#fff');
      expect(options.series!.slice(1).every(series => series.spanGaps === false)).toBe(true);
      expect(options.scales!.y!.auto).toBe(false);
    }
  });
});
