import { describe, expect, it } from 'vitest';
import {
  DEBUG_MAX_ORBIT,
  EARTH_CENTER_DISTANCE,
  EARTH_RADIUS_M,
  FLIGHT_MAX_ORBIT,
  SHADOW_ANGULAR_OFFSET_RAD,
  SKY_CONFIG,
  SKY_DERIVED,
  SUN_ANCHOR_DISTANCE,
  altitudeKmFromRadiusMultiplier,
  capCosineFromCameraEnvelope,
  driftRadPerSecFromGroundSpeed,
  radiusMultiplierFromAltitudeKm,
  shadowAngularOffsetFromAltitude,
  sunAnchorDistanceFromDebugEnvelope,
} from './skyConfig';

describe('sky configuration derivations', () => {
  it('round-trips altitude and radius multiplier', () => {
    for (const altitudeKm of [SKY_CONFIG.deckAltitudeKm, SKY_CONFIG.cirrusAltitudeKm, 1.5, 9]) {
      expect(altitudeKmFromRadiusMultiplier(radiusMultiplierFromAltitudeKm(altitudeKm)))
        .toBeCloseTo(altitudeKm, 11);
    }
  });

  it('derives drift from the physical ground speed and Earth radius', () => {
    expect(SKY_DERIVED.cloudDriftRadPerSec)
      .toBeCloseTo(driftRadPerSecFromGroundSpeed(SKY_CONFIG.cloudGroundSpeedMps), 15);
    expect(SKY_DERIVED.cloudDriftRadPerSec)
      .toBeCloseTo(25 / EARTH_RADIUS_M, 15);
  });

  it('derives the shadow offset from altitude and legibility', () => {
    expect(SHADOW_ANGULAR_OFFSET_RAD)
      .toBeCloseTo(shadowAngularOffsetFromAltitude(7, 1.5, 6371), 15);
    expect(SHADOW_ANGULAR_OFFSET_RAD).toBeGreaterThan(0);
  });

  it('derives the volumetric cap cosine from the flight envelope', () => {
    expect(SKY_DERIVED.volumetricCapCosine)
      .toBeCloseTo(capCosineFromCameraEnvelope(FLIGHT_MAX_ORBIT, EARTH_CENTER_DISTANCE, EARTH_RADIUS_M / 1000), 12);
    expect(SKY_DERIVED.volumetricCapCosine).toBeCloseTo(0.48, 1);
  });

  it('keeps the sun anchor beyond every debug-range occluder', () => {
    const occluderDistance = DEBUG_MAX_ORBIT + EARTH_CENTER_DISTANCE + EARTH_RADIUS_M / 1000;
    expect(SUN_ANCHOR_DISTANCE).toBeGreaterThan(occluderDistance);
    expect(SUN_ANCHOR_DISTANCE - occluderDistance).toBeCloseTo(SKY_CONFIG.sunAnchorMargin, 12);
    expect(SUN_ANCHOR_DISTANCE).toBeCloseTo(
      sunAnchorDistanceFromDebugEnvelope(DEBUG_MAX_ORBIT, EARTH_CENTER_DISTANCE, EARTH_RADIUS_M / 1000),
      12,
    );
  });
});
