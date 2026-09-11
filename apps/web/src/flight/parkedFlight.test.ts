import { expect, it } from 'vitest';
import { FlightSession } from './flightSession';

it('parking cancels a maneuver and prevents stale throttle, trim and held inputs returning', () => {
  const session = new FlightSession();
  session.setThrottle(0.9);
  session.key('BracketRight', true); session.advance(0.1); session.key('BracketRight', false);
  expect(session.controls.trim).not.toBe(0);
  session.startExercise('TURN_RIGHT');
  session.advance(0.05);
  session.park();
  const parkedState = structuredClone(session.state);
  expect(session.exerciseSnapshot().phase).toBe('CANCELLED');
  session.releaseControls();
  session.advance(10);
  expect(session.state).toEqual(parkedState);
  expect(session.controls).toEqual({ pitch: 0, roll: 0, yaw: 0, throttle: 0, trim: 0 });
  // A subsequent manual step must also consume the reconciled private state.
  session.togglePause(); session.advance(0.01);
  expect(session.controls).toEqual({ pitch: 0, roll: 0, yaw: 0, throttle: 0, trim: 0 });
});
