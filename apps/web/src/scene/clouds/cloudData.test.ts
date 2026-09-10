import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { Vector4 } from 'three'

import {
  createWeatherBindingUniforms,
  createWeatherSnapshot,
  EVE_WEATHER_ASSETS,
  sampleReferenceWeatherField
} from './cloudWeather'
import { EVE_CLOUD_PROFILES, EVE_CLOUD_PROFILE_TABLES, EVE_REFERENCE_REGION } from './cloudConfig'

function bytes(path: string): Buffer {
  return readFileSync(new URL(path, import.meta.url))
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

describe('offline EVE weather assets', () => {
  it('matches the committed manifest hashes and bounded dimensions', () => {
    const manifest = JSON.parse(bytes('../../../public/assets/clouds/eve/manifest.json').toString('utf8'))
    const provenance = JSON.parse(bytes('../../../public/vendor/earth-weather/provenance.json').toString('utf8'))
    expect(manifest.deterministic).toBe(true)
    expect(manifest.source.sha256).toBe(provenance.outputSha256)
    expect(sha256(bytes('../../../public/vendor/earth-weather/global-coverage.png'))).toBe(manifest.source.sha256)
    expect(manifest.referenceRegion).toEqual(EVE_REFERENCE_REGION)
    expect(manifest.profiles).toEqual(EVE_CLOUD_PROFILES.map(profile => profile.id))
    expect(manifest.noise).toMatchObject({
      seed: 0x0e7e0c10,
      periodCells: 4,
      lacunarity: 2,
      persistence: 0.5,
      octaves: 4
    })
    expect(manifest.noise.algorithm).toContain('gradient-Perlin')

    for (const [name, descriptor] of Object.entries(EVE_WEATHER_ASSETS)) {
      const manifestAsset = manifest.assets[name]
      const data = bytes(`../../../public${manifestAsset.path}`)
      expect(data.byteLength).toBe(manifestAsset.bytes)
      expect(sha256(data)).toBe(manifestAsset.sha256)
      expect(manifestAsset.sha256).toBe(descriptor.sha256)
      expect(manifestAsset.dimensions).toEqual(descriptor.dimensions)
      expect(manifestAsset.rowOrder).toBe(descriptor.rowOrder)
      expect(manifestAsset).toEqual(descriptor)
      expect(Object.isFrozen(descriptor.dimensions)).toBe(true)
    }
  })

  it('reproduces the authored reference field at every south-first texel center', () => {
    const descriptor = EVE_WEATHER_ASSETS.referenceField
    const data = bytes(`../../../public${descriptor.path}`)
    const [width, height] = descriptor.dimensions
    const region = EVE_REFERENCE_REGION
    const expected = Buffer.alloc(data.length)
    for (let y = 0; y < height; y++) {
      const latitude = region.centerLatitudeDeg - region.latitudeExtentDeg + (y + 0.5) / height * 2 * region.latitudeExtentDeg
      for (let x = 0; x < width; x++) {
        const longitude = region.centerLongitudeDeg - region.longitudeExtentDeg + (x + 0.5) / width * 2 * region.longitudeExtentDeg
        const field = sampleReferenceWeatherField(latitude, longitude)
        const index = (y * width + x) * 2
        expected[index] = Math.round(field.coverage * 255)
        expected[index + 1] = Math.round(field.typeField * 255)
      }
    }
    expect(data.equals(expected)).toBe(true)
  })

  it('samples a continuous unit-period noise field on all axes and matches its baked texels', async () => {
    const script = new URL('../../../scripts/setupEveCloudAssets.mjs', import.meta.url)
    const { samplePeriodicNoise } = await import(/* @vite-ignore */ script.href)
    const descriptor = EVE_WEATHER_ASSETS.noise
    const data = bytes(`../../../public${descriptor.path}`)
    for (const point of [[0.123, 0.417, 0.891], [-0.234, 0.782, 2.191], [0, 0, 0]]) {
      const baseline = samplePeriodicNoise(...point)
      for (let axis = 0; axis < 3; axis++) {
        const translated = point.slice()
        translated[axis] += 1
        const repeated = samplePeriodicNoise(...translated)
        const left = point.slice()
        const right = point.slice()
        left[axis] = 1 - 1e-7
        right[axis] = 1e-7
        const beforeSeam = samplePeriodicNoise(...left)
        const afterSeam = samplePeriodicNoise(...right)
        for (let channel = 0; channel < 4; channel++) {
          expect(repeated[channel]).toBeCloseTo(baseline[channel], 10)
          expect(beforeSeam[channel]).toBeCloseTo(afterSeam[channel], 4)
          expect(baseline[channel]).toBeGreaterThanOrEqual(0)
          expect(baseline[channel]).toBeLessThanOrEqual(1)
        }
      }
    }
    const [width, height, depth] = descriptor.dimensions
    for (const [x, y, z] of [
      [0, 0, 0], [width - 1, height - 1, depth - 1],
      [Math.floor(width / 4), Math.floor(height / 2) - 1, Math.floor(3 * depth / 4) - 1],
      [width - 1, 0, Math.floor(depth / 4) - 1]
    ]) {
      const sample = samplePeriodicNoise((x + 0.5) / width, (y + 0.5) / height, (z + 0.5) / depth)
      const offset = ((z * height + y) * width + x) * 4
      expect([...data.subarray(offset, offset + 4)]).toEqual(sample.map((value: number) => Math.round(value * 255)))
    }
  })

  it('binds production profile tables and separate maps to the media hook', () => {
    const snapshot = createWeatherSnapshot({ visualTimeS: 0, sunDirectionECEF: [0, 0, 1] })
    const uniforms = createWeatherBindingUniforms(snapshot)
    const tableNames = [
      'baseAltitudeM', 'topAltitudeM', 'primaryNoiseScaleM', 'erosionDepth',
      'baseNoiseThreshold', 'baseNoiseSoftness', 'erosionThreshold', 'erosionSoftness',
      'supportFade01', 'scatteringCoefficientMInv', 'absorptionCoefficientMInv',
      'phaseAnisotropyX', 'phaseAnisotropyY', 'phaseMix'
    ] as const
    for (const tableName of tableNames) {
      const value = uniforms[`eveCloud${tableName[0].toUpperCase()}${tableName.slice(1)}`].value as Vector4
      expect(value.toArray()).toEqual(EVE_CLOUD_PROFILE_TABLES[tableName].slice())
    }
    const curveEntries = [
      ['CoverageKnots', 'coverageKnots'],
      ['CoverageValues', 'coverageValues'],
      ['DensityKnots', 'densityKnots'],
      ['DensityValues', 'densityValues']
    ] as const
    for (const [uniformName, tableKey] of curveEntries) {
      const values = uniforms[`eveCloud${uniformName}`].value as Vector4[]
      expect(values.map(vector => vector.toArray())).toEqual(
        EVE_CLOUD_PROFILE_TABLES[tableKey].map(vector => vector.slice())
      )
    }
  })

  // Shader behavior is exercised by CloudWeatherFixture on the GPU.
})
