import { create } from 'zustand';
import type { TelemetryFrame } from '@docking/sim-core';

/**
 * Telemetry bus: the single seam between the sim side and the UI/scene.
 * Publishers push TelemetryFrames; the scene and HUD subscribe via selectors.
 * Nothing in the UI may reach past this store into sim internals.
 */
export interface TelemetryBusState {
  frame: TelemetryFrame | null;
  /** Monotonic count of frames published since app start. */
  frameCount: number;
  publish: (frame: TelemetryFrame) => void;
}

export const useTelemetryBus = create<TelemetryBusState>((set) => ({
  frame: null,
  frameCount: 0,
  publish: (frame) =>
    set((s) => ({ frame, frameCount: s.frameCount + 1 })),
}));

/** Imperative read for non-React consumers (useFrame loops). */
export function getLatestFrame(): TelemetryFrame | null {
  return useTelemetryBus.getState().frame;
}
