import { FSW_HZ, type ManualCommand } from '@docking/sim-core';
import { getLatestFrame } from '../telemetry/bus';
import {
  setControlMode,
  setManualCommand,
  setManualSubMode,
} from '../telemetry/simEmitter';
import { useViewStore } from '../viewStore';

const ZERO_COMMAND: ManualCommand = {
  translation: [0, 0, 0],
  rotation: [0, 0, 0],
};
const DRAG_SENSITIVITY = 0.006;
const ROTATION_DECAY = 0.72;
const TICK_MS = 1000 / FSW_HZ;

function zeroCommand(): void {
  setManualCommand({ translation: [0, 0, 0], rotation: [0, 0, 0] });
}

function clamp(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

/** Attach deterministic keyboard/mouse manual flight controls to an element. */
export function attachManualControls(element: HTMLElement): () => void {
  const pressed = new Set<string>();
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let dragPitch = 0;
  let dragYaw = 0;
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
    if (controlMode !== 'MANUAL') {
      dragPitch *= ROTATION_DECAY;
      dragYaw *= ROTATION_DECAY;
      return;
    }

    // KSP-style bindings (user request, v0.4.2). Body axes: +y forward
    // (docking axis), +z up, +x right (= y × z). Screen left/right derive
    // from the cockpit view (up = +z, forward = +y).
    const anyShift = pressed.has('ShiftLeft') || pressed.has('ShiftRight');
    const anyCtrl = pressed.has('ControlLeft') || pressed.has('ControlRight');
    const translation: [number, number, number] = [
      (pressed.has('KeyL') ? 1 : 0) - (pressed.has('KeyJ') ? 1 : 0),   // right / left
      (anyShift ? 1 : 0) - (anyCtrl ? 1 : 0),                          // forward / back
      (pressed.has('KeyI') ? 1 : 0) - (pressed.has('KeyK') ? 1 : 0),   // up / down
    ];
    // W = pitch down (−x), S = pitch up (+x); A = yaw left (+z), D = yaw
    // right (−z); Q = roll left (−y), E = roll right (+y). Mouse right-drag
    // adds pitch/yaw: pull down = pitch up, drag right = yaw right.
    const pitchKeys = (pressed.has('KeyS') ? 1 : 0) - (pressed.has('KeyW') ? 1 : 0);
    const yawKeys = (pressed.has('KeyA') ? 1 : 0) - (pressed.has('KeyD') ? 1 : 0);
    const roll = (pressed.has('KeyE') ? 1 : 0) - (pressed.has('KeyQ') ? 1 : 0);
    const rotation: [number, number, number] = [
      clamp(pitchKeys + dragPitch),
      roll,
      clamp(yawKeys - dragYaw),
    ];
    setManualCommand({ translation, rotation });
    if (!dragging) {
      dragPitch *= ROTATION_DECAY;
      dragYaw *= ROTATION_DECAY;
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if ([
      'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
      'KeyI', 'KeyJ', 'KeyK', 'KeyL',
      'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
    ].includes(event.code)) {
      pressed.add(event.code);
      event.preventDefault();
      return;
    }
    if (event.repeat) return;
    if (event.code === 'KeyM') {
      controlMode = controlMode === 'MANUAL' ? 'AUTO' : 'MANUAL';
      modeCommandPending = true;
      setControlMode(controlMode);
      if (controlMode === 'AUTO') zeroCommand();
      event.preventDefault();
    } else if (event.code === 'KeyT') {
      manualSubMode = manualSubMode === 'RATE' ? 'PULSE' : 'RATE';
      subModeCommandPending = true;
      setManualSubMode(manualSubMode);
      event.preventDefault();
    } else if (event.code === 'KeyC') {
      useViewStore.getState().cycleMode();
      event.preventDefault();
    }
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    pressed.delete(event.code);
  };

  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 2) return;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    event.preventDefault();
  };

  const onMouseMove = (event: MouseEvent): void => {
    if (!dragging) return;
    dragYaw = clamp(dragYaw + (event.clientX - lastX) * DRAG_SENSITIVITY);
    dragPitch = clamp(dragPitch + (event.clientY - lastY) * DRAG_SENSITIVITY);
    lastX = event.clientX;
    lastY = event.clientY;
  };

  const stopDragging = (): void => {
    dragging = false;
    // Clear the accumulators too — otherwise the next emit interval would
    // re-issue the last drag rotation right after the zero command.
    dragPitch = 0;
    dragYaw = 0;
    zeroCommand();
  };

  const onBlur = (): void => {
    pressed.clear();
    stopDragging();
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') onBlur();
  };
  const onContextMenu = (event: MouseEvent): void => event.preventDefault();

  element.addEventListener('mousedown', onMouseDown);
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
    element.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', stopDragging);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('pointercancel', stopDragging);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    pressed.clear();
    setManualCommand(ZERO_COMMAND);
  };
}
