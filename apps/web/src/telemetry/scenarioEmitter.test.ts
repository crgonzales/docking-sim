import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTelemetryBus } from './bus';
import { useScenarioStore } from './scenarioStore';
import { useViewStore } from '../viewStore';
import { commandAbort, getSelectedScenario, launchScenario, pauseScenario, resumeScenario, retryScenario, selectMission, setManualCommand, setLessonPadCommand, startScenario, stopScenario, togglePrecision, toggleApproach } from './scenarioEmitter';

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

it('precision changes clear held input but keep the held approach; mission selection preserves the advanced exercise', () => {
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
  // X changes speed only: the held approach survives both toggle directions.
  retryScenario(); toggleApproach();
  vi.advanceTimersByTime(2000);
  const precisionStart = frame().nav_r_hill_m[1];
  vi.advanceTimersByTime(2000);
  const precisionAdvance = frame().nav_r_hill_m[1] - precisionStart;
  const heldEpoch = useScenarioStore.getState().inputEpoch;
  togglePrecision();
  expect(useScenarioStore.getState().inputEpoch).toBeGreaterThan(heldEpoch);
  expect(useScenarioStore.getState()).toMatchObject({ precision: false, approaching: true });
  vi.advanceTimersByTime(2000);
  const approachStart = frame().nav_r_hill_m[1];
  vi.advanceTimersByTime(2000);
  expect(frame().nav_r_hill_m[1] - approachStart).toBeGreaterThan(precisionAdvance * 2);
  togglePrecision();
  expect(useScenarioStore.getState()).toMatchObject({ precision: true, approaching: true });
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
  retryScenario('APPROACH'); toggleApproach(); pauseScenario();
  expect(useScenarioStore.getState().approaching).toBe(false);
  resumeScenario(); vi.advanceTimersByTime(2000);
  const released = frame();
  retryScenario('APPROACH'); vi.advanceTimersByTime(2000);
  expect(frame()).toEqual(released);
}, 20_000);

it('retry repeats the exercise being flown unless an exercise is named', () => {
  retryScenario('FINAL');
  retryScenario();
  expect(useScenarioStore.getState().startPoint).toBe('FINAL');
  expect(getSelectedScenario().initial.rel_position_m).toEqual([0, -12.4, 0]);
  retryScenario('APPROACH');
  expect(useScenarioStore.getState().startPoint).toBe('APPROACH');
  expect(getSelectedScenario().initial.rel_position_m).toEqual([0.25, -16.4, 0.15]);
});

it('refuses the abort command in the lesson and honours it in the emergency mission', () => {
  startScenario(); launchScenario(); vi.advanceTimersByTime(500);
  commandAbort(); vi.advanceTimersByTime(1000);
  expect(frame().outcome).toBe('NONE');
  expect(useScenarioStore.getState().phase).toBe('RUNNING');
  expect(useScenarioStore.getState().state?.outcome).toBeNull();
  selectMission('EMERGENCY'); launchScenario(); vi.advanceTimersByTime(500);
  commandAbort(); vi.advanceTimersByTime(1000);
  expect(frame().outcome).toBe('ABORT');
  expect(useScenarioStore.getState().state?.outcome).toBe('PASSIVE_ABORT');
  expect(useScenarioStore.getState().phase).toBe('DEBRIEF');
});
