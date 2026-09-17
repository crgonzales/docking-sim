import { describe, expect, it } from 'vitest';
import { hillFromInertial, rotateVector } from './attitude.js';
import { MU_EARTH_M3_S2 } from './constants.js';
import { ORBIT_RADIUS_M } from './dynamics.js';
import type { Vec3 } from './types.js';
import { createWorldAnchor, physicalHillToEci, stationAbsoluteState, chaserAbsoluteState,
  hillFromAbsolute, eciToEcef, eciStateToEcef, ecefStateToEci, gnssTimeAt,
  EARTH_ROTATION_RAD_S, GPS_WEEK_S, type WorldAnchorConfig } from './worldAnchor.js';

const config: WorldAnchorConfig = { inclination_rad: 0.9, raan_rad: 0.4, argumentOfLatitude_rad: -0.3,
  gmstAtEpoch_rad: 0.7, epoch: { gpsWeek: 2400, secondsOfWeek_s: 604799.75, utcMinusGps_leapSeconds: -18 } };
const basis: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
function close(actual: Vec3, expected: Vec3, tolerance = 1e-8): void {
  actual.forEach((v, i) => expect(Math.abs(v - expected[i]!)).toBeLessThan(tolerance));
}
// Independent orbital direction-cosine columns, not quaternion composition.
function orbitBasis(t: number, n: number): Vec3[] {
  const u = config.argumentOfLatitude_rad + n * t, O = config.raan_rad, i = config.inclination_rad;
  return [
    [Math.cos(O) * Math.cos(u) - Math.sin(O) * Math.sin(u) * Math.cos(i), Math.sin(O) * Math.cos(u) + Math.cos(O) * Math.sin(u) * Math.cos(i), Math.sin(u) * Math.sin(i)],
    [-Math.cos(O) * Math.sin(u) - Math.sin(O) * Math.cos(u) * Math.cos(i), -Math.sin(O) * Math.sin(u) + Math.cos(O) * Math.cos(u) * Math.cos(i), Math.cos(u) * Math.sin(i)],
    [Math.sin(O) * Math.sin(i), -Math.cos(O) * Math.sin(i), Math.cos(i)],
  ];
}

describe('world anchor frames and epochs', () => {
  it('derives default/custom circular radius and detaches immutable epoch metadata', () => {
    const input = { ...config, epoch: { ...config.epoch } }, a = createWorldAnchor(input);
    expect(a.radius_m).toBeCloseTo(ORBIT_RADIUS_M, 7);
    const custom = createWorldAnchor({ ...config, meanMotionRadS: 0.002 });
    expect(custom.radius_m ** 3 * 0.002 ** 2 / MU_EARTH_M3_S2).toBeCloseTo(1, 14);
    input.epoch.gpsWeek = 1;
    expect(a.epoch.gpsWeek).toBe(2400);
    expect(Object.isFrozen(a) && Object.isFrozen(a.epoch) && Object.isFrozen(a.q_ECI_I0)).toBe(true);
  });

  it.each([undefined, 0.002])('matches analytic orbit axes over a full orbit (n=%s), with a right-handed orthonormal basis', meanMotionRadS => {
    const a = createWorldAnchor({ ...config, meanMotionRadS });
    for (let k = 0; k <= 24; k++) {
      const t = k / 24 * 2 * Math.PI / a.meanMotionRadS, q = physicalHillToEci(a, t);
      const axes = basis.map(v => rotateVector(q, v)), oracle = orbitBasis(t, a.meanMotionRadS);
      axes.forEach((v, j) => {
        close(v, oracle[j]!, 2e-14);
        axes.forEach((w, l) => expect(v.reduce((s, c, m) => s + c * w[m]!, 0)).toBeCloseTo(j === l ? 1 : 0, 14));
      });
      const [x, y, z] = axes as [Vec3, Vec3, Vec3];
      close([x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]], z, 2e-14);
      const s = stationAbsoluteState(a, t);
      close(s.eci.r_m, oracle[0]!.map(v => v * a.radius_m) as Vec3);
      close(s.eci.v_mps, oracle[1]!.map(v => v * a.radius_m * a.meanMotionRadS) as Vec3);
      basis.forEach(v => close(rotateVector(q, v), rotateVector([...a.q_ECI_I0], rotateVector(hillFromInertial(t, a.meanMotionRadS), v)), 2e-14));
    }
  });

  it('has exact epoch axes and independent quarter-orbit position/velocity signs', () => {
    const a = createWorldAnchor({ ...config, inclination_rad: 0, raan_rad: 0, argumentOfLatitude_rad: 0, gmstAtEpoch_rad: 0 });
    expect(a.q_ECI_I0).toEqual([1, 0, 0, 0]);
    expect(hillFromInertial(0)).toEqual([1, 0, 0, 0]);
    const s = stationAbsoluteState(a, Math.PI / (2 * a.meanMotionRadS));
    close(s.eci.r_m, [0, a.radius_m, 0]);
    close(s.eci.v_mps, [-a.radius_m * a.meanMotionRadS, 0, 0]);
    const c = chaserAbsoluteState(a, 0, [2, -3, 4], [5, 6, 7]);
    close(c.eci.r_m, [a.radius_m + 2, -3, 4]);
    close(c.eci.v_mps, [5 + 3 * a.meanMotionRadS, 6 + (a.radius_m + 2) * a.meanMotionRadS, 7]);
  });

  it.each([-100, 0, 1234])('round-trips Hill and Earth-fixed positions AND velocities at t=%s', t => {
    const a = createWorldAnchor(config), r: Vec3 = [10, -250, 12], v: Vec3 = [0.2, 0.8, -0.1];
    const state = chaserAbsoluteState(a, t, r, v), hill = hillFromAbsolute(a, t, state.eci);
    expect(state.t_s).toBe(t);
    close(hill.r_hill_m, r); close(hill.v_hill_mps, v);
    const back = ecefStateToEci(a, t, state.ecef);
    close(back.r_m, state.eci.r_m); close(back.v_mps, state.eci.v_mps);
    expect(hillFromAbsolute(a, t, state.eci, state.eci)).toEqual({ r_hill_m: [0, 0, 0], v_hill_mps: [0, 0, 0] });
  });

  it('uses negative Earth rotation and includes coordinate-derivative terms in both directions', () => {
    const a = createWorldAnchor({ ...config, gmstAtEpoch_rad: Math.PI / 2 });
    close(rotateVector(eciToEcef(a, 0), [1, 0, 0]), [0, -1, 0]);
    const fixed = { r_m: [2e6, -3e6, 1e6] as Vec3, v_mps: [0, 0, 0] as Vec3 };
    const eci = ecefStateToEci(a, 0, fixed), w = EARTH_ROTATION_RAD_S;
    close(eci.r_m, [3e6, 2e6, 1e6]); close(eci.v_mps, [-2e6 * w, 3e6 * w, 0]);
    const ecef = eciStateToEcef(a, 0, { r_m: [3e6, 2e6, 1e6], v_mps: [0, 0, 0] });
    close(ecef.v_mps, [-3e6 * w, -2e6 * w, 0]);
    close(rotateVector(eciToEcef(a, Math.PI / (2 * w)), [1, 0, 0]), [-1, 0, 0]);
  });

  it('velocities equal independent time derivatives of positions in ECI and ECEF', () => {
    const a = createWorldAnchor(config), t = 300, h = 0.01, r: Vec3 = [50, -200, 10], v: Vec3 = [0.3, -0.2, 0.1];
    const at = (dt: number) => chaserAbsoluteState(a, t + dt, r.map((x, i) => x + dt * v[i]!) as Vec3, v);
    const before = at(-h), after = at(h), current = at(0);
    for (const frame of ['eci', 'ecef'] as const) {
      close(current[frame].v_mps, after[frame].r_m.map((x, i) => (x - before[frame].r_m[i]!) / (2 * h)) as Vec3, 2e-6);
    }
  });

  it('rolls GPS weeks continuously in both directions and never applies display leap seconds to geometry/time', () => {
    const a = createWorldAnchor(config), b = createWorldAnchor({ ...config, epoch: { ...config.epoch, utcMinusGps_leapSeconds: -19 } });
    expect(gnssTimeAt(a, 0)).toEqual(config.epoch);
    expect(gnssTimeAt(a, 0.25)).toEqual({ ...config.epoch, gpsWeek: 2401, secondsOfWeek_s: 0 });
    expect(gnssTimeAt(a, -GPS_WEEK_S)).toEqual({ ...config.epoch, gpsWeek: 2399 });
    for (const t of [-604800, -1, 0, 0.125, 0.25, 0.5, GPS_WEEK_S + 1]) {
      const time = gnssTimeAt(a, t);
      expect((time.gpsWeek - a.epoch.gpsWeek) * GPS_WEEK_S + time.secondsOfWeek_s - a.epoch.secondsOfWeek_s).toBe(t);
      expect(gnssTimeAt(b, t)).toEqual({ ...time, utcMinusGps_leapSeconds: -19 });
      expect(stationAbsoluteState(a, t)).toEqual(stationAbsoluteState(b, t));
    }
  });

  it('rejects invalid anchor, epoch, time and state inputs with RangeError', () => {
    for (const n of [0, -1, NaN, Infinity, Number.MIN_VALUE, Number.MAX_VALUE]) expect(() => createWorldAnchor({ ...config, meanMotionRadS: n })).toThrow(RangeError);
    for (const key of ['inclination_rad', 'raan_rad', 'argumentOfLatitude_rad', 'gmstAtEpoch_rad'] as const) expect(() => createWorldAnchor({ ...config, [key]: NaN })).toThrow(key);
    for (const i of [-0.1, Math.PI + 0.1]) expect(() => createWorldAnchor({ ...config, inclination_rad: i })).toThrow(RangeError);
    for (const epoch of [{ ...config.epoch, gpsWeek: -1 }, { ...config.epoch, gpsWeek: 1.5 },
      { ...config.epoch, secondsOfWeek_s: GPS_WEEK_S }, { ...config.epoch, secondsOfWeek_s: -1 },
      { ...config.epoch, secondsOfWeek_s: NaN }, { ...config.epoch, utcMinusGps_leapSeconds: 0.5 }]) expect(() => createWorldAnchor({ ...config, epoch })).toThrow(RangeError);
    const a = createWorldAnchor(config), bad = { r_m: [NaN, 0, 0] as Vec3, v_mps: [0, Infinity, 0] as Vec3 };
    for (const t of [NaN, Infinity]) {
      expect(() => physicalHillToEci(a, t)).toThrow(RangeError);
      expect(() => eciToEcef(a, t)).toThrow(RangeError);
      expect(() => gnssTimeAt(a, t)).toThrow(RangeError);
    }
    expect(() => gnssTimeAt(a, -2402 * GPS_WEEK_S)).toThrow(RangeError);
    expect(() => chaserAbsoluteState(a, 0, bad.r_m, [0, 0, 0])).toThrow(RangeError);
    expect(() => chaserAbsoluteState(a, 0, [0, 0, 0], bad.v_mps)).toThrow(RangeError);
    expect(() => eciStateToEcef(a, 0, bad)).toThrow(RangeError);
    expect(() => ecefStateToEci(a, 0, bad)).toThrow(RangeError);
    expect(() => hillFromAbsolute(a, 0, bad)).toThrow(RangeError);
  });
});
