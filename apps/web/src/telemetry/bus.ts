import { create } from 'zustand';
import type { ManualCommand, ManualSubMode, ControlMode, RenderState, TelemetryFrame } from '@docking/sim-core';
import type { FswTraceRecord, PendingWindow, PlantTickRecord, PlantWindowRecord } from '@docking/sim-core';

export interface GncStamp {
  runId: string; epoch: number; plantTick: number; plantTime_s: number;
  fswSequence: number | null; samplePlantTick: number | null; sampleTime_s: number | null;
  source: 'LIVE' | 'REPLAY'; configHash: string;
}
export interface GncTick {
  stamp: GncStamp; poseEpoch: number; renderState: RenderState;
  plantTickRecord: PlantTickRecord | null; plantWindow: PlantWindowRecord | null;
  pendingWindow: PendingWindow; frame: TelemetryFrame | null; fswTrace: FswTraceRecord | null;
  previousFsw: FswTraceRecord | null; sampledPlantTick: PlantTickRecord | null;
}
const gncFields = (gnc: GncTick) => ({ gnc, frame: gnc.frame, renderState: gnc.renderState, poseEpoch: gnc.poseEpoch });

/**
 * Telemetry bus: the single seam between the sim side and the UI/scene.
 * Publishers push TelemetryFrames; the scene and HUD subscribe via selectors.
 * Nothing in the UI may reach past this store into sim internals.
 */
export interface TelemetryBusState {
  frame: TelemetryFrame | null;
  renderState: RenderState | null;
  /** Monotonic count of frames published since app start. */
  frameCount: number;
  publish: (frame: TelemetryFrame) => void;
  publishRenderState: (renderState: RenderState) => void;
  gnc: GncTick | null;
  /** Retained after stop so queued callbacks cannot resurrect a retired run. */
  gncEpoch: number;
  poseEpoch: number;
  beginGncRun: (tick: GncTick) => void;
  publishGncTick: (tick: GncTick) => void;
  endGncRun: (epoch: number) => void;
}

export const useTelemetryBus = create<TelemetryBusState>((set) => ({
  frame: null,
  renderState: null,
  frameCount: 0,
  gnc: null, gncEpoch: 0, poseEpoch: 0,
  beginGncRun: (tick) => set(s => tick.stamp.epoch > s.gncEpoch
    ? { ...gncFields(tick), gncEpoch: tick.stamp.epoch } : s),
  publishGncTick: (tick) => set(s => s.gnc !== null && tick.stamp.epoch === s.gncEpoch
    && tick.stamp.runId === s.gnc.stamp.runId && tick.stamp.plantTick >= s.gnc.stamp.plantTick
    ? { ...gncFields(tick), frameCount: s.frameCount + (tick.frame !== s.frame && tick.frame !== null ? 1 : 0) } : s),
  endGncRun: (epoch) => set(s => s.gnc !== null && epoch === s.gncEpoch
    ? { gnc: null, frame: null, renderState: null } : s),
  publish: (frame) =>
    set((s) => ({ frame, frameCount: s.frameCount + 1 })),
  publishRenderState: (renderState) => set({ renderState }),
}));

/** Imperative read for non-React consumers (useFrame loops). */
export function getLatestFrame(): TelemetryFrame | null {
  return useTelemetryBus.getState().frame;
}
