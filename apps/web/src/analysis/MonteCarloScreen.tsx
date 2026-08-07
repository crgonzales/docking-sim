import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FINAL_APPROACH_01, type MonteCarloRunResult } from '@docking/scenario';
import { Histogram } from './Histogram';
import './analysis.css';
import { useMonteCarloStore } from '../telemetry/monteCarloStore';

type WorkerMessage = MonteCarloRunResult | { done: true };

function isDoneMessage(message: WorkerMessage): message is { done: true } {
  return 'done' in message && message.done === true;
}

const MAX_RUN_COUNT = 2000;
const HISTOGRAM_BINS = 10;

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function format(value: number): string {
  return value.toFixed(2);
}

/** Bin a continuous metric into fixed-width buckets for the bar histogram. */
function binned(values: number[]): { labels: string[]; counts: number[] } {
  if (values.length === 0) return { labels: [], counts: [] };
  const low = Math.min(...values);
  const high = Math.max(...values);
  // A constant-valued metric gets one exact bucket, not ten fictitious ranges.
  if (low === high) return { labels: [low.toFixed(2)], counts: [values.length] };
  const width = (high - low) / HISTOGRAM_BINS;
  const counts = new Array<number>(HISTOGRAM_BINS).fill(0);
  for (const value of values) {
    const bin = Math.min(HISTOGRAM_BINS - 1, Math.floor((value - low) / width));
    counts[bin] += 1;
  }
  const labels = counts.map((_, index) => (low + (index + 0.5) * width).toFixed(1));
  return { labels, counts };
}

export function MonteCarloScreen() {
  const runCount = useMonteCarloStore((state) => state.runCount);
  const masterSeed = useMonteCarloStore((state) => state.masterSeed);
  const status = useMonteCarloStore((state) => state.status);
  const completed = useMonteCarloStore((state) => state.completed);
  const results = useMonteCarloStore((state) => state.results);
  const startRun = useMonteCarloStore((state) => state.start);
  const appendResult = useMonteCarloStore((state) => state.appendResult);
  const finish = useMonteCarloStore((state) => state.finish);
  const cancelRun = useMonteCarloStore((state) => state.cancel);
  const fail = useMonteCarloStore((state) => state.fail);
  const errorMessage = useMonteCarloStore((state) => state.errorMessage);
  const [runCountInput, setRunCountInput] = useState(String(runCount));
  const [seedInput, setSeedInput] = useState(String(masterSeed));
  const workersRef = useRef<Worker[]>([]);
  const runTokenRef = useRef(0);

  const terminateWorkers = useCallback((): void => {
    runTokenRef.current += 1;
    for (const worker of workersRef.current) worker.terminate();
    workersRef.current = [];
  }, []);

  const cancel = useCallback((): void => {
    terminateWorkers();
    cancelRun();
  }, [cancelRun, terminateWorkers]);

  useEffect(() => () => {
    terminateWorkers();
    useMonteCarloStore.getState().cancel();
  }, [terminateWorkers]);

  const start = (): void => {
    terminateWorkers();
    const parsedCount = Math.floor(Number(runCountInput));
    // Every run costs ~360 simulated seconds of MPC solves; an unbounded or
    // non-finite count would freeze the tab before the workers even spawn.
    const requestedCount = Number.isFinite(parsedCount) ? Math.min(Math.max(1, parsedCount), MAX_RUN_COUNT) : 1;
    const parsedSeed = Math.floor(Number(seedInput));
    const requestedSeed = Number.isFinite(parsedSeed) ? parsedSeed : 0;
    setRunCountInput(String(requestedCount));
    setSeedInput(String(requestedSeed));
    startRun(requestedCount, requestedSeed);

    const workerCount = Math.min(navigator.hardwareConcurrency ?? 4, 8);
    const token = runTokenRef.current;
    let finishedWorkers = 0;
    const workers: Worker[] = [];
    try {
      for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
        const runIndices: number[] = [];
        for (let globalIndex = workerIndex; globalIndex < requestedCount; globalIndex += workerCount) {
          runIndices.push(globalIndex);
        }
        const worker = new Worker(new URL('../workers/monteCarloWorker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<WorkerMessage>): void => {
          if (runTokenRef.current !== token) return;
          if (isDoneMessage(event.data)) {
            finishedWorkers += 1;
            worker.terminate();
            if (finishedWorkers === workers.length) {
              workersRef.current = [];
              finish();
            }
            return;
          }
          appendResult(event.data);
        };
        worker.onerror = (event): void => {
          if (runTokenRef.current !== token) return;
          terminateWorkers();
          fail(`Worker failed: ${event.message || 'unknown error'}`);
        };
        workers.push(worker);
        worker.postMessage({ scenario: FINAL_APPROACH_01, runIndices, masterSeed: requestedSeed });
      }
    } catch (error) {
      // workersRef is not assigned yet on this path - terminate the local
      // array explicitly or already-spawned workers leak and keep computing.
      for (const worker of workers) worker.terminate();
      terminateWorkers();
      fail(`Could not start workers: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    workersRef.current = workers;
  };

  const outcomeCounts = useMemo(() => {
    const counts: Record<string, number> = { DOCKED: 0, PASSIVE_ABORT: 0, COLLISION: 0, WINDOW_MISSED: 0 };
    for (const result of results) counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
    return counts;
  }, [results]);
  const gradeCounts = useMemo(() => {
    const counts: Record<string, number> = { A: 0, B: 0, C: 0, F: 0 };
    for (const result of results) counts[result.grade] += 1;
    return counts;
  }, [results]);
  const propValues = results.map((result) => result.prop_consumed_kg);
  const timeValues = results.map((result) => result.time_margin_s);
  const propBins = useMemo(() => binned(propValues), [results]);
  const timeBins = useMemo(
    () => binned(results.filter((result) => result.outcome === 'DOCKED').map((result) => result.time_margin_s)),
    [results],
  );
  const docked = outcomeCounts.DOCKED;
  const minProp = propValues.length === 0 ? 0 : Math.min(...propValues);
  const maxProp = propValues.length === 0 ? 0 : Math.max(...propValues);

  return (
    <main className="analysis-screen">
      <div className="analysis-header">
        <div>
          <p className="analysis-kicker">FLIGHT SOFTWARE / ANALYSIS</p>
          <h1>MONTE CARLO SCENARIO RUNNER</h1>
        </div>
        <span className={`analysis-status status-${status.toLowerCase()}`}>{status}</span>
      </div>
      <div className="analysis-controls">
        <label>RUN COUNT<input type="number" min="1" step="1" value={runCountInput} onChange={(event) => setRunCountInput(event.target.value)} /></label>
        <label>MASTER SEED<input type="number" step="1" value={seedInput} onChange={(event) => setSeedInput(event.target.value)} /></label>
        <button type="button" onClick={start} disabled={status === 'RUNNING'}>START</button>
        <button type="button" onClick={cancel} disabled={status !== 'RUNNING'}>CANCEL</button>
      </div>
      {status === 'RUNNING' && (
        <div className="analysis-progress" aria-live="polite">
          <div className="analysis-progress-bar" style={{ width: `${Math.min(100, (completed / runCount) * 100)}%` }} />
          <span>{completed} / {runCount} COMPLETED</span>
        </div>
      )}
      {status === 'ERROR' && (
        <div className="analysis-error" role="alert">{errorMessage ?? 'Monte Carlo batch failed.'}</div>
      )}
      {status === 'DONE' && (
        <>
          <div className="analysis-summary-grid">
            <div><span>DOCKED</span><strong>{results.length === 0 ? '0.0' : format((docked / results.length) * 100)}%</strong></div>
            <div><span>PROP USED MEAN</span><strong>{format(mean(propValues))} KG</strong></div>
            <div><span>TIME MARGIN MEAN</span><strong>{format(mean(timeValues))} S</strong></div>
          </div>
          <div className="analysis-charts">
            <Histogram title="OUTCOME COUNTS" labels={Object.keys(outcomeCounts)} values={Object.values(outcomeCounts)} />
            <Histogram title="GRADE DISTRIBUTION" labels={Object.keys(gradeCounts)} values={Object.values(gradeCounts)} color="#f2b84b" />
          </div>
          <div className="analysis-charts">
            <Histogram title="PROP CONSUMED (KG)" labels={propBins.labels} values={propBins.counts} color="#4bc0f2" />
            <Histogram title="TIME MARGIN (S, DOCKED RUNS)" labels={timeBins.labels} values={timeBins.counts} color="#9d7bf2" />
          </div>
          <div className="analysis-detail-grid">
            <div><span>PROP MIN</span><strong>{format(minProp)} KG</strong></div>
            <div><span>PROP MAX</span><strong>{format(maxProp)} KG</strong></div>
            {Object.entries(outcomeCounts).map(([outcome, count]) => <div key={outcome}><span>{outcome}</span><strong>{count}</strong></div>)}
            {Object.entries(gradeCounts).map(([grade, count]) => <div key={grade}><span>GRADE {grade}</span><strong>{count}</strong></div>)}
          </div>
        </>
      )}
    </main>
  );
}
