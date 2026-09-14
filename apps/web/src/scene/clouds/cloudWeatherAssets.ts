import {
  ClampToEdgeWrapping, Data3DTexture, DataTexture, LinearFilter,
  LinearMipmapLinearFilter, NoColorSpace, RedFormat, RepeatWrapping,
  RGBAFormat, RGFormat, UnsignedByteType
} from 'three'

import {
  VOLUMETRIC_WEATHER_ASSETS, type WeatherAssetDescriptor, type WeatherTextureBindings
} from './cloudWeather'

export interface CloudWeatherAssets {
  readonly textures: WeatherTextureBindings
  /** Nominal GPU bytes including every mip level; excludes retained CPU bytes and driver overhead. */
  readonly bytes: number
  /** Idempotent. Releases GPU resources and CPU upload data; bindings must no longer be used. */
  dispose(): void
}

const FORMATS = { R8: RedFormat, RG8: RGFormat, RGBA8: RGBAFormat } as const
const CHANNELS = { R8: 1, RG8: 2, RGBA8: 4 } as const

function mipmappedBytes(descriptor: WeatherAssetDescriptor): number {
  let dimensions = [...descriptor.dimensions]
  let bytes = 0
  for (;;) {
    bytes += dimensions.reduce((size, dimension) => size * dimension, CHANNELS[descriptor.format])
    if (dimensions.every(dimension => dimension === 1)) return bytes
    dimensions = dimensions.map(dimension => Math.max(1, Math.floor(dimension / 2)))
  }
}

/** Allocation reservation and loaded-asset reporting share the same mip count. */
export const CLOUD_WEATHER_GPU_BYTES = Object.values(VOLUMETRIC_WEATHER_ASSETS)
  .reduce((sum, descriptor) => sum + mipmappedBytes(descriptor), 0)

async function loadBytes(descriptor: WeatherAssetDescriptor, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(descriptor.path, { signal })
  signal.throwIfAborted()
  if (!response.ok) throw new Error(`Cloud weather asset ${descriptor.path}: HTTP ${response.status}`)
  const buffer = await response.arrayBuffer()
  signal.throwIfAborted()
  const expectedBytes = descriptor.dimensions.reduce((size, dimension) => size * dimension, CHANNELS[descriptor.format])
  if (buffer.byteLength !== descriptor.bytes || buffer.byteLength !== expectedBytes) {
    throw new Error(`Cloud weather asset ${descriptor.path}: expected ${descriptor.bytes} bytes, got ${buffer.byteLength}`)
  }
  if (!globalThis.crypto?.subtle) throw new Error('Cloud weather asset verification requires Web Crypto in a secure context')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer)
  signal.throwIfAborted()
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  if (hash !== descriptor.sha256) throw new Error(`Cloud weather asset ${descriptor.path}: SHA-256 mismatch`)

  const data = new Uint8Array(buffer)
  if (descriptor.rowOrder === 'north-first') {
    // WebGL's flipY unpack flag does not orient raw DataTexture bytes. Reverse
    // whole rows once so V=0 is south, preserving columns and interleaved channels.
    const rowBytes = descriptor.dimensions[0] * CHANNELS[descriptor.format]
    const height = descriptor.dimensions[1]
    const row = new Uint8Array(rowBytes)
    for (let y = 0; y < Math.floor(height / 2); y += 1) {
      const bottom = y * rowBytes
      const top = (height - y - 1) * rowBytes
      row.set(data.subarray(bottom, bottom + rowBytes))
      data.copyWithin(bottom, top, top + rowBytes)
      data.set(row, top)
    }
  }
  return data
}

/**
 * Loads one independently owned set of raw assets. Upload/mipmap generation is
 * deferred to Three.js; retain CPU data until dispose so context restoration works.
 * The caller owns cancellation while loading and disposal after successful return.
 */
export async function loadCloudWeatherAssets(
  { signal }: { signal?: AbortSignal } = {}
): Promise<CloudWeatherAssets> {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', forwardAbort, { once: true })
  const owned: (DataTexture | Data3DTexture)[] = []
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const texture of owned) {
      texture.dispose()
      texture.image.data = new Uint8Array(0)
    }
    owned.length = 0
  }
  let rejectAbort: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(controller.signal.reason)
    controller.signal.addEventListener('abort', rejectAbort, { once: true })
  })

  try {
    const descriptors = Object.entries(VOLUMETRIC_WEATHER_ASSETS)
    // No texture is created until every fetch and hash succeeds. Late completion
    // after a failure/abort can therefore never leak an unpublished GPU resource.
    const sources = await Promise.race([
      Promise.all(descriptors.map(([, descriptor]) => loadBytes(descriptor, controller.signal))),
      aborted
    ])
    controller.signal.throwIfAborted()
    const textures = Object.fromEntries(descriptors.map(([name, descriptor], index) => {
      const [width, height, depth] = descriptor.dimensions as WeatherAssetDescriptor['dimensions']
      const texture = depth === undefined
        ? new DataTexture(sources[index], width, height, FORMATS[descriptor.format], UnsignedByteType)
        : new Data3DTexture(sources[index], width, height, depth)
      owned.push(texture)
      texture.name = `VOLUMETRIC weather ${name}`
      texture.format = FORMATS[descriptor.format]
      texture.internalFormat = descriptor.format
      texture.type = UnsignedByteType
      texture.colorSpace = NoColorSpace
      texture.flipY = false
      texture.unpackAlignment = 1
      texture.magFilter = LinearFilter
      texture.minFilter = LinearMipmapLinearFilter
      texture.generateMipmaps = true
      texture.wrapS = name === 'referenceField' ? ClampToEdgeWrapping : RepeatWrapping
      texture.wrapT = ClampToEdgeWrapping
      if (texture instanceof Data3DTexture) texture.wrapT = texture.wrapR = RepeatWrapping
      texture.needsUpdate = true
      return [name, texture]
    }))
    return Object.freeze({
      textures: Object.freeze(textures),
      bytes: CLOUD_WEATHER_GPU_BYTES,
      dispose
    })
  } catch (error) {
    controller.abort(error)
    dispose()
    throw error
  } finally {
    signal?.removeEventListener('abort', forwardAbort)
    controller.signal.removeEventListener('abort', rejectAbort)
  }
}
