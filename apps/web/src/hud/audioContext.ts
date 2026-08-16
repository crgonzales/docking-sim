/** Shared lazy WebAudio output for panel and flight sounds. */

let context: AudioContext | null = null;
let masterGain: GainNode | null = null;
let masterVolume = 1;
let masterMuted = false;

function applyMasterGain(): void {
  if (masterGain !== null) masterGain.gain.value = masterMuted ? 0 : masterVolume;
}

/** Create/resume the shared context only when a user gesture requests audio. */
export function getAudioContext(): AudioContext | null {
  if (context === null) {
    if (typeof AudioContext === 'undefined') return null;
    context = new AudioContext();
    masterGain = context.createGain();
    applyMasterGain();
    masterGain.connect(context.destination);
  }
  if (context.state === 'suspended') void context.resume().catch(() => undefined);
  return context;
}

/** Return the shared master bus without creating an AudioContext. */
export function getMasterGain(): GainNode | null {
  return masterGain;
}

/** Read the shared context without violating lazy pre-interaction behavior. */
export function getExistingAudioContext(): AudioContext | null {
  return context;
}

export function setMasterVolume(volume: number): void {
  if (!Number.isFinite(volume)) return;
  masterVolume = Math.max(0, Math.min(1, volume));
  applyMasterGain();
}

export function getMasterVolume(): number {
  return masterVolume;
}

export function setMasterMuted(muted: boolean): void {
  masterMuted = muted;
  applyMasterGain();
}

export function getMasterMuted(): boolean {
  return masterMuted;
}
