import { TRUTH_HZ, type SimOutcome } from '@docking/sim-core';
import type { GncStamp } from '../../telemetry/bus';
import { DEMO_CASES, RCS_STUCK_OPEN_CASE, type GncCase, type GncCaseId } from '../session/demoRun';
import { configHash, type SessionState } from '../session/labSession';

type Identity = Readonly<Pick<GncStamp, 'runId' | 'epoch' | 'source' | 'configHash'>>;
export interface FaultContext {
  readonly stamp: Identity;
  readonly state: SessionState;
  readonly gncCase: GncCase;
}
export interface FaultRebuildRequest {
  readonly expected: Identity;
  readonly caseId: GncCaseId;
  readonly seed: number;
  /** Keep only one detached, bounded previous evidence buffer before replacement. */
  readonly retainPrevious: boolean;
}
export interface FaultPanelBoundary {
  /** Resolve current bus source AND current session identity/state at invocation. */
  readCurrent(): FaultContext | null;
  /** Synchronous guarded rebuild of the existing preset. Parent owns errors and lifecycle. */
  rebuild(request: FaultRebuildRequest): boolean;
}
export interface FaultPanelProps {
  /** Parent assembles this only from matching session/bus identities. */
  readonly view: (FaultContext & { readonly outcome: SimOutcome | null }) | null;
  readonly boundary: FaultPanelBoundary;
}
const STATES: readonly SessionState[] = ['RUNNING', 'PAUSED', 'COMPLETE'];
const matches = (a: Identity, b: Identity) => a.source === 'LIVE' && b.source === 'LIVE'
  && a.runId === b.runId && a.epoch === b.epoch && a.configHash === b.configHash;

/** A same-seed label alone cannot make edited physics or a different schedule comparable. */
export function isComparisonPreset(context: FaultContext): boolean {
  const preset = DEMO_CASES.find(c => c.id === context.gncCase.id), current = context.gncCase;
  return !!preset && current.seed === preset.seed && current.geometry === preset.geometry
    && current.maxTicks === preset.maxTicks && configHash(current.config) === configHash(preset.config)
    && context.stamp.configHash === configHash(preset.config)
    && JSON.stringify(current.schedule) === JSON.stringify(preset.schedule);
}

/** No simulation, fault clock, command injection or local presentation state. */
export function FaultPanel({ view, boundary }: FaultPanelProps) {
  // Capture scalar identity now, so even a parent-mutated view cannot retarget a retained callback.
  const expected = view ? Object.freeze({ runId: view.stamp.runId, epoch: view.stamp.epoch,
    source: view.stamp.source, configHash: view.stamp.configHash }) : null;
  const caseId = view?.gncCase.id;
  const enabled = !!view && view.stamp.source === 'LIVE' && STATES.includes(view.state);
  const comparable = enabled && isComparisonPreset(view!);
  const request = (target: GncCaseId, retainPrevious: boolean) => {
    if (!expected || expected.source !== 'LIVE' || (retainPrevious && !comparable)) return;
    const current = boundary.readCurrent();
    if (!current || !STATES.includes(current.state) || !matches(expected, current.stamp)) return;
    if (retainPrevious && (current.gncCase.id !== caseId || !isComparisonPreset(current))) return;
    const preset = DEMO_CASES.find(c => c.id === target)!;
    boundary.rebuild({ expected, caseId: target, seed: preset.seed, retainPrevious });
  };
  return <section className="gnc-fault-panel" aria-label="Demonstration cases">
    <header>{view?.stamp.source ?? 'NO RUN'} · Run {view?.stamp.runId ?? '—'} · epoch {view?.stamp.epoch ?? '—'}</header>
    <p>Current case: {view?.gncCase.label ?? '—'} · seed {view?.gncCase.seed ?? '—'} · {view?.state ?? 'STOPPED'}</p>
    <p>Observed outcome: {view?.outcome ?? 'UNAVAILABLE'}. ABORT reports the run’s latched outcome only.</p>
    <div aria-label="Rebuild case controls">{DEMO_CASES.map(preset =>
      <button key={preset.id} type="button" disabled={!enabled} onClick={() => request(preset.id, false)}>
        Restart {preset.id} · seed {preset.seed}
      </button>)}</div>
    <button type="button" disabled={!comparable} onClick={() => request(caseId === 'NOMINAL' ? 'RCS_STUCK_OPEN' : 'NOMINAL', true)}>
      Keep evidence &amp; run {caseId === 'NOMINAL' ? 'RCS_STUCK_OPEN' : 'NOMINAL'} at the same seed
    </button>
    <p>Restart begins at tick 0. Comparison retains the recorded prefix and runs the other preset sequentially.</p>
    {!comparable && <p>Comparison requires an unchanged LIVE preset, including its seed, configuration and schedule.</p>}
    <details><summary>Scripted J6 preset schedule</summary>
      <ul>{RCS_STUCK_OPEN_CASE.schedule.map((event, index) => <li key={index}>
        Tick {event.tick} ({(event.tick / TRUTH_HZ).toFixed(2)} s): {event.command.kind === 'ISOLATE_THRUSTER'
          ? `operator isolates ${event.command.thrusterId}` : `inject ${event.command.thrusterId} stuck ${event.command.state}`}.
      </li>)}</ul>
      <p>Recorded baseline at seed {RCS_STUCK_OPEN_CASE.seed}: {RCS_STUCK_OPEN_CASE.expected.outcome}. Isolation is scripted operator action.</p>
    </details>
  </section>;
}
