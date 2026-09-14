import { NormalPass, RenderPass } from 'postprocessing';
import { Camera, Color, Line, Material, Mesh, MeshNormalMaterial, Object3D, Points, Scene, ShaderMaterial, Sprite } from 'three';
import { createTerrainSurfaceNormalMaterial } from './terrain/terrainSurfaceNormal';
import { hasOpaqueSurface, SurfaceMaterialCache } from './librarySurfaceMaterials';

type NormalShader = Pick<Parameters<MeshNormalMaterial['onBeforeCompile']>[0], 'vertexShader' | 'fragmentShader'>;

function replaceOnce(source: string, seam: string, replacement: string): string {
  if (source.split(seam).length !== 2) throw new Error('Pinned Three normal shader changed; review water mask');
  return source.replace(seam, replacement);
}

/** Add only water coverage; retain Three's view normals, RGB packing and log depth. */
export function maskSurfaceNormalShader(shader: NormalShader): void {
  const vertex = replaceOnce(shader.vertexShader, '#include <common>',
    '#include <common>\nattribute float waterMask;\nvarying float vSurfaceWaterMask;');
  const vertexShader = replaceOnce(vertex, '#include <begin_vertex>',
    '#include <begin_vertex>\nvSurfaceWaterMask = waterMask;');
  const fragment = replaceOnce(shader.fragmentShader, '#include <packing>',
    '#include <packing>\nvarying float vSurfaceWaterMask;');
  const fragmentShader = replaceOnce(fragment, '#include <clipping_planes_fragment>',
    '#include <clipping_planes_fragment>\nif (vSurfaceWaterMask < 0.5) discard;');
  shader.vertexShader = vertexShader;
  shader.fragmentShader = fragmentShader;
}

/** Geometric normals, with coverage discard only for separate water overlays. */
export class SurfaceNormalPass extends NormalPass {
  // Public at runtime, omitted from the pinned postprocessing declarations.
  declare readonly renderPass: RenderPass;
  #normalMaterials = new SurfaceMaterialCache(source =>
    source instanceof ShaderMaterial && source.uniforms.terrainSurfaceNoiseTexture
      ? createTerrainSurfaceNormalMaterial(source) : new MeshNormalMaterial());
  #waterMaterials = new SurfaceMaterialCache(() => {
    const material = new MeshNormalMaterial();
    material.onBeforeCompile = maskSurfaceNormalShader;
    material.customProgramCacheKey = () => 'library-surface-normal-water-v1';
    return material;
  });
  #originalMaterials = new Map<Mesh, Material | Material[]>();
  #originalLayers = new Map<Object3D, number>();
  #clearColor = new Color();
  #disposed = false;

  constructor(scene: Scene, camera: Camera, options?: ConstructorParameters<typeof NormalPass>[2]) {
    super(scene, camera, options);
    if (!(this.renderPass instanceof RenderPass) || !(this.renderPass.overrideMaterial instanceof MeshNormalMaterial)) {
      throw new Error('Pinned NormalPass changed; review surface normal override');
    }
    this.scene = scene;
    this.camera = camera;
    const original = this.renderPass.overrideMaterial;
    // Disable once: the public setter disposes its clones, but not the source material.
    // Restoring this override each frame would allocate another set of clones.
    (this.renderPass as unknown as { overrideMaterial: Material | null }).overrideMaterial = null;
    original.dispose();
  }

  override set mainScene(scene: Scene) { this.scene = scene; super.mainScene = scene; }
  override set mainCamera(camera: Camera) { this.camera = camera; super.mainCamera = camera; }

  #replaceMaterials = (object: Object3D): void => {
    if (object instanceof Mesh) {
      const source = object.material;
      const materials = Array.isArray(source) ? source : [source];
      // Additive exhaust and transparent decals have no solid surface/depth.
      // Overriding their shader with an opaque material reveals their raster
      // bounds in the atmosphere lighting, even where their alpha is zero.
      if (!materials.some(hasOpaqueSurface)) {
        this.#originalLayers.set(object, object.layers.mask);
        object.layers.mask = 0;
        return;
      }
      this.#originalMaterials.set(object, source);
      // Unified terrainWaterMask tiles cover both land and water. Their stock
      // normal material must keep every fragment, matching their color/depth.
      const water = object.geometry.hasAttribute('waterMask');
      const replacement = (material: Material) => {
        // Retain the existing terrain hook's precedence, also inside arrays.
        const terrain = material instanceof ShaderMaterial && material.uniforms.terrainSurfaceNoiseTexture;
        return (water && !terrain ? this.#waterMaterials : this.#normalMaterials).get(material);
      };
      object.material = Array.isArray(source) ? source.map(replacement) : replacement(source);
    } else if (object instanceof Line || object instanceof Points || object instanceof Sprite) {
      // Exclude unsupported drawables without hiding their mesh children or changing materials.
      this.#originalLayers.set(object, object.layers.mask);
      object.layers.mask = 0;
    }
  };

  override render(...args: Parameters<NormalPass['render']>): void {
    const [renderer] = args;
    const scene = this.scene, camera = this.camera;
    const overrideMaterial = scene.overrideMaterial, background = scene.background;
    const cameraMask = camera.layers.mask;
    const shadowEnabled = renderer.shadowMap.enabled, shadowAutoUpdate = renderer.shadowMap.autoUpdate;
    renderer.getClearColor(this.#clearColor);
    const clearAlpha = renderer.getClearAlpha();
    try {
      scene.overrideMaterial = null;
      renderer.shadowMap.enabled = false;
      scene.traverseVisible(this.#replaceMaterials);
      super.render(...args);
    } finally {
      for (const [mesh, material] of this.#originalMaterials) mesh.material = material;
      for (const [object, mask] of this.#originalLayers) object.layers.mask = mask;
      this.#originalMaterials.clear();
      this.#originalLayers.clear();
      scene.overrideMaterial = overrideMaterial;
      // The pinned RenderPass/ClearPass do not restore these when rendering throws.
      scene.background = background;
      camera.layers.mask = cameraMask;
      renderer.shadowMap.enabled = shadowEnabled;
      renderer.shadowMap.autoUpdate = shadowAutoUpdate;
      renderer.setClearColor(this.#clearColor, clearAlpha);
    }
  }

  override dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // JS private fields keep Pass.dispose's shallow walk from disposing these twice.
    this.#normalMaterials.dispose();
    this.#waterMaterials.dispose();
    super.dispose();
  }
}
