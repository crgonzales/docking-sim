import {
  FSW_HZ,
  createSimLoop,
  type ControlMode,
  type ManualCommand,
  type ManualSubMode,
  type NavSource,
  type SimLoop,
} from '@docking/sim-core';
import {
  createScenarioDirector,
  FINAL_APPROACH_01,
  scenarioToSimConfig,
  type PlayerAction,
  type ScenarioDirector,
} from '@docking/scenario';
import { useTelemetryBus } from './bus';
import { useScenarioStore } from './scenarioStore';

const SCENARIO_DT_S = 1 / FSW_HZ;

let timer: ReturnType<typeof setInterval> | null = null;
let sim: SimLoop | null = null;
let director: ScenarioDirector | null = null;
let simTime_s = 0;

function publishState(): void {
  if (director === null || sim === null) return;
  const state = director.getState();
  useScenarioStore.getState().publish(state);
  if (state.telemetry !== null) useTelemetryBus.getState().publish(state.telemetry);
  useTelemetryBus.getState().publishRenderState(sim.getRenderState());
}

function createRuntime(): void {
  sim = createScenarioSim();
  director = createScenarioDirector(FINAL_APPROACH_01, sim);
  simTime_s = 0;
  publishState();
}

function createScenarioSim(): SimLoop {
  return createSimLoop(scenarioToSimConfig(FINAL_APPROACH_01.initial), FINAL_APPROACH_01.seed);
}

function startTimer(): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    if (director === null || sim === null) return;
    if (director.getState().phase !== 'RUNNING') {
      useTelemetryBus.getState().publishRenderState(sim.getRenderState());
      return;
    }
    simTime_s += SCENARIO_DT_S;
    const state = director.tick(simTime_s);
    if (state.telemetry !== null) useTelemetryBus.getState().publish(state.telemetry);
    useScenarioStore.getState().publish(state);
    useTelemetryBus.getState().publishRenderState(sim.getRenderState());
  }, 1000 / FSW_HZ);
}

/** Start the scenario publisher in its launch-gated BRIEFING phase. */
export function startScenario(): void {
  if (timer !== null) return;
  createRuntime();
  startTimer();
}

/** Launch the current scenario; the clock advances on subsequent intervals. */
export function launchScenario(): void {
  if (director === null) startScenario();
  director?.launch();
  publishState();
}

/** Stop publishing and discard the current scenario runtime. */
export function stopScenario(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  sim = null;
  director = null;
  simTime_s = 0;
}

/** Recreate the same seeded scenario and begin it immediately in RUNNING. */
export function retryScenario(): void {
  stopScenario();
  startScenario();
  launchScenario();
}

// Control-mode, nav-source, and isolation changes are PlayerActions: they
// must go through the director so ACTION-gated beats can latch their clears.
// Keyboard input and the switch panel both land here.
export function setControlMode(mode: ControlMode): void {
  dispatchPlayerAction({ kind: 'SET_CONTROL_MODE', to: mode });
}

export function setManualSubMode(mode: ManualSubMode): void {
  sim?.setManualSubMode(mode);
}

export function setManualCommand(command: ManualCommand): void {
  sim?.setManualCommand(command);
}

export function commandAbort(): void {
  sim?.commandAbort();
}

export function setNavSource(source: NavSource): void {
  dispatchPlayerAction({ kind: 'SET_NAV_SOURCE', to: source });
}

export function isolateThruster(id: string): void {
  dispatchPlayerAction({ kind: 'ISOLATE_THRUSTER', thruster_id: id });
}

export function dispatchPlayerAction(action: PlayerAction): void {
  director?.dispatchPlayerAction(action);
}

export function cycleController(): void {
  const controllers = ['PID', 'LQR', 'MPC'] as const;
  const current = useScenarioStore.getState().state?.telemetry?.controller ?? FINAL_APPROACH_01.initial.controller;
  const next = controllers[(controllers.indexOf(current) + 1) % controllers.length]!;
  dispatchPlayerAction({ kind: 'SET_CONTROLLER', to: next });
}
