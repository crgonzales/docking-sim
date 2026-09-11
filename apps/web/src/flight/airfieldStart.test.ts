import { describe, expect, it } from 'vitest';
import { CharacterSession, characterRouteFromSearch } from '../character/characterSession';
import { CHARACTER_EYE_HEIGHT_M } from '../character/characterView';
import {
  AIRFIELD_ANCHOR_N_M, AIRFIELD_SPAWN_YAW_RAD, AIRFIELD_MAX_WALK_DISTANCE_M,
  AIRFIELD_BUILDING_FOOTPRINTS, airfieldGroundHeight, airfieldLocalPoint,
} from '../airfield/airfieldSite';
import { flightWorldFrame } from './flightFrame';

const baseSession = () => new CharacterSession({
  start: 'GROUND', groundSampler: airfieldGroundHeight,
  fixtureAnchor_N_m: AIRFIELD_ANCHOR_N_M,
  initialYawRad: AIRFIELD_SPAWN_YAW_RAD,
  spawnSideOffsetM: 11.5,
  maxDistanceM: AIRFIELD_MAX_WALK_DISTANCE_M,
});
const press = (session: CharacterSession, code: string) => { session.key(code, true); session.key(code, false); };
const run = (session: CharacterSession, seconds: number) => {
  for (let frame = 0; frame < seconds * 60; frame++) session.advance(1 / 60);
};

describe('runway first-person start', () => {
  it('opens flight on foot by default while retaining explicit airborne starts', () => {
    expect(characterRouteFromSearch('?mode=flight')).toEqual({ enabled: true, start: 'GROUND' });
    expect(characterRouteFromSearch('?mode=flight&start=airborne')).toEqual({ enabled: false, start: 'AIRBORNE' });
    expect(characterRouteFromSearch('?mode=flight&character=0')).toEqual({ enabled: false, start: 'AIRBORNE' });
    expect(characterRouteFromSearch('?mode=flight&character=1&start=airborne')).toEqual({ enabled: true, start: 'AIRBORNE' });
    expect(characterRouteFromSearch('?mode=flight&character=1&start=ground')).toEqual({ enabled: true, start: 'GROUND' });
  });

  it('stands on the rendered runway without waiting for terrain and faces the parked aircraft', () => {
    const session = baseSession();
    expect(session.mode).toBe('ON_FOOT');
    expect(session.groundReady).toBe(true);
    expect(session.parked).toBe(true);
    const feet = airfieldLocalPoint(session.position_N_m);
    expect(feet[0]).toBeGreaterThan(11);
    expect(feet[0]).toBeLessThan(11.6);
    expect(feet[1]).toBeCloseTo(0, 5);
    const worldFeet = flightWorldFrame(session.position_N_m).position;
    expect(Math.hypot(...session.camera.eyeWorld.map((v, i) => v - worldFeet[i]))).toBeCloseTo(CHARACTER_EYE_HEIGHT_M, 6);
    const plane = flightWorldFrame(session.flight.state.position_N_m).position;
    const towardPlane = plane.map((v, i) => v - session.camera.eyeWorld[i]);
    const facing = towardPlane.reduce((sum, v, i) => sum + v * session.camera.forwardWorld[i], 0) / Math.hypot(...towardPlane);
    expect(facing).toBeGreaterThan(0.99);
    expect(airfieldLocalPoint(session.flight.state.position_N_m)[1]).toBeCloseTo(2.4, 5);
  });

  it('walks along the runway beyond the old 150m bound without sinking or moving the aircraft', () => {
    const session = baseSession();
    const plane = structuredClone(session.flight.state);
    session.look(-session.yaw_rad, 0);
    session.key('KeyW', true); session.key('ShiftLeft', true);
    run(session, 35);
    session.releaseControls();
    expect(airfieldLocalPoint(session.position_N_m)[2]).toBeLessThan(-200);
    expect(airfieldLocalPoint(session.position_N_m)[1]).toBeCloseTo(0, 5);
    expect(session.flight.state).toEqual(plane);
    expect(session.interact().kind).toBe('REJECTED');
    session.reset();
    expect(session.yaw_rad).toBe(AIRFIELD_SPAWN_YAW_RAD);
    expect(session.interact().kind).toBe('BOARDED');
    session.key('ShiftLeft', true); session.key('KeyW', true); run(session, 2);
    expect(session.flight.controls).toMatchObject({ throttle: 0, pitch: 0, roll: 0, yaw: 0, trim: 0 });
    expect(session.flight.state).toEqual(plane);
    expect(session.interact().kind).toBe('EXITED');
    const exit = session.position_N_m;
    run(session, 1);
    expect(session.position_N_m).toEqual(exit);
  });

  it('stops at the platform edge and clears movement on pause/reset', () => {
    const session = baseSession();
    session.look(Math.PI, 0); // East, away from the airplane and buildings.
    session.key('KeyW', true); session.key('ShiftLeft', true); run(session, 30);
    const edge = session.position_N_m;
    expect(airfieldGroundHeight(edge)).not.toBeNull();
    run(session, 1); expect(session.position_N_m).toEqual(edge);
    press(session, 'KeyP'); run(session, 1); expect(session.position_N_m).toEqual(edge);
    press(session, 'KeyP'); run(session, 1); expect(session.position_N_m).toEqual(edge);
    press(session, 'KeyR');
    const reset = session.position_N_m; run(session, 1);
    expect(session.position_N_m).toEqual(reset);
    expect(airfieldLocalPoint(reset)[1]).toBeCloseTo(0, 5);
  });

  it('blocks sustained walking into the hangar facing the starting runway position', () => {
    const session = baseSession();
    const hangar = AIRFIELD_BUILDING_FOOTPRINTS.find((building) => building.id === 'hangar-charlie')!;
    session.key('KeyW', true); session.key('ShiftLeft', true); run(session, 30);
    const stopped = session.position_N_m;
    const local = airfieldLocalPoint(stopped);
    expect(local[0]).toBeGreaterThan(hangar.eastMaxM);
    expect(local[0]).toBeLessThan(hangar.eastMaxM + 1);
    run(session, 2);
    expect(session.position_N_m).toEqual(stopped);
  });
});
