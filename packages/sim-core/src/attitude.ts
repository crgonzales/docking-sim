import { MU_EARTH_M3_S2, R_EARTH_M } from './constants.js';
import type { Quat, Vec3 } from './types.js';

/** Mean motion used by the epoch-aligned inertial/Hill frame chain. */
export const DEFAULT_MEAN_MOTION_RAD_S = Math.sqrt(
  MU_EARTH_M3_S2 / (R_EARTH_M + 400_000) ** 3,
);

function finiteQuaternion(q: Quat): void {
  if (q.some((value) => !Number.isFinite(value))) throw new RangeError('quaternion must be finite');
}

function finiteVector(v: Vec3): void {
  if (v.some((value) => !Number.isFinite(value))) throw new RangeError('vector must be finite');
}

/**
 * Hamilton scalar-first quaternion product. The product composes vector
 * rotations: q_AB ⊗ q_BC rotates vectors C→A through the intermediate B frame.
 */
export function multiplyQuaternion(a: Quat, b: Quat): Quat {
  finiteQuaternion(a);
  finiteQuaternion(b);
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

/**
 * Quaternion conjugate, which reverses a unit quaternion's vector rotation:
 * q_AB's conjugate rotates vectors B→A.
 */
export function conjugateQuaternion(q: Quat): Quat {
  finiteQuaternion(q);
  return [q[0], -q[1], -q[2], -q[3]];
}

/**
 * Normalize a quaternion without changing its vector-rotation direction. A
 * zero quaternion returns the identity rotation rather than producing NaNs.
 */
export function normalizeQuaternion(q: Quat): Quat {
  finiteQuaternion(q);
  const norm = Math.hypot(...q);
  if (norm === 0) return [1, 0, 0, 0];
  return [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm];
}

/**
 * Rotate vector components between frames via q ⊗ [0,v] ⊗ conjugate(q).
 * Subscripts are destination-first, matching ARCHI's q_BI (rotates I→B):
 * rotateVector(q_AB, v_B) = v_A — components in frame B become frame A.
 */
export function rotateVector(q: Quat, v: Vec3): Vec3 {
  finiteQuaternion(q);
  finiteVector(v);
  const unit = normalizeQuaternion(q);
  const vectorQuaternion: Quat = [0, v[0], v[1], v[2]];
  const rotated = multiplyQuaternion(multiplyQuaternion(unit, vectorQuaternion), conjugateQuaternion(unit));
  return [rotated[1], rotated[2], rotated[3]];
}

/**
 * Exponential map from a rotation vector to a quaternion. The resulting
 * quaternion rotates vectors from the input frame to the output frame using
 * the right-hand rule; the vector is an axis-angle rotation in radians.
 */
export function smallAngleExp(rotationVector_rad: Vec3): Quat {
  finiteVector(rotationVector_rad);
  const angle_rad = Math.hypot(...rotationVector_rad);
  if (angle_rad < 1e-12) {
    const scale = 0.5 - angle_rad * angle_rad / 48;
    return normalizeQuaternion([
      1 - angle_rad * angle_rad / 8,
      rotationVector_rad[0] * scale,
      rotationVector_rad[1] * scale,
      rotationVector_rad[2] * scale,
    ]);
  }
  const scale = Math.sin(angle_rad / 2) / angle_rad;
  return [
    Math.cos(angle_rad / 2),
    rotationVector_rad[0] * scale,
    rotationVector_rad[1] * scale,
    rotationVector_rad[2] * scale,
  ];
}

/**
 * Logarithm map from a quaternion to its shortest rotation vector. The vector
 * represents the quaternion's source→destination vector rotation and always
 * chooses the positive-scalar double-cover representative.
 */
export function smallAngleLog(q: Quat): Vec3 {
  const unit = normalizeQuaternion(q);
  const sign = unit[0] < 0 ? -1 : 1;
  const w = unit[0] * sign;
  const x = unit[1] * sign;
  const y = unit[2] * sign;
  const z = unit[3] * sign;
  const vectorNorm = Math.hypot(x, y, z);
  if (vectorNorm < 1e-12) return [2 * x, 2 * y, 2 * z];
  const angle_rad = 2 * Math.atan2(vectorNorm, w);
  const scale = angle_rad / vectorNorm;
  return [x * scale, y * scale, z * scale];
}

/**
 * Compute the shortest-path attitude error. `errorQuaternion(reference,
 * actual)` returns q_actual ⊗ conjugate(q_reference), rotating reference-frame
 * vectors into actual-frame vectors; its sign is chosen for the shortest
 * vector rotation so q and -q represent the same error.
 */
export function errorQuaternion(reference: Quat, actual: Quat): Quat {
  const error = normalizeQuaternion(multiplyQuaternion(actual, conjugateQuaternion(reference)));
  return error[0] < 0 ? [-error[0], -error[1], -error[2], -error[3]] : error;
}

/**
 * Spherical interpolation between two quaternion vector rotations. The
 * shortest double-cover path is selected, and the result rotates vectors from
 * the first quaternion's source frame toward the second's destination frame.
 */
export function slerp(a: Quat, b: Quat, fraction: number): Quat {
  if (!Number.isFinite(fraction)) throw new RangeError('slerp fraction must be finite');
  const qa = normalizeQuaternion(a);
  let qb = normalizeQuaternion(b);
  let dot = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3];
  if (dot < 0) {
    qb = [-qb[0], -qb[1], -qb[2], -qb[3]];
    dot = -dot;
  }
  if (dot > 0.9995) {
    return normalizeQuaternion([
      qa[0] + fraction * (qb[0] - qa[0]),
      qa[1] + fraction * (qb[1] - qa[1]),
      qa[2] + fraction * (qb[2] - qa[2]),
      qa[3] + fraction * (qb[3] - qa[3]),
    ]);
  }
  const angle_rad = Math.acos(Math.min(1, Math.max(-1, dot)));
  const sinAngle = Math.sin(angle_rad);
  const firstScale = Math.sin((1 - fraction) * angle_rad) / sinAngle;
  const secondScale = Math.sin(fraction * angle_rad) / sinAngle;
  return normalizeQuaternion([
    firstScale * qa[0] + secondScale * qb[0],
    firstScale * qa[1] + secondScale * qb[1],
    firstScale * qa[2] + secondScale * qb[2],
    firstScale * qa[3] + secondScale * qb[3],
  ]);
}

/**
 * Return q_IH, the epoch-aligned rotation of vectors Hill→inertial. At t=0
 * the Hill and inertial axes coincide; thereafter Hill rotates +z by n·t.
 */
export function hillFromInertial(
  t_s: number,
  meanMotionRadS = DEFAULT_MEAN_MOTION_RAD_S,
): Quat {
  if (!Number.isFinite(t_s) || !Number.isFinite(meanMotionRadS)) throw new RangeError('frame time and mean motion must be finite');
  return smallAngleExp([0, 0, meanMotionRadS * t_s]);
}

/**
 * Compose q_BH = q_BI ⊗ q_IH, which rotates vectors Hill→body through the
 * inertial frame. `q_BI` itself rotates inertial→body vectors.
 */
export function hillToBody(
  q_BI: Quat,
  t_s: number,
  meanMotionRadS = DEFAULT_MEAN_MOTION_RAD_S,
): Quat {
  return normalizeQuaternion(multiplyQuaternion(q_BI, hillFromInertial(t_s, meanMotionRadS)));
}

/**
 * Return q_HB = conjugate(q_BH), which rotates vectors body→Hill. This is the
 * inverse of hillToBody for the same epoch and mean motion.
 */
export function bodyToHill(
  q_BI: Quat,
  t_s: number,
  meanMotionRadS = DEFAULT_MEAN_MOTION_RAD_S,
): Quat {
  return conjugateQuaternion(hillToBody(q_BI, t_s, meanMotionRadS));
}

/** Hamilton product composing the source→destination vector rotations. */
export const multiply = multiplyQuaternion;
/** Conjugate reversing a unit quaternion's vector rotation direction. */
export const conjugate = conjugateQuaternion;
/** Normalize a quaternion without changing the vector rotation it represents. */
export const normalize = normalizeQuaternion;
