import { useEffect } from 'react';
import type { AppMode } from '../appModeStore';
import { useScenarioStore } from '../telemetry/scenarioStore';
import { useTelemetryBus } from '../telemetry/bus';
import type { RenderState, TelemetryFrame } from '@docking/sim-core';
import { getAudioContext, getExistingAudioContext, getMasterGain } from './audioContext';
import { connectRcsListener, createRcsAudioBank, type RcsAudioBank } from './rcsAudio';
import { THRUSTER_NOZZLES } from '../scene/thrusterPresentation';

const AMBIENT_GAIN = 0.018;

interface FlightVoices {
  rcs: RcsAudioBank;
  disconnectListener: () => void;
  ambientOscillator: OscillatorNode;
  ambientGain: GainNode;
}

type FlightOutcome = 'DOCKED' | 'COLLISION' | 'PASSIVE_ABORT' | 'WINDOW_MISSED';

function createVoices(audio: AudioContext, output: GainNode, initialState: RenderState | null): FlightVoices {
  const rcs = createRcsAudioBank(audio, output);
  for (const nozzle of THRUSTER_NOZZLES) rcs.setDuty(nozzle.id, initialState?.thruster_duty[nozzle.id] ?? 0);
  const disconnectListener = connectRcsListener(rcs);

  const ambientOscillator = audio.createOscillator();
  const ambientGain = audio.createGain();
  ambientOscillator.type = 'sine';
  ambientOscillator.frequency.value = 58;
  ambientGain.gain.value = AMBIENT_GAIN;
  ambientOscillator.connect(ambientGain).connect(output);
  ambientOscillator.start();

  return { rcs, disconnectListener, ambientOscillator, ambientGain };
}

function playTone(
  audio: AudioContext,
  output: GainNode,
  frequency_Hz: number,
  endFrequency_Hz: number,
  gainValue: number,
  duration_s: number,
  type: OscillatorType = 'sine',
): void {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  const start = audio.currentTime;
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency_Hz, start);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency_Hz), start + duration_s);
  gain.gain.setValueAtTime(gainValue, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration_s);
  oscillator.connect(gain).connect(output);
  oscillator.start(start);
  oscillator.stop(start + duration_s + 0.01);
}

function playContactThump(audio: AudioContext, output: GainNode, collision: boolean): void {
  playTone(audio, output, collision ? 105 : 75, 35, 0.16, 0.22, 'sine');
}

function playOutcomeStinger(audio: AudioContext, output: GainNode, outcome: FlightOutcome): void {
  switch (outcome) {
    case 'DOCKED':
      playTone(audio, output, 440, 880, 0.12, 0.32, 'sine');
      return;
    case 'COLLISION':
      playTone(audio, output, 180, 55, 0.16, 0.38, 'sawtooth');
      return;
    case 'PASSIVE_ABORT':
      playTone(audio, output, 260, 130, 0.1, 0.42, 'triangle');
      return;
    case 'WINDOW_MISSED':
      playTone(audio, output, 520, 260, 0.1, 0.28, 'square');
      return;
  }
}

function stopVoices(voices: FlightVoices | null): void {
  if (voices === null) return;
  voices.disconnectListener();
  voices.rcs.dispose();
  voices.ambientOscillator.stop();
  voices.ambientOscillator.disconnect();
  voices.ambientGain.disconnect();
}

export function startFlightAudio(mode: AppMode): () => void {
  let disposed = false;
  let voices: FlightVoices | null = null;
  let latestRenderState = useTelemetryBus.getState().renderState;
  let previousTelemetryOutcome: TelemetryFrame['outcome'] = useTelemetryBus.getState().frame?.outcome ?? 'NONE';
  let previousScenarioOutcome = useScenarioStore.getState().state?.outcome ?? null;
  const rcsActive = (): boolean => {
    const scenario = useScenarioStore.getState();
    return mode !== 'MISSION' || (scenario.phase === 'RUNNING' && !scenario.paused);
  };

  const ensureVoices = (): void => {
    if (disposed || voices !== null) return;
    const audio = getExistingAudioContext();
    const output = getMasterGain();
    if (audio === null || output === null || audio.state !== 'running') return;
    voices = createVoices(audio, output, rcsActive() ? latestRenderState : null);
  };

  const onUserGesture = (): void => {
    window.removeEventListener('pointerdown', onUserGesture);
    window.removeEventListener('keydown', onUserGesture);
    const audio = getAudioContext();
    if (audio === null) return;
    void audio.resume()
      .then(() => { ensureVoices(); })
      .catch(() => undefined);
  };

  const onRenderState = (renderState: RenderState | null): void => {
    latestRenderState = renderState;
    if (voices !== null) {
      // Paused and finished missions retain the last truth window for drawing.
      // A looping audio voice must not replay that frozen firing indefinitely.
      const audibleState = rcsActive() ? renderState : null;
      for (const nozzle of THRUSTER_NOZZLES) {
        voices.rcs.setDuty(nozzle.id, audibleState?.thruster_duty[nozzle.id] ?? 0);
      }
    }
  };

  const onTelemetry = (frame: TelemetryFrame | null): void => {
    if (frame === null) return;
    if ((frame.outcome === 'DOCKED' || frame.outcome === 'COLLISION')
      && frame.outcome !== previousTelemetryOutcome && voices !== null) {
      const contactOutcome: 'DOCKED' | 'COLLISION' = frame.outcome;
      const audio = getAudioContext();
      const output = getMasterGain();
      if (audio !== null && output !== null && audio.state === 'running') {
        playContactThump(audio, output, contactOutcome === 'COLLISION');
        playOutcomeStinger(audio, output, contactOutcome);
      }
    }
    previousTelemetryOutcome = frame.outcome;
  };

  const onScenarioState = (state: ReturnType<typeof useScenarioStore.getState>['state']): void => {
    onRenderState(latestRenderState);
    const outcome = state?.outcome ?? null;
    const isScenarioStinger = outcome === 'PASSIVE_ABORT' || outcome === 'WINDOW_MISSED';
    if (isScenarioStinger && outcome !== previousScenarioOutcome && voices !== null) {
      const audio = getAudioContext();
      const output = getMasterGain();
      if (audio !== null && output !== null && audio.state === 'running') playOutcomeStinger(audio, output, outcome);
    }
    previousScenarioOutcome = outcome;
  };

  const unsubscribeRender = useTelemetryBus.subscribe((state) => {
    onRenderState(state.renderState);
    onTelemetry(state.frame);
    ensureVoices();
  });
  const unsubscribeScenario = useScenarioStore.subscribe((state) => onScenarioState(state.state));
  window.addEventListener('pointerdown', onUserGesture);
  window.addEventListener('keydown', onUserGesture);

  return () => {
    disposed = true;
    unsubscribeRender();
    unsubscribeScenario();
    window.removeEventListener('pointerdown', onUserGesture);
    window.removeEventListener('keydown', onUserGesture);
    stopVoices(voices);
    voices = null;
  };
}

/** Attach flight audio while SANDBOX or MISSION is mounted. */
export function useFlightAudio(mode: AppMode): void {
  useEffect(() => {
    if (mode !== 'SANDBOX' && mode !== 'MISSION') return undefined;
    return startFlightAudio(mode);
  }, [mode]);
}
