/** Minimal WebAudio panel sounds: switch clicks and the master-alarm tone.
 *  Synthesized (no assets); the AudioContext resumes lazily on the first
 *  user gesture, so pre-interaction alarm starts fail silently by design. */

let ctx: AudioContext | null = null;
let alarmOscillator: OscillatorNode | null = null;
let alarmGain: GainNode | null = null;

function audioContext(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  if (ctx === null) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  return ctx;
}

/** Short filtered blip approximating a mechanical switch click. */
export function playClick(): void {
  const audio = audioContext();
  if (audio === null || audio.state !== 'running') return;
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = 'square';
  oscillator.frequency.value = 2200;
  gain.gain.setValueAtTime(0.08, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.03);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start();
  oscillator.stop(audio.currentTime + 0.035);
}

/** Start/stop the pulsed master-alarm tone. Idempotent per state. */
export function setMasterAlarmTone(active: boolean): void {
  const audio = audioContext();
  if (!active || audio === null || audio.state !== 'running') {
    alarmOscillator?.stop();
    alarmOscillator = null;
    alarmGain = null;
    return;
  }
  if (alarmOscillator !== null) return;
  alarmOscillator = audio.createOscillator();
  alarmGain = audio.createGain();
  alarmOscillator.type = 'square';
  alarmOscillator.frequency.value = 880;
  // 2 Hz on/off pulse via a periodic gain envelope.
  const start = audio.currentTime;
  alarmGain.gain.setValueAtTime(0, start);
  for (let pulse = 0; pulse < 600; pulse += 1) {
    alarmGain.gain.setValueAtTime(0.05, start + pulse * 0.5);
    alarmGain.gain.setValueAtTime(0, start + pulse * 0.5 + 0.25);
  }
  alarmOscillator.connect(alarmGain).connect(audio.destination);
  alarmOscillator.start();
}
