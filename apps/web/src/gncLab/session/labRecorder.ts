import { createTraceRing, type PlantTickRecord } from '@docking/sim-core';
import { EXPORT_COLUMNS, EXPORT_COLUMN_COUNT } from '../model/ports';
import { readField, resolveTracePath, type TraceRecords } from '../model/tracePaths';
import { TRUTH_TICKS_PER_FSW_WINDOW } from './demoRun';

/** Numeric payload ceiling; raw detail is separately bounded to 200 ticks. */
export const RECORDER_BYTE_LIMIT = 32 * 1024 * 1024;
export const RAW_TICK_CAPACITY = 200;
export interface RecorderCapacity { rows: number; columns: number; bytes: number }
export function recorderCapacity(maxTicks: number): RecorderCapacity {
  if (!Number.isSafeInteger(maxTicks) || maxTicks <= 0) throw new RangeError('maxTicks must be a positive safe integer');
  const rows = Math.floor(maxTicks / TRUTH_TICKS_PER_FSW_WINDOW) + 1;
  const bytes = rows * EXPORT_COLUMN_COUNT * Float64Array.BYTES_PER_ELEMENT;
  if (bytes > RECORDER_BYTE_LIMIT) throw new RangeError(`Recorder requires ${bytes} bytes; limit is ${RECORDER_BYTE_LIMIT}`);
  return { rows, columns: EXPORT_COLUMN_COUNT, bytes };
}

export interface LabRecorder {
  readonly capacity: RecorderCapacity;
  readonly length: number;
  readonly rawLength: number;
  append(records: TraceRecords): void;
  pushRaw(record: PlantTickRecord): void;
  rawTicks(): readonly PlantTickRecord[];
  /** Copies populated values only; callers cannot corrupt retained evidence. */
  column(id: string): Float64Array;
  dispose(): void;
}

export function createLabRecorder(maxTicks: number): LabRecorder {
  const capacity = Object.freeze(recorderCapacity(maxTicks));
  let columns = EXPORT_COLUMNS.map(() => new Float64Array(capacity.rows));
  const raw = createTraceRing<PlantTickRecord>(RAW_TICK_CAPACITY);
  let length = 0, lastTick = 0, disposed = false;
  const active = () => { if (disposed) throw new Error('Recorder is disposed'); };
  return {
    capacity,
    get length() { return length; },
    get rawLength() { return raw.size; },
    append(records) {
      active();
      const { fsw, plantWindow: window, plantTick } = records;
      if (!fsw || !window || !plantTick || window.slicesIntegrated !== TRUTH_TICKS_PER_FSW_WINDOW
        || window.bounds_tick[1] !== fsw.samplePlantTick || plantTick.plantTick !== fsw.samplePlantTick
        || fsw.samplePlantTick !== lastTick + TRUTH_TICKS_PER_FSW_WINDOW
        || fsw.samplePlantTick > maxTicks || window.bounds_tick[0] !== lastTick
        || window.windowIndex !== length + 1 || fsw.fswSequence !== window.windowIndex
        || window.sourceSamplePlantTick !== (lastTick === 0 ? null : lastTick)
        || window.sourceFswSequence !== (fsw.fswSequence === 1 ? null : fsw.fswSequence - 1)) {
        throw new Error('Recorder needs consecutive completed windows paired with their boundary FSW sample and truth');
      }
      if (length === capacity.rows) throw new RangeError('Recorder capacity exhausted');
      // Validate the entire row before changing the retained series.
      const row = EXPORT_COLUMNS.map(column => {
        const base = resolveTracePath(records, column.trace);
        const value = column.component === undefined || base === null ? base : readField(base, column.component);
        if (value === null) return NaN;
        if (column.dataType === 'boolean' && typeof value === 'boolean') return Number(value);
        if (column.dataType === 'enum' && typeof value === 'string') {
          const index = column.enumValues!.indexOf(value);
          if (index >= 0) return index;
        }
        if ((column.dataType === 'double' || column.dataType === 'quaternion') && typeof value === 'number' && Number.isFinite(value)) return value;
        throw new Error(`Invalid recorded value for ${column.id}`);
      });
      row.forEach((value, index) => { columns[index][length] = value; });
      length += 1; lastTick = fsw.samplePlantTick;
    },
    pushRaw(record) { active(); raw.push(record); },
    rawTicks() { return structuredClone(raw.toArray()); },
    column(id) {
      active();
      const index = EXPORT_COLUMNS.findIndex(column => column.id === id);
      if (index < 0) throw new Error(`Unknown export column ${id}`);
      return columns[index].slice(0, length);
    },
    dispose() { disposed = true; columns = []; raw.clear(); length = 0; },
  };
}
