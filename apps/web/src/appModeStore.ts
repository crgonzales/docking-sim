import { create } from 'zustand';

export type AppMode = 'SANDBOX' | 'MISSION' | 'ANALYSIS' | 'FLIGHT';

interface AppModeState {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
}

/**
 * Ordinary entry opens the guided MISSION (first-docking briefing); the
 * autopilot SANDBOX, ANALYSIS and FLIGHT are explicit `?mode=` selections.
 * Missing, empty and unknown values resolve to the default.
 */
export function resolveAppMode(value: string | null | undefined): AppMode {
  switch (value) {
    case 'sandbox': return 'SANDBOX';
    case 'analysis': return 'ANALYSIS';
    case 'flight': return 'FLIGHT';
    default: return 'MISSION';
  }
}

function initialMode(): AppMode {
  return resolveAppMode(typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('mode') : null);
}

export const useAppModeStore = create<AppModeState>((set) => ({
  mode: initialMode(),
  setMode: (mode) => set({ mode }),
}));
