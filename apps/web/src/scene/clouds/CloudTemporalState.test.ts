import { describe, expect, it } from 'vitest'

import {
  CloudTemporalState,
  cloudTemporalResetReasons,
  isCloudCameraCut,
  type CloudTemporalFrame,
  type CloudTemporalResetReason
} from './CloudTemporalState'

const EARTH_RADIUS_M = 6_371_000
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function frame(overrides: Partial<CloudTemporalFrame> = {}): CloudTemporalFrame {
  return {
    projectionMatrix: [...IDENTITY],
    viewportWidth: 1920,
    viewportHeight: 1080,
    dpr: 1,
    backend: 'takram-volumetric',
    cameraPositionECEFM: [EARTH_RADIUS_M + 400_000, 0, 0],
    cameraOrientationECEF: [1, 0, 0, 0],
    rebaseOriginECEFM: [EARTH_RADIUS_M, 0, 0],
    weatherGeneration: 10,
    lightingGeneration: 20,
    weatherCompatibilityKey: 'weather-a',
    lightingCompatibilityKey: 'sun-a',
    representationCompatibilityKey: 'near-far-a',
    nearFarWeights: [1, 0],
    ...overrides
  }
}

describe('CloudTemporalState', () => {
  it('starts invalid and publishes history only after a successful render', () => {
    const state = new CloudTemporalState()
    expect(state.historyValid).toBe(false)
    expect(state.beforeRender(frame())).toEqual({ historyValid: false, reset: true, reasons: ['initial'] })
    // A skipped/failed render must not bootstrap history.
    expect(state.beforeRender(frame()).historyValid).toBe(false)
    state.afterRender(frame())
    expect(state.beforeRender(frame())).toEqual({ historyValid: true, reset: false, reasons: [] })
  })

  it.each<[CloudTemporalResetReason, Partial<CloudTemporalFrame>]>([
    ['projection', { projectionMatrix: IDENTITY.map((value, index) => index === 0 ? 1.1 : value) }],
    ['viewport', { viewportWidth: 1919 }],
    ['viewport', { viewportHeight: 1079 }],
    ['dpr', { dpr: 2 }],
    ['backend', { backend: 'reference' }],
    ['weather', { weatherCompatibilityKey: 'new-front' }],
    ['lighting', { lightingCompatibilityKey: 'new-sun' }],
    ['representation', { representationCompatibilityKey: 'incompatible-far' }]
  ])('invalidates for %s and accepts the new state after resolve', (reason, change) => {
    const state = new CloudTemporalState()
    state.afterRender(frame())
    const next = frame(change)
    expect(state.beforeRender(next)).toEqual({ historyValid: false, reset: true, reasons: [reason] })
    expect(state.historyValid).toBe(false)
    state.afterRender(next)
    expect(state.beforeRender(next).reset).toBe(false)
  })

  it('reports all simultaneous incompatibilities', () => {
    expect(cloudTemporalResetReasons(frame(), frame({
      viewportWidth: 640,
      dpr: 0.75,
      backend: 'reference',
      weatherCompatibilityKey: 'weather-b',
      lightingCompatibilityKey: 'sun-b'
    }))).toEqual(['viewport', 'dpr', 'backend', 'weather', 'lighting'])
  })

  it('retains normal orbital movement, rebases and compatible generations together', () => {
    const state = new CloudTemporalState()
    state.afterRender(frame())
    const next = frame({
      cameraPositionECEFM: [EARTH_RADIUS_M + 400_000, 128, 0],
      cameraOrientationECEF: [Math.cos(0.005), 0, Math.sin(0.005), 0],
      rebaseOriginECEFM: [0, EARTH_RADIUS_M, 0],
      weatherGeneration: 11,
      lightingGeneration: 24,
      nearFarWeights: [0.9, 0.1]
    })
    expect(state.beforeRender(next)).toEqual({ historyValid: true, reset: false, reasons: [] })
  })

  it('measures motion against the last rendered frame, not the initial camera', () => {
    const state = new CloudTemporalState()
    state.afterRender(frame())
    for (let step = 1; step <= 600; ++step) {
      const next = frame({ cameraPositionECEFM: [EARTH_RADIUS_M + 400_000, step * 500, 0] })
      expect(state.beforeRender(next).reset).toBe(false)
      state.afterRender(next)
    }
  })

  it('does not hide a physical teleport behind a matching origin shift', () => {
    const state = new CloudTemporalState()
    state.afterRender(frame())
    expect(state.beforeRender(frame({
      cameraPositionECEFM: [EARTH_RADIUS_M + 3000, 0, 0],
      rebaseOriginECEFM: [EARTH_RADIUS_M - 397_000, 0, 0]
    })).reasons).toEqual(['camera-cut'])
  })

  it('keeps an invalidation pending until a new image is actually rendered', () => {
    const state = new CloudTemporalState()
    state.afterRender(frame())
    state.invalidateHistory()
    expect(state.beforeRender(frame()).reasons).toEqual(['invalidated'])
    expect(state.beforeRender(frame()).historyValid).toBe(false)
    state.afterRender(frame())
    expect(state.beforeRender(frame()).reset).toBe(false)
  })

  it('snapshots mutable caller arrays at publication', () => {
    const projection = [...IDENTITY]
    const position: [number, number, number] = [EARTH_RADIUS_M + 400_000, 0, 0]
    const orientation: [number, number, number, number] = [1, 0, 0, 0]
    const state = new CloudTemporalState()
    const mutable = frame({ projectionMatrix: projection, cameraPositionECEFM: position, cameraOrientationECEF: orientation })
    state.afterRender(mutable)
    projection[0] = 2
    position[0] -= 397_000
    orientation[0] = 0
    orientation[3] = 1
    expect(state.beforeRender(mutable).reasons).toEqual(['projection', 'camera-cut'])
  })

  it('isolates main and PiP history', () => {
    const main = new CloudTemporalState()
    const pip = new CloudTemporalState()
    main.afterRender(frame())
    expect(pip.beforeRender(frame()).reset).toBe(true)
    pip.afterRender(frame({ viewportWidth: 320, viewportHeight: 180 }))
    main.invalidateHistory()
    expect(pip.beforeRender(frame({ viewportWidth: 320, viewportHeight: 180 })).reset).toBe(false)
  })

  it('rejects non-finite metadata without publishing history', () => {
    const state = new CloudTemporalState()
    expect(() => state.afterRender(frame({ cameraPositionECEFM: [NaN, 0, 0] }))).toThrow()
    expect(() => state.afterRender(frame({ cameraOrientationECEF: [0, 0, 0, 0] }))).toThrow()
    expect(() => state.afterRender(frame({ dpr: 0 }))).toThrow()
    expect(state.historyValid).toBe(false)
  })
})

describe('isCloudCameraCut', () => {
  it('uses absolute metre thresholds at Earth scale, including radial teleports', () => {
    const thresholds = { distanceM: 25, angleRad: Math.PI / 6 }
    const previous = frame({ cameraPositionECEFM: [EARTH_RADIUS_M + 50, 0, 0] })
    expect(isCloudCameraCut(previous, frame({ cameraPositionECEFM: [EARTH_RADIUS_M + 75, 0, 0] }), thresholds)).toBe(false)
    expect(isCloudCameraCut(previous, frame({ cameraPositionECEFM: [EARTH_RADIUS_M + 75.001, 0, 0] }), thresholds)).toBe(true)
  })

  it('accounts for displacement on all three axes', () => {
    const previous = frame({ cameraPositionECEFM: [EARTH_RADIUS_M, 0, 0] })
    const next = frame({ cameraPositionECEFM: [EARTH_RADIUS_M + 3, 4, 12] })
    expect(isCloudCameraCut(previous, next, { distanceM: 13, angleRad: Math.PI })).toBe(false)
    expect(isCloudCameraCut(previous, next, { distanceM: 12.99, angleRad: Math.PI })).toBe(true)
  })

  it('honors explicit user teleports below automatic thresholds', () => {
    expect(isCloudCameraCut(frame(), frame({ cameraCut: true }))).toBe(true)
    expect(isCloudCameraCut(frame(), frame({ cameraCut: false }))).toBe(false)
  })

  it('is invariant to quaternion sign and scale', () => {
    const previous = frame({ cameraOrientationECEF: [0.5, 0.5, 0.5, 0.5] })
    const next = frame({ cameraOrientationECEF: [-2, -2, -2, -2] })
    expect(isCloudCameraCut(previous, next, { distanceM: 0, angleRad: 0 })).toBe(false)
  })

  it('detects pure roll and tests the configured angle on either side', () => {
    const angleRad = Math.PI / 6
    const rotation = (angle: number) => frame({ cameraOrientationECEF: [Math.cos(angle / 2), 0, 0, Math.sin(angle / 2)] })
    expect(isCloudCameraCut(frame(), rotation(angleRad - 1e-6))).toBe(false)
    expect(isCloudCameraCut(frame(), rotation(angleRad + 1e-6))).toBe(true)
    expect(isCloudCameraCut(frame(), rotation(Math.PI / 2))).toBe(true)
  })

  it('retains precision for tiny angular cut thresholds', () => {
    const angle = 1e-9
    const next = frame({ cameraOrientationECEF: [Math.cos(angle / 2), Math.sin(angle / 2), 0, 0] })
    expect(isCloudCameraCut(frame(), next, { distanceM: 1, angleRad: angle / 2 })).toBe(true)
    expect(isCloudCameraCut(frame(), next, { distanceM: 1, angleRad: angle * 2 })).toBe(false)
  })

  it('rejects unusable cut policies', () => {
    expect(() => new CloudTemporalState({ distanceM: Infinity })).toThrow()
    expect(() => new CloudTemporalState({ distanceM: -1 })).toThrow()
    expect(() => new CloudTemporalState({ angleRad: Math.PI + 0.1 })).toThrow()
  })
})
