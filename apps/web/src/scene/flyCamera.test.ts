import { describe, expect, it } from 'vitest';
import { directionFromLatLon } from './terrain/heightField';
import {
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
