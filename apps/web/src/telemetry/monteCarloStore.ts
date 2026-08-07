import { FINAL_APPROACH_01, type MonteCarloRunResult } from '@docking/scenario';
import { create } from 'zustand';

export type MonteCarloStatus = 'IDLE' | 'RUNNING' | 'DONE' | 'ERROR';

interface MonteCarloState {
  runCount: number;
  masterSeed: number;
  status: MonteCarloStatus;
  completed: number;
  results: MonteCarloRunResult[];
  errorMessage: string | null;
  start: (runCount: number, masterSeed: number) => void;
  appendResult: (result: MonteCarloRunResult) => void;
  finish: () => void;
  cancel: () => void;
  fail: (message: string) => void;
  reset: () => void;
}

const initialValues = {
  runCount: 100,
  masterSeed: FINAL_APPROACH_01.seed,
  status: 'IDLE' as MonteCarloStatus,
  completed: 0,
  results: [] as MonteCarloRunResult[],
  errorMessage: null as string | null,
};

export const useMonteCarloStore = create<MonteCarloState>((set) => ({
  ...initialValues,
  start: (runCount, masterSeed) => set({
    runCount,
    masterSeed,
    status: 'RUNNING',
    completed: 0,
    results: [],
    errorMessage: null,
  }),
  appendResult: (result) => set((state) => state.status === 'RUNNING'
    ? { results: [...state.results, result], completed: state.completed + 1 }
    : state),
  finish: () => set((state) => state.status === 'RUNNING' ? { status: 'DONE' } : state),
  cancel: () => set({ status: 'IDLE', completed: 0, results: [], errorMessage: null }),
  fail: (message) => set({ status: 'ERROR', errorMessage: message }),
  reset: () => set({ ...initialValues, results: [] }),
}));
