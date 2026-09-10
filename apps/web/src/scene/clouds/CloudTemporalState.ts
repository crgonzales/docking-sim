type Vector3Tuple = readonly [number, number, number]
type QuaternionTuple = readonly [number, number, number, number]

/** CPU metadata only; one instance per view, with no renderer/matrix ownership. */
export interface CloudTemporalFrame {
  /** Unjittered projection, 16 elements in the renderer's matrix order. */
  readonly projectionMatrix: readonly number[]
  /** Actual framebuffer pixels; DPR is tracked separately even at equal sizes. */
  readonly viewportWidth: number
  readonly viewportHeight: number
  readonly dpr: number
  readonly backend: string
  /** Float64 physical position, never a camera-relative or rebased position. */
  readonly cameraPositionECEFM: Vector3Tuple
  /** Camera orientation in the same stable ECEF frame, scalar-first [w,x,y,z]. */
  readonly cameraOrientationECEF: QuaternionTuple
  /** Metadata for the host's existing CloudReprojectionFrame, not a reset key. */
  readonly rebaseOriginECEFM: Vector3Tuple
  readonly weatherGeneration: number
  readonly lightingGeneration: number
  /** Change these keys only when the corresponding update cannot reproject. */
  readonly weatherCompatibilityKey: string | number
  readonly lightingCompatibilityKey: string | number
  readonly representationCompatibilityKey: string | number
  /** Compatible continuous near/far transitions retain history. */
  readonly nearFarWeights: readonly [number, number]
  /** Explicit teleport/camera-mode discontinuity, even below cut thresholds. */
  readonly cameraCut?: boolean
}

export interface CloudCameraCutThresholds {
  /** Absolute displacement between rendered frames, independent of Earth radius. */
  readonly distanceM: number
  /** Shortest rotation between rendered orientations, including camera roll. */
  readonly angleRad: number
}

export const DEFAULT_CLOUD_CAMERA_CUT_THRESHOLDS: CloudCameraCutThresholds = Object.freeze({
  distanceM: 1000,
  angleRad: Math.PI / 6
})

export type CloudTemporalResetReason =
  | 'initial'
  | 'invalidated'
  | 'projection'
  | 'viewport'
  | 'dpr'
  | 'backend'
  | 'camera-cut'
  | 'weather'
  | 'lighting'
  | 'representation'

export interface CloudTemporalDecision {
  readonly historyValid: boolean
  readonly reset: boolean
  readonly reasons: readonly CloudTemporalResetReason[]
}

function validateThresholds(thresholds: CloudCameraCutThresholds): void {
  if (!Number.isFinite(thresholds.distanceM) || thresholds.distanceM < 0 ||
      !Number.isFinite(thresholds.angleRad) || thresholds.angleRad < 0 || thresholds.angleRad > Math.PI) {
    throw new Error('Cloud camera cut thresholds require finite metres >= 0 and radians in [0, PI]')
  }
}

function validatePose(position: Vector3Tuple, orientation: QuaternionTuple): void {
  if (position.length !== 3 || !position.every(Number.isFinite) || orientation.length !== 4 ||
      !orientation.every(Number.isFinite) || !(Math.hypot(...orientation) > 0) ||
      !Number.isFinite(Math.hypot(...orientation))) {
    throw new Error('Cloud temporal camera pose must be finite with a nonzero quaternion')
  }
}

/** Strictly greater than either threshold is a cut; q and -q are identical. */
export function isCloudCameraCut(
  previous: Pick<CloudTemporalFrame, 'cameraPositionECEFM' | 'cameraOrientationECEF'>,
  current: Pick<CloudTemporalFrame, 'cameraPositionECEFM' | 'cameraOrientationECEF' | 'cameraCut'>,
  thresholds: CloudCameraCutThresholds = DEFAULT_CLOUD_CAMERA_CUT_THRESHOLDS
): boolean {
  validateThresholds(thresholds)
  validatePose(previous.cameraPositionECEFM, previous.cameraOrientationECEF)
  validatePose(current.cameraPositionECEFM, current.cameraOrientationECEF)
  if (current.cameraCut) return true

  const before = previous.cameraPositionECEFM
  const after = current.cameraPositionECEFM
  // Subtract float64 ECEF coordinates before taking the norm. Normalizing the
  // Earth-sized positions would miss altitude teleports and small local cuts.
  if (Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]) > thresholds.distanceM) {
    return true
  }

  const p = previous.cameraOrientationECEF
  const q = current.cameraOrientationECEF
  const pLength = Math.hypot(...p)
  const qLength = Math.hypot(...q)
  const pn = p.map(value => value / pLength)
  const qn = q.map(value => value / qLength)
  const dot = pn.reduce((sum, value, index) => sum + value * qn[index], 0)
  const sign = dot < 0 ? -1 : 1
  // Chord distance avoids acos precision loss close to the identity, and the
  // sign makes the test invariant to the quaternion double cover.
  const chord = Math.hypot(...pn.map((value, index) => value - sign * qn[index]))
  const angle = 4 * Math.asin(Math.min(1, chord / 2))
  return angle > thresholds.angleRad
}

function validateFrame(frame: CloudTemporalFrame): void {
  validatePose(frame.cameraPositionECEFM, frame.cameraOrientationECEF)
  if (frame.projectionMatrix.length !== 16 || !frame.projectionMatrix.every(Number.isFinite)) {
    throw new Error('Cloud temporal projection must have 16 finite unjittered elements')
  }
  if (!Number.isInteger(frame.viewportWidth) || frame.viewportWidth <= 0 ||
      !Number.isInteger(frame.viewportHeight) || frame.viewportHeight <= 0 ||
      !Number.isFinite(frame.dpr) || frame.dpr <= 0) {
    throw new Error('Cloud temporal viewport requires positive integer pixels and finite positive DPR')
  }
  if (frame.rebaseOriginECEFM.length !== 3 || !frame.rebaseOriginECEFM.every(Number.isFinite) ||
      !Number.isSafeInteger(frame.weatherGeneration) || frame.weatherGeneration < 0 ||
      !Number.isSafeInteger(frame.lightingGeneration) || frame.lightingGeneration < 0 ||
      frame.nearFarWeights.length !== 2 ||
      !frame.nearFarWeights.every(value => Number.isFinite(value) && value >= 0 && value <= 1) ||
      Math.abs(frame.nearFarWeights[0] + frame.nearFarWeights[1] - 1) > 1e-6) {
    throw new Error('Cloud temporal metadata requires finite origin, nonnegative generations, and normalized weights')
  }
}

/** Compare metadata without mutating either frame or any GPU resource. */
export function cloudTemporalResetReasons(
  previous: CloudTemporalFrame | null,
  current: CloudTemporalFrame,
  thresholds: CloudCameraCutThresholds = DEFAULT_CLOUD_CAMERA_CUT_THRESHOLDS
): readonly CloudTemporalResetReason[] {
  validateThresholds(thresholds)
  validateFrame(current)
  if (previous == null) return ['initial']
  validateFrame(previous)
  const reasons: CloudTemporalResetReason[] = []
  if (current.projectionMatrix.some((value, index) => value !== previous.projectionMatrix[index])) reasons.push('projection')
  if (current.viewportWidth !== previous.viewportWidth || current.viewportHeight !== previous.viewportHeight) reasons.push('viewport')
  if (current.dpr !== previous.dpr) reasons.push('dpr')
  if (current.backend !== previous.backend) reasons.push('backend')
  if (isCloudCameraCut(previous, current, thresholds)) reasons.push('camera-cut')
  if (current.weatherCompatibilityKey !== previous.weatherCompatibilityKey) reasons.push('weather')
  if (current.lightingCompatibilityKey !== previous.lightingCompatibilityKey) reasons.push('lighting')
  if (current.representationCompatibilityKey !== previous.representationCompatibilityKey) reasons.push('representation')
  return reasons
}

function snapshot(frame: CloudTemporalFrame): CloudTemporalFrame {
  return {
    ...frame,
    projectionMatrix: [...frame.projectionMatrix],
    cameraPositionECEFM: [...frame.cameraPositionECEFM],
    cameraOrientationECEF: [...frame.cameraOrientationECEF],
    rebaseOriginECEFM: [...frame.rebaseOriginECEFM],
    nearFarWeights: [...frame.nearFarWeights]
  }
}

/**
 * beforeRender decides whether the host must call CloudsPass.invalidateHistory.
 * Call afterRender only after a successful resolve to publish its metadata.
 * Rebase matrices remain owned by the existing backend reprojection host.
 */
export class CloudTemporalState {
  private previous: CloudTemporalFrame | null = null
  private valid = false
  private readonly thresholds: CloudCameraCutThresholds

  constructor(thresholds: Partial<CloudCameraCutThresholds> = {}) {
    this.thresholds = { ...DEFAULT_CLOUD_CAMERA_CUT_THRESHOLDS, ...thresholds }
    validateThresholds(this.thresholds)
  }

  get historyValid(): boolean {
    return this.valid
  }

  invalidateHistory(): void {
    this.valid = false
  }

  beforeRender(frame: CloudTemporalFrame): CloudTemporalDecision {
    const reasons = [...cloudTemporalResetReasons(this.previous, frame, this.thresholds)]
    if (!this.valid && this.previous != null) reasons.unshift('invalidated')
    if (reasons.length > 0) this.valid = false
    return { historyValid: this.valid, reset: !this.valid, reasons }
  }

  afterRender(frame: CloudTemporalFrame): void {
    validateFrame(frame)
    this.previous = snapshot(frame)
    this.valid = true
  }
}
