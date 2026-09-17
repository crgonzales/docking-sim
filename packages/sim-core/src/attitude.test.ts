import { describe, expect, it } from 'vitest';
import {
  bodyToHill,
  conjugateQuaternion,
  errorQuaternion,
  hillFromInertial,
  hillToBody,
  multiplyQuaternion,
  normalizeQuaternion,
  quaternionFromBasis,
  rotateVector,
  slerp,
  smallAngleExp,
  smallAngleLog,
} from './attitude.js';
import type { Quat, Vec3 } from './types.js';

function expectVecClose(actual: Vec3, expected: Vec3, precision = 12): void {
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, precision));
}

describe('attitude algebra and frame chain', () => {
  it('satisfies quaternion identities and small-angle exp/log round trips', () => {
    const q = normalizeQuaternion(smallAngleExp([0.2, -0.1, 0.3]));
    const identity = multiplyQuaternion(q, conjugateQuaternion(q));
    expect(identity[0]).toBeCloseTo(1, 14);
    identity.slice(1).forEach((value) => expect(value).toBeCloseTo(0, 14));
    const vector: Vec3 = [1.2, -0.4, 2.1];
    expectVecClose(rotateVector(conjugateQuaternion(q), rotateVector(q, vector)), vector, 12);
    expectVecClose(smallAngleLog(smallAngleExp([0.002, -0.003, 0.001])), [0.002, -0.003, 0.001], 12);
  });

  it('round-trips vectors through the epoch-aligned Hill/body frame chain', () => {
    const q_BI: Quat = normalizeQuaternion(smallAngleExp([0.3, -0.2, 0.4]));
    const t_s = 137.5;
    const vectorHill: Vec3 = [2, -3, 5];
    const vectorBody = rotateVector(hillToBody(q_BI, t_s), vectorHill);
    const roundTrip = rotateVector(bodyToHill(q_BI, t_s), vectorBody);
    expectVecClose(roundTrip, vectorHill, 12);
    expect(hillFromInertial(0)).toEqual([1, 0, 0, 0]);
    const q_IH = hillFromInertial(t_s);
    expectVecClose(rotateVector(q_IH, [1, 0, 0]), [
      q_IH[0] * q_IH[0] - q_IH[3] * q_IH[3],
      2 * q_IH[0] * q_IH[3],
      0,
    ], 12);
  });

  it('uses the shortest double-cover path for errors and interpolation', () => {
    const q = normalizeQuaternion(smallAngleExp([0.4, 0.1, -0.2]));
    const negative: Quat = [-q[0], -q[1], -q[2], -q[3]];
    errorQuaternion(q, negative).forEach((value, index) => expect(value).toBeCloseTo(index === 0 ? 1 : 0, 14));
    slerp(q, negative, 0.5).forEach((value, index) => expect(value).toBeCloseTo(q[index]!, 14));
  });
});

/**
 * Launch attitude uses an axis triad rather than Euler angles precisely because
 * a vehicle standing on its pad is the singular pose for pitch/yaw/roll. NED is
 * north/east/down; body axes are forward/right/down, and q_BN rotates N→B.
 */
describe('quaternionFromBasis', () => {
  /** Desired body-forward direction for pitch above the horizon and azimuth from north. */
  const forwardFor = (pitch_rad: number, azimuth_rad: number): Vec3 => [
    Math.cos(pitch_rad) * Math.cos(azimuth_rad),
    Math.cos(pitch_rad) * Math.sin(azimuth_rad),
    -Math.sin(pitch_rad),
  ];

  /** The full body triad, built the way the launch attitude contract prescribes. */
  function triad(pitch_rad: number, azimuth_rad: number): { f: Vec3; r: Vec3; d: Vec3 } {
    const f = forwardFor(pitch_rad, azimuth_rad);
    const reference: Vec3 = [-Math.sin(azimuth_rad), Math.cos(azimuth_rad), 0];
    const projection = reference[0] * f[0] + reference[1] * f[1] + reference[2] * f[2];
    const raw: Vec3 = [
      reference[0] - projection * f[0],
      reference[1] - projection * f[1],
      reference[2] - projection * f[2],
    ];
    const norm = Math.hypot(...raw);
    const r: Vec3 = [raw[0] / norm, raw[1] / norm, raw[2] / norm];
    const d: Vec3 = [
      f[1] * r[2] - f[2] * r[1],
      f[2] * r[0] - f[0] * r[2],
      f[0] * r[1] - f[1] * r[0],
    ];
    return { f, r, d };
  }

  it('maps each source axis onto its destination axis', () => {
    const { f, r, d } = triad(0.7, 1.1);
    const q = quaternionFromBasis(f, r, d);
    expectVecClose(rotateVector(q, f), [1, 0, 0], 12);
    expectVecClose(rotateVector(q, r), [0, 1, 0], 12);
    expectVecClose(rotateVector(q, d), [0, 0, 1], 12);
  });

  it('is regular at the vertical pad pose, where Euler angles are not', () => {
    const { f, r, d } = triad(Math.PI / 2, 0);
    expectVecClose(f, [0, 0, -1], 12);
    const q = quaternionFromBasis(f, r, d);
    // Local up becomes body forward: the rocket points at the sky.
    expectVecClose(rotateVector(q, [0, 0, -1]), [1, 0, 0], 12);
    expectVecClose(rotateVector(q, r), [0, 1, 0], 12);
    expect(Math.hypot(...q)).toBeCloseTo(1, 14);
    q.forEach((value) => expect(Number.isFinite(value)).toBe(true));
  });

  it('keeps the vertical pose regular at a nonzero azimuth and tracks the reference', () => {
    const azimuth_rad = 135 * Math.PI / 180;
    const { f, r, d } = triad(Math.PI / 2, azimuth_rad);
    const q = quaternionFromBasis(f, r, d);
    // Body forward is still exactly local up, whatever the azimuth.
    expectVecClose(rotateVector(q, [0, 0, -1]), [1, 0, 0], 12);
    // Body right follows the azimuth reference, so azimuth fixes roll at 90 degrees pitch.
    expectVecClose(r, [-Math.sin(azimuth_rad), Math.cos(azimuth_rad), 0], 12);
    expectVecClose(rotateVector(q, r), [0, 1, 0], 12);
    expect(Math.hypot(...q)).toBeCloseTo(1, 14);
  });

  it('round-trips a vector through the rotation and its conjugate', () => {
    const { f, r, d } = triad(1.2, -2.4);
    const q = quaternionFromBasis(f, r, d);
    const vector: Vec3 = [3.1, -0.7, 2.2];
    expectVecClose(rotateVector(conjugateQuaternion(q), rotateVector(q, vector)), vector, 11);
  });

  it('stays stable through a full pitch sweep, including the 180 degree branch', () => {
    for (let index = 0; index <= 36; index++) {
      const pitch_rad = -Math.PI / 2 + index * Math.PI / 36;
      const { f, r, d } = triad(pitch_rad, 0.3);
      const q = quaternionFromBasis(f, r, d);
      expect(Math.hypot(...q)).toBeCloseTo(1, 12);
      expectVecClose(rotateVector(q, f), [1, 0, 0], 10);
    }
    // The branch a trace-only formula would lose: a 180 degree yaw about down.
    const q = quaternionFromBasis([-1, 0, 0], [0, -1, 0], [0, 0, 1]);
    expect(Math.hypot(...q)).toBeCloseTo(1, 14);
    expectVecClose(rotateVector(q, [-1, 0, 0]), [1, 0, 0], 12);
  });

  it('rejects a basis that is not orthonormal and right-handed', () => {
    expect(() => quaternionFromBasis([2, 0, 0], [0, 1, 0], [0, 0, 1])).toThrow(RangeError);
    expect(() => quaternionFromBasis([1, 0, 0], [1, 0, 0], [0, 0, 1])).toThrow(RangeError);
    // Left-handed: f × r = -d.
    expect(() => quaternionFromBasis([1, 0, 0], [0, 1, 0], [0, 0, -1])).toThrow(RangeError);
    expect(() => quaternionFromBasis([Number.NaN, 0, 0], [0, 1, 0], [0, 0, 1])).toThrow(RangeError);
  });
});
