import { describe, expect, it } from 'vitest';
import {
  bodyToHill,
  conjugateQuaternion,
  errorQuaternion,
  hillFromInertial,
  hillToBody,
  multiplyQuaternion,
  normalizeQuaternion,
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
