import type { Uniform } from 'three'

import type { CloudBackend, CloudShaderHooks } from './CloudBackend'
import {
  createCloudShaderHooks,
} from './vendor/takram'

// Keep production and conformance imports of backend internals here.
export { CloudsEffect as ForkCloudsEffect } from './vendor/takram/src/CloudsEffect'
export { CloudsMaterial } from './vendor/takram/src/CloudsMaterial'
export { CloudsResolveMaterial } from './vendor/takram/src/CloudsResolveMaterial'
export { bayerOffsets } from './vendor/takram/src/bayer'
export { ShadowMaterial } from './vendor/takram/src/ShadowMaterial'
export { createAtmosphereUniforms, createCloudLayerUniforms, createCloudParameterUniforms } from './vendor/takram/src/uniforms'
export { createCloudShaderHooks } from './vendor/takram/src/ShaderHooks'

export interface TakramCloudBackendOptions {
  readonly mediaGLSL?: string
  readonly lightingGLSL?: string
  readonly uniforms?: Readonly<Record<string, Uniform<unknown>>>
}

function createHooks(
  options: TakramCloudBackendOptions
): CloudShaderHooks {
  return createCloudShaderHooks(options)
}

/** Creates the unactivated Takram 0.7.6 backend seam. */
export function createTakramCloudBackend(
  options: TakramCloudBackendOptions = {}
): CloudBackend {
  return Object.freeze({
    name: 'takram' as const,
    upstreamVersion: '0.7.6' as const,
    shaderHooks: createHooks(options)
  })
}
