import { create } from 'zustand';

export type AppMode = 'SANDBOX' | 'MISSION' | 'ANALYSIS' | 'FLIGHT';

interface AppModeState {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
}

export const useAppModeStore = create<AppModeState>((set) => ({
  mode: typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('mode') === 'flight' ? 'FLIGHT' : 'SANDBOX',
  setMode: (mode) => set({ mode }),
}));
