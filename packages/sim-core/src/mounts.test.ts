import { describe, expect, it } from 'vitest';
import { conjugateQuaternion, rotateVector } from './attitude.js';
import { CORRIDOR } from './corridor.js';
import { STATION_PORT_HILL } from './sim.js';
import { checkMountVisibility, createMountTables, mountedSightline, MOUNT_NEAR_ZERO_M,
  segmentIntersectsBlocker, stationDatumInHill, stationDockingPose,
  type ConvexBlocker, type MountGeometry, type MountPose, type SensorMount, type TargetDatum } from './mounts.js';
import type { Vec3 } from './types.js';

const identity = [1, 0, 0, 0] as [number, number, number, number];
const assumption = { kind: 'SIM_ASSUMPTION', reference: 'Analytic unit-test geometry, not a flight installation.' } as const;
const sensor = (): SensorMount => ({ id: 'optical', kind: 'OPTICAL_RANGE', r_body_m: [0, 0, 0], q_SB: [...identity],
  boresight_sensor: [0, 1, 0], halfAngleFov_rad: Math.PI / 4, minRange_m: 1, maxRange_m: 100,
  cadence_s: .1, provenance: { ...assumption } });
// A frame-origin oracle, NOT an assertion of the installed IDA target station.
// Provenance records the cited exception family; coordinates are test input.
const datum = (): TargetDatum => ({ id: 'target', kind: 'CENTERLINE_TARGET', r_docking_m: [0, 0, 0],
  normal_docking: [0, 0, 1], acceptanceHalfAngle_rad: Math.PI / 4,
  provenance: { kind: 'IDA_EXCEPTION', section: 'Appendix D', reference: 'IDSS Revision E §3.5.2 / Appendix D; analytic test fixture only.' } });
const geometry = (): MountGeometry => ({ sensors: [sensor()], datums: [datum()], blockers: [] });
const poseAt = (delta: Vec3 = [0, -10, 0]): MountPose => ({
  r_hill_m: STATION_PORT_HILL.map((v, i) => v + delta[i]!) as Vec3, q_BH: [...identity] });
const box = (kind: ConvexBlocker['kind'] = 'CAPSULE'): ConvexBlocker => ({ id: kind, kind,
  center_m: [0, 0, 0], halfExtent_m: [1, 1, 1], q_localFrame: [...identity], provenance: { ...assumption } });
const closeVector = (actual: Vec3, expected: Vec3) => actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 12));

describe('mount frame composition', () => {
  it('uses the shared station-port reference and the corridor axis without repeating a numeric datum', () => {
    expect(STATION_PORT_HILL).toBe(CORRIDOR.apex_hill_m);
    const pose = stationDockingPose();
    expect(pose.r_hill_m).toEqual(STATION_PORT_HILL);
    expect(pose.r_hill_m).not.toBe(STATION_PORT_HILL);
    closeVector(rotateVector(conjugateQuaternion(pose.q_DH), [0, 0, 1]), CORRIDOR.axis_hill);
    const d = datum(); d.r_docking_m = [2, 3, 4];
    const result = stationDatumInHill(d);
    closeVector(result.r_hill_m, [STATION_PORT_HILL[0] + 2, STATION_PORT_HILL[1] - 4, STATION_PORT_HILL[2] + 3]);
    closeVector(result.normal_hill, CORRIDOR.axis_hill);
  });

  it('composes lever arm, body attitude and sensor rotation against a quarter-turn oracle', () => {
    const m = sensor(), d = datum(), p = poseAt([-2, -10, 1]);
    m.r_body_m = [1, 0, 0]; m.q_SB = [Math.SQRT1_2, Math.SQRT1_2, 0, 0];
    p.q_BH = [Math.SQRT1_2, 0, 0, Math.SQRT1_2]; d.r_docking_m = [2, 3, 4];
    const sight = mountedSightline(m, d, p);
    closeVector(sight.origin_hill_m, [-2, STATION_PORT_HILL[1] - 11, 1]);
    closeVector(sight.vector_sensor_m, [-7, -2, 4]);
    expect(sight.range_m).toBeCloseTo(Math.sqrt(69), 12);
    const body = rotateVector(conjugateQuaternion(m.q_SB), sight.vector_sensor_m);
    const hill = rotateVector(conjugateQuaternion(p.q_BH), body);
    closeVector(hill, [4, 7, 2]);
  });

  it('keeps actual/calibration tables equal initially but independently editable at every nested level', () => {
    const input = geometry(), tables = createMountTables(input);
    expect(tables.actual.role).toBe('ACTUAL'); expect(tables.calibration.role).toBe('CALIBRATION');
    expect(tables.actual.sensors).toEqual(tables.calibration.sensors);
    tables.actual.sensors[0]!.r_body_m[1] = 1;
    tables.actual.sensors[0]!.provenance.reference = 'Actual mounting assumption changed';
    expect(input.sensors[0]!.r_body_m[1]).toBe(0);
    expect(tables.calibration.sensors[0]!.provenance.reference).toBe(assumption.reference);
    const actual = checkMountVisibility(tables.actual, 'optical', 'target', poseAt());
    const calibrated = checkMountVisibility(tables.calibration, 'optical', 'target', poseAt());
    expect(actual.sightline!.range_m).toBe(9); expect(calibrated.sightline!.range_m).toBe(10);
  });
});

describe('reasoned visibility', () => {
  it('returns explicit reasons for unknown IDs and accepts a visible target', () => {
    const g = geometry();
    expect(checkMountVisibility(g, 'missing', 'target', poseAt()).reason).toBe('UNKNOWN_MOUNT');
    expect(checkMountVisibility(g, 'optical', 'missing', poseAt()).reason).toBe('UNKNOWN_DATUM');
    expect(checkMountVisibility(g, 'optical', 'target', poseAt())).toMatchObject({ valid: true, reason: 'VISIBLE' });
  });

  it('rejects zero and sub-epsilon range before range limits or normalization', () => {
    for (const range of [0, MOUNT_NEAR_ZERO_M / 2]) {
      const result = checkMountVisibility(geometry(), 'optical', 'target', poseAt([0, -range, 0]));
      expect(result.reason).toBe('NEAR_ZERO_RANGE'); expect(result.valid).toBe(false);
      expect(result.sightline!.vector_sensor_m.every(Number.isFinite)).toBe(true);
    }
    const g = geometry(); g.sensors[0]!.minRange_m = 0;
    expect(checkMountVisibility(g, 'optical', 'target', poseAt([0, -4 * MOUNT_NEAR_ZERO_M, 0])).valid).toBe(true);
  });

  it('uses inclusive finite range limits and distinguishes too near from too far', () => {
    const g = geometry();
    expect(checkMountVisibility(g, 'optical', 'target', poseAt([0, -.5, 0])).reason).toBe('BELOW_MIN_RANGE');
    expect(checkMountVisibility(g, 'optical', 'target', poseAt([0, -101, 0])).reason).toBe('ABOVE_MAX_RANGE');
    for (const range of [1, 100]) expect(checkMountVisibility(g, 'optical', 'target', poseAt([0, -range, 0])).valid).toBe(true);
  });

  it('accepts the cone edge and rejects just outside sensor FOV or target acceptance independently', () => {
    const g = geometry();
    expect(checkMountVisibility(g, 'optical', 'target', poseAt([10, -10, 0])).valid).toBe(true);
    expect(checkMountVisibility(g, 'optical', 'target', poseAt([10.001, -10, 0])).reason).toBe('OUTSIDE_FOV');
    g.sensors[0]!.halfAngleFov_rad = Math.PI;
    expect(checkMountVisibility(g, 'optical', 'target', poseAt([10.001, -10, 0])).reason).toBe('TARGET_OUTSIDE_ACCEPTANCE');
    expect(checkMountVisibility(g, 'optical', 'target', poseAt([0, 10, 0])).reason).toBe('TARGET_OUTSIDE_ACCEPTANCE');
  });

  it('reports each caller-supplied capsule/nosecone/station blocker by ID', () => {
    for (const kind of ['CAPSULE', 'NOSECONE', 'STATION_BODY'] as const) {
      const b = box(kind); b.center_m = kind === 'STATION_BODY' ? [0, 0, 5] : [0, 5, 0];
      const result = checkMountVisibility({ ...geometry(), blockers: [b] }, 'optical', 'target', poseAt());
      expect(result).toMatchObject({ valid: false, reason: 'OCCLUDED', blockerId: kind });
    }
    const b = box('STATION_BODY'); b.center_m = [0, 0, -5];
    expect(checkMountVisibility({ ...geometry(), blockers: [b] }, 'optical', 'target', poseAt()).valid).toBe(true);
  });
});

describe('bounded convex blockers', () => {
  const origin: MountPose = { r_hill_m: [0, 0, 0], q_BH: [...identity] };
  it('clips a segment, handles parallel rays and tangency, and does not extend an infinite ray', () => {
    const b = box();
    expect(segmentIntersectsBlocker([-2, 0, 0], [2, 0, 0], b, origin)).toBe(true);
    expect(segmentIntersectsBlocker([-2, 1, 0], [2, 1, 0], b, origin)).toBe(true);
    expect(segmentIntersectsBlocker([-2, 1.0001, 0], [2, 1.0001, 0], b, origin)).toBe(false);
    expect(segmentIntersectsBlocker([-3, 0, 0], [-2, 0, 0], b, origin)).toBe(false);
    expect(segmentIntersectsBlocker([0, 0, 0], [2, 0, 0], b, origin)).toBe(true);
  });
  it('ignores contact confined to either endpoint, but blocks travel along the surface', () => {
    const b = box();
    expect(segmentIntersectsBlocker([-2, 0, 0], [-1, 0, 0], b, origin)).toBe(false);
    expect(segmentIntersectsBlocker([-1, 0, 0], [-2, 0, 0], b, origin)).toBe(false);
    expect(segmentIntersectsBlocker([-1, -1, 0], [-1, 1, 0], b, origin)).toBe(true);
    expect(segmentIntersectsBlocker([0, 0, 0], [0, 0, 0], b, origin)).toBe(false);
  });
  it('rotates the box independently of the body pose', () => {
    const b = box(); b.halfExtent_m = [2, .25, .25]; b.q_localFrame = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
    expect(segmentIntersectsBlocker([.2, -3, 0], [.2, 3, 0], b, origin)).toBe(true);
    expect(segmentIntersectsBlocker([.5, -3, 0], [.5, 3, 0], b, origin)).toBe(false);
    const rotated: MountPose = { r_hill_m: [5, 6, 7], q_BH: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] };
    expect(segmentIntersectsBlocker([2, 6.2, 7], [8, 6.2, 7], b, rotated)).toBe(true);
    // Rotated endpoint-only contact must not turn into penetration from roundoff.
    expect(segmentIntersectsBlocker([1, 6, 7], [3, 6, 7], b, rotated)).toBe(false);
  });
});

describe('configuration and provenance validation', () => {
  it('requires SIM_ASSUMPTION for every capsule mount kind and named station references', () => {
    for (const kind of ['OPTICAL_RANGE', 'GNSS_ANTENNA', 'RF_ANTENNA', 'IMU', 'STAR_TRACKER'] as const) {
      const m = sensor(); m.kind = kind;
      expect(createMountTables({ ...geometry(), sensors: [m] }).actual.sensors[0]!.provenance.kind).toBe('SIM_ASSUMPTION');
      expect(() => createMountTables({ ...geometry(), sensors: [{ ...m, provenance: { kind: 'DERIVED', reference: 'invalid' } } as unknown as SensorMount] })).toThrow('SIM_ASSUMPTION');
    }
    const d = datum(); d.kind = 'PERIMETER_REFLECTOR';
    d.provenance = { kind: 'IDSS_REV_E', section: '3.5.1.1.1', figure: '3.5.1.1-1; test coordinates only' };
    expect(createMountTables({ ...geometry(), datums: [d] }).actual.datums[0]!.provenance.kind).toBe('IDSS_REV_E');
    d.provenance.figure = '';
    expect(() => createMountTables({ ...geometry(), datums: [d] })).toThrow('figure');
  });
  it('refuses duplicate IDs and invalid rotations, directions, ranges, cadence, cone angles or bounds', () => {
    const edits: ((m: SensorMount) => void)[] = [m => { m.q_SB = [0, 0, 0, 0]; }, m => { m.boresight_sensor = [0, 2, 0]; },
      m => { m.r_body_m[0] = NaN; }, m => { m.maxRange_m = Infinity; }, m => { m.minRange_m = 101; },
      m => { m.cadence_s = 0; }, m => { m.r_body_m = new Array(3) as Vec3; }, m => { m.halfAngleFov_rad = -1; }];
    for (const edit of edits) { const m = sensor(); edit(m); expect(() => createMountTables({ ...geometry(), sensors: [m] })).toThrow(RangeError); }
    expect(() => createMountTables({ ...geometry(), sensors: [sensor(), sensor()] })).toThrow('Duplicate');
    const b = box(); b.halfExtent_m[0] = 0;
    expect(() => createMountTables({ ...geometry(), blockers: [b] })).toThrow('positive');
    const d = datum(); d.normal_docking = [0, 0, 0];
    expect(() => stationDatumInHill(d)).toThrow('unit');
    expect(() => mountedSightline(sensor(), datum(), { ...poseAt(), q_BH: [2, 0, 0, 0] })).toThrow('unit');
  });
});
