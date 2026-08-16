export type BindingGroup = 'MODE' | 'TRANSLATE' | 'ROTATE' | 'CAMERA' | 'SAFETY';

export interface Binding {
  id: string;
  code: string | null;
  key?: string;
  label: string;
  group: BindingGroup;
  description: string;
}

/** The single source of truth for keyboard and camera controls. */
export const BINDINGS: readonly Binding[] = [
  { id: 'toggleControlMode', code: 'KeyM', label: 'M', group: 'MODE', description: 'toggle AUTO / MANUAL' },
  { id: 'toggleManualSubMode', code: 'KeyT', label: 'T', group: 'MODE', description: 'toggle RATE / PULSE' },
  { id: 'toggleManualAuthority', code: 'KeyG', label: 'G', group: 'MODE', description: 'toggle LOW / HIGH manual authority' },
  { id: 'cycleController', code: 'KeyV', label: 'V', group: 'MODE', description: 'cycle PID / LQR / MPC' },
  { id: 'cycleView', code: 'KeyC', label: 'C', group: 'CAMERA', description: 'cycle camera view' },
  { id: 'toggleDebugCamera', code: 'KeyB', label: 'B', group: 'CAMERA', description: 'toggle debug camera (free orbit, zoom to full Earth)' },
  { id: 'cameraOrbitLeft', code: 'ArrowLeft', label: 'LEFT', group: 'CAMERA', description: 'orbit camera left' },
  { id: 'cameraOrbitRight', code: 'ArrowRight', label: 'RIGHT', group: 'CAMERA', description: 'orbit camera right' },
  { id: 'cameraOrbitUp', code: 'ArrowUp', label: 'UP', group: 'CAMERA', description: 'orbit camera up' },
  { id: 'cameraOrbitDown', code: 'ArrowDown', label: 'DOWN', group: 'CAMERA', description: 'orbit camera down' },
  { id: 'cameraZoomIn', code: 'PageUp', label: 'PGUP', group: 'CAMERA', description: 'zoom camera in' },
  { id: 'cameraZoomOut', code: 'PageDown', label: 'PGDN', group: 'CAMERA', description: 'zoom camera out' },
  { id: 'toggleKeybinds', code: 'KeyH', label: 'H', group: 'CAMERA', description: 'toggle controls overlay' },
  { id: 'toggleKeybindsQuestion', code: null, key: '?', label: '?', group: 'CAMERA', description: 'toggle controls overlay' },
  { id: 'abort', code: 'Backspace', label: 'BACKSPACE', group: 'SAFETY', description: 'command passive abort' },
  { id: 'translateForwardShiftLeft', code: 'ShiftLeft', label: 'SHIFT', group: 'TRANSLATE', description: 'translate forward' },
  { id: 'translateForwardShiftRight', code: 'ShiftRight', label: 'SHIFT', group: 'TRANSLATE', description: 'translate forward' },
  { id: 'translateBackControlLeft', code: 'ControlLeft', label: 'CTRL', group: 'TRANSLATE', description: 'translate backward' },
  { id: 'translateBackControlRight', code: 'ControlRight', label: 'CTRL', group: 'TRANSLATE', description: 'translate backward' },
  { id: 'pitchDown', code: 'KeyW', label: 'W', group: 'ROTATE', description: 'pitch down' },
  { id: 'pitchUp', code: 'KeyS', label: 'S', group: 'ROTATE', description: 'pitch up' },
  { id: 'yawLeft', code: 'KeyA', label: 'A', group: 'ROTATE', description: 'yaw left' },
  { id: 'yawRight', code: 'KeyD', label: 'D', group: 'ROTATE', description: 'yaw right' },
  { id: 'rollLeft', code: 'KeyQ', label: 'Q', group: 'ROTATE', description: 'roll left' },
  { id: 'rollRight', code: 'KeyE', label: 'E', group: 'ROTATE', description: 'roll right' },
  { id: 'translateUp', code: 'KeyI', label: 'I', group: 'TRANSLATE', description: 'translate up' },
  { id: 'translateDown', code: 'KeyK', label: 'K', group: 'TRANSLATE', description: 'translate down' },
  { id: 'translateLeft', code: 'KeyJ', label: 'J', group: 'TRANSLATE', description: 'translate left' },
  { id: 'translateRight', code: 'KeyL', label: 'L', group: 'TRANSLATE', description: 'translate right' },
  { id: 'orbit', code: null, label: 'RIGHT DRAG', group: 'CAMERA', description: 'orbit camera' },
  { id: 'zoom', code: null, label: 'WHEEL', group: 'CAMERA', description: 'zoom camera' },
];

export const HANDLED_CODES = BINDINGS
  .map((binding) => binding.code)
  .filter((code): code is string => code !== null);

export const HANDLED_KEYS = BINDINGS
  .map((binding) => binding.key)
  .filter((key): key is string => key !== undefined);

export function codesFor(id: string): string[] {
  return BINDINGS
    .filter((binding) => binding.id === id && binding.code !== null)
    .map((binding) => binding.code!);
}

export function bindingForCode(code: string): Binding | undefined {
  return BINDINGS.find((binding) => binding.code === code);
}

export function bindingForKey(key: string): Binding | undefined {
  return BINDINGS.find((binding) => binding.key === key);
}
