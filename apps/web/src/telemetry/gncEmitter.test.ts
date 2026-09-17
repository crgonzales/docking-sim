import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NOMINAL_CASE } from '../gncLab/session/demoRun';
import { useLabStore } from '../gncLab/session/labStore';
import { useViewStore } from '../viewStore';
import { useTelemetryBus, type GncTick } from './bus';
import { getGncSession, pauseGncSession, resumeGncSession, retryGncSession, setGncPlaybackRate,
  startGncSession, stepGncSession, stopGncSession, MAX_CATCHUP_TICKS } from './gncEmitter';

const gncCase = { ...NOMINAL_CASE, maxTicks: 5000 };
const tick = () => useTelemetryBus.getState().gnc!;
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] }); });
afterEach(() => { stopGncSession(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('publishes startup and paced values atomically with a bounded default 10 Hz UI rate', () => {
  const seen: GncTick[] = [];
  const unsubscribe = useTelemetryBus.subscribe(s => {
    if (!s.gnc) return;
    expect(s.frame).toBe(s.gnc.frame); expect(s.renderState).toBe(s.gnc.renderState);
    expect(s.poseEpoch).toBe(s.gnc.poseEpoch);
    expect(s.renderState!.t_s).toBeCloseTo(s.gnc.stamp.plantTime_s, 10);
    if (s.gnc.fswTrace) {
      expect(s.gnc.stamp.samplePlantTick).toBe(s.gnc.sampledPlantTick!.plantTick);
      expect(s.gnc.stamp.plantTick - s.gnc.stamp.samplePlantTick!).toBeLessThan(10);
      expect(s.frame!.t_s).toBe(s.gnc.fswTrace.sensor.t_s);
    }
    seen.push(s.gnc);
  });
  useViewStore.getState().setMode('DEBUG');
  startGncSession(gncCase);
  expect(useViewStore.getState().mode).toBe('CHASE');
  expect(useViewStore.getState().orbits.CHASE).toEqual({ azimuth_rad: 1.15, elevation_rad: 0.3, distance_m: 24 });
  expect(seen).toHaveLength(1);
  expect(tick().stamp).toMatchObject({ plantTick: 0, fswSequence: null, samplePlantTick: null });
  expect(tick().frame).toBeNull(); expect(tick().plantTickRecord).toBeNull();
  vi.advanceTimersByTime(1000);
  expect(seen).toHaveLength(11); expect(tick().stamp.plantTick).toBe(100);
  expect(getGncSession()!.recorder.length).toBe(10);
  expect(new Set(seen.map(t => t.stamp.runId)).size).toBe(1);
  unsubscribe();
});

it('holds clocks while paused, steps exactly at both rates, and retries with a new epoch and identical physics', () => {
  startGncSession(gncCase, { paused: true });
  const initialPoseEpoch = tick().poseEpoch;
  stepGncSession('TRUTH'); expect(tick().stamp.plantTick).toBe(1); expect(tick().frame).toBeNull();
  stepGncSession('FSW');
  expect(tick().stamp).toMatchObject({ plantTick: 11, fswSequence: 1, samplePlantTick: 10 });
  expect(tick().poseEpoch).toBe(initialPoseEpoch + 2);
  expect(tick().pendingWindow.slicesIntegrated).toBe(1);
  const old = tick(); vi.advanceTimersByTime(2000);
  expect(tick().stamp).toEqual(old.stamp); expect(tick().frame).toBe(old.frame);
  retryGncSession(); expect(tick().stamp.epoch).toBeGreaterThan(old.stamp.epoch);
  expect(tick().poseEpoch).toBeGreaterThan(old.poseEpoch);
  expect(tick().stamp.plantTick).toBe(0); expect(tick().frame).toBeNull();
  stepGncSession('TRUTH'); stepGncSession('FSW');
  expect(tick().plantTickRecord).toEqual(old.plantTickRecord);
  expect(tick().fswTrace).toEqual(old.fswTrace);
  expect(tick().stamp.configHash).toBe(old.stamp.configHash);
  resumeGncSession(); vi.advanceTimersByTime(100); expect(tick().stamp.plantTick).toBe(21);
  pauseGncSession(); const paused = tick().stamp.plantTick;
  vi.advanceTimersByTime(5000); expect(tick().stamp.plantTick).toBe(paused);
  resumeGncSession(); vi.advanceTimersByTime(100); expect(tick().stamp.plantTick).toBe(paused + 10);
});

it('discards stale, wrong-run and backwards publishes and never resurrects a stopped epoch', () => {
  startGncSession(gncCase); vi.advanceTimersByTime(100); const old = tick();
  retryGncSession(); const current = useTelemetryBus.getState();
  current.publishGncTick(old); current.beginGncRun(old); current.endGncRun(old.stamp.epoch);
  expect(useTelemetryBus.getState()).toBe(current);
  current.publishGncTick({ ...tick(), stamp: { ...tick().stamp, runId: 'other' } });
  expect(useTelemetryBus.getState()).toBe(current);
  const startup = tick(); vi.advanceTimersByTime(100); const advanced = useTelemetryBus.getState();
  advanced.publishGncTick(startup); expect(useTelemetryBus.getState()).toBe(advanced);
  const last = tick(); stopGncSession(); const stopped = useTelemetryBus.getState();
  stopped.publishGncTick(last); stopped.beginGncRun(last);
  expect(useTelemetryBus.getState()).toBe(stopped);
  expect(stopped.gnc).toBeNull(); expect(stopped.frame).toBeNull(); expect(stopped.renderState).toBeNull();
});

it('changes playback without changing event timing or recorded data and caps catch-up after a stall', () => {
  const fault = { ...gncCase, maxTicks: 160, schedule: [
    { tick: 14, command: { kind: 'INJECT_THRUSTER_STUCK' as const, thrusterId: 'J6', state: 'OPEN' as const } },
    { tick: 25, command: { kind: 'ISOLATE_THRUSTER' as const, thrusterId: 'J6' } },
  ] };
  const results = ([1, 4, 16] as const).map(playbackRate => {
    startGncSession(fault, { playbackRate }); vi.advanceTimersByTime(1600 / playbackRate + 100);
    expect(getGncSession()!.state).toBe('COMPLETE');
    return { duty: getGncSession()!.recorder.column('plant.thrusters/out/activeTime/J6'), truth: tick().plantTickRecord!.truth };
  });
  expect(results[1]).toEqual(results[0]); expect(results[2]).toEqual(results[0]);
  startGncSession(gncCase); setGncPlaybackRate(16);
  const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 10000);
  vi.advanceTimersByTime(20);
  expect(getGncSession()!.tick).toBe(MAX_CATCHUP_TICKS);
  expect(useLabStore.getState().playbackLimited).toBe(true); clock.mockRestore();
});

it('coalesces through requestAnimationFrame and removes listeners, timer, queued frame and session on stop', () => {
  const browser = new EventTarget(), page = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('window', browser); vi.stubGlobal('document', page);
  const callbacks = new Map<number, FrameRequestCallback>(); let next = 0;
  const request = vi.fn((callback: FrameRequestCallback) => { callbacks.set(++next, callback); return next; });
  const cancel = vi.fn((id: number) => callbacks.delete(id));
  vi.stubGlobal('requestAnimationFrame', request); vi.stubGlobal('cancelAnimationFrame', cancel);
  const removeWindow = vi.spyOn(browser, 'removeEventListener'), removeDocument = vi.spyOn(page, 'removeEventListener');
  startGncSession(gncCase); const running = getGncSession()!;
  vi.advanceTimersByTime(140);
  expect(request).toHaveBeenCalledTimes(1); expect(tick().stamp.plantTick).toBe(0);
  callbacks.get(1)!(performance.now()); callbacks.delete(1);
  expect(tick().stamp.plantTick).toBe(14); // freshest snapshot, not the one at request time
  browser.dispatchEvent(new Event('blur')); expect(useLabStore.getState().status).toBe('PAUSED');
  const held = running.tick; vi.advanceTimersByTime(200); expect(running.tick).toBe(held);
  resumeGncSession(); page.hidden = true; page.dispatchEvent(new Event('visibilitychange'));
  expect(running.state).toBe('PAUSED');
  vi.advanceTimersByTime(200); expect(callbacks.size).toBe(1);
  stopGncSession(); expect(callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  expect(removeWindow).toHaveBeenCalledWith('blur', expect.any(Function));
  expect(removeDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  expect(running.state).toBe('STOPPED'); expect(running.recorder.rawLength).toBe(0);
  expect(getGncSession()).toBeNull(); expect(useTelemetryBus.getState().gnc).toBeNull();
});

it('refuses invalid starts without disrupting the existing run and keeps legacy publishers additive', () => {
  startGncSession(gncCase); const active = getGncSession(); const before = tick();
  expect(() => startGncSession({ ...gncCase, maxTicks: 1_000_000 })).toThrow('limit');
  expect(() => startGncSession(gncCase, { publishHz: 21 })).toThrow('2–20');
  expect(() => setGncPlaybackRate(2 as 1)).toThrow('1, 4 or 16');
  expect(getGncSession()).toBe(active); expect(tick()).toBe(before);
  vi.advanceTimersByTime(100); const frame = tick().frame!, render = tick().renderState;
  stopGncSession(); const bus = useTelemetryBus.getState(), poseEpoch = bus.poseEpoch;
  bus.publish(frame); bus.publishRenderState(render);
  expect(useTelemetryBus.getState()).toMatchObject({ frame, renderState: render, poseEpoch, gnc: null });
  expect(useTelemetryBus.getState().frameCount).toBe(bus.frameCount + 1);
});
