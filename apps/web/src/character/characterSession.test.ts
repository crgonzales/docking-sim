import { describe, expect, it } from 'vitest';
import { smallAngleExp, type FlightState, type Vec3 } from '@docking/sim-core';
import { FlightSession } from '../flight/flightSession';
import { CharacterSession, characterRouteFromSearch, CHARACTER_MAX_DISTANCE_M } from './characterSession';
import { CHARACTER_MAX_PITCH_RAD } from './characterView';
import type { GroundSampler } from './characterGround';

const press = (session: CharacterSession, code: string) => { session.key(code, true); session.key(code, false); };
const groundSession = (groundSampler: GroundSampler = () => 100) => new CharacterSession({ start: 'GROUND', groundSampler });
const run = (session: CharacterSession, seconds: number, fps = 30) => {
  for (let i = 0; i < Math.round(seconds * fps); i++) session.advance(1 / fps);
};
function stoppedFlight(overrides: Partial<FlightState> = {}, groundSampler: GroundSampler = () => 100) {
  const flight = new FlightSession();
  flight.state = { ...flight.state, position_N_m: [100, 20, -102], velocity_N_m_s: [0, 0, 0], q_BN: [1, 0, 0, 0], omega_B_rad_s: [0, 0, 0], ...overrides };
  return new CharacterSession({ flight, start: 'AIRBORNE', groundSampler });
}

describe('character ownership and safe interaction', () => {
  it('defaults to the base and preserves an explicitly selected airborne trajectory', () => {
    expect(characterRouteFromSearch('?mode=flight')).toEqual({ enabled: true, start: 'GROUND' });
    expect(characterRouteFromSearch('?mode=flight&character=1&start=ground')).toEqual({ enabled: true, start: 'GROUND' });
    const normal = new FlightSession(), character = new CharacterSession({ start: 'AIRBORNE', groundSampler: () => null });
    normal.key('KeyE', true); character.key('KeyE', true);
    for (let i = 0; i < 10; i++) { normal.advance(0.1); character.advance(0.1); }
    expect(character.flight.state).toEqual(normal.state);
    expect(character.flight.controls).toEqual(normal.controls);
    expect(character.interact().kind).toBe('REJECTED');
    expect(character.mode).toBe('VEHICLE');
  });

  it('waits above the fixture for land, clears waiting input, then permits a board/exit round trip', () => {
    let height: number | null = null;
    const s = groundSession(() => height), waiting = s.position_N_m;
    expect(waiting[2]).toBe(-1000);
    s.key('KeyW', true); s.advance(0.1);
    expect(s.groundReady).toBe(false);
    expect(s.position_N_m).toEqual(waiting);
    expect(s.interact().kind).toBe('REJECTED');
    height = 100; s.advance(0.1);
    expect(s.position_N_m).toEqual([waiting[0], waiting[1], -100]);
    expect(s.groundReady).toBe(true);
    expect(s.interact().kind).toBe('BOARDED');
    expect(s.mode).toBe('VEHICLE');
    expect(s.parked).toBe(true);
    s.advance(100);
    expect(s.flight.state.time_s).toBe(0);
    expect(s.interact().kind).toBe('EXITED');
    expect(s.mode).toBe('ON_FOOT');
    expect(s.position_N_m[2]).toBe(-100);
  });

  it('keeps an ordinary stopped aircraft at its original world location after exit and terrain refinement', () => {
    let height = 100;
    const s = stoppedFlight({}, () => height);
    s.flight.pointer('KeyE', 5, true);
    s.key('KeyW', true);
    expect(s.interact().kind).toBe('EXITED');
    s.advance(0.1);
    expect(s.flight.state.position_N_m).toEqual([100, 20, -102.4]);
    expect(s.position_N_m).toEqual([100, 28, -100]);
    height = 110; s.advance(0.1);
    expect(s.flight.state.position_N_m).toEqual([100, 20, -112.4]);
    expect(s.position_N_m[2]).toBe(-110);
    expect(s.interact().kind).toBe('BOARDED');
    height = 111; s.advance(0.1);
    expect(s.flight.state.position_N_m).toEqual([100, 20, -113.4]);
    expect(s.flight.state.time_s).toBe(0);
    expect(s.flight.controls).toMatchObject({ throttle: 0, pitch: 0, roll: 0, yaw: 0 });
  });

  it.each([
    ['airborne', { position_N_m: [100, 20, -1500] }],
    ['high horizontal speed', { velocity_N_m_s: [180, 0, 0] }],
    ['high vertical speed', { velocity_N_m_s: [0, 0, 2] }],
    ['body rate', { omega_B_rad_s: [0.2, 0, 0] }],
    ['bank', { q_BN: smallAngleExp([0.6, 0, 0]) }],
    ['terminal contact', { status: 'CONTACT' }],
    ['invalid attitude', { q_BN: [NaN, 0, 0, 0] }],
  ] as [string, Partial<FlightState>][])('rejects %s exits without moving or unpowering the aircraft', (_, overrides) => {
    const s = stoppedFlight(overrides), before = structuredClone(s.flight.state), controls = { ...s.flight.controls };
    expect(s.interact().kind).toBe('REJECTED');
    expect(s.mode).toBe('VEHICLE');
    expect(s.flight.state).toEqual(before);
    expect(s.flight.controls).toEqual(controls);
  });

  it.each([null, -10, 0, NaN])('rejects unknown/non-land height %s', (height) => {
    expect(stoppedFlight({}, () => height).interact().kind).toBe('REJECTED');
    const s = groundSession(() => height);
    s.key('KeyW', true); s.advance(0.1);
    expect(s.groundReady).toBe(false);
    expect(s.interact().kind).toBe('REJECTED');
  });

  it('rejects unsafe wing-side terrain, distant boarding, and newly ungrounded boarding', () => {
    expect(stoppedFlight({}, (p) => p[1] > 25 ? 105 : 100).interact().kind).toBe('REJECTED');
    let height = 100;
    const s = groundSession(() => height);
    s.key('KeyD', true); run(s, 3); s.key('KeyD', false);
    expect(s.interact().kind).toBe('REJECTED');
    expect(s.interaction.message).toContain('12 M');
    s.reset(); height = 110;
    expect(s.interact().kind).toBe('REJECTED');
    s.advance(0.1);
    expect(s.interact().kind).toBe('BOARDED');
  });

  it('isolates walking, running and equipment from aircraft control and clears holds on transitions', () => {
    const s = groundSession(), initialControls = { ...s.flight.controls };
    s.key('KeyW', true); s.key('ShiftLeft', true); s.key('KeyE', true);
    press(s, 'Digit2'); expect(s.equipment).toBe('TOOL');
    press(s, 'Digit3'); expect(s.equipment).toBe('WEAPON');
    run(s, 0.5);
    expect(s.flight.controls).toEqual(initialControls);
    expect(s.flight.state.time_s).toBe(0);
    expect(s.interact().kind).toBe('BOARDED');
    press(s, 'Digit3'); expect(s.equipment).toBe('EMPTY');
    expect(s.interact().kind).toBe('EXITED');
    const foot = s.position_N_m;
    run(s, 1);
    expect(s.position_N_m).toEqual(foot);
    expect(s.flight.controls).toEqual(initialControls);
    press(s, 'Digit2'); press(s, 'Digit1'); expect(s.equipment).toBe('EMPTY');
  });
});

describe('ground walking and lifecycle', () => {
  it('normalizes diagonal speed and is identical at 30 and 144 render fps', () => {
    const slow = groundSession(), fast = groundSession(), straight = groundSession();
    const origin = slow.position_N_m;
    for (const s of [slow, fast]) { s.key('KeyW', true); s.key('KeyD', true); }
    straight.key('KeyW', true);
    run(slow, 1, 30); run(fast, 1, 144); run(straight, 1, 30);
    expect(slow.position_N_m).toEqual(fast.position_N_m);
    expect(Math.hypot(slow.position_N_m[0] - origin[0], slow.position_N_m[1] - origin[1])).toBeCloseTo(3, 7);
    expect(straight.position_N_m[0] - origin[0]).toBeCloseTo(3, 7);
  });

  it('tracks a gentle slope, rejects steep/unknown/water destinations, and bounds travel', () => {
    const n = groundSession().position_N_m[0];
    const slope = groundSession((p) => 100 + 0.2 * (p[0] - n));
    slope.key('KeyW', true); run(slope, 1);
    expect(slope.position_N_m[2]).toBeCloseTo(-100.6, 7);
    for (const rejected of [null, -1, 102]) {
      const s = groundSession((p) => p[0] > n ? rejected : 100), before = s.position_N_m;
      s.key('KeyW', true); run(s, 1);
      expect(s.position_N_m).toEqual(before);
    }
    const bounded = groundSession(); bounded.key('KeyW', true); bounded.key('ShiftLeft', true); run(bounded, 40);
    expect(Math.hypot(bounded.position_N_m[0] - bounded.flight.state.position_N_m[0], bounded.position_N_m[1] - bounded.flight.state.position_N_m[1])).toBeLessThanOrEqual(CHARACTER_MAX_DISTANCE_M);
  });

  it('freezes pose, look, equipment and terrain updates while paused; focus/reset discard holds and partial time', () => {
    let height = 100;
    const s = groundSession(() => height);
    s.key('KeyW', true); s.advance(0.005); s.togglePause();
    const foot = s.position_N_m, flight = structuredClone(s.flight.state);
    height = 110; s.look(1, 1); press(s, 'Digit3'); s.advance(100);
    expect(s.position_N_m).toEqual(foot); expect(s.flight.state).toEqual(flight);
    expect(s.yaw_rad).toBe(0); expect(s.equipment).toBe('EMPTY');
    expect(s.interact().kind).toBe('REJECTED');
    s.togglePause(); s.advance(0.005);
    expect(s.position_N_m).toEqual([foot[0], foot[1], -110]);
    s.key('KeyW', true); s.loseFocus(); expect(s.paused).toBe(true);
    s.togglePause(); s.advance(0.1);
    expect(s.position_N_m[0]).toBe(foot[0]);
    s.key('KeyW', true); s.reset(); s.advance(0.1);
    expect(s.position_N_m[0]).toBe(foot[0]);
    expect(s.mode).toBe('ON_FOOT'); expect(s.paused).toBe(false);
  });

  it('caps catch-up, rejects invalid time/look, and clamps sustained keyboard look below vertical', () => {
    const s = groundSession(), before = s.position_N_m;
    s.key('KeyW', true); s.advance(NaN); s.advance(-1); s.advance(Infinity);
    expect(s.position_N_m).toEqual(before);
    s.advance(100); expect(s.position_N_m[0] - before[0]).toBeCloseTo(0.3, 7);
    s.key('KeyW', false); s.key('ArrowUp', true); s.key('ArrowRight', true); run(s, 10);
    expect(s.pitch_rad).toBe(CHARACTER_MAX_PITCH_RAD);
    expect(s.yaw_rad).toBeGreaterThanOrEqual(-Math.PI); expect(s.yaw_rad).toBeLessThan(Math.PI);
    const pose = s.camera;
    expect(s.look(NaN, 0)).toBe(false); expect(s.look(0, Infinity)).toBe(false);
    expect(s.camera).toEqual(pose);
    expect([...pose.forwardWorld, ...pose.eyeWorld].every(Number.isFinite)).toBe(true);
  });

  it('adopts existing flight pause and stops the coordinator at terminal contact', () => {
    const flight = new FlightSession(); flight.loseFocus();
    const s = new CharacterSession({ flight, start: 'AIRBORNE' });
    expect(s.paused).toBe(true); s.togglePause(); expect(flight.paused).toBe(false);
    flight.state = { ...flight.state, position_N_m: [0, 0, -2.001], velocity_N_m_s: [0, 0, 10] as Vec3 };
    s.advance(0.1);
    expect(flight.state.status).toBe('CONTACT'); expect(s.paused).toBe(true);
  });
});
