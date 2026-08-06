import { create } from 'zustand';
import type { ManualCommand, ManualSubMode, ControlMode, RenderState, TelemetryFrame } from '@docking/sim-core';

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
}

export const useTelemetryBus = create<TelemetryBusState>((set) => ({
  frame: null,
  renderState: null,
  frameCount: 0,
  publish: (frame) =>
    set((s) => ({ frame, frameCount: s.frameCount + 1 })),
  publishRenderState: (renderState) => set({ renderState }),
}));

/** Imperative read for non-React consumers (useFrame loops). */
export function getLatestFrame(): TelemetryFrame | null {
  return useTelemetryBus.getState().frame;
}
