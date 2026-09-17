import { useAppModeStore } from '../../appModeStore';
import { useTelemetryBus, type GncStamp } from '../../telemetry/bus';
import { getGncSession } from '../../telemetry/gncEmitter';
import { useLabStore } from '../session/labStore';
import { RECORDER_BYTE_LIMIT } from '../session/labRecorder';
import { EXPORT_COLUMNS, EXPORT_COLUMN_COUNT } from '../model/ports';
import { exportRun, importRun, type RunMetadata } from '../session/runExport';
import { readLabContext, sameIdentity } from './labEvidence';

type Identity = Pick<GncStamp, 'source' | 'runId' | 'epoch' | 'configHash'>;
type InputFile = Pick<File, 'name' | 'size' | 'text'>;
type Role = 'json' | 'csv';
export interface FileUrls { create(blob: Blob): string; revoke(url: string): void }
const browserUrls: FileUrls = { create: blob => URL.createObjectURL(blob), revoke: url => URL.revokeObjectURL(url) };
// B7 limits metadata by UTF-16 length, CSV by ASCII characters. Reject oversized files before reading.
export const FILE_BYTE_LIMITS = {
  json: 4 * 1024 * 1024,
  csv: EXPORT_COLUMNS.map(c => c.id).join(',').length + 1
    + Math.floor(RECORDER_BYTE_LIMIT / (EXPORT_COLUMN_COUNT * 8)) * EXPORT_COLUMN_COUNT * 26,
};
export interface RunFileState {
  readonly prepared: { metadata: RunMetadata; jsonUrl: string; csvUrl: string; generation: number } | null;
  readonly imported: RunMetadata | null;
  readonly files: Readonly<Partial<Record<Role, InputFile>>>;
  readonly busy: boolean;
  readonly error: string | null;
}

/** One mounted disclosure owns files/URLs only, never the publisher or simulation. */
export function createRunFileOwner(shown: Identity, urls: FileUrls = browserUrls) {
  const expected = Object.freeze({ source: shown.source, runId: shown.runId, epoch: shown.epoch, configHash: shown.configHash });
  const session = getGncSession();
  let active = false, life = 0, request = 0, generation = 0, reading = false;
  let state: RunFileState = { prepared: null, imported: null, files: {}, busy: false, error: null };
  const listeners = new Set<() => void>();
  const set = (next: RunFileState) => { state = next; listeners.forEach(listener => listener()); };
  const valid = () => {
    if (!active || !session || getGncSession() !== session || useAppModeStore.getState().mode !== 'GNC') return false;
    const current = readLabContext();
    return !!current && expected.source === 'LIVE' && current.stamp.source === 'LIVE'
      && sameIdentity(expected, current.stamp) && ['RUNNING', 'PAUSED', 'COMPLETE'].includes(current.state)
      && sameIdentity(expected, session.snapshot().stamp);
  };
  const release = () => {
    if (state.prepared) { urls.revoke(state.prepared.jsonUrl); urls.revoke(state.prepared.csvUrl); }
    request++; set({ prepared: null, imported: null, files: {}, busy: false, error: null });
  };
  const retire = () => { active = false; life++; release(); };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    connect() {
      active = true; life++;
      const check = () => { if (active && !valid()) retire(); };
      check();
      const bus = useTelemetryBus.subscribe(check), mode = useAppModeStore.subscribe(check);
      return () => { bus(); mode(); retire(); };
    },
    canAct: valid,
    canDownload: (id: number) => valid() && state.prepared?.generation === id,
    clear() { if (valid()) release(); },
    prepare() {
      if (!valid()) return;
      const attemptLife = life, candidate: string[] = [];
      try {
        const artifact = exportRun(session!, useLabStore.getState().playbackRate);
        if (!valid() || attemptLife !== life) return;
        const metadata = JSON.parse(artifact.runJson) as RunMetadata;
        candidate.push(urls.create(new Blob([artifact.runJson], { type: 'application/json;charset=utf-8' })));
        candidate.push(urls.create(new Blob([artifact.signalsCsv], { type: 'text/csv;charset=utf-8' })));
        if (!valid() || attemptLife !== life) { candidate.forEach(url => urls.revoke(url)); return; }
        if (state.prepared) { urls.revoke(state.prepared.jsonUrl); urls.revoke(state.prepared.csvUrl); }
        set({ ...state, prepared: { metadata, jsonUrl: candidate[0], csvUrl: candidate[1], generation: ++generation }, error: null });
      } catch (error) {
        candidate.forEach(url => urls.revoke(url));
        if (valid() && attemptLife === life) set({ ...state, error: String(error) });
      }
    },
    select(role: Role, file?: InputFile) {
      if (!valid()) return;
      request++; set({ ...state, files: { ...state.files, [role]: file }, busy: reading, error: null });
    },
    async load() {
      if (!valid() || reading) return;
      const token = ++request, attemptLife = life, { json, csv } = state.files;
      const current = () => valid() && life === attemptLife && request === token;
      if (!json || !csv || json === csv || json.size > FILE_BYTE_LIMITS.json || csv.size > FILE_BYTE_LIMITS.csv) {
        set({ ...state, error: 'Choose a distinct run.json and signals.csv pair within the recorder file limits.' }); return;
      }
      reading = true; set({ ...state, busy: true, error: null });
      try {
        // Await both failures/successes before releasing the single read slot.
        const results = await Promise.allSettled([json.text(), csv.text()]);
        if (!current()) return;
        if (results[0].status === 'rejected') throw results[0].reason;
        if (results[1].status === 'rejected') throw results[1].reason;
        const { metadata } = importRun({ runJson: results[0].value, signalsCsv: results[1].value });
        if (current()) set({ ...state, imported: metadata, error: null }); // No numeric-column retention or source switch.
      } catch (error) {
        if (current()) set({ ...state, error: String(error) });
      } finally {
        reading = false;
        // Reconnected effects also share this non-abortable read slot. Release
        // only its busy flag; retired results/errors still fail current().
        if (valid() && state.busy) set({ ...state, busy: false });
      }
    },
  };
}
export type RunFileOwner = ReturnType<typeof createRunFileOwner>;
