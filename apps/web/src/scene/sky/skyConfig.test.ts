import { describe, expect, it } from 'vitest';
import {
  EARTH_RADIUS_M,
  ATMOSPHERE_INTENSITY,
  SHADOW_ANGULAR_OFFSET_RAD,
  SKY_CONFIG,
  SKY_DERIVED,
  TERRAIN_CROSSFADE_END_M,
  TERRAIN_CROSSFADE_START_M,
  altitudeKmFromRadiusMultiplier,
  atmosphereExposureFromAltitudeKm,
  capCosineFromCameraEnvelope,
  driftRadPerSecFromGroundSpeed,
  kmToSceneUnits,
  radiusMultiplierFromAltitudeKm,
  shadowAngularOffsetFromAltitude,
  sunAnchorDistanceFromDebugEnvelope,
  terrainFadeFromAltitudeM,
} from './skyConfig';

describe('sky configuration derivations', () => {
  it('uses metres as the unified scene scale', () => {
    expect(SKY_CONFIG.renderScaleMPerUnit).toBe(1);
    expect(kmToSceneUnits(1)).toBe(1000);
    expect(SKY_DERIVED.earthRadiusScene).toBe(EARTH_RADIUS_M);
  });

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
      .toBeCloseTo(capCosineFromCameraEnvelope(
        SKY_CONFIG.flightMaxOrbitKm,
        SKY_DERIVED.earthCenterDistanceKm,
        SKY_CONFIG.earthRadiusKm,
      ), 12);
    expect(SKY_DERIVED.volumetricCapCosine).toBeCloseTo(0.48, 1);
  });

  it('keeps the sun anchor beyond every debug-range occluder', () => {
    const occluderDistanceKm = SKY_CONFIG.debugMaxOrbitKm
      + SKY_DERIVED.earthCenterDistanceKm
      + SKY_CONFIG.earthRadiusKm;
    expect(SKY_DERIVED.sunAnchorDistanceKm).toBeGreaterThan(occluderDistanceKm);
    expect(SKY_DERIVED.sunAnchorDistanceKm - occluderDistanceKm)
      .toBeCloseTo(SKY_CONFIG.sunAnchorMarginKm, 12);
    expect(SKY_DERIVED.sunAnchorDistanceKm).toBeCloseTo(
      sunAnchorDistanceFromDebugEnvelope(
        SKY_CONFIG.debugMaxOrbitKm,
        SKY_DERIVED.earthCenterDistanceKm,
        SKY_CONFIG.earthRadiusKm,
      ),
      12,
    );
  });

  it('derives the terrain engagement fade from the configured altitude band', () => {
    expect(TERRAIN_CROSSFADE_START_M).toBe(SKY_CONFIG.terrain.crossfadeAltitudeKm.start * 1000);
    expect(TERRAIN_CROSSFADE_END_M).toBe(SKY_CONFIG.terrain.engagementAltitudeKm * 1000);
    expect(terrainFadeFromAltitudeM(TERRAIN_CROSSFADE_END_M + 1)).toBe(0);
    expect(terrainFadeFromAltitudeM(TERRAIN_CROSSFADE_START_M - 1)).toBe(1);
    expect(terrainFadeFromAltitudeM((TERRAIN_CROSSFADE_START_M + TERRAIN_CROSSFADE_END_M) / 2))
      .toBeCloseTo(0.5, 12);
  });

  it('derives the exposure curve from the configured ground and space endpoints', () => {
    expect(atmosphereExposureFromAltitudeKm(SKY_CONFIG.exposure.groundAltitudeKm))
      .toBe(SKY_CONFIG.exposure.groundIntensity);
    expect(atmosphereExposureFromAltitudeKm(SKY_CONFIG.exposure.spaceAltitudeKm))
      .toBe(ATMOSPHERE_INTENSITY);
    expect(atmosphereExposureFromAltitudeKm(SKY_CONFIG.terrain.engagementAltitudeKm + 1))
      .toBe(ATMOSPHERE_INTENSITY);
    expect(atmosphereExposureFromAltitudeKm(0))
      .toBe(SKY_CONFIG.exposure.groundIntensity);
    expect(atmosphereExposureFromAltitudeKm(60)).toBeLessThan(SKY_CONFIG.exposure.groundIntensity);
    expect(atmosphereExposureFromAltitudeKm(60)).toBeGreaterThan(ATMOSPHERE_INTENSITY);
    const samples = [0, 1, 20, 60, 120, 400].map((altitudeKm) => atmosphereExposureFromAltitudeKm(altitudeKm));
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]).toBeLessThanOrEqual(samples[index - 1]!);
    }
  });
});
