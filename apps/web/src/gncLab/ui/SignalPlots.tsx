import { useEffect, useMemo, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { TRUTH_HZ } from '@docking/sim-core';
import type { GncStamp } from '../../telemetry/bus';
import { EXPORT_COLUMNS, EXPORT_SCHEMA_VERSION } from '../model/ports';
import { immutable } from '../model/tracePaths';
import type { LabSession } from '../session/labSession';

function series(column: string, provenance: 'COMMAND' | 'ALLOCATED' | 'DELIVERED', unit: string, divide = false) {
  const descriptor = EXPORT_COLUMNS.find(c => c.id === column);
  if (!descriptor || descriptor.provenance !== provenance || descriptor.unit !== unit
    || (provenance === 'DELIVERED' && !descriptor.trace.startsWith('plantWindow.'))) throw new Error(`Invalid plot binding: ${column}`);
  return { column, provenance, divide, label: provenance === 'ALLOCATED' ? 'ALLOCATED · MODEL' : provenance === 'DELIVERED' ? 'DELIVERED · PLANT' : provenance };
}
export const SIGNAL_PLOTS = immutable([
  { title: 'J6 duty', unit: '1', frame: 'JET J6', conversion: 'Commanded on-time / window duration; delivered active time / window duration (s/s).', series: [
    series('alloc.jets/out/onTimes/J6', 'ALLOCATED', 's', true), series('plant.thrusters/out/activeTime/J6', 'DELIVERED', 's', true)] },
  { title: 'Force y', unit: 'N', frame: 'BODY', conversion: 'Delivered average force = body impulse / window duration (N·s/s).', series: [
    series('fsw.modeSwitch/out/forceBody/1', 'COMMAND', 'N'), series('alloc.jets/out/forceQuantized/1', 'ALLOCATED', 'N'), series('plant.thrusters/out/impulseBody/1', 'DELIVERED', 'N*s', true)] },
  { title: 'Torque y', unit: 'N·m', frame: 'BODY', conversion: 'Delivered average torque = body angular impulse / window duration (N·m·s/s).', series: [
    series('control.attitude/out/torque/1', 'COMMAND', 'N*m'), series('alloc.jets/out/torqueQuantized/1', 'ALLOCATED', 'N*m'), series('plant.thrusters/out/angularImpulse/1', 'DELIVERED', 'N*m*s', true)] },
] as const);
const SERIES = SIGNAL_PLOTS.flatMap(plot => plot.series);
export const PLOT_COLUMN_IDS = Object.freeze(['time_s', 'windowIndex', 'windowStart_tick', 'windowEnd_tick', 'sourceFswSequence',
  'sourceSamplePlantTick', 'fswSequence', 'samplePlantTick', 'sampleTime_s', 'commandStart_tick', 'commandEnd_tick', ...SERIES.map(s => s.column)]);
export interface PlotColumns {
  readonly stamp: Readonly<GncStamp>;
  readonly schemaVersion: number;
  readonly columns: Readonly<Record<string, Float64Array>>;
}
/** Parent calls synchronously on its current session, then publishes this detached snapshot. */
export function copyPlotColumns(session: Pick<LabSession, 'snapshot' | 'recorder'>): PlotColumns {
  const stamp = Object.freeze({ ...session.snapshot().stamp });
  return { stamp, schemaVersion: EXPORT_SCHEMA_VERSION,
    columns: Object.fromEntries(PLOT_COLUMN_IDS.map(id => [id, session.recorder.column(id)])) };
}
export interface PlotWindow {
  readonly time_s: number;
  readonly start_tick: number;
  readonly end_tick: number;
  readonly windowIndex: number;
  readonly sourceSampleTime_s: number | null;
  readonly values: readonly (number | null)[];
}
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
const near = (a: number, b: number) => Number.isFinite(a) && Math.abs(a - b) <= 1e-6;

/** Join by identity AND interval. Recorder row adjacency has no semantic role. */
export function alignPlotColumns(data: PlotColumns): PlotWindow[] {
  if (data.schemaVersion !== EXPORT_SCHEMA_VERSION) throw new Error('Unsupported recorder schema');
  const c = data.columns, length = c.time_s?.length;
  if (length === undefined || PLOT_COLUMN_IDS.some(id => !(c[id] instanceof Float64Array) || c[id].length !== length)) throw new Error('Missing or unequal recorder columns');
  const commands = new Map<string, number>();
  const key = (sequence: number, sample: number, start: number, end: number) => `${sequence}/${sample}/${start}/${end}`;
  for (let i = 0; i < length; i++) {
    const sequence = c.fswSequence[i], sample = c.samplePlantTick[i], start = c.commandStart_tick[i], end = c.commandEnd_tick[i];
    if (!integer(sequence) || sequence < 1 || !integer(sample) || sample !== start || !integer(end) || end <= start
      || !near(c.sampleTime_s[i], sample / TRUTH_HZ)) continue;
    const id = key(sequence, sample, start, end);
    if (commands.has(id)) throw new Error('Ambiguous duplicate source FSW identity');
    commands.set(id, i);
  }
  const indices = new Set<number>();
  const windows = Array.from({ length }, (_, i): PlotWindow => {
    const start = c.windowStart_tick[i], end = c.windowEnd_tick[i], index = c.windowIndex[i];
    if (!integer(start) || !integer(end) || end <= start || !integer(index) || index < 1 || indices.has(index)
      || end > (data.stamp.samplePlantTick ?? 0) || !near(c.time_s[i], end / TRUTH_HZ)) throw new Error('Invalid completed-window clock or identity');
    indices.add(index);
    const source = commands.get(key(c.sourceFswSequence[i], c.sourceSamplePlantTick[i], start, end));
    const duration = (end - start) / TRUTH_HZ;
    return { time_s: c.time_s[i], start_tick: start, end_tick: end, windowIndex: index,
      sourceSampleTime_s: source === undefined ? null : c.sampleTime_s[source],
      values: SERIES.map(s => {
        const row = s.provenance === 'DELIVERED' ? i : source;
        const value = row === undefined ? NaN : c[s.column][row];
        return Number.isFinite(value) ? value / (s.divide ? duration : 1) : null;
      }) };
  }).sort((a, b) => a.end_tick - b.end_tick);
  for (let i = 1; i < windows.length; i++) {
    if (windows[i].start_tick < windows[i - 1].end_tick || windows[i].windowIndex <= windows[i - 1].windowIndex) throw new Error('Overlapping or unordered window identities');
  }
  return windows;
}

export function plotRange(rows: readonly PlotWindow[]): [number, number] {
  return rows.length ? [rows[0].start_tick / TRUTH_HZ, rows[rows.length - 1].time_s] : [0, 1];
}
/** Last REAL sample per pixel, except any unavailable sample or absent window makes a gap. */
export function decimatePlotWindows(rows: readonly PlotWindow[], pixelColumns: number): PlotWindow[] {
  if (!Number.isFinite(pixelColumns) || pixelColumns < 1 || !rows.length) return [];
  const width = Math.floor(pixelColumns), [min, max] = plotRange(rows);
  const buckets = new Map<number, PlotWindow>();
  let previous: PlotWindow | undefined;
  for (const row of rows) {
    const pixel = Math.min(width - 1, Math.floor((row.time_s - min) / (max - min) * width));
    const held = buckets.get(pixel);
    const missingWindow = previous !== undefined && (row.start_tick !== previous.end_tick || row.windowIndex !== previous.windowIndex + 1);
    buckets.set(pixel, { ...row, values: row.values.map((value, i) =>
      missingWindow || value === null || !Number.isFinite(value) || held?.values[i] === null ? null : value) });
    previous = row;
  }
  return [...buckets.values()];
}

export function signalPlotOptions(plot: typeof SIGNAL_PLOTS[number], width: number, color: string): uPlot.Options {
  return { width, height: 170, scales: { x: { time: false, auto: false, min: 0, max: 1 }, y: { auto: false, min: 0, max: 1 } },
    cursor: { show: false }, select: { show: false, left: 0, top: 0, width: 0, height: 0 }, legend: { show: false },
    axes: [{ label: 'Completed window end (sim s)', stroke: color }, { label: `${plot.unit} · ${plot.frame}`, size: 64, stroke: color }],
    series: [{}, ...plot.series.map(s => ({ label: s.label, stroke: color,
      dash: s.provenance === 'COMMAND' ? [2, 3] : s.provenance === 'ALLOCATED' ? [7, 4] : [],
      width: s.provenance === 'DELIVERED' ? 2 : 1, spanGaps: false, points: { show: true, size: 3 } }))] };
}

export function updateSignalPlot(chart: Pick<uPlot, 'over' | 'setData' | 'setScale' | 'batch'>, plot: typeof SIGNAL_PLOTS[number], rows: readonly PlotWindow[]) {
  const indices = plot.series.map(s => SERIES.indexOf(s));
  // Both axes stay present with fixed sizes, even when all measurements are missing.
  const points = decimatePlotWindows(rows, chart.over.clientWidth);
  let low = Infinity, high = -Infinity;
  for (const row of rows) for (const index of indices) {
    const value = row.values[index];
    if (value !== null && Number.isFinite(value)) { low = Math.min(low, value); high = Math.max(high, value); }
  }
  const pad = low === high ? Math.max(1, Math.abs(low) * 0.05) : (high - low) * 0.05;
  const [min, max] = plotRange(rows);
  chart.batch(() => {
    chart.setData([points.map(p => p.time_s), ...indices.map(i => points.map(p => p.values[i]))], false);
    chart.setScale('x', { min, max });
    chart.setScale('y', Number.isFinite(low) ? { min: low - pad, max: high + pad } : { min: 0, max: 1 });
  });
}

function Plot({ plot, rows, widthPx, stamp }: { plot: typeof SIGNAL_PLOTS[number]; rows: readonly PlotWindow[]; widthPx: number; stamp: Readonly<GncStamp> }) {
  const host = useRef<HTMLDivElement>(null), chart = useRef<uPlot | null>(null);
  const latest = useRef(rows); latest.current = rows;
  useEffect(() => {
    if (!host.current) return;
    let active = true;
    const options = signalPlotOptions(plot, Math.floor(widthPx), getComputedStyle(host.current).color);
    // uPlot lays out asynchronously; measure only after its real plotting area exists.
    options.hooks = { ready: [next => { if (active) updateSignalPlot(next, plot, latest.current); }] };
    const next = new uPlot(options,
      [[], ...plot.series.map(() => [])], host.current);
    chart.current = next;
    return () => { active = false; chart.current = null; next.destroy(); };
  }, [plot, widthPx]);
  useEffect(() => {
    if (chart.current?.status === 1) updateSignalPlot(chart.current, plot, rows);
  }, [plot, rows, widthPx]);
  return <figure className="gnc-signal-plot">
    <figcaption>{plot.title} · {plot.unit} · {plot.frame} · {stamp.source} · Run {stamp.runId} · epoch {stamp.epoch}</figcaption>
    <p>{plot.series.map(s => `${s.label} (${s.provenance === 'COMMAND' ? 'dotted' : s.provenance === 'ALLOCATED' ? 'dashed' : 'solid'})`).join(' · ')}</p>
    <div ref={host} role="img" aria-label={`${plot.title}: completed-window comparison`} />
    <p>{plot.conversion}</p>
  </figure>;
}

export interface SignalPlotsProps {
  readonly data: PlotColumns | null;
  /** Current atomic bus stamp, used to reject old run/epoch/source snapshots. */
  readonly current: Readonly<GncStamp> | null;
  /** Parent-owned measured width in CSS pixels; no layout timer or fallback width. */
  readonly widthPx: number;
}
export function SignalPlots({ data, current, widthPx }: SignalPlotsProps) {
  const prepared = useMemo(() => {
    if (!data) return { rows: [], error: null };
    try { return { rows: alignPlotColumns(data), error: null }; }
    catch (error) { return { rows: [], error: String(error) }; }
  }, [data]);
  if (!data || !current || data.stamp.runId !== current.runId || data.stamp.epoch !== current.epoch
    || data.stamp.source !== current.source || data.stamp.configHash !== current.configHash || data.stamp.plantTick > current.plantTick) {
    return <p role="status">Plots unavailable for the current run.</p>;
  }
  if (prepared.error) return <p role="alert">Plots unavailable: {prepared.error}</p>;
  if (!prepared.rows.length) return <p role="status">Awaiting completed windows — no plot samples yet.</p>;
  if (!Number.isFinite(widthPx) || widthPx < 120) return <p role="status">Plots awaiting layout width.</p>;
  return <section className="gnc-signal-plots" aria-label="Aligned signal plots">
    <header>{current.source} · Run {data.stamp.runId} · epoch {data.stamp.epoch} · through completed window {prepared.rows.at(-1)!.time_s.toFixed(2)} s</header>
    <p>FSW commands are sampled at window start; x is completed window end. Commands apply over the same window as delivery. First-window command is unavailable (bootstrap).</p>
    <p>Last recorded window per pixel column; any missing sample or window makes a gap. No peak-preservation claim.</p>
    {SIGNAL_PLOTS.map(plot => <Plot key={`${current.source}/${current.runId}/${current.epoch}/${plot.title}`} plot={plot} rows={prepared.rows} widthPx={widthPx} stamp={data.stamp} />)}
  </section>;
}
