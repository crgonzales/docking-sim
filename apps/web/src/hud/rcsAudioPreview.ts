import { createRcsAudioBank } from './rcsAudio';

/** Uses exactly the live voices in a deterministic offline audio context. */
export async function renderRcsAudioPreview() {
  const audio = new OfflineAudioContext(2, 48000 * 3, 48000);
  const bank = createRcsAudioBank(audio, audio.destination);
  bank.setListener('J1', -0.75, 0); bank.setListener('J2', 0.75, 0);
  bank.setDuty('J1', 1, 0.1); bank.setDuty('J1', 0, 0.35);
  bank.setDuty('J2', 0.35, 0.6); bank.setDuty('J2', 0, 0.8);
  bank.setDuty('J1', 1, 1.1); bank.setDuty('J2', 1, 1.1);
  bank.setDuty('J1', 0, 2); bank.setDuty('J2', 0, 2);
  const buffer = await audio.startRendering(); bank.dispose();
  const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
  const rms = (data: Float32Array, from: number, to: number) => {
    let sum = 0; const a = Math.floor(from * buffer.sampleRate), b = Math.floor(to * buffer.sampleRate);
    for (let i = a; i < b; i++) sum += data[i]! ** 2;
    return Math.sqrt(sum / (b - a));
  };
  let peak = 0, finite = true;
  for (const channel of [left, right]) for (const value of channel) {
    finite &&= Number.isFinite(value); peak = Math.max(peak, Math.abs(value));
  }
  const checks = {
    finite, peak, noClipping: peak < 0.95,
    leftJet: [rms(left, 0.12, 0.3), rms(right, 0.12, 0.3)],
    rightJet: [rms(left, 0.62, 0.78), rms(right, 0.62, 0.78)],
    releaseRms: Math.max(rms(left, 2.4, 2.9), rms(right, 2.4, 2.9)),
  };
  const bytes = new ArrayBuffer(44 + left.length * 4); const view = new DataView(bytes);
  const tag = (offset: number, text: string) => { [...text].forEach((letter, i) => view.setUint8(offset + i, letter.charCodeAt(0))); };
  tag(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * 4, true);
  view.setUint16(32, 4, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, left.length * 4, true);
  for (let i = 0; i < left.length; i++) {
    view.setInt16(44 + i * 4, Math.round(Math.max(-1, Math.min(1, left[i]!)) * 32767), true);
    view.setInt16(46 + i * 4, Math.round(Math.max(-1, Math.min(1, right[i]!)) * 32767), true);
  }
  const dataUrl = await new Promise<string>(resolve => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(new Blob([bytes], { type: 'audio/wav' }));
  });
  return { dataUrl, checks, passed: finite && peak > 0.001 && checks.noClipping
    && checks.leftJet[0]! > checks.leftJet[1]! * 2 && checks.rightJet[1]! > checks.rightJet[0]! * 2
    && checks.releaseRms < 0.00001 };
}
