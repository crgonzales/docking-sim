import type { Uniform } from 'three'

import lightingGLSL from './shaders/lighting.glsl?raw'
import mediaGLSL from './shaders/media.glsl?raw'

export interface CloudShaderHooks {
  /** Defines sampleCloudMedia(positionECEFM, footprintM, weatherLod, jitter). */
  readonly mediaGLSL: string
  /** Defines sampleCloudLighting(positionECEFM, footprintM, sunStartM). */
  readonly lightingGLSL: string
  /** Uniform instances shared by camera, secondary and shadow materials,
   * including any lighting-cache generation used by lightingGLSL. */
  readonly uniforms: Readonly<Record<string, Uniform<unknown>>>
}

export const defaultCloudShaderHooks: CloudShaderHooks = Object.freeze({
  mediaGLSL,
  lightingGLSL,
  uniforms: Object.freeze({})
})

export function createCloudShaderHooks(
  hooks: Partial<CloudShaderHooks> = {}
): CloudShaderHooks {
  return Object.freeze({
    mediaGLSL: hooks.mediaGLSL ?? defaultCloudShaderHooks.mediaGLSL,
    lightingGLSL: hooks.lightingGLSL ?? defaultCloudShaderHooks.lightingGLSL,
    uniforms: Object.freeze({ ...hooks.uniforms })
  })
}
