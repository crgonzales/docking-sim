import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTelemetryBus } from './bus';
import { useScenarioStore } from './scenarioStore';
import { useViewStore } from '../viewStore';
import { getSelectedScenario, launchScenario, pauseScenario, resumeScenario, retryScenario, selectMission, setManualCommand, setLessonPadCommand, startScenario, stopScenario, togglePrecision, toggleApproach } from './scenarioEmitter';

const forward = { translation: [0, 1, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] };
const frame = () => useTelemetryBus.getState().frame!;
beforeEach(() => { vi.useFakeTimers(); useScenarioStore.setState({ selectedMission: 'FIRST_DOCKING', startPoint: 'APPROACH' }); });
afterEach(() => { stopScenario(); vi.useRealTimers(); });

it('gates launch, resets camera and clears previous telemetry on retry', () => {
  useViewStore.getState().setMode('DEBUG');
  startScenario();
  expect(useViewStore.getState().mode).toBe('CINEMATIC');
  setManualCommand(forward);
  vi.advanceTimersByTime(2000);
  expect(useTelemetryBus.getState().frame).toBeNull();
  expect(useScenarioStore.getState().phase).toBe('BRIEFING');
  launchScenario();
  vi.advanceTimersByTime(1000);
  expect(frame().t_s).toBeCloseTo(1, 10);
  expect(frame().control_mode).toBe('MANUAL');
  retryScenario('FINAL');
  expect(useTelemetryBus.getState().frame).toBeNull();
  expect(useTelemetryBus.getState().renderState?.r_hill_m).toEqual([0, -12.4, 0]);
  expect(getSelectedScenario().initial.rel_position_m).toEqual([0, -12.4, 0]);
  expect(useScenarioStore.getState().precision).toBe(true);
});

it('freezes time while paused, clears both input sources, and resumes without hidden thrust', () => {
  startScenario(); launchScenario();
  vi.advanceTimersByTime(500);
  setManualCommand(forward); setLessonPadCommand(forward);
  const prior = frame();
  pauseScenario();
  setManualCommand(forward); setLessonPadCommand(forward);
  vi.advanceTimersByTime(3000);
  expect(frame()).toBe(prior);
  expect(useScenarioStore.getState().state?.clock.elapsed_s).toBe(0.5);
  resumeScenario();
  vi.advanceTimersByTime(1000);
  const actual = frame();
  retryScenario();
  vi.advanceTimersByTime(1500);
  expect(frame()).toEqual(actual);
});

it('routes pointer thrust through fine controls and can dock the final segment', () => {
  retryScenario('FINAL');
  setLessonPadCommand(forward);
  vi.advanceTimersByTime(40_000);
  expect(frame().outcome).toBe('DOCKED');
  expect(useScenarioStore.getState().phase).toBe('DEBRIEF');
  const stoppedTime = frame().t_s;
  vi.advanceTimersByTime(10_000);
  expect(frame().t_s).toBe(stoppedTime);
}, 20_000);

it('precision changes clear held input; mission selection preserves the advanced exercise', () => {
  startScenario(); launchScenario(); setManualCommand(forward);
  const epoch = useScenarioStore.getState().inputEpoch;
  togglePrecision();
  expect(useScenarioStore.getState().inputEpoch).toBeGreaterThan(epoch);
  expect(useScenarioStore.getState().precision).toBe(false);
  vi.advanceTimersByTime(1000);
  const released = frame();
  retryScenario();
  vi.advanceTimersByTime(1000);
  expect(frame()).toEqual(released);
  selectMission('EMERGENCY');
  expect(getSelectedScenario().id).toBe('FINAL_APPROACH_01');
  expect(useTelemetryBus.getState().frame).toBeNull();
  launchScenario(); vi.advanceTimersByTime(1000);
  expect(frame().control_mode).toBe('AUTO');
  stopScenario();
  expect(vi.getTimerCount()).toBe(0);
});


it('maintains only player-requested forward input and releases it on pause', () => {
  retryScenario('FINAL'); toggleApproach();
  vi.advanceTimersByTime(40_000);
  expect(frame().outcome).toBe('DOCKED');
  expect(useScenarioStore.getState().approaching).toBe(false);
  retryScenario(); toggleApproach(); pauseScenario();
  expect(useScenarioStore.getState().approaching).toBe(false);
  resumeScenario(); vi.advanceTimersByTime(2000);
  const released = frame();
  retryScenario(); vi.advanceTimersByTime(2000);
  expect(frame()).toEqual(released);
}, 20_000);
