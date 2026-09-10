import {
  GLSL3,
  RawShaderMaterial,
  Uniform,
  Vector2,
  type BufferGeometry,
  type Camera,
  type Group,
  type Object3D,
  type Scene,
  type Texture,
  type WebGLRenderer
} from 'three'

import { define, resolveIncludes, unrollLoops } from '@takram/three-geospatial'
import { turbo } from '@takram/three-geospatial/shaders'

import { bayerOffsets } from './bayer'

import catmullRomSampling from './shaders/catmullRomSampling.glsl?raw'
import fragmentShader from './shaders/cloudsResolve.frag?raw'
import vertexShader from './shaders/cloudsResolve.vert?raw'
import varianceClipping from './shaders/varianceClipping.glsl?raw'

export interface CloudsResolveMaterialParameters {
  colorBuffer?: Texture | null
  depthVelocityBuffer?: Texture | null
  shadowLengthBuffer?: Texture | null
  colorHistoryBuffer?: Texture | null
  depthHistoryBuffer?: Texture | null
  shadowLengthHistoryBuffer?: Texture | null
  historyEnabled?: boolean
  accumulateFreshSamples?: boolean
  /** Metres; accept |stored - expected| <= max(absolute, relative * expected). */
  depthAbsoluteThresholdM?: number
  /** Opt-in same-pixel stationary quadrature uncertainty in view metres; 0 keeps
   * the strict guard. Real depth changes within this allowance can also blend. */
  stationaryDepthAbsoluteThresholdM?: number
  /** Dimensionless tolerance, including half-float depth quantization. */
  depthRelativeThreshold?: number
  /** Physical cloud opacity at or below this value is a clear gap. */
  historyOpacityThreshold?: number
}

export interface CloudsResolveMaterialUniforms {
  [key: string]: Uniform<unknown>
  colorBuffer: Uniform<Texture | null>
  depthVelocityBuffer: Uniform<Texture | null>
  shadowLengthBuffer: Uniform<Texture | null>
  colorHistoryBuffer: Uniform<Texture | null>
  depthHistoryBuffer: Uniform<Texture | null>
  shadowLengthHistoryBuffer: Uniform<Texture | null>
  historyValid: Uniform<boolean>
  historyEnabled: Uniform<boolean>
  /** Consecutive Bayer frames with the same physical camera and projection. */
  stationaryCamera: Uniform<boolean>
  accumulateFreshSamples: Uniform<boolean>
  depthAbsoluteThresholdM: Uniform<number>
  stationaryDepthAbsoluteThresholdM: Uniform<number>
  depthRelativeThreshold: Uniform<number>
  historyOpacityThreshold: Uniform<number>
  texelSize: Uniform<Vector2>
  frame: Uniform<number>
  jitterOffset: Uniform<Vector2>
  varianceGamma: Uniform<number>
  temporalAlpha: Uniform<number>
}

export class CloudsResolveMaterial extends RawShaderMaterial {
  declare uniforms: CloudsResolveMaterialUniforms

  constructor({
    colorBuffer = null,
    depthVelocityBuffer = null,
    shadowLengthBuffer = null,
    colorHistoryBuffer = null,
    depthHistoryBuffer = null,
    shadowLengthHistoryBuffer = null,
    historyEnabled = true,
    accumulateFreshSamples = false,
    depthAbsoluteThresholdM = 50,
    stationaryDepthAbsoluteThresholdM = 0,
    depthRelativeThreshold = 0.01,
    historyOpacityThreshold = 1e-3
  }: CloudsResolveMaterialParameters = {}) {
    super({
      name: 'CloudsResolveMaterial',
      glslVersion: GLSL3,
      vertexShader,
      fragmentShader: unrollLoops(
        resolveIncludes(fragmentShader, {
          core: { turbo },
          catmullRomSampling,
          varianceClipping
        })
      ),
      uniforms: {
        colorBuffer: new Uniform(colorBuffer),
        depthVelocityBuffer: new Uniform(depthVelocityBuffer),
        shadowLengthBuffer: new Uniform(shadowLengthBuffer),
        colorHistoryBuffer: new Uniform(colorHistoryBuffer),
        depthHistoryBuffer: new Uniform(depthHistoryBuffer),
        shadowLengthHistoryBuffer: new Uniform(shadowLengthHistoryBuffer),
        historyValid: new Uniform(false),
        historyEnabled: new Uniform(historyEnabled),
        stationaryCamera: new Uniform(false),
        accumulateFreshSamples: new Uniform(accumulateFreshSamples),
        depthAbsoluteThresholdM: new Uniform(depthAbsoluteThresholdM),
        stationaryDepthAbsoluteThresholdM: new Uniform(stationaryDepthAbsoluteThresholdM),
        depthRelativeThreshold: new Uniform(depthRelativeThreshold),
        historyOpacityThreshold: new Uniform(historyOpacityThreshold),
        texelSize: new Uniform(new Vector2()),
        frame: new Uniform(0),
        jitterOffset: new Uniform(new Vector2()),
        varianceGamma: new Uniform(2),
        temporalAlpha: new Uniform(0.1)
      } satisfies CloudsResolveMaterialUniforms
    })
  }

  setSize(width: number, height: number): void {
    this.uniforms.texelSize.value.set(1 / width, 1 / height)
  }

  override onBeforeRender(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: Camera,
    geometry: BufferGeometry,
    object: Object3D,
    group: Group
  ): void {
    const uniforms = this.uniforms
    const frame = uniforms.frame.value % 16
    const offset = bayerOffsets[frame]
    const dx = (offset.x - 0.5) * 4
    const dy = (offset.y - 0.5) * 4
    this.uniforms.jitterOffset.value.set(dx, dy)
  }

  @define('TEMPORAL_UPSCALE')
  temporalUpscale = true

  @define('SHADOW_LENGTH')
  shadowLength = true
}
