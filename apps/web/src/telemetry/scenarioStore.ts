import { create } from 'zustand';
import type { ScenarioPhase, ScenarioUiState } from '@docking/scenario';

export interface ScenarioStoreState {
  state: ScenarioUiState | null;
  phase: ScenarioPhase;
  publish: (state: ScenarioUiState) => void;
}

export const useScenarioStore = create<ScenarioStoreState>((set) => ({
  state: null,
  phase: 'BRIEFING',
  publish: (state) => set({ state, phase: state.phase }),
}));
