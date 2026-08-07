import { FSW_HZ, type ManualCommand } from '@docking/sim-core';
import { getLatestFrame } from '../telemetry/bus';
import { useAppModeStore } from '../appModeStore';
import {
  commandAbort,
  cycleController,
  setControlMode,
  setManualCommand,
  setManualSubMode,
} from '../telemetry/simEmitter';
import {
  commandAbort as scenarioCommandAbort,
  cycleController as scenarioCycleController,
  setControlMode as scenarioSetControlMode,
  setManualCommand as scenarioSetManualCommand,
  setManualSubMode as scenarioSetManualSubMode,
} from '../telemetry/scenarioEmitter';
import { bindingForCode, bindingForKey, codesFor } from './bindings';
import { useViewStore } from '../viewStore';

const ZERO_COMMAND: ManualCommand = {
  translation: [0, 0, 0],
  rotation: [0, 0, 0],
};
const ORBIT_SENSITIVITY_RAD_PX = 0.005;
const ZOOM_STEP = 1.1;
const TICK_MS = 1000 / FSW_HZ;

function held(pressed: Set<string>, id: string): boolean {
  return codesFor(id).some((code) => pressed.has(code));
}

function zeroCommand(): void {
  if (useAppModeStore.getState().mode === 'MISSION') scenarioSetManualCommand(ZERO_COMMAND);
  else setManualCommand(ZERO_COMMAND);
}

function forwardControlMode(mode: 'AUTO' | 'MANUAL'): void {
  if (useAppModeStore.getState().mode === 'MISSION') scenarioSetControlMode(mode);
  else setControlMode(mode);
}

function forwardManualSubMode(mode: 'RATE' | 'PULSE'): void {
  if (useAppModeStore.getState().mode === 'MISSION') scenarioSetManualSubMode(mode);
  else setManualSubMode(mode);
}

function forwardManualCommand(command: ManualCommand): void {
  if (useAppModeStore.getState().mode === 'MISSION') scenarioSetManualCommand(command);
  else setManualCommand(command);
}

function forwardAbort(): void {
  if (useAppModeStore.getState().mode === 'MISSION') scenarioCommandAbort();
  else commandAbort();
}

function forwardCycleController(): void {
  if (useAppModeStore.getState().mode === 'MISSION') scenarioCycleController();
  else cycleController();
}

/** Attach deterministic keyboard and camera-only mouse controls to an element. */
export function attachManualControls(element: HTMLElement): () => void {
  const pressed = new Set<string>();
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let controlMode = getLatestFrame()?.control_mode ?? 'AUTO';
  let manualSubMode = getLatestFrame()?.manual_sub_mode ?? 'RATE';
  let modeCommandPending = false;
  let subModeCommandPending = false;

  const emitCommand = (): void => {
    const frame = getLatestFrame();
    if (frame?.control_mode !== undefined) {
      if (modeCommandPending && frame.control_mode === controlMode) modeCommandPending = false;
      if (!modeCommandPending && frame.control_mode !== controlMode) {
        controlMode = frame.control_mode;
        if (controlMode === 'AUTO') zeroCommand();
      }
    }
    if (frame?.manual_sub_mode !== null && frame?.manual_sub_mode !== undefined) {
      if (subModeCommandPending && frame.manual_sub_mode === manualSubMode) subModeCommandPending = false;
      if (!subModeCommandPending && frame.manual_sub_mode !== manualSubMode) manualSubMode = frame.manual_sub_mode;
    }
    if (controlMode !== 'MANUAL') return;

    // KSP-style bindings. Body axes: +y forward, +z up, +x right.
    const anyShift = held(pressed, 'translateForwardShiftLeft') || held(pressed, 'translateForwardShiftRight');
    const anyCtrl = held(pressed, 'translateBackControlLeft') || held(pressed, 'translateBackControlRight');
    const translation: [number, number, number] = [
      (held(pressed, 'translateRight') ? 1 : 0) - (held(pressed, 'translateLeft') ? 1 : 0),
      (anyShift ? 1 : 0) - (anyCtrl ? 1 : 0),
      (held(pressed, 'translateUp') ? 1 : 0) - (held(pressed, 'translateDown') ? 1 : 0),
    ];
    const pitch = (held(pressed, 'pitchUp') ? 1 : 0) - (held(pressed, 'pitchDown') ? 1 : 0);
    const yaw = (held(pressed, 'yawLeft') ? 1 : 0) - (held(pressed, 'yawRight') ? 1 : 0);
    const roll = (held(pressed, 'rollRight') ? 1 : 0) - (held(pressed, 'rollLeft') ? 1 : 0);
    forwardManualCommand({ translation, rotation: [pitch, roll, yaw] });
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const binding = bindingForCode(event.code) ?? bindingForKey(event.key);
    if (!binding) return;

    if (binding.group === 'TRANSLATE' || binding.group === 'ROTATE') {
      if (binding.code !== null) pressed.add(binding.code);
      event.preventDefault();
      return;
    }
    if (event.repeat) return;

    switch (binding.id) {
      case 'toggleControlMode':
        controlMode = controlMode === 'MANUAL' ? 'AUTO' : 'MANUAL';
        modeCommandPending = true;
        forwardControlMode(controlMode);
        if (controlMode === 'AUTO') zeroCommand();
        break;
      case 'toggleManualSubMode':
        manualSubMode = manualSubMode === 'RATE' ? 'PULSE' : 'RATE';
        subModeCommandPending = true;
        forwardManualSubMode(manualSubMode);
        break;
      case 'cycleController':
        forwardCycleController();
        break;
      case 'cycleView':
        useViewStore.getState().cycleMode();
        break;
      case 'toggleKeybinds':
      case 'toggleKeybindsQuestion':
        useViewStore.getState().toggleKeybinds();
        break;
      case 'abort':
        forwardAbort();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    pressed.delete(event.code);
  };

  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 2 || useViewStore.getState().mode === 'COCKPIT') return;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    event.preventDefault();
  };

  const onMouseMove = (event: MouseEvent): void => {
    if (!dragging) return;
    useViewStore.getState().orbitBy(
      (event.clientX - lastX) * ORBIT_SENSITIVITY_RAD_PX,
      -(event.clientY - lastY) * ORBIT_SENSITIVITY_RAD_PX,
    );
    lastX = event.clientX;
    lastY = event.clientY;
  };

  const stopDragging = (): void => {
    dragging = false;
  };

  const onWheel = (event: WheelEvent): void => {
    if (useViewStore.getState().mode === 'COCKPIT') return;
    event.preventDefault();
    useViewStore.getState().zoomBy(Math.pow(ZOOM_STEP, event.deltaY > 0 ? 1 : -1));
  };

  const onBlur = (): void => {
    pressed.clear();
    stopDragging();
    zeroCommand();
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') onBlur();
  };
  const onContextMenu = (event: MouseEvent): void => event.preventDefault();

  element.addEventListener('mousedown', onMouseDown);
  element.addEventListener('wheel', onWheel, { passive: false });
  element.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', stopDragging);
  window.addEventListener('blur', onBlur);
  window.addEventListener('pointercancel', stopDragging);
  document.addEventListener('visibilitychange', onVisibilityChange);
  const timer = window.setInterval(emitCommand, TICK_MS);

  return () => {
    window.clearInterval(timer);
    element.removeEventListener('mousedown', onMouseDown);
    element.removeEventListener('wheel', onWheel);
    element.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', stopDragging);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('pointercancel', stopDragging);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    pressed.clear();
    zeroCommand();
  };
}
