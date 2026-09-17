import { useState, type ReactNode } from 'react';
import { TRUTH_HZ } from '@docking/sim-core';
import type { GncTick } from '../../telemetry/bus';
import { RATE_LABELS } from '../model/blocks';
import { GNC_GRAPH, GRAPH_NOTICE } from '../model/graph';
import { readPort } from '../model/ports';
import { immutable, readField, type TraceRecords } from '../model/tracePaths';
import { BlockNode, type BlockCondition, type BlockReading, type BlockSample } from './BlockNode';
import { SignalEdge } from './SignalEdge';
import { Inspector, type InspectorSelection } from './Inspector';
import { TRUTH_TICKS_PER_FSW_WINDOW } from '../session/demoRun';

// A presentation selection of existing graph ports, never new signal definitions.
function signal(portId: string, label: string, component?: string) {
  const port = GNC_GRAPH.ports.find(p => p.id === portId);
  if (!port) throw new Error(`Unknown chain port ${portId}`);
  return { port, label, component };
}
export const CHAIN_STAGES = immutable([
  { title: 'Measurement', signals: [signal('sensors.suite/out/range', 'Range'), signal('sensors.suite/out/gyroMean', 'Gyro x', '0')] },
  { title: 'Estimate', signals: [signal('nav.ekf/out/position', 'Position y', '1'), signal('nav.ekf/out/velocity', 'Velocity y', '1'), signal('nav.ekf/out/positionVariance', 'Variance y', '1')] },
  { title: 'Reference', signals: [signal('guidance.vbar/out/position', 'Profile y', '1'), signal('guidance.vbar/out/velocity', 'Profile vy', '1')] },
  { title: 'Command', signals: [signal('fsw.modeSwitch/out/forceBody', 'Force y', '1'), signal('control.attitude/out/torque', 'Torque y', '1')] },
  { title: 'Allocated', signals: [signal('alloc.jets/out/forceQuantized', 'Model force y', '1'), signal('alloc.jets/out/onTimes', 'J6 on-time', '5')] },
  { title: 'Delivered', signals: [signal('plant.thrusters/out/impulseBody', 'Impulse y', '1'), signal('plant.thrusters/out/activeTime', 'J6 active', '5')] },
  { title: 'Response', signals: [signal('plant.truth/out/position', 'Position y', '1'), signal('plant.truth/out/velocity', 'Velocity y', '1')] },
]);
export function traceRecords(tick: GncTick): TraceRecords {
  return { fsw: tick.fswTrace, previousFsw: tick.previousFsw, plantTick: tick.plantTickRecord,
    sampledPlantTick: tick.sampledPlantTick, plantWindow: tick.plantWindow, pendingWindow: tick.pendingWindow };
}
export function stageView(stage: typeof CHAIN_STAGES[number], tick: GncTick | null) {
  const { port } = stage.signals[0];
  const records = tick ? traceRecords(tick) : null;
  const readings: BlockReading[] = stage.signals.map(signal => {
    const base = records ? readPort(records, signal.port) : null;
    const value = signal.component === undefined ? base : readField(base, signal.component);
    return { label: signal.label, value: typeof value === 'number' && Number.isFinite(value) ? value : null,
      unit: signal.port.unit, frame: signal.port.frame, digits: 3,
      unavailableStatus: value === undefined ? 'INVALID BINDING'
        : value === null && tick?.fswTrace && signal.port.provenance === 'MEASUREMENT' ? 'DROPOUT' : undefined };
  });
  const fsw = tick?.fswTrace;
  const window = tick?.plantWindow;
  const isTruth = port.provenance === 'TRUTH', isWindow = port.provenance === 'DELIVERED';
  const sample: BlockSample = isTruth
    ? { t_s: tick?.plantTickRecord?.t_s ?? null, age_s: null }
    : isWindow ? { t_s: window?.bounds_s[1] ?? null, age_s: null,
      detail: window ? `Completed (${window.bounds_s[0].toFixed(2)}, ${window.bounds_s[1].toFixed(2)}] s · source FSW ${window.sourceFswSequence ?? 'BOOTSTRAP'}` : 'No completed window' }
    : { t_s: fsw?.sampleTime_s ?? null,
      // Ordinal plant ticks avoid accumulated floating-point noise in zero age.
      age_s: fsw && tick ? (tick.stamp.plantTick - fsw.samplePlantTick) / TRUTH_HZ : null,
      hold: fsw ? 'HELD' : undefined,
      detail: fsw ? `Command (${fsw.commandInterval_tick.join(', ')}] ticks` : 'Awaiting first FSW sample' };
  let condition: BlockCondition | undefined;
  if (port.provenance === 'MEASUREMENT' && fsw?.sensor.range_m === null) condition = { level: 'caution', text: 'RANGE DROPOUT' };
  if (port.provenance === 'ESTIMATE' && fsw?.corridor.caution) condition = { level: 'caution', text: 'CORRIDOR CAUTION' };
  if (port.provenance === 'ESTIMATE' && fsw?.corridor.abortTrigger) condition = { level: 'warning', text: 'CORRIDOR ABORT TRIGGER' };
  if (port.provenance === 'COMMAND' && fsw?.mode.branch === 'AUTO' && fsw.mode.controller === 'MPC' && fsw.mpc.fallback)
    condition = { level: 'caution', text: fsw.mpc.unavailable ? 'MPC UNAVAILABLE → LQR' : 'MPC FALLBACK → LQR' };
  if (port.provenance === 'ALLOCATED' && fsw?.allocation.satFlag) condition = { level: 'caution', text: 'SATURATED' };
  return { id: port.block, title: stage.title, provenance: port.provenance, readings, sample, condition,
    rateLabel: isWindow ? '100 Hz integration / 10 Hz window' : RATE_LABELS[port.rate] };
}

export function BlockDiagram({ tick, tools }: { tick: GncTick | null; tools?: ReactNode }) {
  const [selected, setSelected] = useState<{ id: string; stamp: InspectorSelection['stamp'] } | null>(null);
  const selection = CHAIN_STAGES.find(stage => stage.signals[0].port.block === selected?.id);
  const blocks = GNC_GRAPH.blocks.filter(block => selection?.signals.some(s => s.port.block === block.id));
  const edges = GNC_GRAPH.edges.filter(edge => GNC_GRAPH.ports.some(p => blocks.some(b => b.id === p.block) && (p.id === edge.from || p.id === edge.to)));
  return <section className="gnc-diagram" aria-label="GNC causal chain">
    <div className="gnc-diagram-heading"><strong>Causal chain</strong><span>{GRAPH_NOTICE}</span></div>
    <div className="gnc-chain">{CHAIN_STAGES.map(stage => {
      const view = stageView(stage, tick);
      return <BlockNode key={view.id} {...view} selected={selected?.id === view.id}
        onSelect={id => {
          if (!tick) return;
          const { runId, epoch, source } = tick.stamp;
          setSelected(selected?.id === id ? null : { id, stamp: { runId, epoch, source } });
        }} />;
    })}</div>
    {tick && tick.pendingWindow.slicesIntegrated > 0 && <p className="gnc-pending">
      PENDING ({tick.pendingWindow.bounds_s[0].toFixed(2)}, {tick.pendingWindow.bounds_s[1].toFixed(2)}] s · {tick.pendingWindow.slicesIntegrated}/{TRUTH_TICKS_PER_FSW_WINDOW} slices.
      {' '}Delivered numbers above remain the last completed window.
    </p>}
    {selection && <aside className="gnc-selection" aria-label="Selected stage connections">
      <button type="button" onClick={() => setSelected(null)} aria-label="Close stage connections">Close</button>
      <strong>{selection.title}</strong> · {blocks.map(block => `${block.label} (${RATE_LABELS[block.rate]})`).join(' · ')}
      <p>Declared graph connections. These show the fixed model, not live signal traffic.</p>
      {edges.map(edge => <SignalEdge key={edge.id} edge={edge} />)}
      <Inspector tick={tick} selection={selected && { stamp: selected.stamp, blockIds: blocks.map(block => block.id) }} />
      {tools}
    </aside>}
  </section>;
}
