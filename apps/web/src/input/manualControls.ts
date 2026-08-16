import { FSW_HZ, type ManualAuthority, type ManualCommand } from '@docking/sim-core';
import { getLatestFrame } from '../telemetry/bus';
import { useAppModeStore } from '../appModeStore';
import {
  commandAbort,
  cycleController,
  setControlMode,
  setManualCommand,
  setManualAuthority,
  setManualSubMode,
} from '../telemetry/simEmitter';
import {
  commandAbort as scenarioCommandAbort,
  cycleController as scenarioCycleController,
  setControlMode as scenarioSetControlMode,
  setManualCommand as scenarioSetManualCommand,
  setManualAuthority as scenarioSetManualAuthority,
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
/** Keyboard camera cadence — decoupled from the 10 Hz FSW command loop, which
 *  is far too coarse for smooth orbiting. ~0.85 rad/s orbit; zoom ~2.4x/s. */
const CAMERA_TICK_MS = 33;
const CAMERA_ORBIT_STEP_RAD = 0.028;
const CAMERA_ZOOM_STEP_PER_TICK = 1.03;
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

function forwardManualAuthority(level: ManualAuthority): void {
  if (useAppModeStore.getState().mode === 'MISSION') scenarioSetManualAuthority(level);
  else setManualAuthority(level);
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
  let manualAuthority: ManualAuthority = getLatestFrame()?.manual_authority ?? 'LOW';
  let modeCommandPending = false;
  let subModeCommandPending = false;
  let authorityCommandPending = false;

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
    if (frame?.manual_authority !== undefined) {
      if (authorityCommandPending && frame.manual_authority === manualAuthority) authorityCommandPending = false;
      if (!authorityCommandPending && frame.manual_authority !== manualAuthority) manualAuthority = frame.manual_authority;
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
    // Camera orbit/zoom keys are held-style like flight keys, but drive the
    // view store from their own tick rather than the FSW-rate command loop.
    if (binding.id.startsWith('cameraOrbit') || binding.id.startsWith('cameraZoom')) {
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
      case 'toggleManualAuthority':
        manualAuthority = manualAuthority === 'LOW' ? 'HIGH' : 'LOW';
        authorityCommandPending = true;
        forwardManualAuthority(manualAuthority);
        break;
      case 'cycleController':
        forwardCycleController();
        break;
      case 'cycleView':
        useViewStore.getState().cycleMode();
        break;
      case 'toggleDebugCamera':
        useViewStore.getState().toggleDebug();
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
  const cameraTick = (): void => {
    const az = (held(pressed, 'cameraOrbitRight') ? 1 : 0) - (held(pressed, 'cameraOrbitLeft') ? 1 : 0);
    const el = (held(pressed, 'cameraOrbitUp') ? 1 : 0) - (held(pressed, 'cameraOrbitDown') ? 1 : 0);
    if (az !== 0 || el !== 0) {
      useViewStore.getState().orbitBy(az * CAMERA_ORBIT_STEP_RAD, el * CAMERA_ORBIT_STEP_RAD);
    }
    const zoom = (held(pressed, 'cameraZoomOut') ? 1 : 0) - (held(pressed, 'cameraZoomIn') ? 1 : 0);
    if (zoom !== 0) useViewStore.getState().zoomBy(Math.pow(CAMERA_ZOOM_STEP_PER_TICK, zoom));
  };
  const cameraTimer = window.setInterval(cameraTick, CAMERA_TICK_MS);

  return () => {
    window.clearInterval(timer);
    window.clearInterval(cameraTimer);
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
