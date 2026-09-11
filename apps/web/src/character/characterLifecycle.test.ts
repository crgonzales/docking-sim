import { expect, it, vi } from 'vitest';
import { CharacterInputAdapter } from './useCharacterInput';
import { CharacterSession } from './characterSession';

const emit = (target: EventTarget, type: string, fields = {}) => target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), fields));
const keyFields = (code: string) => ({ code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false });
function fixture() {
  const session = new CharacterSession({ start: 'GROUND', groundSampler: () => 100 });
  const children = new Set<unknown>();
  const root = Object.assign(new EventTarget(), { tagName: 'SECTION', isContentEditable: false, focus: vi.fn(), contains: (target: unknown) => children.has(target) });
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { hidden: false, pointerLockElement: null as unknown, exitPointerLock: vi.fn(() => { document.pointerLockElement = null; emit(document, 'pointerlockchange'); }) });
  const canvas = Object.assign(new EventTarget(), { requestPointerLock: vi.fn<() => void | Promise<void>>(() => { document.pointerLockElement = canvas; emit(document, 'pointerlockchange'); return Promise.resolve(); }) });
  children.add(root); children.add(canvas);
  const adapter = new CharacterInputAdapter({ session, port: { root, window, document, canvas } }); adapter.mount();
  const press = (code: string) => { emit(root, 'keydown', keyFields(code)); emit(window, 'keyup', keyFields(code)); };
  return { session, root, window, document, canvas, adapter, press };
}

it('locks only on canvas, applies mouse look while owned, and clears holds on pause/resume', async () => {
  const f = fixture(); emit(f.root, 'click'); expect(f.canvas.requestPointerLock).not.toHaveBeenCalled();
  emit(f.canvas, 'click'); await Promise.resolve();
  expect(f.document.pointerLockElement).toBe(f.canvas);
  emit(f.canvas, 'mousemove', { movementX: 100, movementY: -10 }); expect(f.session.yaw_rad).toBeCloseTo(0.25);
  emit(f.root, 'keydown', keyFields('KeyW')); f.press('KeyP');
  expect(f.session.paused).toBe(true); expect(f.document.pointerLockElement).toBeNull();
  const before = f.session.state; emit(f.canvas, 'mousemove', { movementX: 100, movementY: 0 }); f.session.advance(1);
  expect(f.session.state).toEqual(before);
  emit(f.canvas, 'click'); expect(f.canvas.requestPointerLock).toHaveBeenCalledTimes(1);
  f.press('KeyP'); f.session.advance(0.1); expect(f.session.position_N_m).toEqual(before.position_N_m);
  f.adapter.unmount();
});

it('intentional boarding unlock does not pause, but unexpected loss after relocking does', async () => {
  const f = fixture(); emit(f.canvas, 'click'); await Promise.resolve();
  f.press('KeyF'); expect(f.session.mode).toBe('VEHICLE'); expect(f.session.paused).toBe(false);
  expect(f.document.pointerLockElement).toBeNull();
  emit(f.canvas, 'click'); expect(f.canvas.requestPointerLock).toHaveBeenCalledTimes(1);
  f.press('KeyF'); emit(f.canvas, 'click'); await Promise.resolve();
  f.document.pointerLockElement = null; emit(f.document, 'pointerlockchange');
  expect(f.session.paused).toBe(true); f.adapter.unmount();
});

it.each(['blur', 'hidden'] as const)('%s pauses and releases keyboard, vehicle pointer holds and pointer lock', async (event) => {
  const f = fixture(); emit(f.canvas, 'click'); await Promise.resolve();
  emit(f.root, 'keydown', keyFields('KeyW')); f.session.flight.pointer('KeyE', 7, true);
  if (event === 'blur') emit(f.window, 'blur');
  else { f.document.hidden = true; emit(f.document, 'visibilitychange'); }
  expect(f.session.paused).toBe(true); expect(f.document.pointerLockElement).toBeNull();
  const before = f.session.position_N_m; f.session.togglePause(); f.session.advance(0.1);
  expect(f.session.position_N_m).toEqual(before); expect(f.session.flight.controls.roll).toBe(0);
  f.adapter.unmount();
});

it.each(['pause', 'roundtrip', 'reset', 'unmount'] as const)('rejects late asynchronous lock acquisition after %s', async (action) => {
  const f = fixture(); let resolve!: () => void;
  f.canvas.requestPointerLock.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
  emit(f.canvas, 'click');
  if (action === 'pause') f.session.togglePause();
  if (action === 'roundtrip') { f.session.interact(); f.session.interact(); }
  if (action === 'reset') f.session.reset();
  if (action === 'unmount') f.adapter.unmount();
  f.document.pointerLockElement = f.canvas; emit(f.document, 'pointerlockchange');
  if (action !== 'unmount') expect(f.document.pointerLockElement).toBeNull();
  resolve(); await Promise.resolve(); await Promise.resolve();
  expect(f.document.pointerLockElement).toBeNull();
  f.adapter.unmount();
});

it('allows retries after synchronous, promise and legacy pointer-lock failures', async () => {
  const f = fixture();
  f.canvas.requestPointerLock.mockImplementationOnce(() => { throw new Error('denied'); });
  emit(f.canvas, 'click');
  f.canvas.requestPointerLock.mockImplementationOnce(() => Promise.reject(new Error('denied')));
  emit(f.canvas, 'click'); await Promise.resolve(); await Promise.resolve();
  f.canvas.requestPointerLock.mockImplementationOnce(() => undefined);
  emit(f.canvas, 'click'); emit(f.document, 'pointerlockerror');
  emit(f.canvas, 'click'); await Promise.resolve();
  expect(f.canvas.requestPointerLock).toHaveBeenCalledTimes(4);
  expect(f.document.pointerLockElement).toBe(f.canvas); expect(f.session.paused).toBe(false);
  f.adapter.unmount();
});

it('releases a key even when focus moved outside the flight root before keyup', () => {
  const f = fixture(), before = f.session.position_N_m;
  emit(f.root, 'keydown', keyFields('KeyW')); emit(f.window, 'keyup', keyFields('KeyW')); f.session.advance(0.1);
  expect(f.session.position_N_m).toEqual(before); f.adapter.unmount();
});

it('pauses when focus leaves the surface but permits focus within it', () => {
  const f = fixture(); emit(f.root, 'focusout', { relatedTarget: f.canvas }); expect(f.session.paused).toBe(false);
  emit(f.root, 'keydown', keyFields('KeyW')); emit(f.root, 'focusout', { relatedTarget: null });
  expect(f.session.paused).toBe(true); const before = f.session.position_N_m;
  f.session.togglePause(); f.session.advance(0.1); expect(f.session.position_N_m).toEqual(before); f.adapter.unmount();
});

it('rejects legacy late locks after reset and unmount, even without a promise', () => {
  for (const action of ['reset', 'unmount']) {
    const f = fixture(); f.canvas.requestPointerLock.mockReturnValue(undefined); emit(f.canvas, 'click');
    if (action === 'reset') f.session.reset(); else f.adapter.unmount();
    f.document.pointerLockElement = f.canvas; emit(f.document, 'pointerlockchange');
    expect(f.document.pointerLockElement).toBeNull(); f.adapter.unmount();
  }
});

it('does not let an older promise release a newer accepted lock, or release another surface on cleanup', async () => {
  const f = fixture(); let resolve!: () => void;
  f.canvas.requestPointerLock.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
  emit(f.canvas, 'click'); f.session.reset();
  f.document.pointerLockElement = f.canvas; emit(f.document, 'pointerlockchange');
  emit(f.canvas, 'click'); await Promise.resolve();
  resolve(); await Promise.resolve();
  expect(f.document.pointerLockElement).toBe(f.canvas);
  const foreign = {}; f.document.pointerLockElement = foreign;
  f.document.exitPointerLock.mockClear(); f.adapter.unmount();
  expect(f.document.exitPointerLock).not.toHaveBeenCalled(); expect(f.document.pointerLockElement).toBe(foreign);
});

it('supports drag look after denied mouse capture and stops on pointer release', async () => {
  const f = fixture();
  f.canvas.requestPointerLock.mockRejectedValue(new Error('denied'));
  emit(f.canvas, 'click'); await Promise.resolve(); await Promise.resolve();
  emit(f.canvas, 'pointerdown', { button: 0, pointerId: 1, clientX: 10, clientY: 20 });
  emit(f.window, 'pointermove', { pointerId: 2, clientX: 900, clientY: 900 });
  expect(f.session.yaw_rad).toBe(0);
  emit(f.window, 'pointermove', { pointerId: 1, clientX: 110, clientY: 10 });
  expect(f.session.yaw_rad).toBeCloseTo(0.25);
  expect(f.session.pitch_rad).toBeCloseTo(0.025);
  emit(f.window, 'pointerup', { pointerId: 1 }); emit(f.canvas, 'click');
  expect(f.canvas.requestPointerLock).toHaveBeenCalledTimes(1);
  emit(f.window, 'pointermove', { pointerId: 1, clientX: 210, clientY: 10 });
  expect(f.session.yaw_rad).toBeCloseTo(0.25);
  f.adapter.unmount();
});

it.each(['pause', 'roundtrip', 'reset', 'unmount'])('clears drag ownership on %s', (action) => {
  const f = fixture();
  emit(f.canvas, 'pointerdown', { button: 0, pointerId: 1, clientX: 10, clientY: 20 });
  if (action === 'pause') { f.session.togglePause(); f.session.togglePause(); }
  if (action === 'roundtrip') { f.session.interact(); f.session.interact(); }
  if (action === 'reset') f.session.reset();
  if (action === 'unmount') f.adapter.unmount();
  emit(f.window, 'pointermove', { pointerId: 1, clientX: 110, clientY: 10 });
  expect(f.session.yaw_rad).toBe(0); expect(f.session.pitch_rad).toBe(0);
  f.adapter.unmount();
});
