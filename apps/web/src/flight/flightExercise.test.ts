import { describe, expect, it } from 'vitest';
import { FLIGHT_EXERCISES } from './flightExercise';
import { FlightSession } from './flightSession';

function run(session: FlightSession, seconds: number, fps = 60) {
  for (let i = 0; i < seconds * fps; ++i) session.advance(1 / fps);
}

describe('repeatable flight exercises', () => {
  it.each(FLIGHT_EXERCISES)('$id flies identically at 30 and 144 fps and stops', ({ id, duration_s }) => {
    const slow = new FlightSession(), fast = new FlightSession();
    slow.startExercise(id); fast.startExercise(id);
    run(slow, duration_s + 1, 30); run(fast, duration_s + 1, 144);
    expect(slow.state).toEqual(fast.state);
    expect(slow.exerciseSnapshot().phase).toBe('COMPLETED');
    expect(slow.state.status).toBe('FLYING');
    expect(slow.state.time_s).toBeCloseTo(duration_s, 8);
    if (id === 'CLOUD_CLIMB') expect(slow.instruments().altitude_m).toBeGreaterThan(3000);
    if (id === 'LOW_DESCENT') expect(slow.instruments().altitude_m).toBeLessThan(350);
    expect(slow.paused).toBe(true);
    expect(slow.controls.pitch).toBe(0);
    expect(slow.controls.roll).toBe(0);
    const final = slow.state;
    run(slow, 10);
    expect(slow.state).toBe(final);
  });

  it.each(['togglePause', 'loseFocus', 'reset', 'releaseControls'] as const)('%s cancels scripted ownership', action => {
    const session = new FlightSession();
    session.startExercise('TURN_RIGHT'); run(session, 1);
    expect(session.controls.roll).toBeGreaterThan(0);
    session[action]();
    expect(session.exerciseSnapshot().phase).toBe('CANCELLED');
    if (session.paused) session.togglePause();
    session.advance(0.1);
    expect(session.controls.roll).toBe(0);
    expect(session.controls.pitch).toBe(0);
  });

  it('manual roll, throttle and wind editing take control immediately', () => {
    const session = new FlightSession();
    session.startExercise('TURN_RIGHT'); run(session, 1);
    session.key('KeyQ', true); session.advance(0.1);
    expect(session.exerciseSnapshot().phase).toBe('CANCELLED');
    expect(session.controls.roll).toBeLessThan(0);
    session.startExercise('CLIMB'); run(session, 1);
    session.setThrottle(0.8); session.advance(0.1);
    expect(session.exerciseSnapshot().phase).toBe('CANCELLED');
    expect(session.controls.throttle).toBe(0.8);
    session.startExercise('TURN_RIGHT'); session.setWind([0, 10, 0]);
    session.advance(0.1);
    expect(session.exerciseSnapshot().phase).toBe('CANCELLED');
    expect(session.environment.wind_N_m_s).toEqual([0, 10, 0]);
    expect(session.controls.roll).toBe(0);
  });

  it('pause discards a partial truth tick even without an intervening paused frame', () => {
    const session = new FlightSession();
    session.advance(0.009);
    session.togglePause(); session.togglePause(); session.advance(0.001);
    expect(session.state.time_s).toBe(0);
  });

  it('surface contact still terminates a scripted maneuver', () => {
    const session = new FlightSession();
    session.startExercise('DESCENT');
    session.state.position_N_m[2] = 0;
    session.advance(0.1);
    expect(session.state.status).toBe('CONTACT');
    expect(session.exerciseSnapshot().phase).toBe('TERMINAL');
    expect(session.paused).toBe(true);
    expect(session.controls.pitch).toBe(0);
  });

  it('surface contact pauses ordinary flight rendering too', () => {
    const session = new FlightSession();
    session.state.position_N_m[2] = 0;
    session.advance(0.1);
    expect(session.state.status).toBe('CONTACT');
    expect(session.paused).toBe(true);
    session.togglePause(); session.advance(0.1);
    expect(session.paused).toBe(true);
  });

  it('Stop pauses at the current pose and releases scripted inputs', () => {
    const session = new FlightSession();
    session.startExercise('TURN_RIGHT'); run(session, 1);
    session.stopExercise(); const stopped = session.state;
    run(session, 1);
    expect(session.state).toBe(stopped);
    expect(session.exerciseSnapshot().phase).toBe('STOPPED');
    expect(session.controls.roll).toBe(0);
    session.togglePause(); session.advance(0.1);
    expect(session.state.time_s).toBeGreaterThan(stopped.time_s);
    expect(session.controls.roll).toBe(0);
  });
});
