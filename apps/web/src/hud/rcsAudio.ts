import { boundedThrusterDuty, THRUSTER_NOZZLES } from '../scene/thrusterPresentation';

export interface RcsAudioBank {
  setDuty: (id: string, duty: number, at?: number) => void;
  setListener: (id: string, pan: number, distanceM: number) => void;
  dispose: () => void;
}
let activeBank: RcsAudioBank | null = null;
export function connectRcsListener(bank: RcsAudioBank): () => void {
  activeBank = bank;
  return () => { if (activeBank === bank) activeBank = null; };
}
/** Screen-relative direction comes from the same rendered nozzle transform. */
export function updateRcsListener(id: string, pan: number, distanceM: number): void {
  activeBank?.setListener(id, pan, distanceM);
}

function createNoise(audio: BaseAudioContext): AudioBuffer {
  const buffer = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
  const channel = buffer.getChannelData(0);
  let seed = 0x71cc5a31;
  for (let i = 0; i < channel.length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    channel[i] = (seed >>> 0) / 2147483648 - 1;
  }
  return buffer;
}

/** Designed valve/structure feedback, including the external camera mix.
 * It is not a recording of sound propagating through vacuum. One bounded pool
 * owns sixteen independently gated jets; no audio nodes are created per firing.
 */
export function createRcsAudioBank(audio: BaseAudioContext, output: AudioNode): RcsAudioBank {
  const noise = createNoise(audio);
  let disposed = false;
  const voices = new Map(THRUSTER_NOZZLES.map((nozzle, index) => {
    const source = audio.createBufferSource();
    source.buffer = noise; source.loop = true;
    const hiss = audio.createBiquadFilter();
    hiss.type = 'bandpass'; hiss.frequency.value = 1100 + index % 4 * 85; hiss.Q.value = 0.55;
    const body = audio.createBiquadFilter();
    body.type = 'lowpass'; body.frequency.value = 260 + index % 4 * 17; body.Q.value = 1.1;
    const bodyMix = audio.createGain(); bodyMix.gain.value = 0.45;
    const valve = audio.createBiquadFilter();
    valve.type = 'bandpass'; valve.frequency.value = 1900 + index % 4 * 160; valve.Q.value = 1.6;
    const gasGain = audio.createGain(); gasGain.gain.value = 0;
    const valveGain = audio.createGain(); valveGain.gain.value = 0;
    const spatialGain = audio.createGain(); spatialGain.gain.value = 1;
    const panner = audio.createStereoPanner();
    source.connect(hiss).connect(gasGain);
    source.connect(body).connect(bodyMix).connect(gasGain);
    source.connect(valve).connect(valveGain);
    gasGain.connect(spatialGain); valveGain.connect(spatialGain);
    spatialGain.connect(panner).connect(output);
    source.start(0, index * 0.107);
    const voice = { source, hiss, body, bodyMix, valve, gasGain, valveGain,
      spatialGain, panner, duty: 0, pan: NaN, distanceGain: NaN };
    return [nozzle.id, voice] as const;
  }));
  return {
    setDuty(id, inputDuty, at = audio.currentTime) {
      const voice = voices.get(id);
      if (!voice || disposed) return;
      const duty = boundedThrusterDuty(inputDuty);
      if (duty === voice.duty) return;
      // Duty is truth-side integrated on-time. Amplitude follows sqrt(power),
      // keeping short pulses readable without inventing an additional firing.
      voice.gasGain.gain.cancelScheduledValues(at);
      voice.gasGain.gain.setTargetAtTime(0.045 * Math.sqrt(duty), at, duty > voice.duty ? 0.006 : 0.022);
      const opening = duty > 0 && voice.duty === 0;
      const closing = duty === 0 && voice.duty > 0;
      if (opening || closing) {
        const gain = voice.valveGain.gain;
        gain.cancelScheduledValues(at);
        gain.setValueAtTime(0, at);
        gain.linearRampToValueAtTime(opening ? 0.095 : 0.045, at + 0.002);
        gain.exponentialRampToValueAtTime(0.00001, at + (opening ? 0.043 : 0.025));
        gain.setValueAtTime(0, at + 0.05);
      }
      voice.duty = duty;
    },
    setListener(id, pan, distanceM) {
      const voice = voices.get(id);
      if (!voice || disposed || !Number.isFinite(pan) || !Number.isFinite(distanceM)) return;
      const value = Math.max(-0.85, Math.min(0.85, pan));
      const gain = 1 / (1 + (Math.max(0, distanceM) / 45) ** 2);
      if (!Number.isFinite(voice.pan) || Math.abs(value - voice.pan) > 0.015) {
        voice.panner.pan.cancelScheduledValues(audio.currentTime);
        voice.panner.pan.setTargetAtTime(value, audio.currentTime, 0.035); voice.pan = value;
      }
      if (!Number.isFinite(voice.distanceGain) || Math.abs(gain - voice.distanceGain) > 0.01) {
        voice.spatialGain.gain.cancelScheduledValues(audio.currentTime);
        voice.spatialGain.gain.setTargetAtTime(gain, audio.currentTime, 0.05); voice.distanceGain = gain;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const voice of voices.values()) {
        voice.source.stop();
        for (const node of [voice.source, voice.hiss, voice.body, voice.bodyMix, voice.valve,
          voice.gasGain, voice.valveGain, voice.spatialGain, voice.panner]) node.disconnect();
      }
      voices.clear();
    },
  };
}
