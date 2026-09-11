/**
 * Canonical wind coordinates for the volumetric weather field.
 *
 * Weather is authored in ECEF with north on +Z.  A positive angle is an
 * eastward rotation around +Z, so a live lookup applies the inverse rotation
 * before it samples either authored maps or either noise domain.
 */

export const WEATHER_WIND_SPEED_MPS = 15
export const WEATHER_MOTION_SEED = 0x51eaf17
export const WEATHER_TAU = 2 * Math.PI

export interface WeatherMotionState {
  readonly enabled: boolean
  readonly timeSeconds: number
  /** Wrapped physical weather rotation. The canonical atlas always uses 0. */
  readonly angleRad: number
  readonly windSpeedMps: number
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`)
  return value
}

function wrapAngle(angleRad: number): number {
  const wrapped = angleRad % WEATHER_TAU
  return wrapped < 0 ? wrapped + WEATHER_TAU : wrapped
}

/** Wind angular speed for the current planet radius. */
export function weatherAngularSpeedRadS(planetRadiusM: number): number {
  const radius = finite(planetRadiusM, 'planetRadiusM')
  if (!(radius > 0)) throw new RangeError('planetRadiusM must be positive')
  return WEATHER_WIND_SPEED_MPS / radius
}

/**
 * Returns a finite, wrapped rotation. Wrapping keeps trigonometric uniforms
 * well-conditioned after many environment days without changing the field.
 */
export function weatherMotionAngleRad(timeSeconds: number, planetRadiusM: number): number {
  return wrapAngle(finite(timeSeconds, 'weather timeSeconds') * weatherAngularSpeedRadS(planetRadiusM))
}

export function createWeatherMotionState(
  timeSeconds: number,
  planetRadiusM: number,
  enabled = true
): WeatherMotionState {
  const time = finite(timeSeconds, 'weather timeSeconds')
  return Object.freeze({
    enabled: Boolean(enabled),
    timeSeconds: time,
    angleRad: enabled ? weatherMotionAngleRad(time, planetRadiusM) : 0,
    windSpeedMps: WEATHER_WIND_SPEED_MPS
  })
}

/** Rotate an ECEF vector around the fixed north axis (+Z). */
export function rotateWeatherEcefAroundNorth(
  positionECEFM: readonly [number, number, number],
  angleRad: number
): readonly [number, number, number] {
  const angle = finite(angleRad, 'weather angle')
  if (positionECEFM.length !== 3 || !positionECEFM.every(Number.isFinite)) {
    throw new RangeError('positionECEFM must contain three finite values')
  }
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  return Object.freeze([
    cosine * positionECEFM[0] - sine * positionECEFM[1],
    sine * positionECEFM[0] + cosine * positionECEFM[1],
    positionECEFM[2]
  ] as const)
}

/**
 * Convert a live physical lookup into the canonical weather frame. This is
 * the one transform shared by coverage, type, primary noise and detail noise.
 */
export function canonicalWeatherPositionECEFM(
  positionECEFM: readonly [number, number, number],
  motion: Pick<WeatherMotionState, 'enabled' | 'angleRad'>
): readonly [number, number, number] {
  return motion.enabled
    ? rotateWeatherEcefAroundNorth(positionECEFM, -finite(motion.angleRad, 'weather angle'))
    : Object.freeze([...positionECEFM] as [number, number, number])
}

/** Relative rotation that maps a current cloud front to its previous position. */
export function previousWeatherRotationAngleRad(previousAngleRad: number, currentAngleRad: number): number {
  const delta = finite(currentAngleRad, 'current weather angle') - finite(previousAngleRad, 'previous weather angle')
  let shortest = ((delta + Math.PI) % WEATHER_TAU + WEATHER_TAU) % WEATHER_TAU - Math.PI
  if (shortest === -Math.PI) shortest = Math.PI
  return -shortest
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(edge1 - edge0, Number.EPSILON)))
  return t * t * (3 - 2 * t)
}

/**
 * Seeded, continuous fronts in canonical spherical coordinates. The same
 * function is spelled in cloudDensity.glsl. It intentionally changes only
 * coverage/type; height and noise remain authored cloud-profile data.
 */
export function sampleSeededWeatherFront(
  canonicalPositionECEFM: readonly [number, number, number]
): readonly [coverage: number, typeField: number] {
  const radius = Math.hypot(...canonicalPositionECEFM)
  if (!(radius > 0) || !Number.isFinite(radius)) throw new RangeError('canonicalPositionECEFM must be non-zero and finite')
  const [x, y, z] = canonicalPositionECEFM.map(value => value / radius)
  const seed = WEATHER_MOTION_SEED * 1e-7
  // Smooth 3D waves restricted to the sphere: no longitude seam or pole singularity.
  const broad = 0.5 + 0.5 * Math.sin(9 * x + 31 * y + 13 * z + seed + 0.8 * Math.sin(17 * x - 11 * y + 7 * z))
  const secondary = 0.5 + 0.5 * Math.sin(37 * x - 19 * y - 23 * z + 1.7 + seed * 0.37)
  const meridional = 0.5 + 0.5 * Math.sin(5 * x + 8 * y + 13 * z + 0.91)
  const organized = smoothstep(0.32, 0.72, broad)
  const broken = 0.65 + 0.35 * secondary
  const coverage = Math.max(0, Math.min(1, 0.06 + 0.85 * organized * broken + 0.03 * meridional))
  const typeField = Math.max(0, Math.min(1, 0.04 + 0.78 * organized + 0.12 * meridional + 0.04 * secondary))
  return Object.freeze([coverage, typeField] as const)
}

export const IDENTITY_WEATHER_MOTION: WeatherMotionState = Object.freeze({
  enabled: false,
  timeSeconds: 0,
  angleRad: 0,
  windSpeedMps: WEATHER_WIND_SPEED_MPS
})
