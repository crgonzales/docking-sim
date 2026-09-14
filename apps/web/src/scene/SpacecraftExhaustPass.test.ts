import { describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Color, Mesh, PerspectiveCamera, Scene, ShaderMaterial, Texture, Vector2,
  WebGLRenderTarget, type WebGLRenderer } from 'three';
import { SpacecraftExhaustPass, SPACECRAFT_EXHAUST_LAYER } from './SpacecraftExhaustPass';

describe('spacecraft emission composition', () => {
  it('borrows opaque depth, composites only exhaust, and restores renderer state even on failure', () => {
    const scene = new Scene(), camera = new PerspectiveCamera();
    const background = new Color('blue'); scene.background = background;
    camera.layers.enable(3); const mask = camera.layers.mask;
    const geometry = new BufferGeometry(), depth = new Texture();
    const material = new ShaderMaterial({ uniforms: { opaqueDepth: { value: null },
      viewportSize: { value: new Vector2() }, clipOpaque: { value: 0 } } });
    const jet = new Mesh(geometry, material); jet.layers.set(SPACECRAFT_EXHAUST_LAYER); scene.add(jet);
    const input = new WebGLRenderTarget(127, 93), previous = new WebGLRenderTarget(1, 1);
    let target = previous;
    const stub = { autoClear: true, shadowMap: { autoUpdate: true },
      getRenderTarget: () => target, setRenderTarget: (value: WebGLRenderTarget) => { target = value; },
      render: vi.fn(() => {
        expect(target).toBe(input); expect(camera.layers.mask).toBe(1 << SPACECRAFT_EXHAUST_LAYER);
        expect(scene.background).toBeNull(); expect(stub.autoClear).toBe(false);
        expect(stub.shadowMap.autoUpdate).toBe(false);
        expect(material.uniforms.opaqueDepth.value).toBe(depth);
        expect(material.uniforms.viewportSize.value.toArray()).toEqual([127, 93]);
        throw new Error('render interrupted');
      }) };
    const pass = new SpacecraftExhaustPass(scene, camera); pass.setDepthTexture(depth);
    const disposeDepth = vi.spyOn(depth, 'dispose');
    try {
      expect(() => pass.render(stub as unknown as WebGLRenderer, input)).toThrow('render interrupted');
      expect(target).toBe(previous); expect(camera.layers.mask).toBe(mask);
      expect(scene.background).toBe(background); expect(stub.autoClear).toBe(true);
      expect(stub.shadowMap.autoUpdate).toBe(true);
      jet.visible = false; stub.render.mockClear(); pass.render(stub as unknown as WebGLRenderer, input);
      expect(stub.render).not.toHaveBeenCalled();
      pass.dispose(); expect(disposeDepth).not.toHaveBeenCalled();
    } finally { material.dispose(); geometry.dispose(); depth.dispose(); input.dispose(); previous.dispose(); }
  });
});
