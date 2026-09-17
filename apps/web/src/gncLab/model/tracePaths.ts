import type { FswTraceRecord, PendingWindow, PlantTickRecord, PlantWindowRecord } from '@docking/sim-core';

export interface TraceRecords {
  fsw: FswTraceRecord | null;
  /** Retain the preceding FSW sample for the explicitly delayed command edge. */
  previousFsw: FswTraceRecord | null;
  plantTick: PlantTickRecord | null;
  /** Actual plant record at fsw.samplePlantTick, retained at the sensor boundary. */
  sampledPlantTick: PlantTickRecord | null;
  plantWindow: PlantWindowRecord | null;
  pendingWindow: PendingWindow;
}
export type TracePath = `${keyof TraceRecords}.${string}`;
/** Exactly the seven provenance classes in the approved plan; delivery means integrated windows. */
export type ProvenanceClass = 'MEASUREMENT' | 'ESTIMATE' | 'REFERENCE' | 'COMMAND' | 'ALLOCATED' | 'DELIVERED' | 'TRUTH';

export function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value;
}

/** Own fields only; null means an unavailable sample, undefined means a bad binding. */
export function readField(value: unknown, path: string): unknown {
  for (const key of path.split('.')) {
    if (value === null) return null;
    if (typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
export function resolveTracePath(records: TraceRecords, path: TracePath): unknown {
  return readField(records, path);
}

/** Source policy follows actual trace fields, including FSW locals outside nav/command. */
export function traceProvenance(path: TracePath): ProvenanceClass | null {
  const [root, field, child] = path.split('.');
  if (root === 'plantWindow' || root === 'pendingWindow') return 'DELIVERED';
  if (root === 'plantTick' || root === 'sampledPlantTick') return field === 'truth' ? 'TRUTH' : null;
  if (root !== 'fsw' && root !== 'previousFsw') return null;
  if (field === 'sensor') return 'MEASUREMENT';
  if (['nav', 'mekf', 'q_BH', 'omega_est_body_rps', 'propEstimate_kg', 'corridor'].includes(field)) return 'ESTIMATE';
  if (field === 'guidance' || (field === 'abort' && child === 'targetVelocity_hill_mps')
    || (field === 'manual' && child === 'rateReference')) return 'REFERENCE';
  if (field === 'allocation') return 'ALLOCATED';
  if (['command', 'manual', 'mode', 'abort', 'feedforward_specificForce_hill_mps2'].includes(field)) return 'COMMAND';
  if (field === 'mpc') return 'COMMAND';
  return null;
}
