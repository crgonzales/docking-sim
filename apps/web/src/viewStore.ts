import { create } from 'zustand';
import type { TelemetryFrame } from '@docking/sim-core';
import { DEBUG_MAX_ORBIT, FLIGHT_MAX_ORBIT } from './scene/sky/skyConfig';

export type ViewMode = 'CINEMATIC' | 'CHASE' | 'COCKPIT' | 'DEBUG';

export interface OrbitState {
  azimuth_rad: number;
  elevation_rad: number;
  distance_m: number;
}

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
  /** Mode to restore when the debug camera is toggled off. Never 'DEBUG'. */
  lastFlightMode: ViewMode;
  orbits: Record<ViewMode, OrbitState>;
  pipVisible: boolean;
  pipRect: PipRect | null;
  keybindsOpen: boolean;
  setMode: (mode: ViewMode) => void;
  cycleMode: () => void;
  toggleDebug: () => void;
  orbitBy: (dAzimuth_rad: number, dElevation_rad: number) => void;
  zoomBy: (factor: number) => void;
  toggleKeybinds: () => void;
  setPipVisible: (visible: boolean) => void;
  setPipRect: (rect: PipRect | null) => void;
}

/** 'C' cycles the flight views only; DEBUG is entered/left via its toggle. */
const VIEW_MODES: readonly ViewMode[] = ['CINEMATIC', 'CHASE', 'COCKPIT'];
const ORBIT_LIMITS: Record<ViewMode, { minDistance_m: number; maxDistance_m: number }> = {
  CINEMATIC: { minDistance_m: 40, maxDistance_m: FLIGHT_MAX_ORBIT },
  CHASE: { minDistance_m: 8, maxDistance_m: 400 },
  COCKPIT: { minDistance_m: 0, maxDistance_m: 0 },
  // Diagnostic camera: zoom range spans from hull inspection out past the full
  // Earth disc (planet centre sits ~6771 units away), for verifying cloud
  // altitude, shadow registration, and limb behavior from arbitrary angles.
  DEBUG: { minDistance_m: 2, maxDistance_m: DEBUG_MAX_ORBIT },
};
const INITIAL_ORBITS: Record<ViewMode, OrbitState> = {
  CINEMATIC: { azimuth_rad: 0.52, elevation_rad: 0.42, distance_m: 120 },
  CHASE: { azimuth_rad: 0, elevation_rad: 0.25, distance_m: 25 },
  COCKPIT: { azimuth_rad: 0, elevation_rad: 0, distance_m: 0 },
  DEBUG: { azimuth_rad: 0.52, elevation_rad: 0.15, distance_m: 400 },
};
const MAX_ELEVATION_RAD = 1.4;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export const useViewStore = create<ViewState>((set) => ({
  mode: 'CINEMATIC',
  lastFlightMode: 'CINEMATIC',
  orbits: INITIAL_ORBITS,
  pipVisible: false,
  pipRect: null,
  keybindsOpen: false,
  setMode: (mode) => set({ mode }),
  cycleMode: () => set((state) => ({
    // indexOf('DEBUG') is -1, so cycling from the debug camera lands on
    // CINEMATIC — pressing C is also an exit from DEBUG.
    mode: VIEW_MODES[(VIEW_MODES.indexOf(state.mode) + 1) % VIEW_MODES.length]!,
  })),
  toggleDebug: () => set((state) => (
    state.mode === 'DEBUG'
      ? { mode: state.lastFlightMode }
      : { mode: 'DEBUG', lastFlightMode: state.mode }
  )),
  orbitBy: (dAzimuth_rad, dElevation_rad) => set((state) => {
    if (state.mode === 'COCKPIT') return state;
    const current = state.orbits[state.mode];
    return {
      orbits: {
        ...state.orbits,
        [state.mode]: {
          ...current,
          azimuth_rad: current.azimuth_rad + dAzimuth_rad,
          elevation_rad: clamp(current.elevation_rad + dElevation_rad, -MAX_ELEVATION_RAD, MAX_ELEVATION_RAD),
        },
      },
    };
  }),
  zoomBy: (factor) => set((state) => {
    if (state.mode === 'COCKPIT' || !Number.isFinite(factor) || factor <= 0) return state;
    const current = state.orbits[state.mode];
    const limits = ORBIT_LIMITS[state.mode];
    return {
      orbits: {
        ...state.orbits,
        [state.mode]: {
          ...current,
          distance_m: clamp(current.distance_m * factor, limits.minDistance_m, limits.maxDistance_m),
        },
      },
    };
  }),
  toggleKeybinds: () => set((state) => ({ keybindsOpen: !state.keybindsOpen })),
  setPipVisible: (pipVisible) => set({ pipVisible }),
  setPipRect: (pipRect) => set({ pipRect }),
}));

export function shouldShowPip(frame: TelemetryFrame | null): boolean {
  if (frame === null) return false;
  const range_m = Math.hypot(...frame.nav_r_hill_m);
  return range_m < 50 || frame.control_mode === 'MANUAL';
}
