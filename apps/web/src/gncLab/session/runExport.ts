import { CREW_DRAGON_THRUSTERS, DRACO_THRUSTER_SPECS, TRUTH_HZ, type SimOutcome } from '@docking/sim-core';
import type { GncStamp } from '../../telemetry/bus';
import { GNC_GRAPH } from '../model/graph';
import { runOutcome } from '../model/runOutcome';
import { EXPORT_COLUMNS, EXPORT_COLUMN_COUNT, EXPORT_SCHEMA_VERSION } from '../model/ports';
import { TRUTH_TICKS_PER_FSW_WINDOW as WINDOW, type GncCase } from './demoRun';
import { recorderCapacity } from './labRecorder';
import { configHash, type LabSession, type PlaybackRate, type SessionState } from './labSession';

const HEADER = EXPORT_COLUMNS.map(c => c.id).join(',');
const FORMAT = 'gnc-evidence/1';
const ENCODING = 'UTF-8 / LF; time-first CSV; finite round-trip decimal doubles, signed zero preserved; NaN = unavailable; booleans 0/1; enums use column dictionary indices.';
const IDENTITY_NOTICE = 'FNV-1a64 display/run-coherence identity; not a cryptographic signature or integrity guarantee.';
const METRIC_BASIS = {
  propellantUsed_kg: 'Sum of DELIVERED propellant over completed windows only; excludes pending slices.',
  peakBodyRate_radps: 'Peak norm of TRUTH body rate at recorded 10 Hz boundaries, not a 100 Hz peak.',
  corridorExcursionSamples: 'Number of FSW samples with corridor error > 0 m; not distinct episodes.',
  saturatedFswTicks: 'Number of FSW samples whose ALLOCATED saturation flag is true.',
  timeToOutcome_s: 'First TRUTH outcome transition in the bounded raw ring, when observed; otherwise null.',
} as const;

export interface RunMetrics {
  propellantUsed_kg: number | null;
  peakBodyRate_radps: number | null;
  corridorExcursionSamples: number | null;
  saturatedFswTicks: number | null;
  timeToOutcome_s: number | null;
}
export interface RunMetadata {
  format: typeof FORMAT;
  schemaVersion: number;
  columns: typeof EXPORT_COLUMNS;
  graphHash: string;
  identityNotice: string;
  encoding: string;
  stamp: Readonly<GncStamp>;
  gncCase: GncCase;
  playbackRate: PlaybackRate;
  state: Exclude<SessionState, 'STOPPED'>;
  rows: number;
  outcome: SimOutcome | null;
  outcomeFirstObserved_tick: number | null;
  metricBasis: typeof METRIC_BASIS;
  metrics: RunMetrics;
}
export interface RunArtifact { readonly runJson: string; readonly signalsCsv: string }
export interface ImportedRun {
  readonly metadata: RunMetadata;
  /** Detached evidence only. Import never changes the bus or assigns a playback source. */
  readonly columns: Readonly<Record<string, Float64Array>>;
}

function canonical(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Nonfinite metadata');
    return Object.is(value, -0) ? '-0' : String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter(k => object[k] !== undefined).sort()
      .map(k => `${JSON.stringify(k)}:${canonical(object[k])}`).join(',')}}`;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  throw new Error('Unsupported metadata value');
}
function graphHash(): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(canonical(GNC_GRAPH))) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}
const GRAPH_HASH = graphHash();
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const near = (a: number, b: number) => Number.isFinite(a) && Math.abs(a - b) <= 1e-6;
const fail = (message: string): never => { throw new Error(`Invalid GNC export: ${message}`); };
const encode = (n: number) => Number.isNaN(n) ? 'NaN' : Object.is(n, -0) ? '-0' : String(n);

/** Structural/data validation, not authentication or a general SimConfig safety validator. */
function validateMetadata(m: RunMetadata): void {
  if (!m || m.format !== FORMAT || m.schemaVersion !== EXPORT_SCHEMA_VERSION
    || canonical(m.columns) !== canonical(EXPORT_COLUMNS) || m.graphHash !== GRAPH_HASH
    || m.identityNotice !== IDENTITY_NOTICE || m.encoding !== ENCODING
    || canonical(m.metricBasis) !== canonical(METRIC_BASIS)) fail('schema/graph/metric definitions');
  const c = m.gncCase, s = m.stamp;
  if (!c || !['NOMINAL', 'RCS_STUCK_OPEN'].includes(c.id) || typeof c.label !== 'string'
    || !['CREW_DRAGON', 'SYNTHETIC_DRACO'].includes(c.geometry) || !integer(c.seed)
    || c.seed > 0xffffffff || !c.config?.initial || !c.config.fsw || (c.config.initial.t_s ?? 0) !== 0
    || !Array.isArray(c.schedule)) fail('case/config/seed');
  const specs = c.config.thrusters?.specs ?? DRACO_THRUSTER_SPECS;
  // Geometry treats signed zeros equally; artifact serialization still preserves their bits.
  const layout = (value: unknown) => canonical(JSON.parse(JSON.stringify(value)));
  if (layout(specs) !== layout(c.geometry === 'CREW_DRAGON' ? CREW_DRAGON_THRUSTERS : DRACO_THRUSTER_SPECS)) fail('jet-layout label does not match configured specs');
  for (const event of c.schedule) {
    const cmd = event?.command;
    if (!integer(event?.tick) || !cmd || !specs.some(jet => jet.id === cmd.thrusterId)
      || !['INJECT_THRUSTER_STUCK', 'ISOLATE_THRUSTER'].includes(cmd.kind)
      || (cmd.kind === 'INJECT_THRUSTER_STUCK' && !['OPEN', 'CLOSED'].includes(cmd.state))) fail('command schedule');
  }
  const capacity = recorderCapacity(c.maxTicks);
  if (!s || typeof s.runId !== 'string' || !s.runId || !integer(s.epoch)
    || !['LIVE', 'REPLAY'].includes(s.source) || s.configHash !== configHash(c.config)
    || !integer(s.plantTick) || s.plantTick > c.maxTicks || !near(s.plantTime_s, s.plantTick / TRUTH_HZ)
    || !integer(m.rows) || m.rows > capacity.rows || m.rows !== Math.floor(s.plantTick / WINDOW)
    || s.fswSequence !== (m.rows || null) || s.samplePlantTick !== (m.rows ? m.rows * WINDOW : null)
    || (m.rows ? !near(s.sampleTime_s!, m.rows * WINDOW / TRUTH_HZ) : s.sampleTime_s !== null)) fail('capture clock or row capacity');
  if (![1, 4, 16].includes(m.playbackRate) || !['RUNNING', 'PAUSED', 'COMPLETE'].includes(m.state)
    || ![null, 'NONE', 'DOCKED', 'COLLISION', 'ABORT'].includes(m.outcome)
    || (s.plantTick === 0) !== (m.outcome === null)) fail('state/outcome');
  const observed = m.outcomeFirstObserved_tick;
  if (observed !== null && (!integer(observed) || observed < 1 || observed > s.plantTick
    || m.outcome === null || m.outcome === 'NONE')) fail('outcome transition clock');
}

/** Read one numeric row at a time; no split of the whole CSV and no temporary numeric matrix. */
function scan(csv: string, m: RunMetadata, visit?: (row: number[], index: number) => void): RunMetrics {
  if (!csv.startsWith(`${HEADER}\n`) || !csv.endsWith('\n')
    || csv.length > HEADER.length + 1 + m.rows * EXPORT_COLUMN_COUNT * 26) fail('CSV header/size');
  const index = (id: string) => EXPORT_COLUMNS.findIndex(c => c.id === id);
  const prop = index('plant.thrusters/out/propellantUsed'), rates = [0, 1, 2].map(i => index(`plant.truth/out/rate/${i}`));
  const corridor = index('safety.corridor/out/error'), saturation = index('alloc.jets/out/saturated');
  const metrics: RunMetrics = { propellantUsed_kg: 0, peakBodyRate_radps: null, corridorExcursionSamples: 0,
    saturatedFswTicks: 0, timeToOutcome_s: m.outcomeFirstObserved_tick === null ? null : m.outcomeFirstObserved_tick / TRUTH_HZ };
  let offset = HEADER.length + 1, count = 0, missingRate = false;
  while (offset < csv.length) {
    const end = csv.indexOf('\n', offset);
    if (end < 0 || count >= m.rows) fail('CSV row count');
    const cells = csv.slice(offset, end).split(','); offset = end + 1;
    if (cells.length !== EXPORT_COLUMN_COUNT) fail(`row ${count}: column count`);
    const row = cells.map((text, i) => {
      const n = text === 'NaN' ? NaN : Number(text), c = EXPORT_COLUMNS[i];
      if (text !== encode(n) || (!Number.isFinite(n) && !Number.isNaN(n))) fail(`row ${count}: ${c.id} numeric encoding`);
      if (!Number.isNaN(n) && ((c.dataType === 'boolean' && n !== 0 && n !== 1)
        || (c.dataType === 'enum' && (!integer(n) || n >= c.enumValues!.length)))) fail(`row ${count}: ${c.id} dictionary`);
      return n;
    });
    const start = count * WINDOW, tick = start + WINDOW;
    const expected = [tick / TRUTH_HZ, count + 1, start, tick, count || NaN, count ? start : NaN,
      count + 1, tick, tick / TRUTH_HZ, tick, tick + WINDOW];
    if (expected.some((n, i) => Number.isNaN(n) ? !Number.isNaN(row[i])
      : i === 0 || i === 8 ? !near(row[i], n) : row[i] !== n)) fail(`row ${count}: window/source/FSW clocks`);
    metrics.propellantUsed_kg = Number.isNaN(row[prop]) || metrics.propellantUsed_kg === null ? null : metrics.propellantUsed_kg + row[prop];
    const rate = Math.hypot(...rates.map(i => row[i])); missingRate ||= !Number.isFinite(rate);
    metrics.peakBodyRate_radps = missingRate ? null : Math.max(metrics.peakBodyRate_radps ?? 0, rate);
    metrics.corridorExcursionSamples = Number.isNaN(row[corridor]) || metrics.corridorExcursionSamples === null ? null
      : metrics.corridorExcursionSamples + Number(row[corridor] > 0);
    metrics.saturatedFswTicks = Number.isNaN(row[saturation]) || metrics.saturatedFswTicks === null ? null
      : metrics.saturatedFswTicks + row[saturation];
    visit?.(row, count);
    count++;
  }
  if (count !== m.rows) fail('CSV row count');
  return metrics;
}

/** Synchronous snapshot: no await, UI clock, file I/O, source assignment or simulation command. */
export function exportRun(session: LabSession, playbackRate: PlaybackRate): RunArtifact {
  const state = session.state;
  if (state === 'STOPPED') return fail('stopped session');
  const tick = session.snapshot(), raw = session.recorder.rawTicks(), outcome = runOutcome(tick);
  const first = raw.findIndex(record => record.outcome !== 'NONE');
  const transition = first >= 0 && (raw[first].plantTick === 1
    || (first > 0 && raw[first - 1].plantTick === raw[first].plantTick - 1 && raw[first - 1].outcome === 'NONE'))
    ? raw[first].plantTick : null;
  const metadata: RunMetadata = { format: FORMAT, schemaVersion: EXPORT_SCHEMA_VERSION, columns: EXPORT_COLUMNS,
    graphHash: GRAPH_HASH, identityNotice: IDENTITY_NOTICE, encoding: ENCODING, stamp: tick.stamp, gncCase: session.gncCase,
    playbackRate, state, rows: session.recorder.length, outcome, outcomeFirstObserved_tick: transition,
    metricBasis: METRIC_BASIS, metrics: {} as RunMetrics };
  validateMetadata(metadata);
  // Accumulate the TEXT artifact column-by-column. At most one copied numeric
  // column is held; never allocate a second full-run numeric matrix on export.
  const rows = Array<string>(metadata.rows).fill('');
  EXPORT_COLUMNS.forEach((column, i) => {
    const values = session.recorder.column(column.id);
    if (values.length !== metadata.rows) fail('recorder changed during export');
    for (let row = 0; row < values.length; row++) rows[row] += `${i ? ',' : ''}${encode(values[row])}`;
  });
  const signalsCsv = `${HEADER}\n${rows.length ? `${rows.join('\n')}\n` : ''}`;
  metadata.metrics = scan(signalsCsv, metadata);
  const runJson = `${canonical(metadata)}\n`;
  if (runJson.length > 1024 * 1024) fail('metadata size');
  return { runJson, signalsCsv };
}

/** Re-import is data-only. A future session owner must explicitly establish REPLAY. */
export function importRun(artifact: RunArtifact): ImportedRun {
  if (artifact.runJson.length > 1024 * 1024) fail('metadata size');
  const metadata = JSON.parse(artifact.runJson) as RunMetadata;
  validateMetadata(metadata);
  const columns = Object.fromEntries(EXPORT_COLUMNS.map(c => [c.id, new Float64Array(metadata.rows)]));
  const metrics = scan(artifact.signalsCsv, metadata, (row, i) => EXPORT_COLUMNS.forEach((c, j) => { columns[c.id][i] = row[j]; }));
  if (canonical(metrics) !== canonical(metadata.metrics)) fail('summary metrics disagree with evidence');
  return { metadata, columns };
}
