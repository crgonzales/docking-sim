import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RenderState } from '@docking/sim-core';
import { useTelemetryBus } from '../telemetry/bus';
import { useScenarioStore } from '../telemetry/scenarioStore';
import { startFlightAudio } from './flightAudio';

const audio = vi.hoisted(() => {
  const node = () => ({ connect: (target: unknown) => target, disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), gain: { value: 0 }, frequency: { value: 0 } });
  return { context: { state: 'running', resume: async () => undefined, createOscillator: node, createGain: node },
    output: node(), duty: new Map<string, number>(), dispose: vi.fn() };
});
vi.mock('./audioContext', () => ({ getAudioContext: () => audio.context,
  getExistingAudioContext: () => audio.context, getMasterGain: () => audio.output }));
vi.mock('./rcsAudio', () => ({ connectRcsListener: () => () => {},
  createRcsAudioBank: () => ({ setDuty: (id: string, value: number) => audio.duty.set(id, value), dispose: audio.dispose }) }));

const firing: RenderState = { t_s: 1, r_hill_m: [0, -15, 0], v_hill_mps: [0, 0, 0],
  q_BH: [1, 0, 0, 0], thruster_duty: { J1: 0.6 } };
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal('window', new EventTarget());
  audio.duty.clear(); audio.dispose.mockClear();
  useTelemetryBus.setState({ frame: null, renderState: null });
  useScenarioStore.setState({ phase: 'RUNNING', paused: false, state: null });
});
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllGlobals(); });

it('silences a frozen firing window on mission pause and debrief', () => {
  stop = startFlightAudio('MISSION');
  useTelemetryBus.getState().publishRenderState(firing);
  expect(audio.duty.get('J1')).toBe(0.6);
  useScenarioStore.setState({ paused: true });
  expect(audio.duty.get('J1')).toBe(0);
  // The paused publisher intentionally retains its last truth/render sample.
  useTelemetryBus.getState().publishRenderState({ ...firing });
  expect(audio.duty.get('J1')).toBe(0);
  expect(useTelemetryBus.getState().renderState?.thruster_duty.J1).toBe(0.6);
  useScenarioStore.setState({ paused: false });
  useTelemetryBus.getState().publishRenderState({ ...firing, t_s: 1.1 });
  expect(audio.duty.get('J1')).toBe(0.6);
  useScenarioStore.setState({ phase: 'DEBRIEF' });
  expect(audio.duty.get('J1')).toBe(0);
  useTelemetryBus.getState().publishRenderState({ ...firing, t_s: 1.1 });
  expect(audio.duty.get('J1')).toBe(0);
});

it('keeps briefing silent when voices are first initialized', async () => {
  useScenarioStore.setState({ phase: 'BRIEFING' });
  useTelemetryBus.getState().publishRenderState(firing);
  stop = startFlightAudio('MISSION');
  window.dispatchEvent(new Event('pointerdown'));
  await Promise.resolve();
  expect(audio.duty.get('J1')).toBe(0);
  useTelemetryBus.getState().publishRenderState(firing);
  expect(audio.duty.get('J1')).toBe(0);
});

it('keeps sandbox audio independent of stale mission state and removes subscriptions', () => {
  useScenarioStore.setState({ phase: 'DEBRIEF', paused: true });
  stop = startFlightAudio('SANDBOX');
  useTelemetryBus.getState().publishRenderState(firing);
  expect(audio.duty.get('J1')).toBe(0.6);
  stop(); stop = undefined;
  expect(audio.dispose).toHaveBeenCalledTimes(1);
  useTelemetryBus.getState().publishRenderState({ ...firing, thruster_duty: { J1: 0.2 } });
  expect(audio.duty.get('J1')).toBe(0.6);
});
