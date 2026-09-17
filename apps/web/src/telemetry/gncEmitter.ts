import { TRUTH_HZ } from '@docking/sim-core';
import { createLabSession, type LabSession, type PlaybackRate } from '../gncLab/session/labSession';
import { NOMINAL_CASE, type GncCase } from '../gncLab/session/demoRun';
import { useLabStore } from '../gncLab/session/labStore';
import { useViewStore } from '../viewStore';
import { useTelemetryBus, type GncTick } from './bus';

export const GNC_PUMP_MS = 20;
export const MAX_CATCHUP_TICKS = 200;
export interface GncEmitterOptions { publishHz?: number; playbackRate?: PlaybackRate; paused?: boolean }
let session: LabSession | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let raf: number | null = null;
let pending: GncTick | null = null;
let lastPump = 0, lastPublish = 0, fractionalTicks = 0;

export function getGncSession(): LabSession | null { return session; }
const now = () => performance.now();
function cancelFrame(): void {
  if (raf !== null) cancelAnimationFrame(raf);
  raf = null;
}
function publish(): void {
  raf = null;
  if (!session || !pending) return;
  useTelemetryBus.getState().publishGncTick(pending);
  pending = null; lastPublish = now();
  useLabStore.setState({ status: session.state });
}
function publishNow(): void {
  cancelFrame();
  if (session) pending = session.snapshot();
  publish();
}
function rebasePacing(): void { lastPump = now(); fractionalTicks = 0; }

/** Presentation pacing only: sim time always comes from integer target ticks. */
function pump(): void {
  if (!session) return;
  const time = now();
  const elapsed = Math.max(0, time - lastPump); lastPump = time;
  if (session.state === 'RUNNING') {
    const desired = fractionalTicks + elapsed * TRUTH_HZ * useLabStore.getState().playbackRate / 1000;
    const whole = Math.floor(desired + 1e-9);
    fractionalTicks = Math.max(0, desired - whole);
    const playbackLimited = whole > MAX_CATCHUP_TICKS;
    if (useLabStore.getState().playbackLimited !== playbackLimited) useLabStore.setState({ playbackLimited });
    try {
      if (whole > 0) session.advanceTo(session.tick + Math.min(whole, MAX_CATCHUP_TICKS));
    } catch (error) {
      session.pause();
      useLabStore.setState({ error: error instanceof Error ? error.message : String(error) });
    }
  }
  // Coalesce runner segments to the freshest coherent snapshot. Paused runs
  // keep their true clocks; no synthetic FSW frame or truth tick is produced.
  pending = session.snapshot();
  if (raf === null && time - lastPublish + 1e-9 >= 1000 / useLabStore.getState().publishHz) {
    if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(publish);
    else publish(); // headless tests / environments without a display
  }
}
function onBlur(): void { pauseGncSession(); }
function onVisibility(): void { if (document.hidden) pauseGncSession(); }
function release(): void {
  if (timer !== null) clearInterval(timer);
  timer = null; cancelFrame(); pending = null;
  if (typeof window !== 'undefined') window.removeEventListener('blur', onBlur);
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  session?.dispose(); session = null;
}

/** Build first, so a refused case cannot replace a healthy active run. */
export function startGncSession(gncCase: GncCase = NOMINAL_CASE, options: GncEmitterOptions = {}): void {
  const publishHz = options.publishHz ?? 10, playbackRate = options.playbackRate ?? 1;
  if (!Number.isFinite(publishHz) || publishHz < 2 || publishHz > 20) throw new RangeError('GNC publish rate must be 2–20 Hz');
  if (![1, 4, 16].includes(playbackRate)) throw new RangeError('Playback rate must be 1, 4 or 16');
  const bus = useTelemetryBus.getState();
  const epoch = bus.gncEpoch + 1;
  const next = createLabSession(gncCase, { runId: `gnc-${epoch}`, epoch, poseEpoch: bus.poseEpoch + 1,
    paused: options.paused, onTick(tick) { if (session === next) pending = tick; } });
  release(); session = next;
  useLabStore.setState({ status: next.state, playbackRate, publishHz, playbackLimited: false, error: null });
  rebasePacing(); lastPublish = lastPump;
  // Clear old data and publish startup pose/null samples in the same update.
  useTelemetryBus.getState().beginGncRun(next.snapshot());
  // Keep the observed vehicle above the lab panel; the corridor-centred
  // cinematic view puts it offscreen at the initial 250 m separation.
  useViewStore.getState().setMode('CHASE');
  useViewStore.setState({ keybindsOpen: false, orbits: { ...useViewStore.getState().orbits,
    CHASE: { azimuth_rad: 1.15, elevation_rad: 0.3, distance_m: 24 } } });
  if (typeof window !== 'undefined') window.addEventListener('blur', onBlur);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  timer = setInterval(pump, GNC_PUMP_MS);
}
export function stopGncSession(): void {
  const epoch = session?.snapshot().stamp.epoch;
  release();
  if (epoch !== undefined) useTelemetryBus.getState().endGncRun(epoch);
  useLabStore.setState({ status: 'STOPPED', playbackLimited: false, error: null });
}
export function pauseGncSession(): void {
  session?.pause(); rebasePacing(); useLabStore.setState({ playbackLimited: false }); publishNow();
}
export function resumeGncSession(): void {
  session?.resume(); rebasePacing(); publishNow();
}
export function stepGncSession(rate: 'TRUTH' | 'FSW'): void {
  session?.singleStep(rate); rebasePacing(); publishNow();
}
export function setGncPlaybackRate(rate: PlaybackRate): void {
  if (![1, 4, 16].includes(rate)) throw new RangeError('Playback rate must be 1, 4 or 16');
  useLabStore.setState({ playbackRate: rate, playbackLimited: false }); rebasePacing();
}
export function retryGncSession(): void {
  if (!session) return;
  const { playbackRate, publishHz } = useLabStore.getState();
  startGncSession(session.gncCase, { playbackRate, publishHz, paused: session.state === 'PAUSED' });
}
