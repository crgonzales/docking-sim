import { expect, it } from 'vitest';
import { FlightSession } from './flightSession';

it('produces the same trajectory at 30 and 144 render fps', () => {
  const slow = new FlightSession(), fast = new FlightSession();
  slow.key('KeyE', true); fast.key('KeyE', true);
  for (let i = 0; i < 30; i++) slow.advance(1 / 30);
  for (let i = 0; i < 144; i++) fast.advance(1 / 144);
  expect(slow.state).toEqual(fast.state);
  expect(slow.controls.roll).toBe(1);
});
it('pause, focus loss and reset clear stuck controls and discard accumulated time', () => {
  const session = new FlightSession();
  session.key('ArrowDown', true); session.advance(0.1);
  expect(session.controls.pitch).toBeGreaterThan(0);
  session.loseFocus(); const before = session.state;
  session.advance(100); expect(session.state).toBe(before);
  session.togglePause(); session.advance(0.01);
  expect(session.controls.pitch).toBe(0);
  expect(session.state.time_s).toBeCloseTo(0.11, 10);
  session.reset(); expect(session.state).toEqual(new FlightSession().state);
  session.advance(100); expect(session.state.time_s).toBeCloseTo(0.1, 10);
});
it('maps throttle, trim and yaw controls and releases them without losing throttle', () => {
  const session = new FlightSession();
  const initial = { ...session.controls };
  session.key('ShiftLeft', true); session.key('BracketRight', true); session.key('KeyD', true);
  session.advance(0.1);
  expect(session.controls.throttle).toBeGreaterThan(initial.throttle);
  expect(session.controls.trim).toBeGreaterThan(initial.trim);
  expect(session.controls.yaw).toBeGreaterThan(0);
  const throttle = session.controls.throttle;
  session.releaseControls(); session.advance(0.1);
  expect(session.controls.throttle).toBe(throttle);
  expect(session.controls.yaw).toBe(0);
});

it.each(['keyboard', 'pointer'] as const)('keeps the remaining hold when the %s releases first', (first) => {
  const session = new FlightSession();
  session.key('KeyE', true);
  session.pointer('KeyE', 7, true);
  session.advance(0.1);
  expect(session.controls.roll).toBeCloseTo(0.3, 12);
  if (first === 'keyboard') session.key('KeyE', false);
  else session.pointer('KeyE', 7, false);
  session.advance(0.1);
  expect(session.controls.roll).toBeCloseTo(0.6, 12);
  session.key('KeyE', false);
  session.pointer('KeyE', 7, false);
  session.advance(0.1); session.advance(0.1);
  expect(session.controls.roll).toBeCloseTo(0, 12);
});

it('keeps independent pointers held through duplicate up/cancel/capture-loss notifications', () => {
  const session = new FlightSession();
  session.pointer('ArrowDown', 7, true);
  session.pointer('ArrowDown', 8, true);
  session.advance(0.1);
  session.pointer('ArrowDown', 7, false);
  session.pointer('ArrowDown', 7, false);
  session.pointer('ArrowDown', 7, false);
  session.key('ArrowDown', false);
  session.advance(0.1);
  expect(session.controls.pitch).toBeCloseTo(0.4, 12);
  session.pointer('ArrowDown', 8, false);
  session.advance(0.1); session.advance(0.1);
  expect(session.controls.pitch).toBeCloseTo(0, 12);
});

it.each(['togglePause', 'loseFocus', 'reset', 'releaseControls'] as const)('%s clears both keyboard and pointer ownership', (action) => {
  const session = new FlightSession();
  session.key('KeyE', true);
  session.pointer('ArrowDown', 7, true);
  session.advance(0.1);
  expect(session.controls.roll).toBeGreaterThan(0);
  expect(session.controls.pitch).toBeGreaterThan(0);
  session[action]();
  if (session.paused) session.togglePause();
  session.advance(0.1);
  expect(session.controls.roll).toBe(0);
  expect(session.controls.pitch).toBe(0);
});
