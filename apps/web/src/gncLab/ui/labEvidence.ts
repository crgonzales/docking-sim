import type { SimOutcome } from '@docking/sim-core';
import { useTelemetryBus, type GncStamp } from '../../telemetry/bus';
import { getGncSession, startGncSession } from '../../telemetry/gncEmitter';
import { DEMO_CASES, type GncCaseId } from '../session/demoRun';
import { useLabStore } from '../session/labStore';
import { runOutcome } from '../model/runOutcome';
import { isComparisonPreset, type FaultContext, type FaultPanelBoundary } from './FaultPanel';
import { copyPlotColumns, type PlotColumns } from './SignalPlots';

type Identity = FaultContext['stamp'];
export const sameIdentity = (a: Identity, b: Identity) => a.source === b.source
  && a.runId === b.runId && a.epoch === b.epoch && a.configHash === b.configHash;

/** Resolve the currently presented source, not just a still-existing LIVE runner. */
export function readLabContext(): (FaultContext & { stamp: Readonly<GncStamp> }) | null {
  const session = getGncSession(), tick = useTelemetryBus.getState().gnc;
  if (!session || session.state === 'STOPPED' || !tick) return null;
  const stamp = session.snapshot().stamp;
  return sameIdentity(stamp, tick.stamp) ? { stamp, state: session.state, gncCase: session.gncCase } : null;
}

export interface RunEvidence {
  readonly data: PlotColumns;
  readonly caseId: GncCaseId;
  readonly seed: number;
  readonly complete: boolean;
  readonly outcome: SimOutcome | null;
}
export interface LabEvidenceState {
  readonly current: RunEvidence | null;
  readonly previous: RunEvidence | null;
  readonly error: { readonly stamp: Identity; readonly message: string } | null;
}

/** Overlay-local storage only. No runner, clock, publisher or whole-record history. */
export function createLabEvidence() {
  let state: LabEvidenceState = { current: null, previous: null, error: null };
  let pairedRun: Identity | null = null;
  let active = false;
  const listeners = new Set<() => void>();
  const set = (next: LabEvidenceState) => {
    if (next.current === state.current && next.previous === state.previous && next.error === state.error) return;
    state = next; listeners.forEach(listener => listener());
  };
  const capture = (): RunEvidence => {
    const session = getGncSession()!;
    const data = copyPlotColumns(session);
    return { data, caseId: session.gncCase.id, seed: session.gncCase.seed,
      complete: session.state === 'COMPLETE', outcome: runOutcome(session.snapshot()) };
  };
  const refresh = () => {
    const context = readLabContext(), tick = useTelemetryBus.getState().gnc;
    if (!active || !context || context.stamp.source !== 'LIVE' || !tick) {
      pairedRun = null; set({ current: null, previous: null, error: null }); return;
    }
    let current = state.current;
    if (current && !sameIdentity(current.data.stamp, context.stamp)) current = null;
    // A queued publication can lag the session. Never capture future evidence for it.
    if (context.stamp.plantTick <= tick.stamp.plantTick
      && (!current || current.data.columns.time_s.length !== getGncSession()!.recorder.length)) current = capture();
    const previous = pairedRun && sameIdentity(pairedRun, context.stamp) ? state.previous : null;
    if (!previous) pairedRun = null;
    const error = state.error && sameIdentity(state.error.stamp, context.stamp) ? state.error : null;
    set({ current, previous, error });
  };
  const boundary: FaultPanelBoundary = {
    readCurrent: () => active ? readLabContext() : null,
    rebuild(request) {
      const context = boundary.readCurrent();
      const preset = DEMO_CASES.find(c => c.id === request.caseId && c.seed === request.seed);
      if (!context || context.stamp.source !== 'LIVE' || !sameIdentity(request.expected, context.stamp)
        || !['RUNNING', 'PAUSED', 'COMPLETE'].includes(context.state) || !preset) return false;
      if (request.retainPrevious && (!isComparisonPreset(context) || preset.id === context.gncCase.id
        || preset.seed !== context.gncCase.seed)) return false;
      try {
        // Request identity contains no data clock; capture the actual sample stamp now.
        const previous = request.retainPrevious ? capture() : null;
        const { playbackRate, publishHz } = useLabStore.getState();
        startGncSession(preset, { playbackRate, publishHz, paused: context.state === 'PAUSED' });
        pairedRun = previous ? Object.freeze({ ...getGncSession()!.snapshot().stamp }) : null;
        set({ current: state.current, previous, error: null });
        refresh();
        return true;
      } catch (error) {
        set({ ...state, error: { stamp: Object.freeze({ ...context.stamp }), message: String(error) } });
        return false;
      }
    },
  };
  return {
    boundary,
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    connect() {
      active = true; refresh();
      const unsubscribe = useTelemetryBus.subscribe(refresh);
      return () => { unsubscribe(); active = false; pairedRun = null; set({ current: null, previous: null, error: null }); };
    },
  };
}
export type LabEvidence = ReturnType<typeof createLabEvidence>;
