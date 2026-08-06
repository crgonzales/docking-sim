import { FSW_HZ, createSimLoop, type SimConfig, type SimLoop } from '@docking/sim-core';
import { useTelemetryBus } from './bus';

export const SIM_SEED = 20260806;
const SIM_DT_S = 1 / FSW_HZ;
const INITIAL_STATE: [number, number, number, number, number, number] = [0, -250, 12, 0, 0, 0];

export const SIM_CONFIG: SimConfig = {
  initial: {
    r_hill_m: [0, -250, 12],
    v_hill_mps: [0, 0, 0],
    q_BI: [1, 0, 0, 0],
    prop_kg: 24,
  },
  fsw: {
    controller: 'LQR',
    massModel: { dryMass_kg: 976, initialProp_kg: 24 },
    guidanceConfig: { initialState: INITIAL_STATE },
    ekfConfig: {
      initialNavPrior: {
        state: [...INITIAL_STATE],
        covariance: [
          [10_000, 0, 0, 0, 0, 0],
          [0, 10_000, 0, 0, 0, 0],
          [0, 0, 10_000, 0, 0, 0],
          [0, 0, 0, 10, 0, 0],
          [0, 0, 0, 0, 10, 0],
          [0, 0, 0, 0, 0, 10],
        ],
      },
    },
  },
};

let timer: ReturnType<typeof setInterval> | null = null;
let sim: SimLoop | null = null;
let simTime_s = 0;

/** Start the fixed-seed, sim-time-driven telemetry publisher. */
export function startSimEmitter(): void {
  if (timer !== null) return;
  sim = createSimLoop(SIM_CONFIG, SIM_SEED);
  simTime_s = 0;
  timer = setInterval(() => {
    simTime_s += SIM_DT_S;
    const frames = sim?.stepTo(simTime_s) ?? [];
    frames.forEach((frame) => useTelemetryBus.getState().publish(frame));
  }, 1000 / FSW_HZ);
}

/** Stop the publisher and reset its loop on the next start. */
export function stopSimEmitter(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  sim = null;
}
