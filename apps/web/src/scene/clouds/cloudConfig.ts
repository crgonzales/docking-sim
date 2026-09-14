/**
 * Authored VOLUMETRIC cloud constants.  These values are deliberately data-only: the
 * render path consumes a WeatherSnapshot and never owns a weather simulation.
 */

export const CLOUD_TYPE_IDS = [
  'broken-cumulus',
  'deep-convective',
  'stratus',
  'cirrus'
] as const

export type CloudTypeId = (typeof CLOUD_TYPE_IDS)[number]

export type HeightCurve = readonly (readonly [height01: number, value: number])[]

export interface CloudPhaseParameters {
  readonly anisotropy: readonly [number, number]
  readonly mix: number
}

export interface CloudTypeProfile {
  readonly id: CloudTypeId
  readonly ordinal: number
  readonly baseAltitudeM: number
  readonly topAltitudeM: number
  readonly coverageCurve: HeightCurve
  readonly densityCurve: HeightCurve
  /** Physical repeat of the coherent mesoscale field. */
  readonly primaryNoiseScaleM: number
  /** Dimensionless erosion strength, clamped to [0, 1]. */
  readonly erosionDepth: number
  /** Centre of the combined support-noise interval normalized to [0, 1]. */
  readonly baseNoiseThreshold: number
  /** Half-width of that support interval, not coverage-edge softness. */
  readonly baseNoiseSoftness: number
  /** Subtractive erosion threshold and transition width, both normalized. */
  readonly erosionThreshold: number
  readonly erosionSoftness: number
  /** Support fade at each authored height endpoint, normalized. */
  readonly supportFade01: number
  readonly phase: CloudPhaseParameters
  /** Participating-medium coefficients in inverse metres. */
  readonly scatteringCoefficientMInv: number
  readonly absorptionCoefficientMInv: number
}

export interface ResolvedCloudProfile {
  readonly leftType: CloudTypeId
  readonly rightType: CloudTypeId
  readonly blend: number
  readonly baseAltitudeM: number
  readonly topAltitudeM: number
  readonly coverageCurve: HeightCurve
  readonly densityCurve: HeightCurve
  readonly primaryNoiseScaleM: number
  readonly erosionDepth: number
  readonly baseNoiseThreshold: number
  readonly baseNoiseSoftness: number
  readonly erosionThreshold: number
  readonly erosionSoftness: number
  readonly supportFade01: number
  readonly phase: CloudPhaseParameters
  readonly scatteringCoefficientMInv: number
  readonly absorptionCoefficientMInv: number
}

export interface WeatherFieldSample {
  /** Independent coverage scalar, not a type identifier. */
  readonly coverage: number
  /** Continuous scalar field in [0, 1], mapped across adjacent authored types. */
  readonly typeField: number
}

export interface CloudSupportBounds {
  readonly minAltitudeM: number
  readonly maxAltitudeM: number
  readonly maxWeatherDisplacementM: number
}

const CLOUD_EROSION_DISPLACEMENT_M = 750

/** Half-width of the coverage support edge in normalized noise space. */
export const VOLUMETRIC_CLOUD_COVERAGE_EDGE_SOFTNESS = 0.08

// The two-domain Perlin/Worley support signal spans about [0.48, 0.63] over
// the reference region. A small calibrated margin keeps authored formations
// intact while coverage selects dense bodies instead of a low-density blanket.
const CLOUD_BASE_NOISE_CENTER = 0.54
const CLOUD_BASE_NOISE_HALF_WIDTH = 0.11

/** Shared CPU/GPU weights for the two-sample VOLUMETRIC-style shape construction. */
export const VOLUMETRIC_CLOUD_NOISE_SHAPE = deepFreeze({
  primaryWorleyMix: 0.3,
  detailSupportMix: 0.6,
  erosionWorleyMix: 0.65
})

export type CloudProfileVector4 = readonly [number, number, number, number]

/** Per-profile physical repeats for the rotated detiling/erosion field. */
const CLOUD_DETAIL_NOISE_SCALE_M: CloudProfileVector4 = [22_000, 42_000, 72_000, 110_000]

export interface CloudProfileTables {
  readonly baseAltitudeM: CloudProfileVector4
  readonly topAltitudeM: CloudProfileVector4
  readonly primaryNoiseScaleM: CloudProfileVector4
  readonly detailNoiseScaleM: CloudProfileVector4
  readonly erosionDepth: CloudProfileVector4
  readonly baseNoiseThreshold: CloudProfileVector4
  readonly baseNoiseSoftness: CloudProfileVector4
  readonly erosionThreshold: CloudProfileVector4
  readonly erosionSoftness: CloudProfileVector4
  readonly supportFade01: CloudProfileVector4
  readonly scatteringCoefficientMInv: CloudProfileVector4
  readonly absorptionCoefficientMInv: CloudProfileVector4
  readonly phaseAnisotropyX: CloudProfileVector4
  readonly phaseAnisotropyY: CloudProfileVector4
  readonly phaseMix: CloudProfileVector4
  readonly coverageKnots: readonly CloudProfileVector4[]
  readonly coverageValues: readonly CloudProfileVector4[]
  readonly densityKnots: readonly CloudProfileVector4[]
  readonly densityValues: readonly CloudProfileVector4[]
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (child && typeof child === 'object') deepFreeze(child)
    }
  }
  return value
}

const profile = (
  value: Omit<CloudTypeProfile, 'ordinal'> & { ordinal: number }
): CloudTypeProfile => deepFreeze(value)

/**
 * Four finite authored media profiles. The order is part of the asset ABI.
 * Visible-cloud coefficients use Takram's conservative-scattering approximation
 * (scattering = extinction, absorption = 0), with authored inverse-metre
 * strengths. These are appearance settings, not calibrated microphysics.
 */
export const VOLUMETRIC_CLOUD_PROFILES = deepFreeze([
  profile({
    id: 'broken-cumulus',
    ordinal: 0,
    baseAltitudeM: 1200,
    topAltitudeM: 3200,
    coverageCurve: [
      [0, 0.05],
      [0.18, 0.78],
      [0.55, 1],
      [1, 0.12]
    ],
    densityCurve: [
      [0, 0.08],
      [0.2, 0.65],
      [0.62, 1],
      [1, 0.2]
    ],
    primaryNoiseScaleM: 160_000,
    erosionDepth: 0.34,
    baseNoiseThreshold: CLOUD_BASE_NOISE_CENTER,
    baseNoiseSoftness: CLOUD_BASE_NOISE_HALF_WIDTH,
    erosionThreshold: 0.34,
    erosionSoftness: 0.12,
    supportFade01: 0.1,
    phase: { anisotropy: [0.72, -0.18], mix: 0.58 },
    scatteringCoefficientMInv: 0.0016,
    absorptionCoefficientMInv: 0
  }),
  profile({
    id: 'deep-convective',
    ordinal: 1,
    baseAltitudeM: 1600,
    topAltitudeM: 9000,
    coverageCurve: [
      [0, 0.03],
      [0.12, 0.72],
      [0.48, 1],
      [1, 0.3]
    ],
    densityCurve: [
      [0, 0.12],
      [0.16, 0.75],
      [0.55, 1],
      [1, 0.18]
    ],
    primaryNoiseScaleM: 260_000,
    erosionDepth: 0.28,
    baseNoiseThreshold: CLOUD_BASE_NOISE_CENTER,
    baseNoiseSoftness: CLOUD_BASE_NOISE_HALF_WIDTH,
    erosionThreshold: 0.35,
    erosionSoftness: 0.13,
    supportFade01: 0.08,
    phase: { anisotropy: [0.8, -0.24], mix: 0.66 },
    scatteringCoefficientMInv: 0.0028,
    absorptionCoefficientMInv: 0
  }),
  profile({
    id: 'stratus',
    ordinal: 2,
    baseAltitudeM: 7000,
    topAltitudeM: 8200,
    coverageCurve: [
      [0, 0.2],
      [0.12, 0.86],
      [0.72, 1],
      [1, 0.4]
    ],
    densityCurve: [
      [0, 0.18],
      [0.2, 0.72],
      [0.75, 0.94],
      [1, 0.3]
    ],
    primaryNoiseScaleM: 360_000,
    erosionDepth: 0.12,
    baseNoiseThreshold: CLOUD_BASE_NOISE_CENTER,
    baseNoiseSoftness: CLOUD_BASE_NOISE_HALF_WIDTH,
    erosionThreshold: 0.38,
    erosionSoftness: 0.14,
    supportFade01: 0.12,
    phase: { anisotropy: [0.56, -0.08], mix: 0.42 },
    scatteringCoefficientMInv: 0.0012,
    absorptionCoefficientMInv: 0
  }),
  profile({
    id: 'cirrus',
    ordinal: 3,
    baseAltitudeM: 11000,
    topAltitudeM: 14000,
    coverageCurve: [
      [0, 0.12],
      [0.2, 0.62],
      [0.68, 0.86],
      [1, 0.25]
    ],
    densityCurve: [
      [0, 0.06],
      [0.24, 0.45],
      [0.7, 0.72],
      [1, 0.16]
    ],
    primaryNoiseScaleM: 520_000,
    erosionDepth: 0.08,
    baseNoiseThreshold: CLOUD_BASE_NOISE_CENTER,
    baseNoiseSoftness: CLOUD_BASE_NOISE_HALF_WIDTH,
    erosionThreshold: 0.4,
    erosionSoftness: 0.13,
    supportFade01: 0.14,
    phase: { anisotropy: [0.38, -0.04], mix: 0.28 },
    scatteringCoefficientMInv: 0.00015,
    absorptionCoefficientMInv: 0
  })
] as const)

const profileVector = (read: (profile: CloudTypeProfile) => number): CloudProfileVector4 => [
  read(VOLUMETRIC_CLOUD_PROFILES[0]),
  read(VOLUMETRIC_CLOUD_PROFILES[1]),
  read(VOLUMETRIC_CLOUD_PROFILES[2]),
  read(VOLUMETRIC_CLOUD_PROFILES[3])
]

const curveVector = (
  curve: HeightCurve,
  value: boolean
): CloudProfileVector4 => [
  curve[0][value ? 1 : 0],
  curve[1][value ? 1 : 0],
  curve[2][value ? 1 : 0],
  curve[3][value ? 1 : 0]
]

/** Single source of truth for the GLSL profile uniform tables. */
export const VOLUMETRIC_CLOUD_PROFILE_TABLES: CloudProfileTables = deepFreeze({
  baseAltitudeM: profileVector(profile => profile.baseAltitudeM),
  topAltitudeM: profileVector(profile => profile.topAltitudeM),
  primaryNoiseScaleM: profileVector(profile => profile.primaryNoiseScaleM),
  detailNoiseScaleM: CLOUD_DETAIL_NOISE_SCALE_M,
  erosionDepth: profileVector(profile => profile.erosionDepth),
  baseNoiseThreshold: profileVector(profile => profile.baseNoiseThreshold),
  baseNoiseSoftness: profileVector(profile => profile.baseNoiseSoftness),
  erosionThreshold: profileVector(profile => profile.erosionThreshold),
  erosionSoftness: profileVector(profile => profile.erosionSoftness),
  supportFade01: profileVector(profile => profile.supportFade01),
  scatteringCoefficientMInv: profileVector(profile => profile.scatteringCoefficientMInv),
  absorptionCoefficientMInv: profileVector(profile => profile.absorptionCoefficientMInv),
  phaseAnisotropyX: profileVector(profile => profile.phase.anisotropy[0]),
  phaseAnisotropyY: profileVector(profile => profile.phase.anisotropy[1]),
  phaseMix: profileVector(profile => profile.phase.mix),
  // GLSL indexes these arrays by type, then indexes the vec4 by height knot.
  coverageKnots: VOLUMETRIC_CLOUD_PROFILES.map(profile => curveVector(profile.coverageCurve, false)),
  coverageValues: VOLUMETRIC_CLOUD_PROFILES.map(profile => curveVector(profile.coverageCurve, true)),
  densityKnots: VOLUMETRIC_CLOUD_PROFILES.map(profile => curveVector(profile.densityCurve, false)),
  densityValues: VOLUMETRIC_CLOUD_PROFILES.map(profile => curveVector(profile.densityCurve, true))
})

export const VOLUMETRIC_CLOUD_SUPPORT_BOUNDS: CloudSupportBounds = deepFreeze({
  minAltitudeM:
    Math.min(...VOLUMETRIC_CLOUD_PROFILES.map(({ baseAltitudeM }) => baseAltitudeM)) -
    CLOUD_EROSION_DISPLACEMENT_M,
  maxAltitudeM:
    Math.max(...VOLUMETRIC_CLOUD_PROFILES.map(({ topAltitudeM }) => topAltitudeM)) +
    CLOUD_EROSION_DISPLACEMENT_M,
  maxWeatherDisplacementM: CLOUD_EROSION_DISPLACEMENT_M
})

export const VOLUMETRIC_REFERENCE_REGION = deepFreeze({
  centerLatitudeDeg: 40.5,
  centerLongitudeDeg: -75,
  latitudeExtentDeg: 2.4,
  longitudeExtentDeg: 3.2,
  zones: {
    isolatedFormation: { latitudeDeg: 40.88, longitudeDeg: -75.42, radiusDeg: 0.24 },
    brokenField: {
      minLatitudeDeg: 39.78,
      maxLatitudeDeg: 41.26,
      minLongitudeDeg: -76.34,
      maxLongitudeDeg: -73.72
    },
    deepGroup: { latitudeDeg: 40.34, longitudeDeg: -74.58, radiusDeg: 0.46 },
    clearGap: { latitudeDeg: 40.08, longitudeDeg: -75.18, radiusDeg: 0.2 }
  }
})

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

export function evaluateHeightCurve(curve: HeightCurve, height01: number): number {
  if (curve.length === 0) return 0
  const height = clamp01(height01)
  if (height <= curve[0][0]) return curve[0][1]
  for (let index = 1; index < curve.length; index += 1) {
    const previous = curve[index - 1]
    const current = curve[index]
    if (height <= current[0]) {
      const span = Math.max(current[0] - previous[0], Number.EPSILON)
      return lerp(previous[1], current[1], (height - previous[0]) / span)
    }
  }
  return curve[curve.length - 1][1]
}

function blendCurve(left: HeightCurve, right: HeightCurve, blend: number): HeightCurve {
  return left.map((knot, index) =>
    deepFreeze([
      lerp(knot[0], right[index]?.[0] ?? knot[0], blend),
      lerp(knot[1], right[index]?.[1] ?? knot[1], blend)
    ] as const)
  )
}

/** Resolves the adjacent authored entries before a density curve is evaluated. */
export function interpolateCloudProfile(typeField: number): ResolvedCloudProfile {
  const scalar = clamp01(typeField) * (VOLUMETRIC_CLOUD_PROFILES.length - 1)
  const leftIndex = Math.min(VOLUMETRIC_CLOUD_PROFILES.length - 1, Math.floor(scalar))
  const rightIndex = Math.min(VOLUMETRIC_CLOUD_PROFILES.length - 1, leftIndex + 1)
  const blend = scalar - leftIndex
  const left = VOLUMETRIC_CLOUD_PROFILES[leftIndex]
  const right = VOLUMETRIC_CLOUD_PROFILES[rightIndex]

  return deepFreeze({
    leftType: left.id,
    rightType: right.id,
    blend,
    baseAltitudeM: lerp(left.baseAltitudeM, right.baseAltitudeM, blend),
    topAltitudeM: lerp(left.topAltitudeM, right.topAltitudeM, blend),
    coverageCurve: blendCurve(left.coverageCurve, right.coverageCurve, blend),
    densityCurve: blendCurve(left.densityCurve, right.densityCurve, blend),
    primaryNoiseScaleM: lerp(left.primaryNoiseScaleM, right.primaryNoiseScaleM, blend),
    erosionDepth: lerp(left.erosionDepth, right.erosionDepth, blend),
    baseNoiseThreshold: lerp(left.baseNoiseThreshold, right.baseNoiseThreshold, blend),
    baseNoiseSoftness: lerp(left.baseNoiseSoftness, right.baseNoiseSoftness, blend),
    erosionThreshold: lerp(left.erosionThreshold, right.erosionThreshold, blend),
    erosionSoftness: lerp(left.erosionSoftness, right.erosionSoftness, blend),
    supportFade01: lerp(left.supportFade01, right.supportFade01, blend),
    phase: deepFreeze({
      anisotropy: [
        lerp(left.phase.anisotropy[0], right.phase.anisotropy[0], blend),
        lerp(left.phase.anisotropy[1], right.phase.anisotropy[1], blend)
      ] as const,
      mix: lerp(left.phase.mix, right.phase.mix, blend)
    }),
    scatteringCoefficientMInv: lerp(
      left.scatteringCoefficientMInv,
      right.scatteringCoefficientMInv,
      blend
    ),
    absorptionCoefficientMInv: lerp(
      left.absorptionCoefficientMInv,
      right.absorptionCoefficientMInv,
      blend
    )
  })
}

export function clampCloudWeatherField(sample: WeatherFieldSample): WeatherFieldSample {
  if (!Number.isFinite(sample.coverage) || !Number.isFinite(sample.typeField)) {
    throw new Error('Weather coverage and typeField must be finite')
  }
  return deepFreeze({
    coverage: clamp01(sample.coverage),
    typeField: clamp01(sample.typeField)
  })
}
