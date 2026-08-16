import { useEffect } from 'react';
import type { AppMode } from '../appModeStore';
import { useScenarioStore } from '../telemetry/scenarioStore';
import { useTelemetryBus } from '../telemetry/bus';
import type { RenderState, TelemetryFrame } from '@docking/sim-core';
import { getAudioContext, getExistingAudioContext, getMasterGain } from './audioContext';

const RCS_GAIN = 0.18;
const RCS_ONSET_THRESHOLD = 0.01;
const AMBIENT_GAIN = 0.018;

interface FlightVoices {
  rcsSource: AudioBufferSourceNode;
  rcsGain: GainNode;
  ambientOscillator: OscillatorNode;
  ambientGain: GainNode;
}

type FlightOutcome = 'DOCKED' | 'COLLISION' | 'PASSIVE_ABORT' | 'WINDOW_MISSED';

function aggregateDuty(renderState: RenderState | null): number {
  if (renderState === null) return 0;
  let total = 0;
  for (const value of Object.values(renderState.thruster_duty)) total += Math.max(0, value);
  return Math.min(1, total / 4);
}

function createNoiseBuffer(audio: AudioContext): AudioBuffer {
  const buffer = audio.createBuffer(1, Math.floor(audio.sampleRate * 2), audio.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let index = 0; index < samples.length; index += 1) samples[index] = Math.random() * 2 - 1;
  return buffer;
}

function createVoices(audio: AudioContext, output: GainNode, initialDuty: number): FlightVoices {
  const rcsSource = audio.createBufferSource();
  const rcsFilter = audio.createBiquadFilter();
  const rcsGain = audio.createGain();
  rcsSource.buffer = createNoiseBuffer(audio);
  rcsSource.loop = true;
  rcsFilter.type = 'bandpass';
  rcsFilter.frequency.value = 950;
  rcsFilter.Q.value = 0.8;
  rcsGain.gain.value = RCS_GAIN * initialDuty;
  rcsSource.connect(rcsFilter).connect(rcsGain).connect(output);
  rcsSource.start();

  const ambientOscillator = audio.createOscillator();
  const ambientGain = audio.createGain();
  ambientOscillator.type = 'sine';
  ambientOscillator.frequency.value = 58;
  ambientGain.gain.value = AMBIENT_GAIN;
  ambientOscillator.connect(ambientGain).connect(output);
  ambientOscillator.start();

  return { rcsSource, rcsGain, ambientOscillator, ambientGain };
}

function updateRcsGain(voices: FlightVoices, audio: AudioContext, duty: number): void {
  voices.rcsGain.gain.setTargetAtTime(RCS_GAIN * duty, audio.currentTime, 0.035);
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

function playRcsAttack(audio: AudioContext, output: GainNode): void {
  playTone(audio, output, 1200, 500, 0.06, 0.055, 'triangle');
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
  voices.rcsSource.stop();
  voices.rcsSource.disconnect();
  voices.rcsGain.disconnect();
  voices.ambientOscillator.stop();
  voices.ambientOscillator.disconnect();
  voices.ambientGain.disconnect();
}

function startFlightAudio(): () => void {
  let disposed = false;
  let voices: FlightVoices | null = null;
  let latestRenderState = useTelemetryBus.getState().renderState;
  let previousDuty = aggregateDuty(latestRenderState);
  let previousTelemetryOutcome: TelemetryFrame['outcome'] = useTelemetryBus.getState().frame?.outcome ?? 'NONE';
  let previousScenarioOutcome = useScenarioStore.getState().state?.outcome ?? null;

  const ensureVoices = (): void => {
    if (disposed || voices !== null) return;
    const audio = getExistingAudioContext();
    const output = getMasterGain();
    if (audio === null || output === null || audio.state !== 'running') return;
    voices = createVoices(audio, output, aggregateDuty(latestRenderState));
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
    const duty = aggregateDuty(renderState);
    if (voices !== null) {
      const audio = getAudioContext();
      if (audio !== null) {
        updateRcsGain(voices, audio, duty);
        if (duty > RCS_ONSET_THRESHOLD && previousDuty <= RCS_ONSET_THRESHOLD) {
          const output = getMasterGain();
          if (output !== null) playRcsAttack(audio, output);
        }
      }
    }
    previousDuty = duty;
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
    if (mode === 'ANALYSIS') return undefined;
    return startFlightAudio();
  }, [mode]);
}
