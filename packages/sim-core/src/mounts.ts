import { conjugateQuaternion, quaternionFromBasis, rotateVector } from './attitude.js';
import { CORRIDOR } from './corridor.js';
import { STATION_PORT_HILL } from './sim.js';
import type { Quat, Vec3 } from './types.js';

export type MountProvenance =
  | { kind: 'SIM_ASSUMPTION'; reference: string }
  | { kind: 'IDSS_REV_E'; section: string; figure: string }
  | { kind: 'IDA_EXCEPTION'; section: '3.5.2' | 'Appendix D'; reference: string }
  | { kind: 'DERIVED'; reference: string };
export interface SensorMount {
  id: string;
  kind: 'OPTICAL_RANGE' | 'GNSS_ANTENNA' | 'RF_ANTENNA' | 'IMU' | 'STAR_TRACKER';
  r_body_m: Vec3;
  /** Hamilton scalar-first, body → sensor. */
  q_SB: Quat;
  boresight_sensor: Vec3;
  halfAngleFov_rad: number;
  minRange_m: number;
  maxRange_m: number;
  cadence_s: number;
  provenance: Extract<MountProvenance, { kind: 'SIM_ASSUMPTION' }>;
}
export interface TargetDatum {
  id: string;
  kind: 'PERIMETER_REFLECTOR' | 'CENTERLINE_TARGET';
  r_docking_m: Vec3;
  normal_docking: Vec3;
  acceptanceHalfAngle_rad: number;
  /** Revision E (October 2016); IDA exceptions cite §3.5.2 / Appendix D. */
  provenance: Extract<MountProvenance, { kind: 'IDSS_REV_E' | 'IDA_EXCEPTION' }>;
}
/** Bounded convex proxy, not a mesh or a surveyed spacecraft silhouette. */
export interface ConvexBlocker {
  id: string;
  kind: 'CAPSULE' | 'NOSECONE' | 'STATION_BODY';
  center_m: Vec3;
  halfExtent_m: Vec3;
  /** BODY → local box for capsule/nosecone; DOCKING → box for station. */
  q_localFrame: Quat;
  provenance: Extract<MountProvenance, { kind: 'SIM_ASSUMPTION' }>;
}
export interface MountGeometry {
  sensors: readonly SensorMount[];
  datums: readonly TargetDatum[];
  blockers: readonly ConvexBlocker[];
}
/** Separate role tags prevent accidentally substituting truth for calibration. */
export interface MountSet extends MountGeometry { role: 'ACTUAL' }
export interface MountCalibration extends MountGeometry { role: 'CALIBRATION' }
export interface MountPose { r_hill_m: Vec3; q_BH: Quat }
export interface Sightline {
  origin_hill_m: Vec3;
  target_hill_m: Vec3;
  normal_hill: Vec3;
  vector_sensor_m: Vec3;
  range_m: number;
}
export type VisibilityReason = 'VISIBLE' | 'UNKNOWN_MOUNT' | 'UNKNOWN_DATUM' | 'NEAR_ZERO_RANGE'
  | 'BELOW_MIN_RANGE' | 'ABOVE_MAX_RANGE' | 'OUTSIDE_FOV' | 'TARGET_OUTSIDE_ACCEPTANCE' | 'OCCLUDED';
export interface MountVisibility {
  valid: boolean;
  reason: VisibilityReason;
  sightline?: Sightline;
  blockerId?: string;
}
/** Numerical guard, not a receiver's minimum measurable range. */
export const MOUNT_NEAR_ZERO_M = 1e-9;
const ANGULAR_TOLERANCE = 1e-12;
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function finite(values: readonly number[], size: number, name: string) {
  if (!Array.isArray(values) || values.length !== size || !Array.from(values).every(Number.isFinite)) throw new RangeError(`${name} must contain ${size} finite values`);
}
function unit(values: readonly number[], size: number, name: string) {
  finite(values, size, name);
  if (Math.abs(Math.hypot(...values) - 1) > 1e-10) throw new RangeError(`${name} must be unit length`);
}
function angle(value: number, name: string) {
  if (!Number.isFinite(value) || value < 0 || value > Math.PI) throw new RangeError(`${name} must be in [0, pi]`);
}
function named(value: string, name: string) {
  if (typeof value !== 'string' || !value.trim()) throw new RangeError(`${name} must be named`);
}
function assumption(p: SensorMount['provenance']) {
  if (p?.kind !== 'SIM_ASSUMPTION') throw new RangeError('Capsule mounts and blocker proxies must be SIM_ASSUMPTION');
  named(p.reference, 'assumption reference');
}
function validateSensor(m: SensorMount) {
  named(m.id, 'mount id');
  if (!['OPTICAL_RANGE', 'GNSS_ANTENNA', 'RF_ANTENNA', 'IMU', 'STAR_TRACKER'].includes(m.kind)) throw new RangeError('Unknown mount kind');
  finite(m.r_body_m, 3, 'mount position'); unit(m.q_SB, 4, 'q_SB'); unit(m.boresight_sensor, 3, 'boresight');
  angle(m.halfAngleFov_rad, 'FOV'); assumption(m.provenance);
  if (!Number.isFinite(m.minRange_m) || !Number.isFinite(m.maxRange_m) || m.minRange_m < 0 || m.maxRange_m < m.minRange_m) throw new RangeError('Invalid mount range limits');
  if (!Number.isFinite(m.cadence_s) || m.cadence_s <= 0) throw new RangeError('Cadence must be positive and finite');
}
function validateDatum(d: TargetDatum) {
  named(d.id, 'datum id');
  if (!['PERIMETER_REFLECTOR', 'CENTERLINE_TARGET'].includes(d.kind)) throw new RangeError('Unknown datum kind');
  finite(d.r_docking_m, 3, 'datum position'); unit(d.normal_docking, 3, 'datum normal'); angle(d.acceptanceHalfAngle_rad, 'acceptance cone');
  if (d.provenance?.kind === 'IDSS_REV_E') {
    named(d.provenance.section, 'IDSS Revision E section'); named(d.provenance.figure, 'IDSS Revision E figure');
  } else if (d.provenance?.kind === 'IDA_EXCEPTION') {
    if (!['3.5.2', 'Appendix D'].includes(d.provenance.section)) throw new RangeError('IDA exception needs Revision E section 3.5.2 or Appendix D');
    named(d.provenance.reference, 'IDA exception reference');
  } else throw new RangeError('Station target needs IDSS_REV_E or IDA_EXCEPTION provenance');
}
function validateBlocker(b: ConvexBlocker) {
  named(b.id, 'blocker id');
  if (!['CAPSULE', 'NOSECONE', 'STATION_BODY'].includes(b.kind)) throw new RangeError('Unknown blocker kind');
  finite(b.center_m, 3, 'blocker center'); finite(b.halfExtent_m, 3, 'blocker half extents');
  if (b.halfExtent_m.some(v => v <= 0)) throw new RangeError('Blocker half extents must be positive');
  unit(b.q_localFrame, 4, 'blocker rotation'); assumption(b.provenance);
}
function validatePose(p: MountPose) { finite(p.r_hill_m, 3, 'chaser position'); unit(p.q_BH, 4, 'q_BH'); }

/** No installation preset: callers supply referenced station coordinates. Both
 * tables start equal but own disjoint nested data, including provenance. */
export function createMountTables(geometry: MountGeometry): { actual: MountSet; calibration: MountCalibration } {
  for (const entries of [geometry.sensors, geometry.datums, geometry.blockers]) {
    const ids = new Set<string>();
    for (const entry of entries) {
      // Each collection is checked separately below; IDs are namespaced by kind.
      if (ids.has(entry.id)) throw new RangeError(`Duplicate geometry id: ${entry.id}`);
      ids.add(entry.id);
    }
  }
  geometry.sensors.forEach(validateSensor); geometry.datums.forEach(validateDatum); geometry.blockers.forEach(validateBlocker);
  return { actual: { ...structuredClone(geometry), role: 'ACTUAL' },
    calibration: { ...structuredClone(geometry), role: 'CALIBRATION' } };
}

/** D origin is the shared port. D +x = Hill radial, D +z = outward corridor
 * axis, D +y completes the right-handed triad. This is our frame convention,
 * not an assertion that IDSS drawing axes already use it: survey inputs must
 * first be converted to this declared docking frame. Evaluated on demand so
 * importing geometry does not initialize a second port or SimLoop. */
export function stationDockingPose(): { r_hill_m: Vec3; q_DH: Quat } {
  const z = CORRIDOR.axis_hill, x: Vec3 = [1, 0, 0];
  const y: Vec3 = [0, z[2], -z[1]];
  return { r_hill_m: [...STATION_PORT_HILL], q_DH: quaternionFromBasis(x, y, z) };
}
export function stationDatumInHill(datum: TargetDatum): { r_hill_m: Vec3; normal_hill: Vec3 } {
  validateDatum(datum);
  const pose = stationDockingPose(), q_HD = conjugateQuaternion(pose.q_DH);
  return { r_hill_m: add(pose.r_hill_m, rotateVector(q_HD, datum.r_docking_m)),
    normal_hill: rotateVector(q_HD, datum.normal_docking) };
}
export function mountedSightline(mount: SensorMount, datum: TargetDatum, pose: MountPose): Sightline {
  validateSensor(mount); validatePose(pose);
  const target = stationDatumInHill(datum);
  const origin = add(pose.r_hill_m, rotateVector(conjugateQuaternion(pose.q_BH), mount.r_body_m));
  const vector = sub(target.r_hill_m, origin);
  return { origin_hill_m: origin, target_hill_m: target.r_hill_m, normal_hill: target.normal_hill,
    vector_sensor_m: rotateVector(mount.q_SB, rotateVector(pose.q_BH, vector)), range_m: Math.hypot(...vector) };
}

/** Closed convex box intersected with an open line segment. Contact only at a
 * sensor/target endpoint (within MOUNT_NEAR_ZERO_M) is ignored; internal tangency blocks.
 * An origin inside a hull blocks. No mesh, time evolution or moving nosecone
 * mechanism is implied; the caller supplies the current proxy pose. */
export function segmentIntersectsBlocker(start_hill_m: Vec3, end_hill_m: Vec3, blocker: ConvexBlocker, pose: MountPose): boolean {
  validateBlocker(blocker); validatePose(pose); finite(start_hill_m, 3, 'segment start'); finite(end_hill_m, 3, 'segment end');
  const station = stationDockingPose();
  const frame = blocker.kind === 'STATION_BODY' ? { r: station.r_hill_m, q: station.q_DH } : { r: pose.r_hill_m, q: pose.q_BH };
  const local = (p: Vec3) => rotateVector(blocker.q_localFrame, sub(rotateVector(frame.q, sub(p, frame.r)), blocker.center_m));
  const a = local(start_hill_m), b = local(end_hill_m), delta = sub(b, a);
  const length = Math.hypot(...delta);
  if (length <= MOUNT_NEAR_ZERO_M) return false;
  let enter = 0, exit = 1;
  for (const axis of [0, 1, 2] as const) {
    const half = blocker.halfExtent_m[axis];
    if (delta[axis] === 0) { if (Math.abs(a[axis]) > half) return false; continue; }
    const t1 = (-half - a[axis]) / delta[axis], t2 = (half - a[axis]) / delta[axis];
    enter = Math.max(enter, Math.min(t1, t2)); exit = Math.min(exit, Math.max(t1, t2));
    if (enter > exit) return false;
  }
  const endpointFraction = MOUNT_NEAR_ZERO_M / length;
  return exit > endpointFraction && enter < 1 - endpointFraction;
}

/** Cone/range gates are inclusive at their edges. Invalid configuration throws;
 * valid geometry that cannot produce an observation returns a named reason. */
export function checkMountVisibility(geometry: MountGeometry, mountId: string, datumId: string, pose: MountPose): MountVisibility {
  const mount = geometry.sensors.find(m => m.id === mountId);
  if (!mount) return { valid: false, reason: 'UNKNOWN_MOUNT' };
  const datum = geometry.datums.find(d => d.id === datumId);
  if (!datum) return { valid: false, reason: 'UNKNOWN_DATUM' };
  const sightline = mountedSightline(mount, datum, pose), range = sightline.range_m;
  const reject = (reason: VisibilityReason, blockerId?: string): MountVisibility => ({ valid: false, reason, sightline, ...(blockerId ? { blockerId } : {}) });
  if (range <= MOUNT_NEAR_ZERO_M) return reject('NEAR_ZERO_RANGE');
  if (range < mount.minRange_m) return reject('BELOW_MIN_RANGE');
  if (range > mount.maxRange_m) return reject('ABOVE_MAX_RANGE');
  const unitSensor = sightline.vector_sensor_m.map(v => v / range) as Vec3;
  if (dot(unitSensor, mount.boresight_sensor) < Math.cos(mount.halfAngleFov_rad) - ANGULAR_TOLERANCE) return reject('OUTSIDE_FOV');
  const toSensor = sub(sightline.origin_hill_m, sightline.target_hill_m).map(v => v / range) as Vec3;
  if (dot(toSensor, sightline.normal_hill) < Math.cos(datum.acceptanceHalfAngle_rad) - ANGULAR_TOLERANCE) return reject('TARGET_OUTSIDE_ACCEPTANCE');
  for (const blocker of geometry.blockers) {
    if (segmentIntersectsBlocker(sightline.origin_hill_m, sightline.target_hill_m, blocker, pose)) return reject('OCCLUDED', blocker.id);
  }
  return { valid: true, reason: 'VISIBLE', sightline };
}
