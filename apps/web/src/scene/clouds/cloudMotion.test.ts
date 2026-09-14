import { describe, expect, it } from 'vitest';
import {
  canonicalWeatherPositionECEFM, createWeatherMotionState, IDENTITY_WEATHER_MOTION,
  previousWeatherRotationAngleRad, rotateWeatherEcefAroundNorth, sampleSeededWeatherFront,
  WEATHER_TAU, WEATHER_WIND_SPEED_MPS, weatherAngularSpeedRadS, weatherMotionAngleRad,
} from './cloudMotion';
import {
  cloudDetailNoisePositionECEFM, createWeatherSnapshot, evaluateCloudLayerMedia,
  sampleWeatherField, sampleWeatherFieldWithMotion,
} from './cloudWeather';
import { VOLUMETRIC_REFERENCE_REGION, interpolateCloudProfile } from './cloudConfig';

type Position = readonly [number, number, number];
const radiusM = 6_371_000;
const dayS = 86_400;
const snapshot = createWeatherSnapshot({ planetRadiusM: radiusM, visualTimeS: 0, sunDirectionECEF: [1, 0, 0] });
const positionAt = (latitude: number, longitude: number, altitude = 0): Position => [
  (radiusM + altitude) * Math.cos(latitude) * Math.cos(longitude),
  (radiusM + altitude) * Math.cos(latitude) * Math.sin(longitude),
  (radiusM + altitude) * Math.sin(latitude),
];
const difference = (a: readonly number[], b: readonly number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));

describe('physical weather advection', () => {
  it('moves east at the prescribed equatorial speed, preserves altitude and latitude', () => {
    const dt = 1 / 60;
    expect(weatherAngularSpeedRadS(radiusM) * radiusM).toBeCloseTo(WEATHER_WIND_SPEED_MPS, 12);
    for (const latitude of [-Math.PI / 2, -0.8, 0, 7 * Math.PI / 180, Math.PI / 2]) {
      const p = positionAt(latitude, 0.37, 2600);
      const q = rotateWeatherEcefAroundNorth(p, weatherMotionAngleRad(dt, radiusM));
      expect(Math.abs(Math.hypot(...q) - Math.hypot(...p))).toBeLessThan(3e-9);
      expect(q[2]).toBe(p[2]);
      const east = [-Math.sin(0.37), Math.cos(0.37), 0];
      const eastSpeed = q.reduce((v, x, i) => v + (x - p[i]!) * east[i]! / dt, 0);
      expect(eastSpeed).toBeCloseTo(WEATHER_WIND_SPEED_MPS * (radiusM + 2600) / radiusM * Math.cos(latitude), 5);
    }
  });

  it('pulls an advected parcel back to the same map and BOTH noise-domain coordinates', () => {
    for (const time of [-dayS, 1 / 60, 3600, dayS, 10_000 * dayS]) {
      const motion = createWeatherMotionState(time, radiusM);
      for (const p of [positionAt(0.12, 0.02, 2400), positionAt(-0.7, Math.PI - 1e-5, 8100)]) {
        const live = rotateWeatherEcefAroundNorth(p, motion.angleRad);
        const canonical = canonicalWeatherPositionECEFM(live, motion);
        expect(difference(canonical, p)).toBeLessThan(3e-9);
        expect(difference(cloudDetailNoisePositionECEFM(canonical), cloudDetailNoisePositionECEFM(p))).toBeLessThan(3e-9);
        expect(difference(sampleSeededWeatherFront(canonical), sampleSeededWeatherFront(p))).toBeLessThan(1e-12);
        const field = sampleWeatherFieldWithMotion(live, motion);
        const original = sampleWeatherFieldWithMotion(p, createWeatherMotionState(0, radiusM));
        expect(difference([field.coverage, field.typeField], [original.coverage, original.typeField])).toBeLessThan(1e-12);
      }
    }
  });

  it('preserves a nonempty physical medium under rigid advection', () => {
    const motion = createWeatherMotionState(dayS * 0.7, radiusM);
    // The CPU authored sampler covers only its reference region, not the global
    // GPU assets. Choose a known covered zone rather than assuming base7degN is
    // covered by that reference-only CPU map.
    const zone = VOLUMETRIC_REFERENCE_REGION.zones.deepGroup;
    const latitude = zone.latitudeDeg * Math.PI / 180, longitude = zone.longitudeDeg * Math.PI / 180;
    const direction = positionAt(latitude, longitude);
    const field = sampleWeatherFieldWithMotion(direction, createWeatherMotionState(0, radiusM));
    const profile = interpolateCloudProfile(field.typeField);
    const p = positionAt(latitude, longitude, (profile.baseAltitudeM + profile.topAltitudeM) / 2);
    const moved = rotateWeatherEcefAroundNorth(p, motion.angleRad);
    const query = { positionECEFM: p, footprintM: 0, weatherLod: 0, jitter: 0.125 };
    // Constant, high-support samples isolate the physical height/map contract.
    // Actual nonconstant texture domains are covered by the GPU fixture.
    const noise = [1, 1, 0, 0] as const;
    const before = evaluateCloudLayerMedia(query, field, snapshot, noise, noise);
    const after = evaluateCloudLayerMedia({ ...query, positionECEFM: moved, jitter: 0.875 },
      sampleWeatherFieldWithMotion(moved, motion), snapshot, noise, noise);
    expect(before.density).toBeGreaterThan(0.1);
    expect(after.density).toBeCloseTo(before.density, 10);
    expect(after.extinctionMInv).toBeCloseTo(before.extinctionMInv, 12);
  });

  it('maps a current parcel to its previous position across the wrapped-angle seam', () => {
    const period = WEATHER_TAU / weatherAngularSpeedRadS(radiusM);
    for (const [before, after] of [[0, 1 / 60], [period - 0.25, period + 0.25], [-0.25, 0.25], [dayS, dayS - 1]]) {
      const a = createWeatherMotionState(before, radiusM);
      const b = createWeatherMotionState(after, radiusM);
      const parcel = positionAt(0.4, -2, 4000);
      const previous = rotateWeatherEcefAroundNorth(parcel, a.angleRad);
      const current = rotateWeatherEcefAroundNorth(parcel, b.angleRad);
      const recovered = rotateWeatherEcefAroundNorth(current, previousWeatherRotationAngleRad(a.angleRad, b.angleRad));
      expect(difference(recovered, previous)).toBeLessThan(1e-8);
      expect(Math.abs(previousWeatherRotationAngleRad(a.angleRad, b.angleRad))).toBeLessThan(1e-5);
    }
  });

  it('keeps paused transforms identical and disabled weather on the legacy field', () => {
    const p = positionAt(0.7, -1.3, 2400);
    expect(createWeatherMotionState(3600, radiusM)).toEqual(createWeatherMotionState(3600, radiusM));
    for (const time of [-dayS, 0, dayS * 9000]) {
      const disabled = createWeatherMotionState(time, radiusM, false);
      expect(disabled.angleRad).toBe(0);
      expect(canonicalWeatherPositionECEFM(p, disabled)).toEqual(p);
      expect(sampleWeatherFieldWithMotion(p, disabled)).toEqual(sampleWeatherField(p));
    }
    expect(canonicalWeatherPositionECEFM(p, IDENTITY_WEATHER_MOTION)).toEqual(p);
    const period = WEATHER_TAU / weatherAngularSpeedRadS(radiusM);
    expect(difference(rotateWeatherEcefAroundNorth(p, weatherMotionAngleRad(1234 + period, radiusM)),
      rotateWeatherEcefAroundNorth(p, weatherMotionAngleRad(1234, radiusM)))).toBeLessThan(1e-8);
  });

  it.each([NaN, Infinity, -Infinity])('rejects nonfinite motion inputs (%s)', value => {
    expect(() => createWeatherMotionState(value, radiusM)).toThrow();
    expect(() => weatherAngularSpeedRadS(value)).toThrow();
    expect(() => rotateWeatherEcefAroundNorth([value, 0, 1], 0)).toThrow();
    expect(() => previousWeatherRotationAngleRad(0, value)).toThrow();
  });
});

describe('seeded fronts on a physical sphere', () => {
  it.each([[6.9, -0.08], [7, 0.02], [7.1, 0.12]])('varies coverage and type over 24h near base7degN (%s, %s)', (lat, lon) => {
    const site = positionAt(lat * Math.PI / 180, lon * Math.PI / 180);
    const series = Array.from({ length: 97 }, (_, i) => sampleSeededWeatherFront(
      canonicalWeatherPositionECEFM(site, createWeatherMotionState(i * 900, radiusM))));
    for (const value of series.flat()) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    for (const channel of [0, 1]) {
      const values = series.map(sample => sample[channel]!);
      expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.15);
    }
    expect(series).toEqual(Array.from({ length: 97 }, (_, i) => sampleSeededWeatherFront(
      canonicalWeatherPositionECEFM(site, createWeatherMotionState(i * 900, radiusM)))));
  });

  it.each([-70, -20, 7, 55])('has no physical antimeridian seam at latitude %s', degrees => {
    const latitude = degrees * Math.PI / 180;
    for (const epsilon of [1e-4, 1e-6, 1e-8]) {
      const west = sampleSeededWeatherFront(positionAt(latitude, -Math.PI + epsilon));
      const east = sampleSeededWeatherFront(positionAt(latitude, Math.PI - epsilon));
      // A conservative angular slope budget, shrinking with physical distance.
      expect(difference(west, east)).toBeLessThan(64 * epsilon + 1e-12);
    }
  });

  it.each([-1, 1])('converges to one longitude-independent front at pole %s', sign => {
    const pole = sampleSeededWeatherFront([0, 0, sign * radiusM]);
    expect(pole.every(Number.isFinite)).toBe(true);
    for (const epsilon of [1e-4, 1e-6, 1e-8]) {
      for (const longitude of [-Math.PI, -2, -1, 0, 1, 2, Math.PI]) {
        const ring = sampleSeededWeatherFront(positionAt(sign * (Math.PI / 2 - epsilon), longitude));
        expect(difference(ring, pole)).toBeLessThan(64 * epsilon + 1e-12);
      }
    }
  });
});
