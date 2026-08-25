import { describe, expect, it } from 'vitest';
import { directionFromLatLon } from './terrain/heightField';
import {
  clampFlyPositionToGround,
  flyBasisFromPosition,
  flyForward,
  flyPoseFromDirection,
  flyRight,
} from './flyCamera';

function dot(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

describe('local-frame debug flight', () => {
  it('keeps the camera up vector aligned with geodetic up at several latitudes', () => {
    for (const [latDeg, lonDeg] of [[0, 0], [28.6, -80.6], [60, 120], [-45, 30]]) {
      const up = directionFromLatLon(latDeg * Math.PI / 180, lonDeg * Math.PI / 180);
      const basis = flyBasisFromPosition(up.map((value) => value * 1000) as [number, number, number]);
      expect(dot(basis.up, up)).toBeCloseTo(1, 12);
      expect(dot(basis.north, basis.up)).toBeCloseTo(0, 12);
      expect(dot(basis.east, basis.up)).toBeCloseTo(0, 12);
      expect(dot(basis.north, basis.east)).toBeCloseTo(0, 12);
    }
  });

  it('round-trips yaw and pitch in the local tangent frame', () => {
    for (const [latDeg, lonDeg] of [[0, 0], [35, -80], [-55, 140]]) {
      const up = directionFromLatLon(latDeg * Math.PI / 180, lonDeg * Math.PI / 180);
      const basis = flyBasisFromPosition(up);
      const yaw = 0.7;
      const pitch = 0.25;
      const forward = flyForward(yaw, pitch, basis.up);
      const pose = flyPoseFromDirection(forward, basis.up);
      expect(pose.yawRad).toBeCloseTo(yaw, 12);
      expect(pose.pitchRad).toBeCloseTo(pitch, 12);
      expect(dot(flyRight(yaw, basis.up), basis.up)).toBeCloseTo(0, 12);
    }
  });
});

describe('clampFlyPositionToGround', () => {
  const PLANET_RADIUS_M = 6_371_000;

  it('takes planet-centred coordinates: pushes a below-floor position radially up to the floor', () => {
    const belowFloor: [number, number, number] = [PLANET_RADIUS_M - 100, 0, 0];
    const clamped = clampFlyPositionToGround(belowFloor, PLANET_RADIUS_M, 30, 2);
    const floorRadius = PLANET_RADIUS_M + 30 + 2;
    expect(Math.hypot(...clamped)).toBeCloseTo(floorRadius, 6);
    // Direction from the planet centre is preserved — only the radius changes.
    expect(clamped[1]).toBeCloseTo(0, 9);
    expect(clamped[2]).toBeCloseTo(0, 9);
  });

  it('leaves an above-floor position unchanged', () => {
    const aboveFloor: [number, number, number] = [PLANET_RADIUS_M + 5000, 0, 0];
    const clamped = clampFlyPositionToGround(aboveFloor, PLANET_RADIUS_M, 30, 2);
    expect(clamped).toEqual(aboveFloor);
  });

  it('treats negative ground height (below sea level) as a sea-level floor', () => {
    const belowFloor: [number, number, number] = [PLANET_RADIUS_M - 100, 0, 0];
    const clamped = clampFlyPositionToGround(belowFloor, PLANET_RADIUS_M, -500, 2);
    expect(Math.hypot(...clamped)).toBeCloseTo(PLANET_RADIUS_M + 2, 6);
  });

  it('does not silently pass on a station-relative (non-planet-centred) position', () => {
    // Regression guard for the CameraRig bug: a small station-relative
    // magnitude read as a planet-centred radius reads as "deep underground"
    // and gets scaled up by orders of magnitude instead of left alone.
    const stationRelative: [number, number, number] = [0, -320, 60];
    const clamped = clampFlyPositionToGround(stationRelative, PLANET_RADIUS_M, 30, 2);
    const scaleFactor = Math.hypot(...clamped) / Math.hypot(...stationRelative);
    expect(scaleFactor).toBeGreaterThan(1000);
  });
});
