import { expect, it, vi } from 'vitest';
import { handleFlightKeyDown } from './flightInput';
import { FlightSession } from './flightSession';

const keyEvent = (code: string) => ({ code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, defaultPrevented: false, preventDefault: vi.fn() });
const widgets = [
  { tagName: 'INPUT', type: 'range', isContentEditable: false },
  { tagName: 'SELECT', isContentEditable: false },
];

it.each(widgets)('allows pause/resume and reset on a focused $tagName without repeat toggles', (target) => {
  const session = new FlightSession();
  session.advance(0.05);
  const pause = keyEvent('KeyP');
  handleFlightKeyDown(pause, session, target);
  expect(pause.preventDefault).toHaveBeenCalledOnce();
  expect(session.paused).toBe(true);
  handleFlightKeyDown({ ...keyEvent('KeyP'), repeat: true }, session, target);
  expect(session.paused).toBe(true);
  session.key('KeyP', false);
  handleFlightKeyDown(keyEvent('KeyP'), session, target);
  expect(session.paused).toBe(false);
  session.advance(0.05);
  expect(session.state.time_s).toBeCloseTo(0.1, 10);
  const reset = keyEvent('KeyR');
  handleFlightKeyDown(reset, session, target);
  expect(reset.preventDefault).toHaveBeenCalledOnce();
  expect(session.state).toEqual(new FlightSession().state);
});

it.each(widgets)('leaves navigation, selection and other flight keys native on a focused $tagName', (target) => {
  const session = new FlightSession();
  const controls = { ...session.controls };
  for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Enter', 'Tab', 'Home', 'End', 'KeyC', 'KeyE', 'KeyW', 'KeyS', 'BracketRight']) {
    const event = keyEvent(code);
    handleFlightKeyDown(event, session, target);
    expect(event.preventDefault).not.toHaveBeenCalled();
  }
  session.advance(0.1);
  expect(session.controls).toEqual(controls);
  expect(session.camera).toBe('CHASE');
});

it('does not intercept text, numeric input, textarea or inherited contenteditable editing', () => {
  const session = new FlightSession();
  session.advance(0.05);
  const state = session.state;
  for (const target of [
    { tagName: 'INPUT', type: 'text', isContentEditable: false },
    { tagName: 'INPUT', type: 'number', isContentEditable: false },
    { tagName: 'TEXTAREA', isContentEditable: false },
    { tagName: 'SPAN', isContentEditable: true },
  ]) {
    for (const code of ['KeyP', 'KeyR', 'KeyC', 'ArrowDown', 'KeyE']) {
      const event = keyEvent(code);
      handleFlightKeyDown(event, session, target);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
  }
  expect(session.state).toBe(state);
  expect(session.paused).toBe(false);
  expect(session.camera).toBe('CHASE');
  session.advance(0.1);
  expect(session.controls.roll).toBe(0);
  expect(session.controls.pitch).toBe(0);
});

it('respects modifiers, composition and already-handled events', () => {
  const session = new FlightSession();
  for (const flag of ['ctrlKey', 'metaKey', 'altKey', 'isComposing', 'defaultPrevented'] as const) {
    const event = { ...keyEvent('KeyP'), [flag]: true };
    handleFlightKeyDown(event, session, widgets[0]);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(session.paused).toBe(false);
  }
});

it('still forwards ordinary flying keys from the flight surface', () => {
  const session = new FlightSession();
  const event = keyEvent('KeyE');
  handleFlightKeyDown(event, session, { tagName: 'SECTION', isContentEditable: false });
  expect(event.preventDefault).toHaveBeenCalledOnce();
  session.advance(0.1);
  expect(session.controls.roll).toBeCloseTo(0.3, 12);
  session.key('KeyE', false);
  session.advance(0.1);
  expect(session.controls.roll).toBeCloseTo(0, 12);
});


it.each([
  ['KeyW', 'pitch', -1], ['KeyS', 'pitch', 1],
  ['KeyA', 'yaw', -1], ['KeyD', 'yaw', 1],
  ['KeyQ', 'roll', -1], ['KeyE', 'roll', 1],
  ['ShiftLeft', 'throttle', 1], ['ShiftRight', 'throttle', 1],
  ['ControlLeft', 'throttle', -1], ['ControlRight', 'throttle', -1],
] as const)('KSP %s changes only %s in the expected direction and releases', (code, axis, sign) => {
  const session = new FlightSession();
  const before = { ...session.controls };
  const event = { ...keyEvent(code), ctrlKey: code.startsWith('Control') };
  handleFlightKeyDown(event, session, { tagName: 'SECTION', isContentEditable: false });
  expect(event.preventDefault).toHaveBeenCalledOnce();
  session.advance(0.1);
  expect((session.controls[axis] - before[axis]) * sign).toBeGreaterThan(0);
  for (const other of ['pitch', 'yaw', 'roll', 'throttle'] as const) {
    if (other !== axis) expect(session.controls[other]).toBe(before[other]);
  }
  const heldThrottle = session.controls.throttle;
  session.key(code, false);
  session.advance(0.1);
  expect(session.controls.pitch).toBe(0);
  expect(session.controls.yaw).toBe(0);
  expect(session.controls.roll).toBeCloseTo(0, 12);
  expect(session.controls.throttle).toBe(heldThrottle);
});

it('can steer while holding throttle down without resetting on Ctrl+R', () => {
  const session = new FlightSession();
  const target = { tagName: 'SECTION', isContentEditable: false };
  const throttle = session.controls.throttle;
  for (const code of ['ControlLeft', 'KeyE', 'KeyS']) {
    handleFlightKeyDown({ ...keyEvent(code), ctrlKey: true }, session, target);
  }
  session.advance(0.1);
  expect(session.controls.throttle).toBeLessThan(throttle);
  expect(session.controls.roll).toBeGreaterThan(0);
  expect(session.controls.pitch).toBeGreaterThan(0);
  const reset = { ...keyEvent('KeyR'), ctrlKey: true };
  handleFlightKeyDown(reset, session, target);
  expect(reset.preventDefault).not.toHaveBeenCalled();
  expect(session.state.time_s).toBeCloseTo(0.1, 10);
  session.loseFocus(); session.togglePause(); session.advance(0.1);
  expect(session.controls.roll).toBeCloseTo(0, 12);
  expect(session.controls.pitch).toBe(0);
});

it('requests UI updates for paused commands without relying on another animation frame', () => {
  const session = new FlightSession();
  session.togglePause();
  expect(handleFlightKeyDown(keyEvent('KeyC'), session, null)).toBe(true);
  expect(session.camera).toBe('NOSE');
  expect(handleFlightKeyDown(keyEvent('KeyP'), session, null)).toBe(true);
  expect(session.paused).toBe(false);
  expect(handleFlightKeyDown({ ...keyEvent('KeyP'), repeat: true }, session, null)).toBe(false);
  expect(handleFlightKeyDown({ ...keyEvent('KeyR'), ctrlKey: true }, session, null)).toBe(false);
  expect(handleFlightKeyDown(keyEvent('KeyE'), session, null)).toBe(false);
  expect(handleFlightKeyDown(keyEvent('KeyR'), session, null)).toBe(true);
});
