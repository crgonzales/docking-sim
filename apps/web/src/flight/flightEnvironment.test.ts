import { describe, expect, it } from 'vitest';
import { FlightEnvironmentClock, ENVIRONMENT_DAY_SECONDS, subscribeEnvironmentToFlightReset } from './flightEnvironment';
import { FlightSession } from './flightSession';
import { CharacterSession } from '../character/characterSession';
import { airfieldGroundHeight, AIRFIELD_ANCHOR_N_M } from '../airfield/airfieldSite';

describe('flight environment time', () => {
  it.each([1, 60])('advances at %sx equally at 30, 60 and 144 FPS', (scale) => {
    for (const fps of [30, 60, 144]) {
      const clock = new FlightEnvironmentClock({ startTimeSeconds: 0, timeScale: scale });
      for (let i = 0; i < fps * 10; i++) clock.advance(1 / fps);
      expect(clock.state.timeSeconds).toBeCloseTo(10 * scale, 7);
    }
  });
  it('crosses midnight continuously, without a seek or weather jump', () => {
    const clock = new FlightEnvironmentClock({ startTimeSeconds: ENVIRONMENT_DAY_SECONDS - 0.05 });
    clock.advance(0.1);
    expect(clock.state.timeSeconds).toBeCloseTo(ENVIRONMENT_DAY_SECONDS + 0.05, 8);
    expect(clock.state.timeOfDaySeconds).toBeCloseTo(0.05, 8);
    expect(clock.state.discontinuityRevision).toBe(0);
  });
  it('does not advance during focus loss or 96 paused settling frames', () => {
    const clock = new FlightEnvironmentClock();
    clock.loseFocus();
    const before = clock.state;
    for (let i = 0; i < 96; i++) expect(clock.advance(1 / 30)).toBe(0);
    expect(clock.state).toBe(before);
    clock.setPaused(false);
    expect(clock.advance(600)).toBe(0.1);
  });
  it('restores the configured local time after seeking and reset', () => {
    const clock = new FlightEnvironmentClock({ startTimeSeconds: 8 * 3600, localLongitudeDeg: 30, paused: true });
    clock.seekLocalSolarHours(22);
    expect(clock.state.localSolarTimeHours).toBe(22);
    expect(clock.state.paused).toBe(true);
    clock.reset();
    expect(clock.state.localSolarTimeHours).toBe(8);
    expect(clock.state.discontinuityRevision).toBe(2);
  });
  it('puts the sun east at dawn, overhead at noon, west at dusk and below at night', () => {
    const clock = new FlightEnvironmentClock();
    const cases = [[6, [0, 0, -1]], [12, [1, 0, 0]], [18, [0, 0, 1]], [0, [-1, 0, 0]]] as const;
    for (const [hour, direction] of cases) {
      clock.seekLocalSolarHours(hour);
      direction.forEach((v, i) => expect(clock.state.sunDirection[i]).toBeCloseTo(v, 12));
      expect(Math.hypot(...clock.state.sunDirection)).toBeCloseTo(1, 12);
    }
    expect(clock.state.directLightFactor).toBe(0);
  });
  it('uses longitude to label local noon without rotating the planet convention', () => {
    const clock = new FlightEnvironmentClock({ startTimeSeconds: 12 * 3600, localLongitudeDeg: 90 });
    // +90°E in our world is [0,0,-1]. Local noon points along that radial.
    expect(clock.state.sunDirection[2]).toBeCloseTo(-1, 12);
    expect(clock.state.sunElevationSin).toBeCloseTo(1, 12);
  });
  it('rejects nonfinite input and does not notify the UI every rendered frame', () => {
    const clock = new FlightEnvironmentClock();
    expect(() => clock.advance(NaN)).toThrow();
    expect(() => clock.setTimeScale(Infinity)).toThrow();
    expect(() => clock.seekLocalSolarHours(NaN)).toThrow();
    let notifications = 0;
    clock.subscribe(() => notifications++);
    for (let i = 0; i < 60; i++) clock.advance(1 / 60);
    expect(notifications).toBeGreaterThan(5);
    expect(notifications).toBeLessThanOrEqual(10);
    clock.setPaused(true);
    expect(clock.getSnapshot()).toBe(clock.state);
  });
  it('receives resets from both keyboard paths and direct HUD actions', () => {
    for (const start of [null, 'GROUND', 'AIRBORNE'] as const) {
      const flight = new FlightSession();
      const character = start === null ? null : new CharacterSession({
        flight, start, groundSampler: airfieldGroundHeight, fixtureAnchor_N_m: AIRFIELD_ANCHOR_N_M,
      });
      const owner = character ?? flight;
      const clock = new FlightEnvironmentClock();
      let resets = 0;
      const unsubscribe = subscribeEnvironmentToFlightReset(clock, flight, character, () => resets++);
      clock.seekLocalSolarHours(22);
      const revision = clock.state.discontinuityRevision;
      owner.key('KeyR', true); owner.key('KeyR', false);
      expect(clock.state.localSolarTimeHours).toBe(10);
      expect(clock.state.discontinuityRevision).toBe(revision + 1);
      expect(resets).toBe(1);
      clock.seekLocalSolarHours(2); owner.reset();
      expect(clock.state.localSolarTimeHours).toBe(10);
      expect(resets).toBe(2);
      if (start !== 'GROUND') {
        clock.seekLocalSolarHours(15);
        flight.startExercise('TURN_RIGHT');
        expect(clock.state.localSolarTimeHours).toBe(10);
        expect(resets).toBe(3);
      }
      unsubscribe();
      clock.seekLocalSolarHours(15); owner.reset();
      expect(clock.state.localSolarTimeHours).toBe(15);
    }
  });
});
