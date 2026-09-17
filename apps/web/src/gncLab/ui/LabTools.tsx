import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { GncTick } from '../../telemetry/bus';
import { FaultPanel } from './FaultPanel';
import { SignalPlots } from './SignalPlots';
import { RunEvidencePanel } from './RunEvidencePanel';
import { runOutcome } from '../model/runOutcome';
import { createLabEvidence, readLabContext, sameIdentity, type LabEvidence, type LabEvidenceState, type RunEvidence } from './labEvidence';

/** Measure available content width; late resize deliveries cannot update an unmounted host. */
export function observePlotWidth(host: HTMLElement, update: (width: number) => void) {
  let active = true;
  const report = (width: number) => { if (active) update(Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0); };
  report(host.clientWidth);
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
    for (const entry of entries) if (entry.target === host) report(entry.contentRect.width);
  });
  observer?.observe(host);
  return () => { active = false; observer?.disconnect(); };
}

/** Cache survives selection close/reopen and the diagram's run-key remount. */
export function useLabTools(tick: GncTick | null) {
  const [model] = useState(createLabEvidence);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useEffect(() => model.connect(), [model]);
  return <LabTools model={model} state={state} tick={tick} />;
}

export function EvidenceLabel({ evidence, previous }: { evidence: RunEvidence; previous: boolean }) {
  const { stamp, columns } = evidence.data;
  return <p className="gnc-evidence-label">
    {previous ? 'Previous recorded evidence' : 'Current recorded evidence'} · {evidence.caseId} · seed {evidence.seed}
    {' · '}{evidence.complete ? 'Completed run' : 'Recorded prefix — not a completed run'}
    {' · '}captured at plant tick {stamp.plantTick} ({stamp.plantTime_s.toFixed(2)} s)
    {' · '}FSW {stamp.fswSequence ?? '—'} sampled {stamp.sampleTime_s?.toFixed(2) ?? '—'} s
    {' · '}{columns.time_s.length} completed windows through {columns.time_s.at(-1)?.toFixed(2) ?? '—'} s
    {' · '}observed outcome at capture: {evidence.outcome ?? 'UNAVAILABLE'}.
    {previous && ' Frozen evidence captured from LIVE; the spacecraft and controls remain on the current run.'}
  </p>;
}

export function LabTools({ model, state, tick }: { model: LabEvidence; state: LabEvidenceState; tick: GncTick | null }) {
  const [showPrevious, setShowPrevious] = useState(false);
  const [width, setWidth] = useState(0), host = useRef<HTMLDivElement>(null);
  useEffect(() => host.current ? observePlotWidth(host.current, setWidth) : undefined, []);
  const context = readLabContext();
  const matching = !!context && !!tick && sameIdentity(context.stamp, tick.stamp);
  const current = matching && state.current && sameIdentity(state.current.data.stamp, tick.stamp) ? state.current : null;
  const previous = current ? state.previous : null;
  const selected = showPrevious && previous ? previous : current;
  return <section className="gnc-lab-tools" aria-label="Signal evidence and cases">
    <h3>Actuation evidence</h3>
    {previous && <div className="gnc-evidence-switch" aria-label="Recorded run selection">
      <button type="button" aria-pressed={!showPrevious} onClick={() => setShowPrevious(false)}>Current run</button>
      <button type="button" aria-pressed={showPrevious} onClick={() => setShowPrevious(true)}>Previous recorded prefix / run</button>
      <p>Same-seed presets, sequential runs. Select a record to compare the same signals; no second live simulation.</p>
    </div>}
    {selected && <EvidenceLabel evidence={selected} previous={selected === previous} />}
    <div className="gnc-plot-host" ref={host}>
      <SignalPlots data={selected?.data ?? null} widthPx={width}
        current={selected && selected === previous ? selected.data.stamp : tick?.stamp ?? null} />
    </div>
    <FaultPanel view={matching ? { ...context, outcome: runOutcome(tick) } : null} boundary={model.boundary} />
    {matching && <RunEvidencePanel key={`${tick.stamp.source}/${tick.stamp.runId}/${tick.stamp.epoch}/${tick.stamp.configHash}`} expected={tick.stamp} />}
    {matching && state.error && sameIdentity(state.error.stamp, tick.stamp)
      && <p className="gnc-error" role="alert">{state.error.message}</p>}
  </section>;
}
