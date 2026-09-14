import {
  Camera, GLSL3, HalfFloatType, LinearFilter, Matrix3, Mesh, PlaneGeometry,
  RawShaderMaterial, RedFormat, RGBAFormat, Scene, Uniform, Vector2, Vector3,
  Vector4, WebGLArrayRenderTarget, type Texture, type WebGLRenderer,
} from 'three';
import {
  CLOUD_LIGHT_QUALITY, cloudLightSliceAltitude, cloudLightSliceBatches,
  completeCloudLightSliceBatch, createCloudLightGenerationState,
  invalidateCloudLightGenerations, planCloudLightAllocation, requestCloudLightGeneration,
  type CloudLightBuildInputs, type CloudLightFormat, type CloudLightQuality,
  type CloudLightVolumeLayout,
} from './cloudLightVolumeLayout';
import transportGLSL from './shaders/cloudTransport.glsl?raw';

const vertexShader = `in vec3 position; out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position, 1.0); }`;

/** Minimal media ABI for non-view producers; the density include itself is shared. */
export const CLOUD_MEDIA_GLSL_ABI = `
const float PI = 3.141592653589793;
const float RECIPROCAL_PI = 0.3183098861837907;
const float RECIPROCAL_PI2 = 0.15915494309189535;
struct MediaSample {
  float density; vec4 weight; float scattering; float extinction;
  vec2 phaseAnisotropy; float phaseMix;
};`;

function frameMatrix(layout: CloudLightVolumeLayout, matrix: Matrix3): void {
  const { x, y, z } = layout.frame;
  matrix.set(x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]);
}

type Uniforms = Record<string, Uniform>;
function frozenBindingCopy(source: Readonly<Uniforms>): Uniforms {
  return Object.fromEntries(Object.entries(source).map(([name, uniform]) => {
    const value = uniform.value;
    // Weather textures are immutable assets shared across views/generations.
    // Clone mutable math values; do not duplicate GPU textures per generation.
    return [name, new Uniform(value?.isTexture ? value : value?.clone?.() ?? value)];
  }));
}

export interface CloudLightVolumeOptions {
  readonly quality: CloudLightQuality;
  readonly mediaGLSL: string;
  readonly reservedCloudBytes: number;
  readonly slicesPerFrame?: Readonly<{ direct: number; ambient: number }>;
}

/** Two complete arrays, atomic publication, no feedback reads or compute API. */
export class CloudLightVolume {
  readonly uniforms = {
    volumetricLightVolumeTexture: new Uniform<Texture | null>(null),
    volumetricCloudPlanetRadiusM: new Uniform(0),
    volumetricLightFrame: new Uniform(new Matrix3()),
    volumetricLightCapRadius: new Uniform(1),
    volumetricLightAltitudeBoundsM: new Uniform(new Vector2()),
    volumetricLightSlices: new Uniform(1),
    volumetricLightValid: new Uniform(0),
    volumetricLightGeneration: new Uniform(-1),
  };
  readonly status = {
    state: 'uninitialized', format: '', bytes: 0, generation: -1, pendingSlices: 0, error: '',
    ageSeconds: null as number | null, valid: false
  };
  private state = createCloudLightGenerationState();
  private buffers: [WebGLArrayRenderTarget, WebGLArrayRenderTarget] | null = null;
  private readonly bindings = new Map<number, Uniforms>();
  private readonly camera = new Camera();
  private readonly scene = new Scene();
  private readonly geometry = new PlaneGeometry(2, 2);
  private readonly material: RawShaderMaterial;
  private readonly baseUniforms = {
    bottomRadius: new Uniform(0), volumetricCloudPlanetRadiusM: new Uniform(0), sunDirection: new Uniform(new Vector3()),
    volumetricCloudAltitudeBoundsM: new Uniform(new Vector2()),
    buildFrame: new Uniform(new Matrix3()), buildCapRadius: new Uniform(1),
    buildAltitudeM: new Uniform(0), buildQuantity: new Uniform(0), buildTexelSize: new Uniform(1),
  };
  private activeBuildId = -1;
  private disposed = false;

  constructor(private readonly options: CloudLightVolumeOptions) {
    this.material = new RawShaderMaterial({ glslVersion: GLSL3, vertexShader,
      depthTest: false, depthWrite: false,
      fragmentShader: `precision highp float; precision highp sampler3D;
uniform float bottomRadius; uniform vec3 sunDirection;
${CLOUD_MEDIA_GLSL_ABI}
${options.mediaGLSL}
${transportGLSL}
uniform mat3 buildFrame; uniform float buildCapRadius;
uniform float buildAltitudeM; uniform int buildQuantity; uniform float buildTexelSize;
in vec2 vUv; layout(location=0) out vec4 value;
void main() {
  vec2 q = (vUv * 2.0 - 1.0) * buildCapRadius;
  float q2 = dot(q,q);
  if (q2 > buildCapRadius * buildCapRadius) { value = vec4(0.0); return; }
  // Cloud support is nonlinear in noise/coverage. Filtering those inputs at
  // the cache's kilometre-wide footprint can erase a cloud before it casts a
  // shadow. Integrate canonical subrays, then average transmitted light.
  float visibility = 0.0;
  for (int i = 0; i < 4; ++i) {
    vec2 offset = vec2(float(i % 2), float(i / 2)) * 0.5 - 0.25;
    vec2 sampleQ = q + offset * buildTexelSize * (2.0 * buildCapRadius);
    float sampleQ2 = dot(sampleQ, sampleQ);
    vec3 direction = buildFrame * vec3(2.0 * sampleQ, 1.0 - sampleQ2) / (1.0 + sampleQ2);
    vec3 p = direction * (bottomRadius + buildAltitudeM);
    visibility += buildQuantity == 0
      ? volumetricDirectIntegration(p, sunDirection, 0.0, 32, 0.0)
      : volumetricAmbientIntegration(p, 4, 16, 0.0);
  }
  value = vec4(clamp(visibility * 0.25, 0.0, 1.0), 0.0, 0.0, 1.0);
}`, uniforms: this.baseUniforms });
    const mesh = new Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  private makeTarget(format: CloudLightFormat, width: number, height: number, layers: number) {
    const target = new WebGLArrayRenderTarget(width, height, layers, {
      depthBuffer: false,
    });
    // Three r170 replaces the base target's texture after applying options.
    // Set array texture properties on the replacement, not constructor options.
    Object.assign(target.texture, { type: HalfFloatType,
      format: format === 'R16F' ? RedFormat : RGBAFormat, internalFormat: format,
      minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false });
    return target;
  }

  initialize(renderer: WebGLRenderer): void {
    if (this.disposed || this.status.state !== 'uninitialized') return;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (!renderer.capabilities.isWebGL2 || !renderer.extensions.has('EXT_color_buffer_float')) {
      this.status.state = 'unsupported';
      this.status.error = 'Renderable float WebGL2 arrays unavailable; using bounded transport fallback.';
      return;
    }
    const previous = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    const viewport = renderer.getViewport(new Vector4());
    const failures: string[] = [];
    try {
      for (const format of ['R16F', 'RGBA16F'] as const) {
        const probe = this.makeTarget(format, 1, 1, 2);
        let supported = false;
        try {
          renderer.setRenderTarget(probe, 0);
          const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
          supported = status === gl.FRAMEBUFFER_COMPLETE;
          if (!supported) failures.push(`${format}: 0x${status.toString(16)} (GL 0x${gl.getError().toString(16)})`);
        } finally { renderer.setRenderTarget(previous, face, mip); probe.dispose(); }
        if (!supported) continue;
        const allocation = planCloudLightAllocation(this.options.quality, format, {
          maxTextureSize: renderer.capabilities.maxTextureSize,
          maxArrayLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
          reservedCloudBytes: this.options.reservedCloudBytes,
        });
        const a = this.makeTarget(format, allocation.width, allocation.height, allocation.layers);
        const b = this.makeTarget(format, allocation.width, allocation.height, allocation.layers);
        this.buffers = [a, b];
        Object.assign(this.status, { state: 'building', format, bytes: allocation.lightVolumeBytes });
        return;
      }
      this.status.state = 'unsupported';
      this.status.error = `Neither R16F nor RGBA16F arrays are renderable: ${failures.join(', ')}.`;
    } catch (error) {
      this.status.state = 'unsupported'; this.status.error = String(error);
    } finally { renderer.setRenderTarget(previous, face, mip); renderer.setViewport(viewport); }
  }

  request(inputs: CloudLightBuildInputs, mediaUniforms: Readonly<Uniforms>): void {
    if (this.disposed) return;
    const next = requestCloudLightGeneration(this.state, inputs);
    if (next === this.state) return;
    this.state = next;
    this.uniforms.volumetricCloudPlanetRadiusM.value = inputs.layout.planetRadiusM;
    this.bindings.set(inputs.generation, frozenBindingCopy(mediaUniforms));
    const retained = new Set([next.build?.inputs.generation, next.pending?.generation]);
    for (const generation of this.bindings.keys()) if (!retained.has(generation)) this.bindings.delete(generation);
  }

  /** Call before view rendering. Current inputs only validate already published data. */
  update(renderer: WebGLRenderer, current: CloudLightBuildInputs): void {
    this.initialize(renderer);
    if (this.buffers === null || this.disposed) return;
    const target = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    const viewport = renderer.getViewport(new Vector4());
    const scissor = renderer.getScissorTest(), autoClear = renderer.autoClear;
    try {
      renderer.setScissorTest(false); renderer.autoClear = false;
      for (const batch of cloudLightSliceBatches(this.state, this.options.slicesPerFrame ?? { direct: 1, ambient: 1 })) {
        const build = this.state.build;
        if (!build || build.buildId !== batch.buildId) break;
        if (build.buildId !== this.activeBuildId) {
          // Three caches this map with the compiled program. Preserve its
          // identity while replacing the frozen generation's Uniform objects.
          Object.assign(this.material.uniforms, this.bindings.get(build.inputs.generation), this.baseUniforms);
          this.material.uniformsNeedUpdate = true;
          this.activeBuildId = build.buildId;
        }
        const u = this.baseUniforms, layout = build.inputs.layout;
        u.bottomRadius.value = layout.planetRadiusM;
        u.volumetricCloudPlanetRadiusM.value = layout.planetRadiusM;
        u.sunDirection.value.fromArray(build.inputs.sunDirectionECEF);
        u.volumetricCloudAltitudeBoundsM.value.set(layout.minAltitudeM, layout.maxAltitudeM);
        frameMatrix(layout, u.buildFrame.value);
        u.buildCapRadius.value = layout.capRadius;
        u.buildTexelSize.value = 1 / CLOUD_LIGHT_QUALITY[layout.quality].width;
        u.buildQuantity.value = batch.quantity === 'direct' ? 0 : 1;
        for (let layer = batch.firstLayer; layer < batch.firstLayer + batch.sliceCount; ++layer) {
          u.buildAltitudeM.value = cloudLightSliceAltitude(layout, batch.quantity, layer);
          // This shader has NO sampler for either light buffer; feedback is impossible.
          renderer.setRenderTarget(this.buffers[batch.bufferIndex], layer);
          renderer.render(this.scene, this.camera);
        }
        this.state = completeCloudLightSliceBatch(this.state, batch);
      }
    } catch (error) {
      this.invalidate(); this.status.state = 'failed'; this.status.error = String(error);
    } finally {
      renderer.setRenderTarget(target, face, mip); renderer.setViewport(viewport);
      renderer.setScissorTest(scissor); renderer.autoClear = autoClear;
    }
    const published = this.state.published;
    const age = published ? current.visualTimeSeconds - published.inputs.visualTimeSeconds : Infinity;
    const sunAgreement = published ? published.inputs.sunDirectionECEF.reduce((v, c, i) => v + c * current.sunDirectionECEF[i]!, 0) : 0;
    const valid = published !== null && published.inputs.weatherGeneration === current.weatherGeneration &&
      age >= 0 && age <= 3 && sunAgreement >= Math.cos(Math.PI / 180);
    this.status.ageSeconds = Number.isFinite(age) ? Math.max(0, age) : null;
    this.status.valid = valid;
    this.uniforms.volumetricLightValid.value = valid ? 1 : 0;
    if (published) {
      const layout = published.inputs.layout;
      this.uniforms.volumetricLightVolumeTexture.value = this.buffers[published.bufferIndex].texture;
      frameMatrix(layout, this.uniforms.volumetricLightFrame.value);
      this.uniforms.volumetricLightCapRadius.value = layout.capRadius;
      this.uniforms.volumetricLightAltitudeBoundsM.value.set(layout.minAltitudeM, layout.maxAltitudeM);
      this.uniforms.volumetricLightSlices.value = CLOUD_LIGHT_QUALITY[layout.quality].slicesPerQuantity;
      this.uniforms.volumetricLightGeneration.value = published.inputs.generation;
      this.status.generation = published.inputs.generation;
      this.status.state = valid ? 'ready' : 'building';
    }
    const build = this.state.build;
    this.status.pendingSlices = build ? 2 * CLOUD_LIGHT_QUALITY[build.inputs.layout.quality].slicesPerQuantity - build.directDone - build.ambientDone : 0;
  }

  invalidate(): void {
    this.state = invalidateCloudLightGenerations(this.state); this.bindings.clear();
    this.uniforms.volumetricLightValid.value = 0; this.activeBuildId = -1;
    this.uniforms.volumetricLightGeneration.value = -1;
    this.status.generation = -1;
    this.status.pendingSlices = 0;
    this.status.ageSeconds = null;
    this.status.valid = false;
    if (!['failed', 'unsupported', 'disposed'].includes(this.status.state)) {
      this.status.state = 'invalidated';
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.invalidate();
    this.buffers?.forEach(buffer => buffer.dispose()); this.buffers = null;
    this.material.dispose(); this.geometry.dispose(); this.scene.clear();
    this.uniforms.volumetricLightVolumeTexture.value = null; this.status.state = 'disposed';
  }
}
