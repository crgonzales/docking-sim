import { useEffect, useState, useSyncExternalStore } from 'react';
import type { GncStamp } from '../../telemetry/bus';
import type { RunMetadata, RunMetrics } from '../session/runExport';
import { createRunFileOwner, type RunFileOwner, type RunFileState } from './runFileOwner';

export function RunEvidencePanel({ expected }: { expected: Readonly<GncStamp> }) {
  const [owner] = useState(() => createRunFileOwner(expected));
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  useEffect(() => owner.connect(), [owner]);
  return <RunEvidencePanelView owner={owner} state={state} />;
}

const METRICS: readonly [keyof RunMetrics, string][] = [
  ['propellantUsed_kg', 'Delivered propellant (kg)'], ['peakBodyRate_radps', 'Sampled truth body-rate peak (rad/s)'],
  ['corridorExcursionSamples', 'Corridor excursion FSW samples'], ['saturatedFswTicks', 'Saturated FSW ticks'],
  ['timeToOutcome_s', 'Observed outcome transition (s)'],
];
function RecordedSummary({ data }: { data: RunMetadata }) {
  const { stamp, gncCase } = data;
  return <div className="gnc-file-summary">
    <p>Run {stamp.runId} · epoch {stamp.epoch} · source at capture: {stamp.source}</p>
    <p>{gncCase.label} · {gncCase.geometry} · seed {gncCase.seed} · {data.state === 'COMPLETE' ? 'Completed capture' : 'Recorded prefix'}
      {' · '}plant tick {stamp.plantTick} ({stamp.plantTime_s.toFixed(2)} s)
      {' · '}FSW {stamp.fswSequence ?? '—'} sampled {stamp.sampleTime_s?.toFixed(2) ?? '—'} s.</p>
    <p>{data.rows} completed windows. Pending slices are excluded. Recorded outcome: {data.outcome ?? 'UNAVAILABLE'}.</p>
    <dl>{METRICS.map(([id, label]) => <div key={id}><dt>{label}</dt><dd>{data.metrics[id] === null ? 'UNAVAILABLE' : data.metrics[id]!.toPrecision(6)}</dd></div>)}</dl>
    <details><summary>Metric definitions and identity limits</summary>
      {METRICS.map(([id]) => <p key={id}>{data.metricBasis[id]}</p>)}<p>{data.identityNotice}</p>
      <p>Configuration identity: {stamp.configHash}. Graph identity: {data.graphHash}.</p>
    </details>
  </div>;
}

/** Explicit inputs keep callback/markup tests independent of a browser renderer. */
export function RunEvidencePanelView({ owner, state }: { owner: RunFileOwner; state: RunFileState }) {
  const enabled = owner.canAct(), prepared = state.prepared;
  return <details className="gnc-run-files"><summary>Run files</summary>
    <p>Export uses the current active recorder, even when previous-run plots are selected. Save both files before replacing a run.</p>
    <button type="button" disabled={!enabled} onClick={owner.prepare}>Export current run</button>
    {prepared && <section aria-label="Prepared run downloads">
      <p>Prepared recorded capture. Download both files as a pair.</p>
      <RecordedSummary data={prepared.metadata} />
      {(['json', 'csv'] as const).map(kind => <a key={kind} href={prepared[`${kind}Url`]}
        download={kind === 'json' ? 'run.json' : 'signals.csv'} onClick={event => {
          if (!owner.canDownload(prepared.generation)) event.preventDefault();
        }}>{kind === 'json' ? 'Download run.json' : 'Download signals.csv'}</a>)}
    </section>}
    <fieldset disabled={!enabled}><legend>Inspect recorded files</legend>
      {(['json', 'csv'] as const).map(role => <label key={role}>{role === 'json' ? 'run.json' : 'signals.csv'}
        <input type="file" accept={role === 'json' ? '.json,application/json' : '.csv,text/csv'}
          onChange={event => { owner.select(role, event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
        <span>{state.files[role]?.name ?? 'No file selected'}</span>
      </label>)}
      <button type="button" disabled={state.busy || !state.files.json || !state.files.csv} onClick={() => { void owner.load(); }}>
        {state.busy ? 'Reading files…' : 'Load recorded evidence'}</button>
    </fieldset>
    {state.imported && <section aria-label="Imported recorded evidence"><strong>Imported recorded evidence — not live telemetry.</strong>
      <RecordedSummary data={state.imported} /></section>}
    <p>File inspection does not change the spacecraft or controls. Session-owned REPLAY playback is not implemented here.</p>
    <button type="button" disabled={!enabled} onClick={owner.clear}>Clear files and downloads</button>
    {state.error && <p className="gnc-error" role="alert">{state.error}</p>}
  </details>;
}
