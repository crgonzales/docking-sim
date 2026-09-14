import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ClampToEdgeWrapping, Data3DTexture, DataTexture, LinearFilter,
  LinearMipmapLinearFilter, NoColorSpace, RedFormat, RepeatWrapping,
  RGBAFormat, RGFormat, Texture, UnsignedByteType
} from 'three'

import { VOLUMETRIC_WEATHER_ASSETS } from './cloudWeather'
import { loadCloudWeatherAssets } from './cloudWeatherAssets'

function fileBytes(path: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(readFileSync(new URL(`../../../public${path}`, import.meta.url)))
}

function serveAssets() {
  const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(fileBytes(String(input)))
  )
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('owned VOLUMETRIC weather texture loading', () => {
  it('loads raw formats, reverses only global rows, and configures filtered periodic sampling', async () => {
    const fetcher = serveAssets()
    const assets = await loadCloudWeatherAssets()
    try {
      expect(fetcher).toHaveBeenCalledTimes(4)
      const formats = { coverage: RedFormat, typeField: RedFormat, referenceField: RGFormat, noise: RGBAFormat }
      for (const name of ['coverage', 'typeField', 'referenceField', 'noise'] as const) {
        const texture = assets.textures[name] as DataTexture | Data3DTexture
        const descriptor = VOLUMETRIC_WEATHER_ASSETS[name]
        expect(texture).toBeInstanceOf(name === 'noise' ? Data3DTexture : DataTexture)
        expect(texture.format).toBe(formats[name])
        expect(texture.internalFormat).toBe(descriptor.format)
        expect(texture.type).toBe(UnsignedByteType)
        expect(texture.colorSpace).toBe(NoColorSpace)
        expect(texture.flipY).toBe(false)
        expect(texture.unpackAlignment).toBe(1)
        expect(texture.generateMipmaps).toBe(true)
        expect(texture.minFilter).toBe(LinearMipmapLinearFilter)
        expect(texture.magFilter).toBe(LinearFilter)
        expect(texture.version).toBeGreaterThan(0)
        expect(texture.image.width).toBe(descriptor.dimensions[0])
        expect(texture.image.height).toBe(descriptor.dimensions[1])
        const source = fileBytes(descriptor.path)
        if (name === 'coverage' || name === 'typeField') {
          const [width, height] = descriptor.dimensions
          const expected = new Uint8Array(source.length)
          for (let y = 0; y < height; y++) {
            expected.set(source.subarray((height - 1 - y) * width, (height - y) * width), y * width)
          }
          // Compare the entire upload, including columns and the two poles.
          expect(Buffer.from(texture.image.data).equals(Buffer.from(expected))).toBe(true)
          expect(texture.wrapS).toBe(RepeatWrapping)
          expect(texture.wrapT).toBe(ClampToEdgeWrapping)
        } else {
          expect(Buffer.from(texture.image.data).equals(Buffer.from(source))).toBe(true)
        }
      }
      expect(assets.textures.referenceField?.wrapS).toBe(ClampToEdgeWrapping)
      expect(assets.textures.referenceField?.wrapT).toBe(ClampToEdgeWrapping)
      const noise = assets.textures.noise as Data3DTexture
      expect(noise.image.depth).toBe(VOLUMETRIC_WEATHER_ASSETS.noise.dimensions[2])
      expect([noise.wrapS, noise.wrapT, noise.wrapR]).toEqual([RepeatWrapping, RepeatWrapping, RepeatWrapping])
      // Rectangular 2D chains include the final 1x1 level; the 3D chain shrinks
      // all three axes. Count explicit levels independently of loader helpers.
      const globalLevels = [524288, 131072, 32768, 8192, 2048, 512, 128, 32, 8, 2, 1]
      const referenceLevels = [16384, 4096, 1024, 256, 64, 16, 4, 2]
      const noiseLevels = [1048576, 131072, 16384, 2048, 256, 32, 4]
      expect(assets.bytes).toBe([...globalLevels, ...globalLevels, ...referenceLevels, ...noiseLevels].reduce((a, b) => a + b))
      expect(Object.isFrozen(assets.textures)).toBe(true)
    } finally { assets.dispose() }
  })

  it('owns each load independently, removes cancellation listeners, and disposes once', async () => {
    serveAssets()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const first = await loadCloudWeatherAssets({ signal: controller.signal })
    const second = await loadCloudWeatherAssets()
    const disposal = Object.values(first.textures).map(texture => vi.spyOn(texture!, 'dispose'))
    const secondDisposal = vi.spyOn(second.textures.noise!, 'dispose')
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort()
    expect(disposal.every(spy => spy.mock.calls.length === 0)).toBe(true)
    first.dispose()
    first.dispose()
    expect(disposal.every(spy => spy.mock.calls.length === 1)).toBe(true)
    for (const name of ['coverage', 'typeField', 'referenceField', 'noise'] as const) {
      expect(first.textures[name]).not.toBe(second.textures[name])
      expect((first.textures[name] as DataTexture).image.data.byteLength).toBe(0)
      expect((second.textures[name] as DataTexture).image.data.byteLength).toBe(VOLUMETRIC_WEATHER_ASSETS[name].bytes)
    }
    expect(secondDisposal).not.toHaveBeenCalled()
    second.dispose()
    expect(secondDisposal).toHaveBeenCalledTimes(1)
  })

  it('rejects pre-cancelled requests without fetching', async () => {
    const fetcher = serveAssets()
    const controller = new AbortController()
    const reason = new Error('Caller cancelled')
    controller.abort(reason)
    await expect(loadCloudWeatherAssets({ signal: controller.signal })).rejects.toBe(reason)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('cancels promptly while response bodies are pending, even if a fetch ignores abort', async () => {
    const controller = new AbortController()
    let finishBody!: (buffer: ArrayBuffer) => void
    const body = new Promise<ArrayBuffer>(resolve => { finishBody = resolve })
    let bodyStarted!: () => void
    const started = new Promise<void>(resolve => { bodyStarted = resolve })
    const fetcher = serveAssets().mockImplementation(async () => ({
      ok: true, arrayBuffer: () => { bodyStarted(); return body }
    } as Response))
    const allocation = vi.spyOn(Texture.prototype, 'needsUpdate', 'set')
    const pending = loadCloudWeatherAssets({ signal: controller.signal })
    await started
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true)
    finishBody(new ArrayBuffer(0))
    await body
    await Promise.resolve()
    expect(allocation).not.toHaveBeenCalled()
  })

  it.each(['http', 'short', 'oversized', 'hash', 'network', 'body'] as const)(
    'rejects %s failures before allocation and cancels sibling requests', async failure => {
      const fetcher = serveAssets()
      const good = fetcher.getMockImplementation()!
      fetcher.mockImplementation(async (input, init) => {
        if (String(input) !== VOLUMETRIC_WEATHER_ASSETS.typeField.path) return good(input, init)
        if (failure === 'network') throw new Error('network unavailable')
        if (failure === 'http') return new Response('missing', { status: 404 })
        if (failure === 'body') return { ok: true, arrayBuffer: async () => { throw new Error('body interrupted') } } as unknown as Response
        const source = fileBytes(String(input))
        if (failure === 'short') return new Response(source.subarray(1))
        if (failure === 'oversized') return new Response(new Uint8Array(source.length + 1))
        source[0] ^= 1
        return new Response(source)
      })
      const allocation = vi.spyOn(Texture.prototype, 'needsUpdate', 'set')
      const errors = { http: 'HTTP 404', short: 'bytes', oversized: 'bytes', hash: 'SHA-256 mismatch', network: 'network unavailable', body: 'body interrupted' }
      await expect(loadCloudWeatherAssets()).rejects.toThrow(errors[failure])
      expect(fetcher).toHaveBeenCalledTimes(4)
      expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true)
      expect(allocation).not.toHaveBeenCalled()
      allocation.mockRestore()
      fetcher.mockImplementation(good)
      const retry = await loadCloudWeatherAssets()
      expect(retry.bytes).toBeGreaterThan(0)
      retry.dispose()
    }
  )

  it('cleans up partially constructed textures when configuration fails', async () => {
    serveAssets()
    vi.spyOn(Texture.prototype, 'needsUpdate', 'set')
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => { throw new Error('texture configuration failed') })
    const dispose = vi.spyOn(Texture.prototype, 'dispose')
    await expect(loadCloudWeatherAssets()).rejects.toThrow('texture configuration failed')
    expect(dispose).toHaveBeenCalledTimes(2)
    for (const texture of dispose.mock.contexts) expect((texture as DataTexture).image.data.byteLength).toBe(0)
  })
})
