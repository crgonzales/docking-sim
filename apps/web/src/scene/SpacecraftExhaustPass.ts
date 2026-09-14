import { Pass } from 'postprocessing';
import { BasicDepthPacking, Camera, Mesh, Scene, ShaderMaterial, Texture, Vector2,
  type DepthPackingStrategies, type WebGLRenderer, type WebGLRenderTarget } from 'three';

export const SPACECRAFT_EXHAUST_LAYER = 29;

/** Transparent emission belongs after the sky/cloud composite and before
 * tone mapping. Sample the original opaque depth in the plume shader so the
 * capsule occludes exhaust even after the composer swaps its color buffers.
 */
export class SpacecraftExhaustPass extends Pass {
  #depth: Texture | null = null;
  #size = new Vector2();
  constructor(scene: Scene, camera: Camera) {
    super('SpacecraftExhaustPass', scene, camera); this.needsSwap = false; this.needsDepthTexture = true;
  }
  override setDepthTexture(texture: Texture, packing: DepthPackingStrategies = BasicDepthPacking): void {
    if (packing !== BasicDepthPacking) throw new Error('Exhaust pass requires native scene depth');
    this.#depth = texture;
  }
  override render(renderer: WebGLRenderer, input: WebGLRenderTarget | null): void {
    if (!input || !this.#depth) return;
    let count = 0;
    this.#size.set(input.width, input.height);
    this.scene.traverseVisible(object => {
      if (!(object instanceof Mesh) || !(object.layers.mask & (1 << SPACECRAFT_EXHAUST_LAYER))) return;
      const material = object.material;
      if (!(material instanceof ShaderMaterial) || !material.uniforms.opaqueDepth) return;
      material.uniforms.opaqueDepth.value = this.#depth;
      material.uniforms.viewportSize.value.copy(this.#size);
      material.uniforms.clipOpaque.value = 1;
      count++;
    });
    if (count === 0) return;
    const mask = this.camera.layers.mask, background = this.scene.background;
    const autoClear = renderer.autoClear, shadowAutoUpdate = renderer.shadowMap.autoUpdate;
    const target = renderer.getRenderTarget();
    try {
      this.camera.layers.set(SPACECRAFT_EXHAUST_LAYER);
      this.scene.background = null; renderer.autoClear = false; renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(input);
      renderer.render(this.scene, this.camera);
    } finally {
      this.camera.layers.mask = mask; this.scene.background = background;
      renderer.autoClear = autoClear; renderer.shadowMap.autoUpdate = shadowAutoUpdate;
      renderer.setRenderTarget(target);
    }
  }
}
