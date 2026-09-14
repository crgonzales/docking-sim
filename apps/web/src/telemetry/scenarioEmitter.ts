import {
  FSW_HZ,
  createSimLoop,
  MANUAL_AUTHORITY_PRESETS,
  type ControlMode,
  type ManualCommand,
  type ManualAuthority,
  type ManualSubMode,
  type NavSource,
  type SimLoop,
} from '@docking/sim-core';
import {
  createScenarioDirector,
  FINAL_APPROACH_01,
  createFirstDockingScenario,
  createFirstDockingConfig,
  scenarioToSimConfig,
  type PlayerAction,
  type ScenarioDirector,
} from '@docking/scenario';
import { useTelemetryBus } from './bus';
import { useScenarioStore } from './scenarioStore';
import { useViewStore } from '../viewStore';

const ZERO: ManualCommand = { translation: [0, 0, 0], rotation: [0, 0, 0] };
let keyboardCommand: ManualCommand = ZERO;
let padCommand: ManualCommand = ZERO;
let keyboardTap: ManualCommand = ZERO;
let padTap: ManualCommand = ZERO;
let padTapTicks = 0;
const hasInput = (c: ManualCommand) => [...c.translation, ...c.rotation].some(v => v !== 0);

export function getSelectedScenario() {
  const { selectedMission, startPoint } = useScenarioStore.getState();
  return selectedMission === 'FIRST_DOCKING' ? createFirstDockingScenario(startPoint) : FINAL_APPROACH_01;
}

function running(): boolean {
  return director?.getState().phase === 'RUNNING' && !useScenarioStore.getState().paused;
}

function clearInput(): void {
  keyboardCommand = padCommand = keyboardTap = padTap = ZERO;
  padTapTicks = 0;
  sim?.setManualCommand(ZERO);
  useScenarioStore.setState(state => ({ inputEpoch: state.inputEpoch + 1, approaching: false }));
}

function resetCamera(): void {
  useViewStore.getState().setMode('CINEMATIC');
  useViewStore.setState(state => ({
    keybindsOpen: false,
    orbits: { ...state.orbits, CINEMATIC: { azimuth_rad: 0.55, elevation_rad: 0.28,
      distance_m: useScenarioStore.getState().selectedMission === 'FIRST_DOCKING' ? 28 : 120 } },
  }));
}

function onFocusLost(): void { pauseScenario(); }
function onVisibilityChanged(): void { if (document.hidden) pauseScenario(); }


let timer: ReturnType<typeof setInterval> | null = null;
let sim: SimLoop | null = null;
let director: ScenarioDirector | null = null;
let simTick = 0;

function publishState(): void {
  if (director === null || sim === null) return;
  const state = director.getState();
  useScenarioStore.getState().publish(state);
  if (state.telemetry !== null) useTelemetryBus.getState().publish(state.telemetry);
  else useTelemetryBus.setState({ frame: null });
  useTelemetryBus.getState().publishRenderState(sim.getRenderState());
}

function createRuntime(): void {
  const scenario = getSelectedScenario();
  sim = createSimLoop(useScenarioStore.getState().selectedMission === 'FIRST_DOCKING'
    ? createFirstDockingConfig(scenario) : scenarioToSimConfig(scenario.initial), scenario.seed);
  director = createScenarioDirector(scenario, sim);
  simTick = 0;
  useTelemetryBus.setState({ frame: null, renderState: null });
  useScenarioStore.setState({ paused: false, precision: true });
  clearInput();
  resetCamera();
  publishState();
}

function startTimer(): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    if (director === null || sim === null) return;
    if (!running()) {
      useTelemetryBus.getState().publishRenderState(sim.getRenderState());
      return;
    }
    if (useScenarioStore.getState().selectedMission === 'FIRST_DOCKING') {
      const precision = useScenarioStore.getState().precision;
      const speed = precision ? 0.07 : 0.25;
      const maxSpeed = MANUAL_AUTHORITY_PRESETS.LOW.maxVelocity_mps as number;
      const keyboard = hasInput(keyboardCommand) ? keyboardCommand : keyboardTap;
      const pad = hasInput(padCommand) ? padCommand : padTapTicks > 0 ? padTap : ZERO;
      const combine = (key: 'translation' | 'rotation', scale: number) =>
        keyboard[key].map((v, i) => Math.max(-1, Math.min(1, v + pad[key][i]!)) * scale) as [number, number, number];
      const translation = combine('translation', speed / maxSpeed);
      if (useScenarioStore.getState().approaching) translation[1] = speed / maxSpeed;
      sim.setManualCommand({ translation, rotation: combine('rotation', 0.3) });
      keyboardTap = ZERO;
      padTapTicks = Math.max(0, padTapTicks - 1);
    }
    const state = director.tick(++simTick / FSW_HZ);
    if (state.phase === 'DEBRIEF') clearInput();
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
  if (typeof window !== 'undefined') {
    window.addEventListener('blur', onFocusLost);
    document.addEventListener('visibilitychange', onVisibilityChanged);
  }
}

/** Launch the current scenario; the clock advances on subsequent intervals. */
export function launchScenario(): void {
  if (director === null) startScenario();
  clearInput();
  resetCamera();
  director?.launch();
  publishState();
}

/** Stop publishing and discard the current scenario runtime. */
export function stopScenario(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  clearInput();
  sim = null;
  director = null;
  simTick = 0;
  if (typeof window !== 'undefined') {
    window.removeEventListener('blur', onFocusLost);
    document.removeEventListener('visibilitychange', onVisibilityChanged);
  }
  useTelemetryBus.setState({ frame: null, renderState: null });
  useScenarioStore.setState({ state: null, phase: 'BRIEFING', paused: false });
}

/** Recreate the same seeded scenario and begin it immediately in RUNNING. */
export function retryScenario(startPoint: 'APPROACH' | 'FINAL' = 'APPROACH'): void {
  stopScenario();
  useScenarioStore.setState({ startPoint });
  startScenario();
  launchScenario();
}

export function selectMission(selectedMission: 'FIRST_DOCKING' | 'EMERGENCY'): void {
  stopScenario();
  useScenarioStore.setState({ selectedMission, startPoint: 'APPROACH' });
  startScenario();
}

export function pauseScenario(): void {
  if (!running()) return;
  useScenarioStore.setState({ paused: true });
  clearInput();
}

export function resumeScenario(): void {
  clearInput();
  useScenarioStore.setState({ paused: false });
}

export function toggleScenarioPause(): void {
  if (useScenarioStore.getState().paused) resumeScenario(); else pauseScenario();
}

export function togglePrecision(): void {
  if (!running()) return;
  clearInput();
  useScenarioStore.setState(state => ({ precision: !state.precision }));
}

export function holdPosition(): void {
  if (!running()) return;
  clearInput();
  sim?.holdManualPosition();
}

export function toggleApproach(): void {
  if (!running()) return;
  const approaching = !useScenarioStore.getState().approaching;
  clearInput();
  useScenarioStore.setState({ approaching });
}

export function setLessonPadCommand(command: ManualCommand): void {
  if (!running()) return;
  padCommand = command;
  if (hasInput(command)) { padTap = command; padTapTicks = 3; }
  if (command.translation[1] !== 0) useScenarioStore.setState({ approaching: false });
}

// Control-mode, nav-source, and isolation changes are PlayerActions: they
// must go through the director so ACTION-gated beats can latch their clears.
// Keyboard input and the switch panel both land here.
export function setControlMode(mode: ControlMode): void {
  dispatchPlayerAction({ kind: 'SET_CONTROL_MODE', to: mode });
}

export function setManualSubMode(mode: ManualSubMode): void {
  if (running() && useScenarioStore.getState().selectedMission === 'EMERGENCY') sim?.setManualSubMode(mode);
}

export function setManualCommand(command: ManualCommand): void {
  if (!running()) return;
  if (useScenarioStore.getState().selectedMission === 'FIRST_DOCKING') {
    keyboardCommand = command;
    if (hasInput(command)) keyboardTap = command;
    if (command.translation[1] !== 0) useScenarioStore.setState({ approaching: false });
  }
  else sim?.setManualCommand(command);
}

export function setManualAuthority(level: ManualAuthority): void {
  if (running() && useScenarioStore.getState().selectedMission === 'EMERGENCY') sim?.setManualAuthority(level);
}

export function commandAbort(): void {
  if (running()) sim?.commandAbort();
}

export function setNavSource(source: NavSource): void {
  dispatchPlayerAction({ kind: 'SET_NAV_SOURCE', to: source });
}

export function isolateThruster(id: string): void {
  dispatchPlayerAction({ kind: 'ISOLATE_THRUSTER', thruster_id: id });
}

export function dispatchPlayerAction(action: PlayerAction): void {
  if (running() && useScenarioStore.getState().selectedMission === 'EMERGENCY') director?.dispatchPlayerAction(action);
}

export function cycleController(): void {
  const controllers = ['PID', 'LQR', 'MPC'] as const;
  const current = useScenarioStore.getState().state?.telemetry?.controller ?? FINAL_APPROACH_01.initial.controller;
  const next = controllers[(controllers.indexOf(current) + 1) % controllers.length]!;
  dispatchPlayerAction({ kind: 'SET_CONTROLLER', to: next });
}
