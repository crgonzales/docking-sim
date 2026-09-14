import { LightingMaskPass } from '@takram/three-atmosphere';
import { RenderPass, type DepthMaskMaterial } from 'postprocessing';
import { Camera, Color, Material, Mesh, MeshBasicMaterial, Scene } from 'three';
import { SurfaceMaterialCache } from './librarySurfaceMaterials';

const CONVERSION = `  #ifdef PERSPECTIVE_CAMERA
  depth.x = viewZToOrthographicDepth(getViewZ(depth.x), cameraNearFar.x, cameraNearFar.y);
  depth.y = viewZToOrthographicDepth(getViewZ(depth.y), cameraNearFar.x, cameraNearFar.y);
  #endif // PERSPECTIVE_CAMERA`;

/** Both inputs are copied with identical RGBA depth packing. Compare them in
 * that shared, monotonic depth space. Reconstructing perspective Z at cleared
 * depth 1 divides by zero with near=.5/far=1e8 in Float32, causing even an empty
 * exclusion selection to mask out the entire terrain.
 */
export function stableLightingMaskDepth(source: string): string {
  if (source.split(CONVERSION).length !== 2) throw new Error('Pinned lighting mask changed; review depth comparison');
  return source.replace(CONVERSION, '  // Preserve shared packed/log depth ordering, including clear depth 1.');
}

export class StableLightingMaskPass extends LightingMaskPass {
  #materials = new SurfaceMaterialCache(() => new MeshBasicMaterial());
  #originalMaterials = new Map<Mesh, Material | Material[]>();
  #clearColor = new Color();
  #disposed = false;

  constructor(...args: ConstructorParameters<typeof LightingMaskPass>) {
    super(...args);
    this.scene = args[0]; this.camera = args[1];
    // This shader is private in the pinned release. Validate its packing and
    // unique source seam before adapting; never silently patch another ABI.
    const material = (this as unknown as { depthMaskMaterial: DepthMaskMaterial }).depthMaskMaterial;
    if (!material || Number(material.defines.DEPTH_PACKING_0) !== 3201 || Number(material.defines.DEPTH_PACKING_1) !== 3201) {
      throw new Error('Pinned lighting mask packing changed; review depth comparison');
    }
    material.fragmentShader = stableLightingMaskDepth(material.fragmentShader);
    material.needsUpdate = true;
    const renderPass = (this as unknown as { renderPass: RenderPass }).renderPass;
    if (!(renderPass instanceof RenderPass) || !(renderPass.overrideMaterial instanceof MeshBasicMaterial)) {
      throw new Error('Pinned LightingMaskPass changed; review surface override');
    }
    // The installed global override drops material sidedness and group arrays.
    // Disable its manager once, and keep source-aware replacements local to us.
    const original = renderPass.overrideMaterial;
    (renderPass as unknown as { overrideMaterial: Material | null }).overrideMaterial = null;
    original.dispose();
  }

  override set mainScene(scene: Scene) { this.scene = scene; super.mainScene = scene; }
  override set mainCamera(camera: Camera) { this.camera = camera; super.mainCamera = camera; }

  override render(...args: Parameters<LightingMaskPass['render']>): void {
    const [renderer] = args;
    const scene = this.scene, camera = this.camera;
    const override = scene.overrideMaterial, background = scene.background, cameraMask = camera.layers.mask;
    const autoClear = renderer.autoClear;
    const shadowEnabled = renderer.shadowMap.enabled, shadowAutoUpdate = renderer.shadowMap.autoUpdate;
    renderer.getClearColor(this.#clearColor);
    const clearAlpha = renderer.getClearAlpha();
    try {
      scene.overrideMaterial = null;
      renderer.shadowMap.enabled = false;
      scene.traverseVisible(object => {
        if (!(object instanceof Mesh) || !this.selection.has(object)) return;
        const source = object.material;
        this.#originalMaterials.set(object, source);
        object.material = Array.isArray(source)
          ? source.map(material => this.#materials.get(material)) : this.#materials.get(source);
      });
      super.render(...args);
    } finally {
      for (const [mesh, source] of this.#originalMaterials) mesh.material = source;
      this.#originalMaterials.clear();
      scene.overrideMaterial = override; scene.background = background; camera.layers.mask = cameraMask;
      renderer.autoClear = autoClear;
      renderer.shadowMap.enabled = shadowEnabled; renderer.shadowMap.autoUpdate = shadowAutoUpdate;
      renderer.setClearColor(this.#clearColor, clearAlpha);
    }
  }

  override dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#materials.dispose();
    super.dispose();
  }
}
