import {
  Camera, ClampToEdgeWrapping, Color, GLSL3, HalfFloatType, LinearFilter,
  LinearMipmapLinearFilter, Mesh, NoBlending, NoColorSpace, NoToneMapping,
  PlaneGeometry, RawShaderMaterial, RepeatWrapping, RGBAFormat, Scene, Uniform,
  Vector2, Vector4, WebGLRenderTarget, type Texture, type WebGLRenderer,
} from 'three';

import { CLOUD_MEDIA_GLSL_ABI } from './CloudLightVolume';
import type { WeatherBindingUniforms } from './cloudWeather';
import defaultMediaGLSL from './shaders/cloudDensity.glsl?raw';
import columnAtlasGLSL from './shaders/cloudColumnAtlas.glsl?raw';
import columnGLSL from './shaders/cloudColumn.glsl?raw';

const vertexShader = `in vec3 position; out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position, 1.0); }`;

const BYTES_PER_RGBA16F_TEXEL = 8;
const DEFAULT_ROWS_PER_FRAME = 16;
const MEBIBYTE = 1024 * 1024;

function mipAllocation(width: number, height: number): {
  readonly mipLevels: number;
  readonly bytes: number;
} {
  let mipWidth = width;
  let mipHeight = height;
  let texels = 0;
  let mipLevels = 0;
  for (;;) {
    texels += mipWidth * mipHeight;
    mipLevels += 1;
    if (mipWidth === 1 && mipHeight === 1) break;
    mipWidth = Math.max(1, Math.floor(mipWidth / 2));
    mipHeight = Math.max(1, Math.floor(mipHeight / 2));
  }
  return Object.freeze({ mipLevels, bytes: texels * BYTES_PER_RGBA16F_TEXEL });
}

function quality(
  width: number,
  height: number,
  segmentCount: 32 | 48,
  maxCloudBytes: number,
) {
  return Object.freeze({
    width,
    height,
    segmentCount,
    maxCloudBytes,
    ...mipAllocation(width, height),
  });
}

/** RGBA16F base level plus its complete mip chain; excludes driver overhead. */
export const CLOUD_COLUMN_ATLAS_QUALITY = Object.freeze({
  low: quality(1024, 512, 32, 48 * MEBIBYTE),
  medium: quality(2048, 1024, 48, 96 * MEBIBYTE),
});

export type CloudColumnAtlasQuality = keyof typeof CLOUD_COLUMN_ATLAS_QUALITY;
export type CloudColumnAtlasState =
  | 'uninitialized'
  | 'idle'
  | 'building'
  | 'ready'
  | 'invalidated'
  | 'context-lost'
  | 'unsupported'
  | 'failed'
  | 'disposed';

export interface CloudColumnAtlasStatus {
  state: CloudColumnAtlasState;
  /** Exact RGBA16F byte count for the base level and every mip. */
  bytes: number;
  completedRows: number;
  error: string;
}

export interface CloudColumnAtlasOptions {
  readonly quality: CloudColumnAtlasQuality;
  /** Defaults to the canonical cloudDensity.glsl include. */
  readonly mediaGLSL?: string;
  readonly rowsPerFrame?: number;
  /** Bytes already reserved by all other cloud resources. */
  readonly reservedCloudBytes?: number;
  /** Optional stricter total cap; never raises the quality tier's cap. */
  readonly maxCloudBytes?: number;
}

type UniformMap = Record<string, Uniform<unknown>>;

function cloneUniformValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if ((value as Texture).isTexture) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(cloneUniformValue));
  if (ArrayBuffer.isView(value)) {
    const slice = (value as { slice?: () => unknown }).slice;
    return typeof slice === 'function' ? slice.call(value) : value;
  }
  const clone = (value as { clone?: () => unknown }).clone;
  if (typeof clone === 'function') return clone.call(value);
  if (Object.getPrototypeOf(value) === Object.prototype) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneUniformValue(child)]),
    ));
  }
  return value;
}

/** Snapshot scalar/math inputs while retaining immutable GPU texture assets. */
function frozenBindingCopy(source: WeatherBindingUniforms, generation: number): Readonly<UniformMap> {
  const copy: UniformMap = {};
  for (const [name, uniform] of Object.entries(source)) {
    copy[name] = new Uniform(cloneUniformValue(uniform.value));
  }
  copy.eveWeatherGeneration = new Uniform(generation);
  return Object.freeze(copy);
}

function finiteNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasRequiredMediaContract(mediaGLSL: string): boolean {
  return /\bMediaSample\s+sampleCloudMedia\s*\(/.test(mediaGLSL) &&
    /\bvec2\s+eveSampleWeather\s*\(/.test(mediaGLSL);
}

interface RendererState {
  readonly target: WebGLRenderTarget | null;
  readonly face: number;
  readonly mip: number;
  readonly viewport: Vector4;
  readonly scissor: Vector4;
  readonly scissorTest: boolean;
  readonly clearColor: Color;
  readonly clearAlpha: number;
  readonly autoClear: boolean;
  readonly autoClearColor: boolean;
  readonly autoClearDepth: boolean;
  readonly autoClearStencil: boolean;
  readonly toneMapping: WebGLRenderer['toneMapping'];
  readonly toneMappingExposure: number;
}

function captureRendererState(renderer: WebGLRenderer): RendererState {
  return {
    target: renderer.getRenderTarget(),
    face: renderer.getActiveCubeFace(),
    mip: renderer.getActiveMipmapLevel(),
    viewport: renderer.getViewport(new Vector4()),
    scissor: renderer.getScissor(new Vector4()),
    scissorTest: renderer.getScissorTest(),
    clearColor: renderer.getClearColor(new Color()),
    clearAlpha: renderer.getClearAlpha(),
    autoClear: renderer.autoClear,
    autoClearColor: renderer.autoClearColor,
    autoClearDepth: renderer.autoClearDepth,
    autoClearStencil: renderer.autoClearStencil,
    toneMapping: renderer.toneMapping,
    toneMappingExposure: renderer.toneMappingExposure,
  };
}

function restoreRendererState(renderer: WebGLRenderer, state: RendererState): void {
  renderer.setRenderTarget(state.target, state.face, state.mip);
  renderer.setViewport(state.viewport);
  renderer.setScissor(state.scissor);
  renderer.setScissorTest(state.scissorTest);
  renderer.setClearColor(state.clearColor, state.clearAlpha);
  renderer.autoClear = state.autoClear;
  renderer.autoClearColor = state.autoClearColor;
  renderer.autoClearDepth = state.autoClearDepth;
  renderer.autoClearStencil = state.autoClearStencil;
  renderer.toneMapping = state.toneMapping;
  renderer.toneMappingExposure = state.toneMappingExposure;
}

/**
 * Owns one unpublished-while-building, mipmapped equirectangular column atlas.
 * Weather textures are shared; all scalar/math inputs are copied per request.
 */
export class CloudColumnAtlas {
  readonly uniforms: {
    readonly eveColumnTexture: Uniform<Texture | null>;
    readonly eveColumnDimensions: Uniform<Vector2>;
    readonly eveColumnReady: Uniform<number>;
    readonly eveColumnGeneration: Uniform<number>;
  };
  readonly status: CloudColumnAtlasStatus;
  /** Exact target reservation, including the complete mip chain. */
  readonly bytes: number;

  private readonly config: (typeof CLOUD_COLUMN_ATLAS_QUALITY)[CloudColumnAtlasQuality];
  private readonly rowsPerFrame: number;
  private readonly reservedCloudBytes: number;
  private readonly maxCloudBytes: number;
  private readonly camera = new Camera();
  private readonly scene = new Scene();
  private readonly geometry = new PlaneGeometry(2, 2);
  private readonly baseUniforms: UniformMap;
  private readonly material: RawShaderMaterial;
  private target: WebGLRenderTarget | null = null;
  private binding: Readonly<UniformMap> | null = null;
  private requestedGeneration = -1;
  private boundGeneration = -1;
  private initialized = false;
  private disposed = false;

  constructor(options: CloudColumnAtlasOptions) {
    const config = CLOUD_COLUMN_ATLAS_QUALITY[options.quality];
    if (config === undefined) throw new RangeError(`Unsupported cloud column atlas quality: ${options.quality}`);
    const rowsPerFrame = options.rowsPerFrame ?? DEFAULT_ROWS_PER_FRAME;
    if (!Number.isSafeInteger(rowsPerFrame) || rowsPerFrame <= 0) {
      throw new RangeError('Cloud column atlas rowsPerFrame must be a positive safe integer');
    }
    const reservedCloudBytes = options.reservedCloudBytes ?? 0;
    const requestedMaxCloudBytes = options.maxCloudBytes ?? config.maxCloudBytes;
    finiteNonNegativeInteger(reservedCloudBytes, 'Cloud column atlas reservedCloudBytes');
    finiteNonNegativeInteger(requestedMaxCloudBytes, 'Cloud column atlas maxCloudBytes');
    const mediaGLSL = options.mediaGLSL ?? defaultMediaGLSL;
    if (!hasRequiredMediaContract(mediaGLSL)) {
      throw new Error('Cloud column atlas requires canonical eveSampleWeather and sampleCloudMedia GLSL hooks');
    }

    this.config = config;
    this.rowsPerFrame = Math.min(rowsPerFrame, config.height);
    this.reservedCloudBytes = reservedCloudBytes;
    this.maxCloudBytes = Math.min(requestedMaxCloudBytes, config.maxCloudBytes);
    this.bytes = config.bytes;
    this.status = {
      state: 'uninitialized',
      bytes: config.bytes,
      completedRows: 0,
      error: '',
    };
    this.uniforms = {
      eveColumnTexture: new Uniform<Texture | null>(null),
      eveColumnDimensions: new Uniform(new Vector2(config.width, config.height)),
      eveColumnReady: new Uniform(0),
      eveColumnGeneration: new Uniform(-1),
    };
    this.baseUniforms = {
      eveColumnAngularPixelRad: new Uniform(2 * Math.PI / config.width),
      eveColumnSegmentCount: new Uniform(config.segmentCount),
    };
    this.material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader,
      fragmentShader: `precision highp float; precision highp int;
precision highp sampler2D; precision highp sampler3D;
${CLOUD_MEDIA_GLSL_ABI}
${mediaGLSL}
${columnGLSL}
${columnAtlasGLSL}`,
      uniforms: this.baseUniforms,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  /**
   * Starts a generation snapshot. Repeating the same generation is a no-op;
   * callers must advance it whenever any scalar, math or texture input changes.
   */
  request(weatherGeneration: number, weatherUniforms: WeatherBindingUniforms): void {
    if (this.disposed) return;
    finiteNonNegativeInteger(weatherGeneration, 'Weather generation');
    if (weatherGeneration === this.requestedGeneration) return;

    this.requestedGeneration = weatherGeneration;
    this.binding = frozenBindingCopy(weatherUniforms, weatherGeneration);
    this.boundGeneration = -1;
    this.status.completedRows = 0;
    this.unpublish();
    if (this.target) this.target.texture.generateMipmaps = false;
    if (this.status.state !== 'unsupported') {
      this.status.state = this.target ? 'building' : 'uninitialized';
      this.status.error = '';
    }
  }

  /** Prepare at most rowsPerFrame base-level rows and publish only when complete. */
  update(renderer: WebGLRenderer): void {
    if (this.disposed || this.status.state === 'failed' ||
      (this.status.state === 'unsupported' && this.initialized)) return;
    const gl = renderer.getContext();
    if (gl.isContextLost()) {
      this.handleContextLoss();
      return;
    }
    if (this.status.state === 'ready' && this.status.completedRows === this.config.height) return;
    if (!this.binding || this.requestedGeneration < 0) return;

    const previous = captureRendererState(renderer);
    try {
      renderer.autoClear = false;
      renderer.autoClearColor = false;
      renderer.autoClearDepth = false;
      renderer.autoClearStencil = false;
      renderer.toneMapping = NoToneMapping;

      if (!this.initialize(renderer, gl as WebGL2RenderingContext)) return;
      if (!this.target) return;
      if (this.status.completedRows >= this.config.height) return;

      if (this.boundGeneration !== this.requestedGeneration) {
        Object.assign(this.material.uniforms, this.binding, this.baseUniforms);
        this.material.uniformsNeedUpdate = true;
        this.boundGeneration = this.requestedGeneration;
      }
      for (const uniform of Object.values(this.material.uniforms)) {
        if (uniform.value === this.target.texture) {
          throw new Error('Cloud column atlas texture feedback is not allowed');
        }
      }

      const firstRow = this.status.completedRows;
      const rowCount = Math.min(this.rowsPerFrame, this.config.height - firstRow);
      const finalBatch = firstRow + rowCount === this.config.height;
      this.target.viewport.set(0, 0, this.config.width, this.config.height);
      this.target.scissor.set(0, firstRow, this.config.width, rowCount);
      this.target.scissorTest = true;
      // Three r170 calls updateRenderTargetMipmap once at the end of render().
      // Keeping this false until the final base-level batch avoids partial mips.
      this.target.texture.generateMipmaps = finalBatch;
      renderer.setRenderTarget(this.target);
      renderer.render(this.scene, this.camera);
      this.status.completedRows += rowCount;

      if (finalBatch) {
        this.target.scissor.set(0, 0, this.config.width, this.config.height);
        this.target.scissorTest = false;
        this.uniforms.eveColumnTexture.value = this.target.texture;
        this.uniforms.eveColumnGeneration.value = this.requestedGeneration;
        this.uniforms.eveColumnReady.value = 1;
        this.status.state = 'ready';
      } else {
        this.status.state = 'building';
      }
    } catch (error) {
      if (this.target) this.target.texture.generateMipmaps = false;
      this.unpublish();
      this.status.state = 'failed';
      this.status.error = `Cloud column atlas build failed: ${errorMessage(error)}`;
    } finally {
      restoreRendererState(renderer, previous);
    }
  }

  /** Cancel partial/published data without reallocating a supported target. */
  invalidate(): void {
    if (this.disposed) return;
    this.binding = null;
    this.requestedGeneration = -1;
    this.boundGeneration = -1;
    this.status.completedRows = 0;
    this.unpublish();
    if (this.target) this.target.texture.generateMipmaps = false;
    if (this.status.state === 'unsupported') {
      // An explicit invalidation permits one capability retry after restoration.
      this.initialized = false;
    } else {
      this.status.state = 'invalidated';
      this.status.error = '';
    }
  }

  /** Safe to call directly from a webglcontextlost listener. */
  handleContextLoss(): void {
    if (this.disposed) return;
    this.binding = null;
    this.requestedGeneration = -1;
    this.boundGeneration = -1;
    this.status.completedRows = 0;
    this.unpublish();
    this.target?.dispose();
    this.target = null;
    this.initialized = false;
    this.status.state = 'context-lost';
    this.status.error = 'WebGL context lost; cloud column atlas is unavailable until rebuilt.';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.binding = null;
    this.requestedGeneration = -1;
    this.boundGeneration = -1;
    this.unpublish();
    this.target?.dispose();
    this.target = null;
    this.material.dispose();
    this.geometry.dispose();
    this.scene.clear();
    this.status.completedRows = 0;
    this.status.state = 'disposed';
    this.status.error = '';
  }

  private initialize(renderer: WebGLRenderer, gl: WebGL2RenderingContext): boolean {
    if (this.initialized) return this.target !== null;
    this.initialized = true;
    if (!renderer.capabilities.isWebGL2 || !renderer.extensions.has('EXT_color_buffer_float')) {
      this.unsupported('Renderable RGBA16F WebGL2 targets are unavailable.');
      return false;
    }
    // RGBA16F is linearly filterable in WebGL2 without OES_texture_float_linear
    // (that extension is needed for 32-bit float filtering).
    if (renderer.capabilities.maxTextureSize < Math.max(this.config.width, this.config.height)) {
      this.unsupported(
        `${this.config.width}x${this.config.height} cloud column atlas exceeds the device texture-size limit.`,
      );
      return false;
    }
    const totalCloudBytes = this.reservedCloudBytes + this.config.bytes;
    if (!Number.isSafeInteger(totalCloudBytes) || totalCloudBytes > this.maxCloudBytes) {
      this.unsupported(
        `Cloud column atlas allocation (${this.config.bytes} bytes) exceeds the total cloud memory cap.`,
      );
      return false;
    }

    const target = new WebGLRenderTarget(this.config.width, this.config.height, {
      type: HalfFloatType,
      format: RGBAFormat,
      internalFormat: 'RGBA16F',
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
      wrapS: RepeatWrapping,
      wrapT: ClampToEdgeWrapping,
      generateMipmaps: false,
      colorSpace: NoColorSpace,
      depthBuffer: false,
      stencilBuffer: false,
    });
    target.texture.name = `EVE cloud column atlas ${this.config.width}x${this.config.height}`;
    target.viewport.set(0, 0, this.config.width, this.config.height);
    target.scissor.set(0, 0, this.config.width, this.config.height);
    target.scissorTest = false;
    try {
      renderer.setRenderTarget(target);
      const framebufferStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (framebufferStatus !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`RGBA16F framebuffer incomplete (0x${framebufferStatus.toString(16)})`);
      }
      this.target = target;
      this.status.state = this.binding ? 'building' : 'idle';
      this.status.error = '';
      return true;
    } catch (error) {
      target.dispose();
      this.unsupported(`RGBA16F cloud column atlas unavailable: ${errorMessage(error)}`);
      return false;
    }
  }

  private unpublish(): void {
    this.uniforms.eveColumnTexture.value = null;
    this.uniforms.eveColumnReady.value = 0;
    this.uniforms.eveColumnGeneration.value = -1;
  }

  private unsupported(message: string): void {
    this.target?.dispose();
    this.target = null;
    this.unpublish();
    this.status.completedRows = 0;
    this.status.state = 'unsupported';
    this.status.error = message;
  }
}
