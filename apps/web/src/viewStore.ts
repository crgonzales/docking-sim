import { create } from 'zustand';
import type { TelemetryFrame } from '@docking/sim-core';

export type ViewMode = 'CINEMATIC' | 'CHASE' | 'COCKPIT';

/** Measured CSS-pixel rectangle of the PiP overlay, relative to the canvas
 *  (x from left, y from BOTTOM — WebGL viewport convention). */
export interface PipRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ViewState {
  mode: ViewMode;
  pipVisible: boolean;
  pipRect: PipRect | null;
  setMode: (mode: ViewMode) => void;
  cycleMode: () => void;
  setPipVisible: (visible: boolean) => void;
  setPipRect: (rect: PipRect | null) => void;
}

const VIEW_MODES: readonly ViewMode[] = ['CINEMATIC', 'CHASE', 'COCKPIT'];

export const useViewStore = create<ViewState>((set) => ({
  mode: 'CINEMATIC',
  pipVisible: false,
  pipRect: null,
  setMode: (mode) => set({ mode }),
  cycleMode: () => set((state) => ({
    mode: VIEW_MODES[(VIEW_MODES.indexOf(state.mode) + 1) % VIEW_MODES.length]!,
  })),
  setPipVisible: (pipVisible) => set({ pipVisible }),
  setPipRect: (pipRect) => set({ pipRect }),
}));

export function shouldShowPip(frame: TelemetryFrame | null): boolean {
  if (frame === null) return false;
  const range_m = Math.hypot(...frame.nav_r_hill_m);
  return range_m < 50 || frame.control_mode === 'MANUAL';
}
