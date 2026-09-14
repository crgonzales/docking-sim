import { describe, expect, it } from 'vitest'

import {
  clampCloudWeatherField,
  VOLUMETRIC_CLOUD_COVERAGE_EDGE_SOFTNESS,
  VOLUMETRIC_CLOUD_NOISE_SHAPE,
  VOLUMETRIC_CLOUD_PROFILES,
  VOLUMETRIC_CLOUD_PROFILE_TABLES,
  VOLUMETRIC_CLOUD_SUPPORT_BOUNDS,
  evaluateHeightCurve,
  interpolateCloudProfile
} from './cloudConfig'

describe('VOLUMETRIC cloud authored profiles', () => {
  it('keeps the finite four-profile ABI and conservative support bounds', () => {
    expect(VOLUMETRIC_CLOUD_PROFILES.map(profile => profile.id)).toEqual([
      'broken-cumulus',
      'deep-convective',
      'stratus',
      'cirrus'
    ])
    expect(Object.isFrozen(VOLUMETRIC_CLOUD_PROFILES)).toBe(true)

    for (const profile of VOLUMETRIC_CLOUD_PROFILES) {
      expect(profile.topAltitudeM).toBeGreaterThan(profile.baseAltitudeM)
      expect(profile.primaryNoiseScaleM).toBeGreaterThan(0)
      expect(profile.erosionDepth).toBeGreaterThanOrEqual(0)
      expect(profile.erosionDepth).toBeLessThanOrEqual(1)
      expect(profile.baseNoiseThreshold).toBeGreaterThanOrEqual(0)
      expect(profile.baseNoiseThreshold).toBeLessThanOrEqual(1)
      expect(profile.baseNoiseSoftness).toBeGreaterThan(0)
      expect(profile.erosionThreshold).toBeGreaterThanOrEqual(0)
      expect(profile.erosionThreshold).toBeLessThanOrEqual(1)
      expect(profile.erosionSoftness).toBeGreaterThan(0)
      expect(profile.supportFade01).toBeGreaterThan(0)
      expect(profile.supportFade01).toBeLessThan(0.5)
      expect(Number.isFinite(profile.scatteringCoefficientMInv)).toBe(true)
      expect(Number.isFinite(profile.absorptionCoefficientMInv)).toBe(true)
      expect(profile.scatteringCoefficientMInv).toBeGreaterThanOrEqual(0)
      expect(profile.absorptionCoefficientMInv).toBeGreaterThanOrEqual(0)
      expect(profile.phase.mix).toBeGreaterThanOrEqual(0)
      expect(profile.phase.mix).toBeLessThanOrEqual(1)
      expect(VOLUMETRIC_CLOUD_SUPPORT_BOUNDS.minAltitudeM).toBeLessThanOrEqual(
        profile.baseAltitudeM - VOLUMETRIC_CLOUD_SUPPORT_BOUNDS.maxWeatherDisplacementM
      )
      expect(VOLUMETRIC_CLOUD_SUPPORT_BOUNDS.maxAltitudeM).toBeGreaterThanOrEqual(
        profile.topAltitudeM + VOLUMETRIC_CLOUD_SUPPORT_BOUNDS.maxWeatherDisplacementM
      )
    }
    expect(VOLUMETRIC_CLOUD_PROFILE_TABLES.baseAltitudeM).toEqual(
      VOLUMETRIC_CLOUD_PROFILES.map(profile => profile.baseAltitudeM)
    )
  })

  it('interpolates adjacent type entries before evaluating independent curves', () => {
    const resolved = interpolateCloudProfile(0.5)
    expect(resolved.leftType).toBe('deep-convective')
    expect(resolved.rightType).toBe('stratus')
    expect(resolved.blend).toBeCloseTo(0.5)
    expect(resolved.baseAltitudeM).toBeCloseTo((1600 + 7000) / 2)
    expect(resolved.coverageCurve[2][0]).toBeCloseTo((0.48 + 0.72) / 2)
    expect(evaluateHeightCurve(resolved.coverageCurve, 0.5)).not.toBe(
      evaluateHeightCurve(resolved.densityCurve, 0.5)
    )
  })

  it('bounds both authored noise domains separately from conservative-scattering strengths', () => {
    expect(VOLUMETRIC_CLOUD_COVERAGE_EDGE_SOFTNESS).toBe(0.08)
    expect(VOLUMETRIC_CLOUD_PROFILES.map(profile => profile.scatteringCoefficientMInv)).toEqual([
      0.0016, 0.0028, 0.0012, 0.00015
    ])
    for (const profile of VOLUMETRIC_CLOUD_PROFILES) {
      // Actual-noise occupancy and columns exercise calibration in cloudWeather
      // tests; these bounds only enforce a usable, interior normalization range.
      expect(profile.baseNoiseThreshold - profile.baseNoiseSoftness).toBeGreaterThan(0)
      expect(profile.baseNoiseThreshold + profile.baseNoiseSoftness).toBeLessThan(1)
      expect(profile.absorptionCoefficientMInv).toBe(0)
    }
    expect(VOLUMETRIC_CLOUD_PROFILE_TABLES.detailNoiseScaleM).toHaveLength(4)
    expect(Object.isFrozen(VOLUMETRIC_CLOUD_PROFILE_TABLES.detailNoiseScaleM)).toBe(true)
    VOLUMETRIC_CLOUD_PROFILE_TABLES.detailNoiseScaleM.forEach((scaleM, index) => {
      expect(Number.isFinite(scaleM)).toBe(true)
      expect(scaleM).toBeGreaterThan(0)
      expect(scaleM).toBeLessThan(VOLUMETRIC_CLOUD_PROFILE_TABLES.primaryNoiseScaleM[index])
    })
    for (const mix of Object.values(VOLUMETRIC_CLOUD_NOISE_SHAPE)) {
      expect(mix).toBeGreaterThan(0)
      expect(mix).toBeLessThan(1)
    }
  })

  it('does not conflate clear coverage with the type scalar', () => {
    const clearCirrus = clampCloudWeatherField({ coverage: 0, typeField: 1 })
    expect(clearCirrus).toEqual({ coverage: 0, typeField: 1 })
    expect(Object.isFrozen(clearCirrus)).toBe(true)
  })

  it('packs each shader curve entry as the four knots of one profile', () => {
    VOLUMETRIC_CLOUD_PROFILES.forEach((profile, index) => {
      expect(VOLUMETRIC_CLOUD_PROFILE_TABLES.coverageKnots[index]).toEqual(profile.coverageCurve.map(knot => knot[0]))
      expect(VOLUMETRIC_CLOUD_PROFILE_TABLES.coverageValues[index]).toEqual(profile.coverageCurve.map(knot => knot[1]))
      expect(VOLUMETRIC_CLOUD_PROFILE_TABLES.densityKnots[index]).toEqual(profile.densityCurve.map(knot => knot[0]))
      expect(VOLUMETRIC_CLOUD_PROFILE_TABLES.densityValues[index]).toEqual(profile.densityCurve.map(knot => knot[1]))
    })
  })
})
