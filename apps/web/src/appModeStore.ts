import { create } from 'zustand';

export type AppMode = 'SANDBOX' | 'MISSION' | 'ANALYSIS';

interface AppModeState {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
}

export const useAppModeStore = create<AppModeState>((set) => ({
  mode: 'SANDBOX',
  setMode: (mode) => set({ mode }),
}));
