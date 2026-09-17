import { useState, type ReactNode } from 'react';
import { useTelemetryBus, type GncTick } from '../../telemetry/bus';
import { getGncSession, pauseGncSession, resumeGncSession, retryGncSession, setGncPlaybackRate, stepGncSession } from '../../telemetry/gncEmitter';
import { useLabStore, type LabStoreState } from '../session/labStore';
import type { SessionState } from '../session/labSession';
import { RATE_LABELS } from '../model/blocks';
import { runOutcome } from '../model/runOutcome';
import { BlockDiagram } from './BlockDiagram';
import { formatSampleTime } from './format';
import { useLabTools } from './LabTools';
import { readLabContext, sameIdentity } from './labEvidence';
import '../../hud/hud.css';
import './gnc.css';

/** Subscriber overlay only. B8 owns the single publisher's start/stop lifecycle,
 * alongside SceneRoot; mounting this component cannot start another simulation.
 */
export function GncLab() {
  const tick = useTelemetryBus(s => s.gnc);
  const presentation = useLabStore();
  const tools = useLabTools(tick);
  return <GncLabView tick={tick} presentation={presentation} tools={tools} />;
}
/** Explicit inputs also allow headless markup checks without a browser or fake telemetry. */
export function GncLabView({ tick, presentation, tools }: { tick: GncTick | null; presentation: LabStoreState; tools?: ReactNode }) {
  const [actionError, setActionError] = useState<{ epoch: number; message: string } | null>(null);
  const session = getGncSession();
  const identity = session && session.state !== 'STOPPED' ? session.snapshot().stamp : null;
  const active = tick && identity?.runId === tick.stamp.runId && identity.epoch === tick.stamp.epoch ? session : null;
  const live = !!active && tick?.stamp.source === 'LIVE';
  const runnable = live && (presentation.status === 'RUNNING' || presentation.status === 'PAUSED');
  const act = (command: () => void, states: readonly SessionState[] = ['RUNNING', 'PAUSED']) => {
    // A callback may outlive the run or state displayed when it was rendered.
    const current = readLabContext();
    if (!tick || tick.stamp.source !== 'LIVE' || !current || !states.includes(current.state)) return;
    if (!sameIdentity(current.stamp, tick.stamp)) return;
    setActionError(null);
    try { command(); } catch (error) { setActionError({ epoch: tick.stamp.epoch, message: String(error) }); }
  };
  const error = actionError && actionError.epoch === tick?.stamp.epoch ? actionError.message : presentation.error;
  return <div className="gnc-overlay" aria-label="GNC demonstration">
    <header className="gnc-header">
      <div className="gnc-heading"><strong>GNC / Docking</strong>
        <span>{tick?.stamp.source ?? 'NO RUN'} · {presentation.status}</span>
        <span>{active?.gncCase.label ?? 'No active case'}</span>
        {active && <span>{active.gncCase.geometry} · seed {active.gncCase.seed}</span>}
      </div>
      <div className="gnc-meta">
        <span>Run {tick?.stamp.runId ?? '—'} · epoch {tick?.stamp.epoch ?? '—'}</span>
        <span>Plant {tick?.stamp.plantTick ?? '—'} · {formatSampleTime(tick?.stamp.plantTime_s ?? null)}</span>
        <span>FSW {tick?.stamp.fswSequence ?? '—'} · sampled {formatSampleTime(tick?.stamp.sampleTime_s ?? null)}</span>
        <span>Outcome {runOutcome(tick) ?? '—'}</span>
      </div>
      <div className="gnc-controls" aria-label="Session controls">
        <button disabled={!runnable} onClick={() => presentation.status === 'RUNNING'
          ? act(pauseGncSession, ['RUNNING']) : act(resumeGncSession, ['PAUSED'])}>
          {presentation.status === 'RUNNING' ? 'Pause' : 'Resume'}</button>
        <button disabled={!runnable} onClick={() => act(() => stepGncSession('TRUTH'))}>Step 0.01 s</button>
        <button disabled={!runnable} onClick={() => act(() => stepGncSession('FSW'))}>Step 0.10 s</button>
        <button disabled={!live} onClick={() => act(retryGncSession, ['RUNNING', 'PAUSED', 'COMPLETE'])}>Retry</button>
        <span>Playback</span>{([1, 4, 16] as const).map(rate => <button key={rate} disabled={!runnable}
          aria-pressed={presentation.playbackRate === rate} onClick={() => act(() => setGncPlaybackRate(rate))}>{rate}×</button>)}
        <small>Selected controller {tick?.fswTrace?.mode.controller ?? '—'} · branch {tick?.fswTrace?.mode.branch ?? '—'}
          {tick?.fswTrace?.mode.controller === 'MPC' && tick.fswTrace.mode.branch === 'AUTO' && ` · ${RATE_LABELS.MPC_1HZ_IN_10HZ}`}</small>
      </div>
      {presentation.playbackLimited && <p className="gnc-caution" role="status">PLAYBACK LIMITED</p>}
      {error && <p className="gnc-error" role="alert">{error}</p>}
    </header>
    <BlockDiagram key={tick ? `${tick.stamp.source}:${tick.stamp.runId}:${tick.stamp.epoch}` : 'none'} tick={tick} tools={tools} />
  </div>;
}
