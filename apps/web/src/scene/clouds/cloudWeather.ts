import { Uniform, Vector2, Vector3, Vector4, type Texture } from 'three'

import type { CloudMediaQuery, CloudMediaSample } from './CloudBackend'
import {
  clampCloudWeatherField,
  VOLUMETRIC_CLOUD_COVERAGE_EDGE_SOFTNESS,
  VOLUMETRIC_CLOUD_NOISE_SHAPE,
  VOLUMETRIC_CLOUD_PROFILES,
  VOLUMETRIC_CLOUD_PROFILE_TABLES,
  VOLUMETRIC_CLOUD_SUPPORT_BOUNDS,
  VOLUMETRIC_REFERENCE_REGION,
  evaluateHeightCurve,
  interpolateCloudProfile,
  type CloudSupportBounds,
  type CloudProfileTables,
  type CloudTypeProfile,
  type WeatherFieldSample
} from './cloudConfig'
import {
  canonicalWeatherPositionECEFM,
  IDENTITY_WEATHER_MOTION,
  sampleSeededWeatherFront,
  type WeatherMotionState
} from './cloudMotion'

const DEGREES_PER_RADIAN = 180 / Math.PI
const RADIANS_PER_DEGREE = Math.PI / 180
const DEFAULT_PLANET_RADIUS_M = 6_371_000
const NORTH_AXIS_ECEF = Object.freeze([0, 0, 1] as const)

export interface WeatherAssetDescriptor {
  readonly path: string
  readonly sha256: string
  /** Base-level source bytes; hashes apply before any CPU row reversal. */
  readonly bytes: number
  readonly format: 'R8' | 'RG8' | 'RGBA8'
  readonly dimensions: readonly [number, number] | readonly [number, number, number]
  readonly rowOrder: 'north-first' | 'south-first' | 'not-applicable'
}

export const VOLUMETRIC_WEATHER_ASSETS = Object.freeze({
  coverage: Object.freeze({
    path: '/assets/clouds/volumetric/global-coverage-r8.bin',
    sha256: '22e089d3dff76bf26097c4168644b1a35989b2d384b770c83787673b6eb9abef',
    bytes: 524288,
    format: 'R8',
    dimensions: Object.freeze([1024, 512] as const),
    rowOrder: 'north-first' as const
  }),
  typeField: Object.freeze({
    path: '/assets/clouds/volumetric/global-type-r8.bin',
    sha256: 'defe79160d3365b4c006298edd6ce876034ce63c2eff29e99a2d2dd5414cee7a',
    bytes: 524288,
    format: 'R8',
    dimensions: Object.freeze([1024, 512] as const),
    rowOrder: 'north-first' as const
  }),
  referenceField: Object.freeze({
    path: '/assets/clouds/volumetric/reference-field-rg8.bin',
    sha256: '2a5946d8209287e772b7f639fb2e5b5bf045b2424f66b1732ab2ec4f5e420a8f',
    bytes: 16384,
    format: 'RG8',
    dimensions: Object.freeze([128, 64] as const),
    rowOrder: 'south-first' as const
  }),
  noise: Object.freeze({
    path: '/assets/clouds/volumetric/periodic-noise-rgba8.bin',
    sha256: '980d4a1569c8e1cadaea32d62842c790a4d732752b6243eb25e08ad1575a9628',
    bytes: 1048576,
    format: 'RGBA8',
    dimensions: Object.freeze([64, 64, 64] as const),
    rowOrder: 'not-applicable' as const
  })
} satisfies Readonly<Record<string, WeatherAssetDescriptor>>)

export interface WeatherSnapshot {
  readonly planetRadiusM: number
  /** Engine ECEF north is +Z, represented by v=1 in the weather maps. */
  readonly northAxisECEF: readonly [number, number, number]
  readonly coverageAsset: WeatherAssetDescriptor
  readonly typeFieldAsset: WeatherAssetDescriptor
  readonly referenceFieldAsset: WeatherAssetDescriptor
  readonly noiseAsset: WeatherAssetDescriptor
  readonly profiles: readonly CloudTypeProfile[]
  readonly profileTables: CloudProfileTables
  readonly referenceRegion: typeof VOLUMETRIC_REFERENCE_REGION
  /** [min longitude, min latitude, max longitude, max latitude] degrees. */
  readonly referenceBoundsDeg: readonly [number, number, number, number]
  readonly bounds: CloudSupportBounds
  /** Public caller-owned visual time; no simulation clock is consulted. */
  readonly visualTimeS: number
  readonly sunDirectionECEF: readonly [number, number, number]
  readonly generation: number
}

export interface WeatherSnapshotOptions {
  readonly visualTimeS: number
  readonly sunDirectionECEF: readonly [number, number, number]
  readonly planetRadiusM?: number
  readonly generation?: number
}

export type WeatherBindingUniforms = Readonly<Record<string, Uniform<unknown>>>

export interface WeatherBindingOptions {
  readonly motion?: WeatherMotionState
}

export interface WeatherTextureBindings {
  /** Global rows must be reversed on CPU before raw upload with flipY=false. */
  readonly coverage?: Texture | null
  readonly typeField?: Texture | null
  /**
   * Reference bytes are south-first and should be uploaded without a second flip.
   * Exact empty support requires sampled zero coverage: the finite texture filter
   * footprint can mix covered texels across an authored clear boundary.
   */
  readonly referenceField?: Texture | null
  readonly noise?: Texture | null
}

export type CloudNoiseSample = readonly [perlin: number, worley: number, erosion: number, detail: number]

export const DEFAULT_CLOUD_NOISE_SAMPLE: CloudNoiseSample = Object.freeze([0.75, 0.5, 0.5, 0.5])

/** Stable, camera-independent secondary domain used to break the primary repeat. */
export function cloudDetailNoisePositionECEFM(
  positionECEFM: readonly [number, number, number]
): readonly [number, number, number] {
  const [x, y, z] = positionECEFM
  return Object.freeze([
    0.36 * x - 0.48 * y + 0.8 * z + 17_300,
    0.8 * x + 0.6 * y - 29_100,
    -0.48 * x + 0.64 * y + 0.6 * z + 47_600
  ] as const)
}

/** Canonical two-domain shape terms mirrored by volumetricCloudNoiseShape in GLSL. */
export function evaluateCloudNoiseShape(
  primaryNoise: CloudNoiseSample,
  detailNoise: CloudNoiseSample = primaryNoise
): readonly [support: number, erosion: number] {
  const { primaryWorleyMix, detailSupportMix, erosionWorleyMix } = VOLUMETRIC_CLOUD_NOISE_SHAPE
  const primaryBillow = primaryNoise[0] +
    (primaryNoise[1] - primaryNoise[0]) * primaryWorleyMix
  const detailBillow = detailNoise[0] +
    (detailNoise[1] - detailNoise[0]) * primaryWorleyMix
  return Object.freeze([
    Math.min(1, Math.max(0, primaryBillow + (detailBillow - primaryBillow) * detailSupportMix)),
    Math.min(1, Math.max(0, detailNoise[3] + (1 - detailNoise[1] - detailNoise[3]) * erosionWorleyMix))
  ] as const)
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`)
  return value
}

function normalizeDirection(direction: readonly [number, number, number]): readonly [number, number, number] {
  const length = Math.hypot(direction[0], direction[1], direction[2])
  if (!(length > 0) || !Number.isFinite(length)) throw new Error('sunDirectionECEF must be non-zero')
  return Object.freeze([
    direction[0] / length,
    direction[1] / length,
    direction[2] / length
  ] as const)
}

/** Creates an immutable, camera-independent snapshot for all cloud consumers. */
export function createWeatherSnapshot(options: WeatherSnapshotOptions): WeatherSnapshot {
  const planetRadiusM = finite(options.planetRadiusM ?? DEFAULT_PLANET_RADIUS_M, 'planetRadiusM')
  if (!(planetRadiusM > 0)) throw new Error('planetRadiusM must be positive')
  const visualTimeS = finite(options.visualTimeS, 'visualTimeS')
  const generation = options.generation ?? 0
  if (!Number.isInteger(generation) || generation < 0) throw new Error('generation must be a non-negative integer')

  return Object.freeze({
    planetRadiusM,
    northAxisECEF: NORTH_AXIS_ECEF,
    coverageAsset: VOLUMETRIC_WEATHER_ASSETS.coverage,
    typeFieldAsset: VOLUMETRIC_WEATHER_ASSETS.typeField,
    referenceFieldAsset: VOLUMETRIC_WEATHER_ASSETS.referenceField,
    noiseAsset: VOLUMETRIC_WEATHER_ASSETS.noise,
    profiles: VOLUMETRIC_CLOUD_PROFILES,
    profileTables: VOLUMETRIC_CLOUD_PROFILE_TABLES,
    referenceRegion: VOLUMETRIC_REFERENCE_REGION,
    referenceBoundsDeg: Object.freeze([
      VOLUMETRIC_REFERENCE_REGION.centerLongitudeDeg - VOLUMETRIC_REFERENCE_REGION.longitudeExtentDeg,
      VOLUMETRIC_REFERENCE_REGION.centerLatitudeDeg - VOLUMETRIC_REFERENCE_REGION.latitudeExtentDeg,
      VOLUMETRIC_REFERENCE_REGION.centerLongitudeDeg + VOLUMETRIC_REFERENCE_REGION.longitudeExtentDeg,
      VOLUMETRIC_REFERENCE_REGION.centerLatitudeDeg + VOLUMETRIC_REFERENCE_REGION.latitudeExtentDeg
    ] as const),
    bounds: VOLUMETRIC_CLOUD_SUPPORT_BOUNDS,
    visualTimeS,
    sunDirectionECEF: normalizeDirection(options.sunDirectionECEF),
    generation
  })
}

/**
 * ECEF equirectangular mapping shared by CPU reference sampling and the GLSL
 * include.  Longitude wraps in U; north is +Z and therefore V=1.
 */
export function weatherUvFromEcef(positionECEFM: readonly [number, number, number]): readonly [number, number] {
  const length = Math.hypot(positionECEFM[0], positionECEFM[1], positionECEFM[2])
  if (!(length > 0) || !Number.isFinite(length)) throw new Error('positionECEFM must be non-zero and finite')
  const x = positionECEFM[0] / length
  const y = positionECEFM[1] / length
  const z = positionECEFM[2] / length
  const horizontal = Math.hypot(x, y)
  if (horizontal < Number.EPSILON) return [0.5, z < 0 ? 0 : 1]
  const longitude = Math.atan2(y, x)
  return [((longitude / (2 * Math.PI) + 0.5) % 1 + 1) % 1, Math.asin(z) / Math.PI + 0.5]
}

/**
 * CPU contract for the shared weather sampler's requested mip levels. Each map
 * converts the physical footprint using its own texels per radian; weatherLod
 * is a nonnegative additive bias, applied once to each map. Texture sampling
 * clamps requests to the available mip chain. The polar floor matches GLSL.
 */
export function weatherMapLods(
  query: Pick<CloudMediaQuery, 'positionECEFM' | 'footprintM' | 'weatherLod'>,
  snapshot: WeatherSnapshot
): { readonly global: number; readonly reference: number } {
  const length = Math.hypot(...query.positionECEFM)
  if (!(length > 0) || !Number.isFinite(length)) throw new Error('positionECEFM must be non-zero and finite')
  const radiusM = Math.max(length, 1)
  const horizontal = Math.max(Math.hypot(query.positionECEFM[0], query.positionECEFM[1]) / length, 0.02)
  const angularFootprint = Math.max(0, finite(query.footprintM, 'footprintM')) / radiusM
  const bias = Math.max(0, finite(query.weatherLod, 'weatherLod'))
  const lod = (dimensions: readonly number[], longitudeSpanDeg: number, latitudeSpanDeg: number): number => {
    const texelsX = angularFootprint * dimensions[0] /
      (Math.max(longitudeSpanDeg, 1e-6) * RADIANS_PER_DEGREE * horizontal)
    const texelsY = angularFootprint * dimensions[1] /
      (Math.max(latitudeSpanDeg, 1e-6) * RADIANS_PER_DEGREE)
    return bias + Math.log2(Math.max(1, texelsX, texelsY))
  }
  const bounds = snapshot.referenceBoundsDeg
  return {
    global: lod(snapshot.coverageAsset.dimensions, 360, 180),
    reference: lod(snapshot.referenceFieldAsset.dimensions, bounds[2] - bounds[0], bounds[3] - bounds[1])
  }
}

function wrapLongitude(longitudeDeg: number): number {
  return ((longitudeDeg + 180) % 360 + 360) % 360 - 180
}

function smooth(value: number): number {
  const t = Math.min(1, Math.max(0, value))
  return t * t * (3 - 2 * t)
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const span = Math.max(edge1 - edge0, Number.EPSILON)
  return smooth((value - edge0) / span)
}

function hash2(x: number, y: number): number {
  let value = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ 0x0e7e0c10
  value = Math.imul(value ^ (value >>> 13), 1274126177)
  return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff
}

function distanceSquared(
  latitudeDeg: number,
  longitudeDeg: number,
  otherLatitudeDeg: number,
  otherLongitudeDeg: number
): number {
  const longitudeDelta = wrapLongitude(longitudeDeg - otherLongitudeDeg)
  const latitudeDelta = latitudeDeg - otherLatitudeDeg
  return latitudeDelta * latitudeDelta + longitudeDelta * longitudeDelta
}

/** Deterministic authored zones used by the offline reference field. */
export function sampleReferenceWeatherField(latitudeDeg: number, longitudeDeg: number): WeatherFieldSample {
  const longitude = wrapLongitude(longitudeDeg)
  const zones = VOLUMETRIC_REFERENCE_REGION.zones
  if (
    distanceSquared(latitudeDeg, longitude, zones.clearGap.latitudeDeg, zones.clearGap.longitudeDeg) <
    zones.clearGap.radiusDeg ** 2
  ) {
    return Object.freeze({ coverage: 0, typeField: 0 })
  }

  const isolatedDistance = Math.sqrt(
    distanceSquared(
      latitudeDeg,
      longitude,
      zones.isolatedFormation.latitudeDeg,
      zones.isolatedFormation.longitudeDeg
    )
  )
  const isolated = smooth(1 - isolatedDistance / zones.isolatedFormation.radiusDeg)
  if (isolated > 0) {
    return Object.freeze({ coverage: 0.78 * isolated, typeField: 0.1 + 0.08 * isolated })
  }

  const deepDistance = Math.sqrt(
    distanceSquared(latitudeDeg, longitude, zones.deepGroup.latitudeDeg, zones.deepGroup.longitudeDeg)
  )
  const deep = smooth(1 - deepDistance / zones.deepGroup.radiusDeg)
  if (deep > 0) {
    return Object.freeze({ coverage: 0.7 + 0.28 * deep, typeField: 0.34 + 0.1 * deep })
  }

  const broken = zones.brokenField
  if (
    latitudeDeg >= broken.minLatitudeDeg &&
    latitudeDeg <= broken.maxLatitudeDeg &&
    longitude >= broken.minLongitudeDeg &&
    longitude <= broken.maxLongitudeDeg
  ) {
    const cellX = Math.floor((longitude - broken.minLongitudeDeg) * 5)
    const cellY = Math.floor((latitudeDeg - broken.minLatitudeDeg) * 5)
    const cellNoise = hash2(cellX, cellY)
    const clearGap = hash2(cellX + 97, cellY - 31)
    if (clearGap > 0.72) return Object.freeze({ coverage: 0, typeField: 0 })
    return Object.freeze({
      coverage: 0.18 + 0.45 * smooth(cellNoise),
      typeField: 0.03 + 0.2 * cellNoise
    })
  }

  return Object.freeze({ coverage: 0, typeField: 0 })
}

/** CPU reference for fixtures and tools; render consumers use the same UV ABI. */
export function sampleWeatherField(positionECEFM: readonly [number, number, number]): WeatherFieldSample {
  const [u, v] = weatherUvFromEcef(positionECEFM)
  return sampleReferenceWeatherField((v - 0.5) * 180, (u - 0.5) * 360)
}

/**
 * CPU registration oracle for the opt-in moving field. The authored reference
 * field and seeded fronts are sampled in the same canonical frame; the static
 * sampleWeatherField contract above remains byte-for-byte legacy behavior.
 */
export function sampleWeatherFieldWithMotion(
  positionECEFM: readonly [number, number, number],
  motion: WeatherMotionState = IDENTITY_WEATHER_MOTION
): WeatherFieldSample {
  const canonical = canonicalWeatherPositionECEFM(positionECEFM, motion)
  const authored = sampleWeatherField(canonical)
  if (!motion.enabled) return authored
  const fronts = sampleSeededWeatherFront(canonical)
  return Object.freeze({
    coverage: Math.max(0, Math.min(1, authored.coverage * (0.12 + 1.5 * fronts[0]))),
    typeField: Math.max(0, Math.min(1, authored.typeField * 0.55 + fronts[1] * 0.45))
  })
}

function weightForProfile(profile: ReturnType<typeof interpolateCloudProfile>): readonly [number, number, number, number] {
  const left = VOLUMETRIC_CLOUD_PROFILES.findIndex(({ id }) => id === profile.leftType)
  const right = VOLUMETRIC_CLOUD_PROFILES.findIndex(({ id }) => id === profile.rightType)
  const weights: [number, number, number, number] = [0, 0, 0, 0]
  weights[left] = 1 - profile.blend
  weights[right] += profile.blend
  return weights
}

/**
 * One layer evaluator used by CPU fixtures and the matching cloudDensity.glsl
 * include.  Type interpolation happens before the height density curves.
 */
export function evaluateCloudLayerMedia(
  query: CloudMediaQuery,
  field: WeatherFieldSample,
  snapshot: WeatherSnapshot,
  noiseSample: CloudNoiseSample = DEFAULT_CLOUD_NOISE_SAMPLE,
  detailNoiseSample: CloudNoiseSample = noiseSample
): CloudMediaSample {
  const weather = clampCloudWeatherField(field)
  const profile = interpolateCloudProfile(weather.typeField)
  const altitudeM = Math.hypot(...query.positionECEFM) - snapshot.planetRadiusM
  const heightSpanM = Math.max(profile.topAltitudeM - profile.baseAltitudeM, Number.EPSILON)
  const height01 = (altitudeM - profile.baseAltitudeM) / heightSpanM
  const inside = altitudeM >= profile.baseAltitudeM && altitudeM <= profile.topAltitudeM
  const [supportNoise, erosionNoise] = evaluateCloudNoiseShape(noiseSample, detailNoiseSample)
  const normalizedNoise = Math.min(1, Math.max(0,
    (supportNoise - (profile.baseNoiseThreshold - profile.baseNoiseSoftness)) /
      Math.max(2 * profile.baseNoiseSoftness, Number.EPSILON)
  ))
  // Coverage and its height curve expand spatial support. Once inside a body,
  // density is set by the density curve and erosion, not attenuated by coverage.
  const heightCoverage = weather.coverage * evaluateHeightCurve(profile.coverageCurve, height01)
  const baseShape = heightCoverage > 0 ? smoothstep(
    1 - heightCoverage - VOLUMETRIC_CLOUD_COVERAGE_EDGE_SOFTNESS,
    1 - heightCoverage + VOLUMETRIC_CLOUD_COVERAGE_EDGE_SOFTNESS,
    normalizedNoise
  ) : 0
  const erosionMask = smoothstep(
    profile.erosionThreshold - profile.erosionSoftness,
    profile.erosionThreshold + profile.erosionSoftness,
    erosionNoise
  )
  const shapedNoise = Math.min(1, Math.max(0, baseShape - profile.erosionDepth * erosionMask))
  const supportTaper = smoothstep(0, profile.supportFade01, height01) *
    (1 - smoothstep(1 - profile.supportFade01, 1, height01))
  const density = inside
    ? evaluateHeightCurve(profile.densityCurve, height01) *
      shapedNoise *
      supportTaper
    : 0
  const scatteringMInv = density * profile.scatteringCoefficientMInv
  const extinctionMInv = density *
    (profile.scatteringCoefficientMInv + profile.absorptionCoefficientMInv)

  return Object.freeze({
    density,
    extinctionMInv,
    scatteringMInv,
    weights: density > 0 ? weightForProfile(profile) : [0, 0, 0, 0] as const,
    phaseAnisotropy: density > 0 ? profile.phase.anisotropy : [0, 0] as const,
    phaseMix: density > 0 ? profile.phase.mix : 0
  })
}

/**
 * CPU/reference spelling of the fork hook: the query owns physical ECEF
 * inputs. Query jitter is intentionally not an advection input; callers may
 * use it only when choosing a ray sample position before this evaluator.
 */
export function sampleCloudMedia(
  query: CloudMediaQuery,
  snapshot: WeatherSnapshot,
  noiseSample: CloudNoiseSample = DEFAULT_CLOUD_NOISE_SAMPLE,
  detailNoiseSample: CloudNoiseSample = noiseSample
): CloudMediaSample {
  return evaluateCloudLayerMedia(
    query, sampleWeatherField(query.positionECEFM), snapshot, noiseSample, detailNoiseSample
  )
}

/** Shared weather values supplied to camera, secondary, shadow and volume materials. */
function vector4Table(values: readonly (readonly [number, number, number, number])[]): readonly Vector4[] {
  return Object.freeze(values.map(values => new Vector4(...values)))
}

/**
 * Shared uniforms keep their writable .value so texture upload and caller-owned
 * frame updates remain possible. The returned binding map itself is immutable.
 */
export function createWeatherBindingUniforms(
  snapshot: WeatherSnapshot,
  textures: WeatherTextureBindings = {},
  options: WeatherBindingOptions = {}
): WeatherBindingUniforms {
  const motion = options.motion ?? IDENTITY_WEATHER_MOTION
  const northAxis = new Vector3(...snapshot.northAxisECEF)
  const sunDirection = new Vector3(...snapshot.sunDirectionECEF)
  const bounds = new Vector2(snapshot.bounds.minAltitudeM, snapshot.bounds.maxAltitudeM)
  const referenceBounds = new Vector4(...snapshot.referenceBoundsDeg)
  const mapDimensions = new Vector2(
    snapshot.coverageAsset.dimensions[0],
    snapshot.coverageAsset.dimensions[1]
  )
  const referenceMapDimensions = new Vector2(
    snapshot.referenceFieldAsset.dimensions[0],
    snapshot.referenceFieldAsset.dimensions[1]
  )
  const noiseDimensions = new Vector3(
    VOLUMETRIC_WEATHER_ASSETS.noise.dimensions[0],
    VOLUMETRIC_WEATHER_ASSETS.noise.dimensions[1],
    VOLUMETRIC_WEATHER_ASSETS.noise.dimensions[2]
  )
  const tables = snapshot.profileTables
  return Object.freeze({
    volumetricWeatherGeneration: new Uniform(snapshot.generation),
    volumetricWeatherVisualTimeS: new Uniform(snapshot.visualTimeS),
    volumetricWeatherMotionTimeS: new Uniform(motion.timeSeconds),
    volumetricWeatherMotionAngleRad: new Uniform(motion.angleRad),
    volumetricWeatherMotionEnabled: new Uniform(motion.enabled ? 1 : 0),
    volumetricWeatherPlanetRadiusM: new Uniform(snapshot.planetRadiusM),
    volumetricWeatherNorthAxisECEF: new Uniform(northAxis),
    volumetricWeatherSunDirectionECEF: new Uniform(sunDirection),
    volumetricWeatherAltitudeBoundsM: new Uniform(bounds),
    volumetricWeatherSupportDisplacementM: new Uniform(snapshot.bounds.maxWeatherDisplacementM),
    volumetricWeatherMapDimensions: new Uniform(mapDimensions),
    volumetricWeatherReferenceMapDimensions: new Uniform(referenceMapDimensions),
    volumetricWeatherNoiseDimensions: new Uniform(noiseDimensions),
    volumetricWeatherReferenceBoundsDeg: new Uniform(referenceBounds),
    volumetricWeatherReferenceFieldEnabled: new Uniform(textures.referenceField ? 1 : 0),
    volumetricWeatherCoverageTexture: new Uniform(textures.coverage ?? null),
    volumetricWeatherTypeFieldTexture: new Uniform(textures.typeField ?? null),
    volumetricWeatherReferenceFieldTexture: new Uniform(textures.referenceField ?? null),
    volumetricWeatherNoiseTexture: new Uniform(textures.noise ?? null),
    volumetricCloudBaseAltitudeM: new Uniform(new Vector4(...tables.baseAltitudeM)),
    volumetricCloudTopAltitudeM: new Uniform(new Vector4(...tables.topAltitudeM)),
    volumetricCloudPrimaryNoiseScaleM: new Uniform(new Vector4(...tables.primaryNoiseScaleM)),
    volumetricCloudDetailNoiseScaleM: new Uniform(new Vector4(...tables.detailNoiseScaleM)),
    volumetricCloudPrimaryWorleyMix: new Uniform(VOLUMETRIC_CLOUD_NOISE_SHAPE.primaryWorleyMix),
    volumetricCloudDetailSupportMix: new Uniform(VOLUMETRIC_CLOUD_NOISE_SHAPE.detailSupportMix),
    volumetricCloudErosionWorleyMix: new Uniform(VOLUMETRIC_CLOUD_NOISE_SHAPE.erosionWorleyMix),
    volumetricCloudErosionDepth: new Uniform(new Vector4(...tables.erosionDepth)),
    volumetricCloudBaseNoiseThreshold: new Uniform(new Vector4(...tables.baseNoiseThreshold)),
    volumetricCloudBaseNoiseSoftness: new Uniform(new Vector4(...tables.baseNoiseSoftness)),
    volumetricCloudCoverageEdgeSoftness: new Uniform(VOLUMETRIC_CLOUD_COVERAGE_EDGE_SOFTNESS),
    volumetricCloudErosionThreshold: new Uniform(new Vector4(...tables.erosionThreshold)),
    volumetricCloudErosionSoftness: new Uniform(new Vector4(...tables.erosionSoftness)),
    volumetricCloudSupportFade01: new Uniform(new Vector4(...tables.supportFade01)),
    volumetricCloudScatteringCoefficientMInv: new Uniform(new Vector4(...tables.scatteringCoefficientMInv)),
    volumetricCloudAbsorptionCoefficientMInv: new Uniform(new Vector4(...tables.absorptionCoefficientMInv)),
    volumetricCloudPhaseAnisotropyX: new Uniform(new Vector4(...tables.phaseAnisotropyX)),
    volumetricCloudPhaseAnisotropyY: new Uniform(new Vector4(...tables.phaseAnisotropyY)),
    volumetricCloudPhaseMix: new Uniform(new Vector4(...tables.phaseMix)),
    volumetricCloudCoverageKnots: new Uniform(vector4Table(tables.coverageKnots)),
    volumetricCloudCoverageValues: new Uniform(vector4Table(tables.coverageValues)),
    volumetricCloudDensityKnots: new Uniform(vector4Table(tables.densityKnots)),
    volumetricCloudDensityValues: new Uniform(vector4Table(tables.densityValues))
  })
}

export const VOLUMETRIC_DEFAULT_PLANET_RADIUS_M = DEFAULT_PLANET_RADIUS_M
export const VOLUMETRIC_NORTH_AXIS_ECEF = NORTH_AXIS_ECEF
export const VOLUMETRIC_DEGREES_PER_RADIAN = DEGREES_PER_RADIAN
export const VOLUMETRIC_RADIANS_PER_DEGREE = RADIANS_PER_DEGREE
