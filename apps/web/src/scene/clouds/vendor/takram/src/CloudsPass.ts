import { ShaderPass } from 'postprocessing'
import {
  BasicDepthPacking,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  NearestFilter,
  RedFormat,
  WebGLRenderTarget,
  type Camera,
  type DataArrayTexture,
  type DepthPackingStrategies,
  type Texture,
  type TextureDataType,
  type WebGLRenderer
} from 'three'

import type { AtmosphereParameters } from '@takram/three-atmosphere'

import { CloudsMaterial } from './CloudsMaterial'
import { CloudsResolveMaterial } from './CloudsResolveMaterial'
import { PassBase, type PassBaseOptions } from './PassBase'
import { defaults } from './qualityPresets'
import type {
  AtmosphereUniforms,
  CloudLayerUniforms,
  CloudParameterUniforms
} from './uniforms'
import type { CloudShaderHooks } from './ShaderHooks'

type RenderTarget = WebGLRenderTarget & {
  depthVelocity: Texture | null
  viewDepth: Texture | null
  shadowLength: Texture | null
}

interface RenderTargetOptions {
  depthVelocity: boolean
  shadowLength: boolean
}

function createRenderTarget(
  name: string,
  { depthVelocity, shadowLength }: RenderTargetOptions
): RenderTarget {
  const renderTarget: WebGLRenderTarget & {
    depthVelocity?: Texture
    viewDepth?: Texture
    shadowLength?: Texture
  } = new WebGLRenderTarget(1, 1, {
    depthBuffer: false,
    type: HalfFloatType
  })
  renderTarget.texture.minFilter = LinearFilter
  renderTarget.texture.magFilter = LinearFilter
  renderTarget.texture.name = name

  // Attachment 1 is always present: current RGBA depth/velocity, or resolved
  // R16F positive view depth in units of 10 km. Shadow length stays at 2.
  const depthBuffer = renderTarget.texture.clone()
  depthBuffer.isRenderTargetTexture = true
  depthBuffer.minFilter = NearestFilter
  depthBuffer.magFilter = NearestFilter
  renderTarget.textures.push(depthBuffer)
  let depthVelocityBuffer
  let viewDepthBuffer
  if (depthVelocity) {
    depthVelocityBuffer = depthBuffer
    depthBuffer.name = `${name}.DepthVelocity`
    renderTarget.depthVelocity = depthVelocityBuffer
  } else {
    viewDepthBuffer = depthBuffer
    depthBuffer.name = `${name}.ViewDepth`
    depthBuffer.format = RedFormat
    depthBuffer.internalFormat = 'R16F'
    renderTarget.viewDepth = viewDepthBuffer
  }
  let shadowLengthBuffer
  if (shadowLength) {
    shadowLengthBuffer = renderTarget.texture.clone()
    shadowLengthBuffer.isRenderTargetTexture = true
    shadowLengthBuffer.format = RedFormat
    renderTarget.shadowLength = shadowLengthBuffer
    renderTarget.textures.push(shadowLengthBuffer)
  }

  return Object.assign(renderTarget, {
    depthVelocity: depthVelocityBuffer ?? null,
    viewDepth: viewDepthBuffer ?? null,
    shadowLength: shadowLengthBuffer ?? null
  })
}

export interface CloudsPassOptions extends PassBaseOptions {
  parameterUniforms: CloudParameterUniforms
  layerUniforms: CloudLayerUniforms
  atmosphereUniforms: AtmosphereUniforms
  shaderHooks?: CloudShaderHooks
}

export class CloudsPass extends PassBase {
  private currentRenderTarget!: RenderTarget
  readonly currentMaterial: CloudsMaterial
  readonly currentPass: ShaderPass
  private resolveRenderTarget!: RenderTarget
  readonly resolveMaterial: CloudsResolveMaterial
  readonly resolvePass: ShaderPass
  private historyRenderTarget!: RenderTarget

  private width = 0
  private height = 0
  private previousFrame = -1
  private readonly cameraToECEF = new Matrix4()
  private readonly previousCameraToECEF = new Matrix4()
  private readonly previousProjection = new Matrix4()

  constructor(
    {
      parameterUniforms,
      layerUniforms,
      atmosphereUniforms,
      shaderHooks,
      ...options
    }: CloudsPassOptions,
    private readonly atmosphere: AtmosphereParameters
  ) {
    super('CloudsPass', options)

    this.currentMaterial = new CloudsMaterial(
      {
        parameterUniforms,
        layerUniforms,
        atmosphereUniforms,
        shaderHooks
      },
      atmosphere
    )
    this.currentPass = new ShaderPass(this.currentMaterial)
    this.resolveMaterial = new CloudsResolveMaterial()
    this.resolvePass = new ShaderPass(this.resolveMaterial)

    this.initRenderTargets({
      depthVelocity: true,
      shadowLength: defaults.lightShafts
    })
  }

  copyCameraSettings(camera: Camera): void {
    this.currentMaterial.copyCameraSettings(camera)
  }

  override initialize(
    renderer: WebGLRenderer,
    alpha: boolean,
    frameBufferType: TextureDataType
  ): void {
    this.currentPass.initialize(renderer, alpha, frameBufferType)
    this.resolvePass.initialize(renderer, alpha, frameBufferType)
  }

  private initRenderTargets(options: RenderTargetOptions): void {
    this.currentRenderTarget?.dispose()
    this.resolveRenderTarget?.dispose()
    this.historyRenderTarget?.dispose()
    const current = createRenderTarget('Clouds', options)
    const resolve = createRenderTarget('Clouds.A', {
      ...options,
      depthVelocity: false
    })
    const history = createRenderTarget('Clouds.B', {
      ...options,
      depthVelocity: false
    })
    this.currentRenderTarget = current
    this.resolveRenderTarget = resolve
    this.historyRenderTarget = history

    const resolveUniforms = this.resolveMaterial.uniforms
    resolveUniforms.colorBuffer.value = current.texture
    resolveUniforms.depthVelocityBuffer.value = current.depthVelocity
    resolveUniforms.shadowLengthBuffer.value = current.shadowLength
    resolveUniforms.colorHistoryBuffer.value = history.texture
    resolveUniforms.depthHistoryBuffer.value = history.viewDepth
    resolveUniforms.shadowLengthHistoryBuffer.value = history.shadowLength
    this.invalidateHistory()
  }

  private copyShadow(): void {
    const shadow = this.shadow
    const currentUniforms = this.currentMaterial.uniforms
    for (let i = 0; i < shadow.cascadeCount; ++i) {
      const cascade = shadow.cascades[i]
      currentUniforms.shadowIntervals.value[i].copy(cascade.interval)
      currentUniforms.shadowMatrices.value[i].copy(cascade.matrix)
    }
    currentUniforms.shadowFar.value = shadow.far
  }

  private copyReprojection(): void {
    this.currentMaterial.copyReprojectionMatrix(this.mainCamera)
  }

  private updateStationaryCamera(frame: number): void {
    // Compare the physical camera: a render-origin rebase alone is not motion.
    this.cameraToECEF.multiplyMatrices(
      this.currentMaterial.uniforms.worldToECEFMatrix.value,
      this.mainCamera.matrixWorld
    )
    let stationary = this.historyValid && frame === this.previousFrame + 1 &&
      this.previousProjection.equals(this.mainCamera.projectionMatrix)
    const current = this.cameraToECEF.elements
    const previous = this.previousCameraToECEF.elements
    for (let i = 0; stationary && i < 16; ++i) {
      // Allow only floating-point rebase noise: 10 micrometres of translation
      // and 1e-12 relative linear-transform error, not perceptible camera motion.
      const tolerance = i >= 12 && i < 15 ? 1e-5 :
        1e-12 * Math.max(1, Math.abs(current[i]), Math.abs(previous[i]))
      stationary = Math.abs(current[i] - previous[i]) <= tolerance
    }
    this.resolveMaterial.uniforms.stationaryCamera.value = stationary
  }

  private swapBuffers(): void {
    const nextResolve = this.historyRenderTarget
    const nextHistory = this.resolveRenderTarget
    this.resolveRenderTarget = nextResolve
    this.historyRenderTarget = nextHistory

    const resolveUniforms = this.resolveMaterial.uniforms
    resolveUniforms.colorHistoryBuffer.value = nextHistory.texture
    resolveUniforms.depthHistoryBuffer.value = nextHistory.viewDepth
    resolveUniforms.shadowLengthHistoryBuffer.value = nextHistory.shadowLength
  }

  update(renderer: WebGLRenderer, frame: number, deltaTime: number): void {
    // Update frame uniforms before copyCameraSettings.
    this.currentMaterial.uniforms.frame.value = frame
    this.resolveMaterial.uniforms.frame.value = frame

    this.copyCameraSettings(this.mainCamera)
    this.copyShadow()
    this.updateStationaryCamera(frame)

    this.currentPass.render(renderer, null, this.currentRenderTarget)
    this.resolvePass.render(renderer, null, this.resolveRenderTarget)

    // Store the current view and projection matrices for the next reprojection.
    this.copyReprojection()

    // Swap resolve and history render targets for the next render.
    this.swapBuffers()
    this.resolveMaterial.uniforms.historyValid.value = this.historyEnabled
    this.previousFrame = frame
    this.previousCameraToECEF.copy(this.cameraToECEF)
    this.previousProjection.copy(this.mainCamera.projectionMatrix)
  }

  override setSize(width: number, height: number): void {
    width = Math.max(1, Math.floor(width))
    height = Math.max(1, Math.floor(height))
    if (width === this.width && height === this.height) {
      return
    }
    this.width = width
    this.height = height
    this.resizeRenderTargets()
  }

  private resizeRenderTargets(): void {
    const width = Math.max(1, this.width)
    const height = Math.max(1, this.height)
    this.invalidateHistory()

    if (this.temporalUpscale) {
      const lowResWidth = Math.ceil(width / 4)
      const lowResHeight = Math.ceil(height / 4)
      this.currentRenderTarget.setSize(lowResWidth, lowResHeight)
      this.currentMaterial.setSize(
        lowResWidth * 4,
        lowResHeight * 4,
        width,
        height
      )
    } else {
      this.currentRenderTarget.setSize(width, height)
      this.currentMaterial.setSize(width, height)
    }
    this.resolveRenderTarget.setSize(width, height)
    this.resolveMaterial.setSize(width, height)
    this.historyRenderTarget.setSize(width, height)
  }

  /** Call for cuts/discontinuities/context loss. Rebases are handled by the host. */
  invalidateHistory(): void {
    this.resolveMaterial.uniforms.historyValid.value = false
    this.resolveMaterial.uniforms.stationaryCamera.value = false
    this.previousFrame = -1
  }

  get historyValid(): boolean {
    return this.resolveMaterial.uniforms.historyValid.value
  }

  /** Disable history and set temporalUpscale=false for the native reference. */
  get historyEnabled(): boolean {
    return this.resolveMaterial.uniforms.historyEnabled.value
  }

  set historyEnabled(value: boolean) {
    if (value !== this.historyEnabled) {
      this.resolveMaterial.uniforms.historyEnabled.value = value
      this.invalidateHistory()
    }
  }

  setShadowSize(width: number, height: number, depth: number): void {
    this.currentMaterial.shadowCascadeCount = depth
    this.currentMaterial.setShadowSize(width, height)
  }

  override setDepthTexture(
    depthTexture: Texture,
    depthPacking?: DepthPackingStrategies
  ): void {
    this.currentMaterial.depthBuffer = depthTexture
    this.currentMaterial.depthPacking = depthPacking ?? BasicDepthPacking
  }

  get outputBuffer(): Texture {
    // Resolve and history render targets are already swapped.
    return this.historyRenderTarget.texture
  }

  /** Paired with outputBuffer; positive view depth * 1e-4, or zero for clear. */
  get outputDepthBuffer(): Texture | null {
    return this.historyRenderTarget.viewDepth
  }

  get shadowBuffer(): DataArrayTexture | null {
    return this.currentMaterial.uniforms.shadowBuffer.value
  }

  set shadowBuffer(value: DataArrayTexture | null) {
    this.currentMaterial.uniforms.shadowBuffer.value = value
  }

  get shadowLengthBuffer(): Texture | null {
    // Resolve and history render targets are already swapped.
    return this.historyRenderTarget.shadowLength
  }

  get temporalUpscale(): boolean {
    return this.currentMaterial.temporalUpscale
  }

  set temporalUpscale(value: boolean) {
    if (value !== this.temporalUpscale) {
      this.currentMaterial.temporalUpscale = value
      this.resolveMaterial.temporalUpscale = value
      this.resizeRenderTargets()
    }
  }

  get lightShafts(): boolean {
    return this.currentMaterial.shadowLength
  }

  set lightShafts(value: boolean) {
    if (value !== this.lightShafts) {
      this.currentMaterial.shadowLength = value
      this.resolveMaterial.shadowLength = value
      this.initRenderTargets({
        depthVelocity: true,
        shadowLength: value
      })
      this.resizeRenderTargets()
    }
  }
}
