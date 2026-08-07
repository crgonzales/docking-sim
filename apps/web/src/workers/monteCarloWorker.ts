import { FINAL_APPROACH_01, runMonteCarloRun } from '@docking/scenario';

interface MonteCarloWorkerRequest {
  scenario: unknown;
  runIndices: number[];
  masterSeed: number;
}

interface MonteCarloWorkerDone {
  done: true;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<MonteCarloWorkerRequest>) => void) | null;
  postMessage(message: unknown): void;
}

const workerScope = self as unknown as WorkerScope;

workerScope.onmessage = (event: MessageEvent<MonteCarloWorkerRequest>): void => {
  const { runIndices, masterSeed } = event.data;
  for (const globalIndex of runIndices) {
    workerScope.postMessage(runMonteCarloRun(FINAL_APPROACH_01, globalIndex, masterSeed));
  }
  const done: MonteCarloWorkerDone = { done: true };
  workerScope.postMessage(done);
};

export {};
