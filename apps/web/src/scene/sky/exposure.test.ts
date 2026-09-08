import { describe, expect, it } from 'vitest';
import { SUN_DIR } from '../sun';
import {
  NIGHT_EV_GOLDEN,
  NOON_GROUND_EV_GOLDEN,
  ORBIT_EV_GOLDEN,
  SUNSET_LIMB_EV_GOLDEN,
  frameExposureFromCamera,
  type FrameExposureFrame,
  type Vector3Like,
} from './exposure';
import { SKY_CONFIG } from './skyConfig';

const PLANET_CENTER: Vector3Like = { x: 0, y: 0, z: 0 };
const CONTINUITY_WINDOW_KM = 1;
const CONTINUITY_SAMPLES_PER_SIDE = 1_000;
const CONTINUITY_EPSILON = 1e-3;

function cross(a: Vector3Like, b: Vector3Like): Vector3Like {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalize(vector: Vector3Like): Vector3Like {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function radialForSunSine(sine: number): Vector3Like {
  const reference: Vector3Like = { x: 0, y: 1, z: 0 };
  const tangent = normalize(cross(SUN_DIR, reference));
  const tangentScale = Math.sqrt(Math.max(0, 1 - sine ** 2));
  return {
    x: SUN_DIR.x * sine + tangent.x * tangentScale,
    y: SUN_DIR.y * sine + tangent.y * tangentScale,
    z: SUN_DIR.z * sine + tangent.z * tangentScale,
  };
}

function frameAt(altitudeKm: number, sunSine: number, center = PLANET_CENTER): FrameExposureFrame {
  const radial = radialForSunSine(sunSine);
  const radiusKm = SKY_CONFIG.atmosphere.bottomRadiusKm + altitudeKm;
  return {
    cameraPositionWorld: {
      x: center.x + radial.x * radiusKm,
      y: center.y + radial.y * radiusKm,
      z: center.z + radial.z * radiusKm,
    },
    planetCenterWorld: center,
    cameraAltitudeKm: altitudeKm,
  };
}

function maxAdjacentStepAroundAltitude(boundaryKm: number): { ev: number; exposure: number } {
  let previous = frameExposureFromCamera(frameAt(boundaryKm - CONTINUITY_WINDOW_KM, 1));
  let maxEvStep = 0;
  let maxExposureStep = 0;
  const sampleCount = CONTINUITY_SAMPLES_PER_SIDE * 2;
  for (let index = 1; index <= sampleCount; index += 1) {
    const altitudeKm = boundaryKm - CONTINUITY_WINDOW_KM
      + (2 * CONTINUITY_WINDOW_KM * index) / sampleCount;
    const current = frameExposureFromCamera(frameAt(altitudeKm, 1));
    maxEvStep = Math.max(maxEvStep, Math.abs(current.ev - previous.ev));
    maxExposureStep = Math.max(maxExposureStep, Math.abs(current.exposure - previous.exposure));
    previous = current;
  }
  return { ev: maxEvStep, exposure: maxExposureStep };
}

describe('frame exposure', () => {
  it('measures sun elevation at the sub-nadir ground point', () => {
    const frame = frameAt(
      SKY_CONFIG.earthOrbitAltitudeKm,
      -1,
      { x: 1_200, y: -800, z: 450 },
    );
    const result = frameExposureFromCamera(frame);

    expect(result.sinSunElevation).toBeCloseTo(-1, 14);
    expect(result.sunFactor).toBe(0);
  });

  it('matches the four recorded reference EV values', () => {
    const referenceFrames = [
      ['noon ground', frameAt(0, 1), NOON_GROUND_EV_GOLDEN],
      ['sunset limb', frameAt(SKY_CONFIG.earthOrbitAltitudeKm, 0), SUNSET_LIMB_EV_GOLDEN],
      ['night', frameAt(0, -1), NIGHT_EV_GOLDEN],
      ['orbit', frameAt(SKY_CONFIG.earthOrbitAltitudeKm, 1), ORBIT_EV_GOLDEN],
    ] as const;

    for (const [name, frame, expectedEv] of referenceFrames) {
      expect(frameExposureFromCamera(frame).ev, name).toBeCloseTo(expectedEv, 9);
    }
  });

  it('keeps the four reference framings mutually distinct', () => {
    // Guards the calibration itself, not the arithmetic: with kSun 3.0 and
    // evMin -4.0 the EV clamp engaged at ~17 deg of sun elevation, so the
    // sunset and night framings both pinned to -4 and two of the four goldens
    // silently stopped discriminating. Distinctness is what makes them oracles.
    const evs = [
      frameExposureFromCamera(frameAt(0, 1)).ev,
      frameExposureFromCamera(frameAt(SKY_CONFIG.earthOrbitAltitudeKm, 0)).ev,
      frameExposureFromCamera(frameAt(0, -1)).ev,
      frameExposureFromCamera(frameAt(SKY_CONFIG.earthOrbitAltitudeKm, 1)).ev,
    ];

    for (let i = 0; i < evs.length; i += 1) {
      for (let j = i + 1; j < evs.length; j += 1) {
        expect(Math.abs(evs[i]! - evs[j]!)).toBeGreaterThan(0.1);
      }
    }
  });

  it('leaves the whole above-horizon sun range unclamped', () => {
    // The twilight band is where the descent flash lived, so it must stay on
    // the live part of the curve rather than sitting flat against evMin.
    for (let index = 0; index <= 20; index += 1) {
      const sunSine = index / 20;
      const result = frameExposureFromCamera(frameAt(0, sunSine));
      expect(result.ev, `sun sine ${sunSine}`).toBeGreaterThan(SKY_CONFIG.frameExposure.evMin);
    }
  });

  it('is continuous across the atmosphere shell and terrain crossfade boundaries', () => {
    const atmosphereBoundaryKm =
      SKY_CONFIG.atmosphere.topRadiusKm - SKY_CONFIG.atmosphere.bottomRadiusKm;
    const boundaries = [
      atmosphereBoundaryKm,
      SKY_CONFIG.terrain.crossfadeAltitudeKm.start,
      SKY_CONFIG.terrain.crossfadeAltitudeKm.end,
    ];

    for (const boundaryKm of boundaries) {
      const largestStep = maxAdjacentStepAroundAltitude(boundaryKm);
      expect(largestStep.ev).toBeLessThan(CONTINUITY_EPSILON);
      expect(largestStep.exposure).toBeLessThan(CONTINUITY_EPSILON);
    }
  });

  it('decreases EV monotonically as sun elevation falls from zenith to night', () => {
    let previousEv = frameExposureFromCamera(frameAt(0, 1)).ev;
    for (let index = 1; index <= 200; index += 1) {
      const sunSine = 1 - (2 * index) / 200;
      const currentEv = frameExposureFromCamera(frameAt(0, sunSine)).ev;
      expect(currentEv).toBeLessThanOrEqual(previousEv);
      previousEv = currentEv;
    }
  });

  it('clamps EV at both configured endpoints and never exceeds them', () => {
    const minimum = frameExposureFromCamera(frameAt(0, -1));
    const maximum = frameExposureFromCamera(
      frameAt(SKY_CONFIG.atmosphere.topRadiusKm - SKY_CONFIG.atmosphere.bottomRadiusKm, 1),
      { ...SKY_CONFIG.frameExposure, evBase: SKY_CONFIG.frameExposure.evMax + 1 },
    );

    expect(minimum.ev).toBe(SKY_CONFIG.frameExposure.evMin);
    expect(maximum.ev).toBe(SKY_CONFIG.frameExposure.evMax);

    for (const altitudeKm of [0, SKY_CONFIG.earthOrbitAltitudeKm, SKY_CONFIG.debugMaxOrbitKm]) {
      for (let index = 0; index <= 20; index += 1) {
        const result = frameExposureFromCamera(frameAt(altitudeKm, -1 + index / 10));
        expect(result.ev).toBeGreaterThanOrEqual(SKY_CONFIG.frameExposure.evMin);
        expect(result.ev).toBeLessThanOrEqual(SKY_CONFIG.frameExposure.evMax);
      }
    }
  });

  it('stays finite and strictly positive from ground through the full altitude envelope', () => {
    const topAtmosphereAltitudeKm =
      SKY_CONFIG.atmosphere.topRadiusKm - SKY_CONFIG.atmosphere.bottomRadiusKm;
    const altitudeSamples = [
      0,
      topAtmosphereAltitudeKm,
      SKY_CONFIG.earthOrbitAltitudeKm,
      SKY_CONFIG.debugMaxOrbitKm,
    ];

    for (const altitudeKm of altitudeSamples) {
      for (let index = 0; index <= 20; index += 1) {
        const result = frameExposureFromCamera(frameAt(altitudeKm, -1 + index / 10));
        expect(Number.isFinite(result.ev)).toBe(true);
        expect(Number.isFinite(result.exposure)).toBe(true);
        expect(result.exposure).toBeGreaterThan(0);
      }
    }
  });
});
