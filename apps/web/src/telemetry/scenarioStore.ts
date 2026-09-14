import { create } from 'zustand';
import type { ScenarioPhase, ScenarioUiState } from '@docking/scenario';

export interface ScenarioStoreState {
  selectedMission: 'FIRST_DOCKING' | 'EMERGENCY';
  startPoint: 'APPROACH' | 'FINAL';
  paused: boolean;
  precision: boolean;
  approaching: boolean;
  inputEpoch: number;
  state: ScenarioUiState | null;
  phase: ScenarioPhase;
  publish: (state: ScenarioUiState) => void;
}

export const useScenarioStore = create<ScenarioStoreState>((set) => ({
  selectedMission: 'FIRST_DOCKING',
  startPoint: 'APPROACH',
  paused: false,
  precision: true,
  approaching: false,
  inputEpoch: 0,
  state: null,
  phase: 'BRIEFING',
  publish: (state) => set({ state, phase: state.phase }),
}));
