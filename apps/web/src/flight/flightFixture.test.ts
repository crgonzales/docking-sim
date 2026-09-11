import { describe, expect, it } from 'vitest';
import { stepFlight } from '@docking/sim-core';
import { FlightSession } from './flightSession';
import { CLOUD_BASE_FLIGHT_FIXTURE } from './flightFixture';

describe('captured flight reproduction', () => {
  it('stays at the captured pose while the renderer settles', () => {
    const session = new FlightSession();
    session.applyFixture(CLOUD_BASE_FLIGHT_FIXTURE);
    const before = structuredClone(session.state);
    for (let i = 0; i < 128; ++i) session.advance(1 / 60);
    expect(session.state).toEqual(before);
    expect(session.instruments().altitude_m).toBeCloseTo(2830.0462, 3);
  });

  it('resumes with captured throttle/trim instead of the default flight inputs', () => {
    const session = new FlightSession();
    session.key('KeyW', true);
    session.advance(0.005);
    session.applyFixture(CLOUD_BASE_FLIGHT_FIXTURE);
    const expected = stepFlight(session.state, session.controls, undefined, session.environment);
    session.togglePause();
    session.advance(0.01);
    expect(session.state).toEqual(expected);
    expect(session.controls.throttle).toBe(CLOUD_BASE_FLIGHT_FIXTURE.controls.throttle);
  });

  it('does not let a later flight mutate the reusable captured state', () => {
    const session = new FlightSession();
    const source = structuredClone(CLOUD_BASE_FLIGHT_FIXTURE);
    session.applyFixture(CLOUD_BASE_FLIGHT_FIXTURE);
    session.state.position_N_m[0] = 0;
    session.environment.wind_N_m_s[1] = 10;
    session.reset();
    expect(CLOUD_BASE_FLIGHT_FIXTURE).toEqual(source);
    expect(session.state.time_s).toBe(0);
    expect(session.paused).toBe(false);
  });
});
