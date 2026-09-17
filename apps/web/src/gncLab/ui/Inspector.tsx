import { TRUTH_HZ } from '@docking/sim-core';
import type { GncStamp, GncTick } from '../../telemetry/bus';
import { RATE_LABELS } from '../model/blocks';
import { GNC_GRAPH } from '../model/graph';
import { readPort, type PortDescriptor } from '../model/ports';
import { resolveTracePath, traceProvenance, type TracePath, type TraceRecords } from '../model/tracePaths';
import { displayUnit, formatReading, formatSampleAge, formatSampleTime } from './format';

export interface InspectorSelection {
  readonly stamp: Readonly<Pick<GncStamp, 'runId' | 'epoch' | 'source'>>;
  /** Existing graph IDs; a chain stage may select more than one block. */
  readonly blockIds: readonly string[];
}
export interface InspectorProps {
  readonly selection: InspectorSelection | null;
  readonly tick: GncTick | null;
}

function traceRecords(tick: GncTick): TraceRecords {
  return { fsw: tick.fswTrace, previousFsw: tick.previousFsw, plantTick: tick.plantTickRecord,
    sampledPlantTick: tick.sampledPlantTick, plantWindow: tick.plantWindow, pendingWindow: tick.pendingWindow };
}

function provenance(path: TracePath): string {
  if (path.startsWith('pendingWindow.')) return 'PENDING · PARTIAL PLANT';
  const source = traceProvenance(path);
  return source === 'TRUTH' ? 'TRUTH · COMPARISON' : source === 'ALLOCATED' ? 'ALLOCATED · MODEL'
    : source === 'DELIVERED' ? 'DELIVERED · PLANT' : source ?? 'PLANT STATUS';
}

/** Every sample label follows the bound record, never the header's newer time. */
export function inspectorSample(tick: GncTick, path: TracePath): string {
  const root = path.split('.')[0];
  if (root === 'fsw' || root === 'previousFsw') {
    const fsw = root === 'fsw' ? tick.fswTrace : tick.previousFsw;
    if (!fsw) return root === 'previousFsw' ? 'No previous FSW sample' : 'Awaiting first FSW sample';
    return `${formatSampleTime(fsw.sampleTime_s)} · HELD · ${formatSampleAge((tick.stamp.plantTick - fsw.samplePlantTick) / TRUTH_HZ)} · FSW ${fsw.fswSequence} · command (${fsw.commandInterval_tick.join(', ')}] ticks`;
  }
  if (root === 'plantWindow' || root === 'pendingWindow') {
    const window = root === 'plantWindow' ? tick.plantWindow : tick.pendingWindow;
    if (!window) return 'No completed window';
    return `${root === 'plantWindow' ? 'Completed' : 'PENDING'} (${window.bounds_s.map(t => t.toFixed(2)).join(', ')}] s · (${window.bounds_tick.join(', ')}] ticks · source FSW ${window.sourceFswSequence ?? 'BOOTSTRAP'}`;
  }
  const plant = root === 'sampledPlantTick' ? tick.sampledPlantTick : tick.plantTickRecord;
  return plant ? `${formatSampleTime(plant.t_s)} · plant tick ${plant.plantTick} · ${formatSampleAge((tick.stamp.plantTick - plant.plantTick) / TRUTH_HZ)}` : 'No plant sample';
}

/** Descriptor-selected value and explicit availability, also used by headless oracles. */
export function inspectorReading(tick: GncTick, port: PortDescriptor): string {
  const records = traceRecords(tick);
  const root = port.trace.split('.')[0];
  const source = records[root as keyof typeof records];
  if (source === null) return 'UNAVAILABLE';
  if (port.when && !port.when.some(group => group.every(c => resolveTracePath(records, c.path) === c.value))) return 'INACTIVE';
  const value = readPort(records, port);
  const scalar = (item: unknown): string => {
    if (item === undefined) return 'INVALID BINDING';
    if (item === null) return port.provenance === 'MEASUREMENT' ? 'DROPOUT' : 'UNAVAILABLE';
    if (port.dataType === 'boolean') return typeof item === 'boolean' ? String(item) : 'INVALID VALUE';
    if (port.dataType === 'enum') return typeof item === 'string' && port.enumValues?.includes(item) ? item : 'INVALID VALUE';
    return formatReading({ value: typeof item === 'number' ? item : null, unit: port.unit, si: true, digits: 3 }).number;
  };
  return Array.isArray(value) ? value.map((item, i) => `${port.components?.[i] ?? (port.dataType === 'quaternion' ? ['w', 'x', 'y', 'z'][i] : i)}: ${scalar(item)}`).join(' · ') : scalar(value);
}

/** Bounded raw disclosure; never substitute zero for absent/error values. */
export function inspectorPreview(value: unknown): string {
  if (value === undefined) return 'INVALID BINDING';
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || (typeof item === 'number' && !Number.isFinite(item))) return 'UNAVAILABLE';
    return Array.isArray(item) && item.length > 16 ? [...item.slice(0, 16), `${item.length - 16} more entries (preview limit)`] : item;
  }, 2);
}

/** Stateless disclosure only. Parent owns selection, close/reset and all controls. */
export function Inspector({ selection, tick }: InspectorProps) {
  if (!selection) return null;
  if (!tick || selection.stamp.runId !== tick.stamp.runId || selection.stamp.epoch !== tick.stamp.epoch
    || selection.stamp.source !== tick.stamp.source) {
    return <aside className="gnc-inspector" aria-label="Stage inspector"><p role="status">Selection unavailable — select a stage in the current run.</p></aside>;
  }
  const blocks = GNC_GRAPH.blocks.filter(block => selection.blockIds.includes(block.id));
  if (!blocks.length || selection.blockIds.some(id => !GNC_GRAPH.blocks.some(block => block.id === id))) {
    return <aside className="gnc-inspector" aria-label="Stage inspector"><p role="status">Unknown graph selection.</p></aside>;
  }
  const records = traceRecords(tick);
  return <aside className="gnc-inspector" aria-label="Stage inspector">
    <header>{tick.stamp.source} · Run {tick.stamp.runId} · epoch {tick.stamp.epoch}</header>
    {blocks.map(block => <section key={block.id} data-block-id={block.id}>
      <h3>{block.label}</h3><p>{RATE_LABELS[block.rate]}</p>
      {block.id === 'control.mpc' && tick.fswTrace
        && (tick.fswTrace.mode.controller !== 'MPC' || tick.fswTrace.mode.branch !== 'AUTO')
        && <p>INACTIVE — current branch {tick.fswTrace.mode.branch}, selected controller {tick.fswTrace.mode.controller}.</p>}
      {(['IN', 'OUT'] as const).map(direction => <div key={direction}>
        <h4>{direction === 'IN' ? 'Inputs' : 'Outputs'}</h4>
        <dl>{GNC_GRAPH.ports.filter(port => port.block === block.id && port.direction === direction).map(port =>
          <div key={port.id} data-port-id={port.id} data-provenance={port.provenance}
            style={port.provenance === 'TRUTH' ? { color: 'var(--gnc-truth)' } : undefined}>
            <dt>{port.name} · {provenance(port.trace)}</dt>
            <dd>{inspectorReading(tick, port)} · {displayUnit(port.unit, true) || 'dimensionless'} · {port.frame}
              {port.dataType === 'quaternion' && ' → BODY; scalar-first [w, x, y, z]'}
              <br /><small>{inspectorSample(tick, port.trace)} · {RATE_LABELS[port.rate]}</small></dd>
          </div>)}</dl>
        {!GNC_GRAPH.ports.some(port => port.block === block.id && port.direction === direction) && <p>No declared {direction === 'IN' ? 'inputs' : 'outputs'}.</p>}
      </div>)}
      <details><summary>States and errors · native record details</summary>
        <p>Mixed SI fields. Units and frames are declared in the port rows above or record field names; no additional units are inferred. Arrays preview at most 16 entries.</p>
        {block.inspect.map(path => <details key={path} data-trace-path={path}
          style={traceProvenance(path) === 'TRUTH' ? { color: 'var(--gnc-truth)' } : undefined}>
          <summary>{path} · {provenance(path)}</summary>
          <small>{inspectorSample(tick, path)}</small>
          <pre>{inspectorPreview(resolveTracePath(records, path))}</pre>
        </details>)}
      </details>
    </section>)}
  </aside>;
}
