import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { Texture, Vector4 } from 'three'

import type { CloudMediaQuery } from './CloudBackend'
import {
  cloudDetailNoisePositionECEFM,
  createWeatherBindingUniforms,
  createWeatherSnapshot,
  DEFAULT_CLOUD_NOISE_SAMPLE,
  evaluateCloudLayerMedia,
  EVE_WEATHER_ASSETS,
  sampleCloudMedia,
  sampleReferenceWeatherField,
  sampleWeatherField,
  weatherMapLods,
  weatherUvFromEcef,
  type CloudNoiseSample,
  type WeatherSnapshot
} from './cloudWeather'
import {
  EVE_CLOUD_COVERAGE_EDGE_SOFTNESS, EVE_CLOUD_PROFILE_TABLES, EVE_REFERENCE_REGION,
  interpolateCloudProfile, type WeatherFieldSample
} from './cloudConfig'

const radiusM = 6_371_000
const snapshot = createWeatherSnapshot({
  visualTimeS: 17.25,
  sunDirectionECEF: [0.3, 0.4, 0.5],
  planetRadiusM: radiusM,
  generation: 4
})

// Match the byte-backed, fixed-domain oracle in CloudWeatherFixture. These
// helpers only sample assets; all density and transport use the production CPU
// evaluator. cloudData.test.ts separately verifies asset hashes and generation.
const noiseBytes = readFileSync(new URL(`../../../public${EVE_WEATHER_ASSETS.noise.path}`, import.meta.url))
const referenceBytes = readFileSync(new URL(`../../../public${EVE_WEATHER_ASSETS.referenceField.path}`, import.meta.url))

function positionAt(latitudeDeg: number, longitudeDeg: number, altitudeM: number): CloudMediaQuery['positionECEFM'] {
  const latitude = latitudeDeg * Math.PI / 180
  const longitude = longitudeDeg * Math.PI / 180
  const radius = radiusM + altitudeM
  return [radius * Math.cos(latitude) * Math.cos(longitude),
    radius * Math.cos(latitude) * Math.sin(longitude), radius * Math.sin(latitude)]
}

function noiseAtScale(position: CloudMediaQuery['positionECEFM'], scaleM: number): CloudNoiseSample {
  const size = EVE_WEATHER_ASSETS.noise.dimensions[0]
  const coordinates = position.map(value => {
    const unit = Math.fround(Math.fround(value) / Math.fround(scaleM))
    return (unit - Math.floor(unit)) * size - 0.5
  })
  const low = coordinates.map(Math.floor)
  const fraction = coordinates.map((value, axis) => value - low[axis])
  const result: [number, number, number, number] = [0, 0, 0, 0]
  for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const tap = [x, y, z]
    const wrapped = tap.map((offset, axis) => ((low[axis] + offset) % size + size) % size)
    const weight = tap.reduce((product, offset, axis) => product *
      (offset ? fraction[axis] : 1 - fraction[axis]), 1)
    const index = ((wrapped[2] * size + wrapped[1]) * size + wrapped[0]) * 4
    for (let channel = 0; channel < 4; channel++) result[channel] += noiseBytes[index + channel] / 255 * weight
  }
  return result
}

function actualNoise(position: CloudMediaQuery['positionECEFM'], typeField: number) {
  const scalar = typeField * 3
  const left = Math.min(3, Math.floor(scalar)), right = Math.min(3, left + 1)
  const blend = scalar - left
  const sampleDomain = (domain: CloudMediaQuery['positionECEFM'], scales: readonly number[]): CloudNoiseSample => {
    const a = noiseAtScale(domain, scales[left])
    const b = noiseAtScale(domain, scales[right])
    const mix = (channel: number) => a[channel] + (b[channel] - a[channel]) * blend
    return [mix(0), mix(1), mix(2), mix(3)]
  }
  return {
    primary: sampleDomain(position, EVE_CLOUD_PROFILE_TABLES.primaryNoiseScaleM),
    detail: sampleDomain(cloudDetailNoisePositionECEFM(position), EVE_CLOUD_PROFILE_TABLES.detailNoiseScaleM)
  }
}

function actualReference(latitudeDeg: number, longitudeDeg: number): WeatherFieldSample {
  const [width, height] = EVE_WEATHER_ASSETS.referenceField.dimensions
  const region = EVE_REFERENCE_REGION
  const x = (longitudeDeg - region.centerLongitudeDeg + region.longitudeExtentDeg) /
    (2 * region.longitudeExtentDeg) * width - 0.5
  const y = (latitudeDeg - region.centerLatitudeDeg + region.latitudeExtentDeg) /
    (2 * region.latitudeExtentDeg) * height - 0.5
  const lowX = Math.floor(x), lowY = Math.floor(y), fx = x - lowX, fy = y - lowY
  const values = [0, 0]
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const tx = Math.max(0, Math.min(width - 1, lowX + dx))
    const ty = Math.max(0, Math.min(height - 1, lowY + dy))
    const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy)
    for (let channel = 0; channel < 2; channel++) values[channel] += referenceBytes[(ty * width + tx) * 2 + channel] / 255 * weight
  }
  return { coverage: values[0], typeField: values[1] }
}

function columnOpticalDepth(latitude: number, longitude: number, maxStepM = 25): number {
  const field = actualReference(latitude, longitude)
  const profile = interpolateCloudProfile(field.typeField)
  const span = profile.topAltitudeM - profile.baseAltitudeM
  const steps = Math.ceil(span / maxStepM), stepM = span / steps
  let tau = 0
  for (let i = 0; i < steps; i++) {
    const position = positionAt(latitude, longitude, profile.baseAltitudeM + (i + 0.5) * stepM)
    const noise = actualNoise(position, field.typeField)
    const media = evaluateCloudLayerMedia({ positionECEFM: position, footprintM: 0, weatherLod: 0, jitter: 0 },
      field, snapshot, noise.primary, noise.detail)
    tau += media.extinctionMInv * stepM
  }
  return tau
}

describe('EVE weather snapshot and media', () => {
  it('uses the engine ECEF north-at-V=1 mapping', () => {
    expect(weatherUvFromEcef([0, 0, radiusM])).toEqual([0.5, 1])
    expect(weatherUvFromEcef([0, 0, -radiusM])).toEqual([0.5, 0])
    expect(weatherUvFromEcef([radiusM, 0, 0])).toEqual([0.5, 0.5])
    expect(weatherUvFromEcef([0, radiusM, 0])).toEqual([0.75, 0.5])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(snapshot.visualTimeS).toBe(17.25)
  })

  it('exposes one immutable binding set without camera or rebase state', () => {
    const uniforms = createWeatherBindingUniforms(snapshot)
    expect(Object.isFrozen(uniforms)).toBe(true)
    expect(uniforms.eveWeatherVisualTimeS.value).toBe(17.25)
    expect(uniforms.eveCloudCoverageEdgeSoftness.value).toBe(EVE_CLOUD_COVERAGE_EDGE_SOFTNESS)
    expect(uniforms.eveCloudPrimaryNoiseScaleM.value).toEqual(new Vector4(...EVE_CLOUD_PROFILE_TABLES.primaryNoiseScaleM))
    expect(uniforms.eveCloudDetailNoiseScaleM.value).toEqual(new Vector4(...EVE_CLOUD_PROFILE_TABLES.detailNoiseScaleM))
    expect(uniforms.eveWeatherMapDimensions.value).toMatchObject({ x: 1024, y: 512 })
    expect(uniforms.eveWeatherReferenceMapDimensions.value).toMatchObject({ x: 128, y: 64 })
    expect(uniforms.eveWeatherGeneration.value).toBe(4)
    expect(uniforms.eveWeatherNorthAxisECEF.value).toMatchObject({ x: 0, y: 0, z: 1 })
    expect(uniforms.eveWeatherAltitudeBoundsM.value).toMatchObject({
      x: snapshot.bounds.minAltitudeM,
      y: snapshot.bounds.maxAltitudeM
    })
    expect(uniforms).not.toHaveProperty('cameraPosition')
    expect(uniforms).not.toHaveProperty('rebaseOffset')

    const coverageTexture = new Texture()
    const textured = createWeatherBindingUniforms(snapshot, { coverage: coverageTexture })
    expect(textured.eveWeatherCoverageTexture.value).toBe(coverageTexture)
    textured.eveWeatherCoverageTexture.value = null
    expect(textured.eveWeatherCoverageTexture.value).toBeNull()
    const referenceTexture = new Texture()
    const referenceBindings = createWeatherBindingUniforms(snapshot, { referenceField: referenceTexture })
    expect(referenceBindings.eveWeatherReferenceFieldEnabled.value).toBe(1)
    expect(referenceBindings.eveWeatherReferenceFieldTexture.value).toBe(referenceTexture)
  })

  it('filters a four-local-texel footprint without coarsening the subtexel global map', () => {
    const latitudeDeg = 40.5, altitudeM = 2200
    // Independent physical pixel size: the local patch spans 6.4 degrees in
    // longitude, with 128 texels, each scaled by the parallel's circumference.
    const localPixelM = (radiusM + altitudeM) * Math.cos(latitudeDeg * Math.PI / 180) *
      (6.4 * Math.PI / 180) / 128
    const query = { positionECEFM: positionAt(latitudeDeg, -75, altitudeM),
      footprintM: 4 * localPixelM, weatherLod: 0 }
    const lods = weatherMapLods(query, snapshot)
    expect(lods.global).toBe(0)
    expect(lods.reference).toBeCloseTo(2, 10)
    const biased = weatherMapLods({ ...query, weatherLod: 0.75 }, snapshot)
    expect(biased.global).toBe(0.75)
    expect(biased.reference).toBeCloseTo(2.75, 10)
    expect(weatherMapLods({ ...query, footprintM: localPixelM * 0.5 }, snapshot)).toEqual({ global: 0, reference: 0 })
    expect(weatherMapLods({ ...query, footprintM: -100, weatherLod: -2 }, snapshot)).toEqual({ global: 0, reference: 0 })
  })

  it('uses each reference descriptor and angular bounds in both CPU requests and bindings', () => {
    const query = { positionECEFM: positionAt(40.5, -75, 2200), footprintM: 20_000, weatherLod: 0 }
    const baseline = weatherMapLods(query, snapshot)
    const finer: WeatherSnapshot = { ...snapshot, referenceFieldAsset: {
      ...snapshot.referenceFieldAsset, dimensions: [256, 128]
    } }
    const smallerPatch: WeatherSnapshot = { ...snapshot, referenceBoundsDeg: [-76.6, 39.3, -73.4, 41.7] }
    for (const changed of [finer, smallerPatch]) {
      const lods = weatherMapLods(query, changed)
      expect(lods.reference).toBeCloseTo(baseline.reference + 1, 10)
      expect(lods.global).toBe(baseline.global)
    }
    expect(createWeatherBindingUniforms(finer).eveWeatherReferenceMapDimensions.value).toMatchObject({ x: 256, y: 128 })
    expect(createWeatherBindingUniforms(smallerPatch).eveWeatherReferenceBoundsDeg.value)
      .toMatchObject({ x: -76.6, y: 39.3, z: -73.4, w: 41.7 })
  })

  it('selects the latitude footprint when dominant and bounds longitude filtering at the poles', () => {
    const widePatch: WeatherSnapshot = { ...snapshot, referenceBoundsDeg: [-50, -0.5, 50, 0.5] }
    const latitudePixelM = radiusM * Math.PI / 180 / 64
    const meridian = weatherMapLods({ positionECEFM: [radiusM, 0, 0], footprintM: 4 * latitudePixelM, weatherLod: 0 }, widePatch)
    expect(meridian.reference).toBeCloseTo(2, 10)
    const polarPixelM = radiusM * 2 * Math.PI * 0.02 / 1024
    for (const direction of [-1, 1]) {
      const polar = weatherMapLods({ positionECEFM: [0, 0, direction * radiusM],
        footprintM: 4 * polarPixelM, weatherLod: 0 }, snapshot)
      expect(polar.global).toBeCloseTo(2, 10)
      expect(Number.isFinite(polar.reference)).toBe(true)
    }
  })

  it('keeps authored clear gaps clear and all media coefficients finite', () => {
    const clear = sampleReferenceWeatherField(40.08, -75.18)
    expect(clear.coverage).toBe(0)

    const query: CloudMediaQuery = {
      positionECEFM: [radiusM + 2200, 0, 0],
      footprintM: 24,
      weatherLod: 0,
      jitter: 0.5
    }
    const media = evaluateCloudLayerMedia(query, clear, snapshot)
    expect(media.density).toBe(0)
    expect(media.extinctionMInv).toBe(0)
    expect(media.scatteringMInv).toBe(0)
    expect(media.weights.reduce((sum, value) => sum + value, 0)).toBe(0)
    for (const value of [media.density, media.extinctionMInv, media.scatteringMInv, media.phaseMix]) {
      expect(Number.isFinite(value)).toBe(true)
    }

    const covered = evaluateCloudLayerMedia(
      query,
      { coverage: 1, typeField: 0 },
      snapshot,
      [0.8, 0.2, 0.3, 0.4]
    )
    expect(covered.density).toBeGreaterThan(0)
    expect(covered.extinctionMInv).toBeGreaterThanOrEqual(covered.scatteringMInv)

    const thresholdedClear = evaluateCloudLayerMedia(
      query,
      { coverage: 0.5, typeField: 0 },
      snapshot,
      [0, 0, 0, 0]
    )
    expect(thresholdedClear.density).toBe(0)

    expect(sampleWeatherField([radiusM + 2200, 0, 0]).coverage).toBe(0)

    const atBase = evaluateCloudLayerMedia(
      { ...query, positionECEFM: [radiusM + 1200, 0, 0] },
      { coverage: 1, typeField: 0 },
      snapshot,
      DEFAULT_CLOUD_NOISE_SAMPLE
    )
    expect(atBase.density).toBe(0)
    const atTop = evaluateCloudLayerMedia(
      { ...query, positionECEFM: [radiusM + 3200, 0, 0] },
      { coverage: 1, typeField: 0 },
      snapshot,
      DEFAULT_CLOUD_NOISE_SAMPLE
    )
    expect(atTop.density).toBe(0)

    const latitude = 40.88 * Math.PI / 180
    const longitude = -75.42 * Math.PI / 180
    const referenceRadius = radiusM + 5500
    const referenceQuery: CloudMediaQuery = {
      positionECEFM: [
        referenceRadius * Math.cos(latitude) * Math.cos(longitude),
        referenceRadius * Math.cos(latitude) * Math.sin(longitude),
        referenceRadius * Math.sin(latitude)
      ],
      footprintM: 24,
      weatherLod: 0,
      jitter: 0
    }
    const sameFieldDifferentJitter = [
      sampleCloudMedia(referenceQuery, snapshot, [0.8, 0.2, 0.3, 0.4]),
      sampleCloudMedia({ ...referenceQuery, jitter: 1 }, snapshot, [0.8, 0.2, 0.3, 0.4])
    ]
    expect(sameFieldDifferentJitter[0].density).toBeGreaterThan(0)
    expect(sameFieldDifferentJitter[0]).toEqual(sameFieldDifferentJitter[1])
  })

  it('expands raw-noise support with coverage while preserving dense interiors', () => {
    const typeField = 0.18, count = 4096
    const profile = interpolateCloudProfile(typeField)
    const altitudeM = (profile.baseAltitudeM + profile.topAltitudeM) / 2
    let seed = 0x0e7e0c10
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 4294967296
    }
    const coverages = [0, 0.125, 0.25, 0.5, 0.75, 1]
    const densities = coverages.map(() => [] as number[])
    for (let i = 0; i < count; i++) {
      const position = positionAt(39.8 + 1.4 * random(), -76.3 + 2.5 * random(), altitudeM)
      const query = { positionECEFM: position, footprintM: 0, weatherLod: 0, jitter: 0 }
      const noise = actualNoise(position, typeField)
      coverages.forEach((coverage, index) => {
        densities[index].push(evaluateCloudLayerMedia(query, { coverage, typeField },
          snapshot, noise.primary, noise.detail).density)
      })
    }
    expect(densities[0].every(value => value === 0)).toBe(true)
    for (let index = 1; index < coverages.length; index++) {
      expect(densities[index].every((value, sample) =>
        Number.isFinite(value) && value >= densities[index - 1][sample] && value <= 1)).toBe(true)
    }
    const occupied = densities.map(values => values.filter(value => value > 1e-6).length / count)
    // Sparse weather must leave real holes; increasing coverage must add bodies,
    // not merely brighten an already occupied, spatially uniform blanket.
    expect(occupied[2]).toBeGreaterThan(0.03)
    expect(occupied[2]).toBeLessThan(0.3)
    expect(densities[2].filter(value => value === 0).length).toBeGreaterThan(count * 0.7)
    expect(occupied[3] - occupied[2]).toBeGreaterThan(0.3)
    expect(occupied[4]).toBeGreaterThan(0.85)
    const full = densities[densities.length - 1]
    expect(full.filter(value => value > 0.5).length).toBeGreaterThan(count * 0.85)
    // Across the sweep, a substantial set of formed bodies must already have
    // their final density before full coverage. This rejects coverage opacity
    // multiplication without pinning the edge to one noise value or location.
    expect(densities[3].filter((value, index) => value > 0.5 && Math.abs(value - full[index]) < 1e-12).length)
      .toBeGreaterThan(count * 0.1)
  })

  it('keeps both raw-noise domains and media continuous through type interpolation', () => {
    for (const typeField of [1 / 3, 0.5, 2 / 3]) {
      const profile = interpolateCloudProfile(typeField)
      const position = positionAt(40.5, -75, (profile.baseAltitudeM + profile.topAltitudeM) / 2)
      const query = { positionECEFM: position, footprintM: 0, weatherLod: 0, jitter: 0 }
      const center = actualNoise(position, typeField)
      const media = evaluateCloudLayerMedia(query, { coverage: 1, typeField }, snapshot, center.primary, center.detail)
      expect(media.density).toBeGreaterThan(0.3)
      for (const nearbyType of [typeField - 1e-6, typeField + 1e-6]) {
        const nearby = actualNoise(position, nearbyType)
        for (const domain of ['primary', 'detail'] as const) for (let channel = 0; channel < 4; channel++) {
          expect(Math.abs(nearby[domain][channel] - center[domain][channel])).toBeLessThan(1e-5)
        }
        const nearbyMedia = evaluateCloudLayerMedia(query, { coverage: 1, typeField: nearbyType },
          snapshot, nearby.primary, nearby.detail)
        expect(Math.abs(nearbyMedia.density - media.density)).toBeLessThan(1e-4)
        expect(Math.abs(nearbyMedia.extinctionMInv - media.extinctionMInv)).toBeLessThan(1e-6)
        expect(nearbyMedia.weights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12)
      }
    }
  })

  it('breaks the primary X repeat with actual rotated detail noise for every profile', () => {
    const position: CloudMediaQuery['positionECEFM'] = [radiusM + 2200, 0, 0]
    const difference = (a: CloudNoiseSample, b: CloudNoiseSample) =>
      Math.max(...a.map((value, channel) => Math.abs(value - b[channel])))
    EVE_CLOUD_PROFILE_TABLES.primaryNoiseScaleM.forEach((scaleM, index) => {
      const original = actualNoise(position, index / 3)
      const rotated = noiseAtScale(cloudDetailNoisePositionECEFM(position), scaleM)
      const shifted: CloudMediaQuery['positionECEFM'] = [position[0] + scaleM, position[1], position[2]]
      const repeated = actualNoise(shifted, index / 3)
      expect(difference(original.primary, repeated.primary)).toBeLessThan(1e-4)
      expect(difference(original.detail, repeated.detail)).toBeGreaterThan(1 / 255)
      // Holding the repeat length equal isolates rotation from scale choice.
      expect(difference(rotated, noiseAtScale(cloudDetailNoisePositionECEFM(shifted), scaleM)))
        .toBeGreaterThan(1 / 255)
    })
  })

  it('keeps zero coverage and finite layer endpoints exactly empty for every type', () => {
    for (const typeField of [0, 0.18, 1 / 3, 0.5, 2 / 3, 1]) {
      const profile = interpolateCloudProfile(typeField)
      const middle = (profile.baseAltitudeM + profile.topAltitudeM) / 2
      for (const coverage of [0, 1]) for (const altitudeM of [
        profile.baseAltitudeM - 1, profile.baseAltitudeM,
        profile.topAltitudeM, profile.topAltitudeM + 1, ...(coverage === 0 ? [middle] : [])
      ]) {
        const media = evaluateCloudLayerMedia({ positionECEFM: [radiusM + altitudeM, 0, 0],
          footprintM: 0, weatherLod: 0, jitter: 0 }, { coverage, typeField }, snapshot, [1, 0, 0, 1], [1, 1, 0, 0])
        // Interpolated endpoints can round at Earth-sized radii; endpoint taper
        // must still approach zero with finite values, not leak a full body.
        expect(media.density).toBeLessThan(1e-20)
        expect(media.extinctionMInv).toBeLessThan(1e-20)
        if (coverage === 0 || typeField === 0 || typeField === 1) {
          expect(media.density).toBe(0)
          expect(media.extinctionMInv).toBe(0)
          expect(media.weights).toEqual([0, 0, 0, 0])
        }
        expect(media.scatteringMInv).toBe(media.extinctionMInv)
      }
    }
  })

  it.each([
    // Direct transmitted-light bands: 1–5%, 0.1–1%, and 0.01–0.1%.
    // With 64³ noise the authored two-domain columns have tau ≈ 3.188,
    // 5.705 and 7.820. Bands constrain meaningful opacity without pinning a
    // particular noise phase to a narrow decimal snapshot.
    ['isolated', 40.88, -75.42, 0.01, 0.05],
    ['covered broken cell', 40.7625, -76.075, 0.001, 0.01],
    ['deep', 40.34, -74.58, 0.0001, 0.001]
  ] as const)('makes the real %s column optically substantial', (_name, latitude, longitude, minimumTransmission, maximumTransmission) => {
    const tau = columnOpticalDepth(latitude, longitude)
    const transmission = Math.exp(-tau)
    expect(transmission).toBeGreaterThan(minimumTransmission)
    expect(transmission).toBeLessThan(maximumTransmission)
    const fine = columnOpticalDepth(latitude, longitude, 12.5)
    const finer = columnOpticalDepth(latitude, longitude, 6.25)
    expect(Math.abs(tau - fine)).toBeLessThan(0.01)
    expect(Math.abs(fine - finer)).toBeLessThan(0.01)
  })

  it('retains exact sampled zero in the raw clear interior without claiming an analytic filter boundary', () => {
    for (const [latitude, longitude] of [[40.08, -75.18], [40.0875, -75.175]]) {
      expect(actualReference(latitude, longitude).coverage).toBe(0)
      expect(columnOpticalDepth(latitude, longitude)).toBe(0)
    }
  })
})
