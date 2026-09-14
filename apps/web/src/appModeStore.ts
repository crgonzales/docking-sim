import { create } from 'zustand';

export type AppMode = 'SANDBOX' | 'MISSION' | 'ANALYSIS' | 'FLIGHT';

interface AppModeState {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
}

function initialMode(): AppMode {
  const mode = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('mode') : null;
  return mode === 'flight' ? 'FLIGHT' : mode === 'mission' ? 'MISSION' : 'SANDBOX';
}

export const useAppModeStore = create<AppModeState>((set) => ({
  mode: initialMode(),
  setMode: (mode) => set({ mode }),
}));
