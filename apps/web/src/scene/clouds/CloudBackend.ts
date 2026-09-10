import type { Uniform } from 'three'

import type { CloudShaderHooks as TakramCloudShaderHooks } from './vendor/takram'

/** Position contract shared by camera, secondary and shadow media queries. */
export interface CloudMediaQuery {
  /** Earth-centered, Earth-fixed metres. */
  readonly positionECEFM: readonly [number, number, number]
  /** Physical footprint in metres, never a texture-space derivative. */
  readonly footprintM: number
  /** Backend-selected weather/detail level. */
  readonly weatherLod: number
  readonly jitter: number
}

/** Participating-medium coefficients are inverse metres. */
export interface CloudMediaSample {
  readonly density: number
  readonly extinctionMInv: number
  readonly scatteringMInv: number
  readonly weights: readonly [number, number, number, number]
  readonly phaseAnisotropy: readonly [number, number]
  readonly phaseMix: number
}

export interface CloudLightingQuery extends CloudMediaQuery {
  /** Start of the lighting remainder, in metres along the sun ray. */
  readonly sunStartM: number
}

export interface CloudLightingSample {
  /** Cloud transmittance over [sunStartM, conservative support exit]. */
  readonly directTransmittance: number
  /** Full cloud-occluded sky irradiance at the query point. */
  readonly skyIrradiance: readonly [number, number, number]
  readonly valid: boolean
  /** Shared binding generation used to reject stale lighting caches. */
  readonly generation: number
  /** Invalid custom lighting must set this false to request media fallback. */
  readonly stockFallback: boolean
}

/**
 * Immutable shader seam consumed by the pinned Takram effect. The GLSL
 * includes define sampleCloudMedia and sampleCloudLighting with the contracts
 * above; all listed Uniform instances are shared by participating materials.
 */
export type CloudShaderHooks = TakramCloudShaderHooks & {
  readonly uniforms: Readonly<Record<string, Uniform<unknown>>>
}

export interface CloudBackend {
  readonly name: 'takram'
  readonly upstreamVersion: '0.7.6'
  readonly shaderHooks: CloudShaderHooks
}

/**
 * The fork's overlay keeps representative front depth in the depth/velocity
 * attachment. Its color attachment is premultiplied, atmosphere-treated RGB
 * with physical alpha 1-Tcloud; the compositor must not apply aerial
 * perspective a second time.
 */
export interface CloudOverlayAbi {
  readonly representativeDepthM: number
  readonly atmosphereTreatedPremultipliedRgb: readonly [number, number, number]
  readonly alphaOneMinusCloudTransmittance: number
}
