import { describe, expect, it, vi } from 'vitest';
import { AerialPerspectiveEffect, LightingMaskPass } from '@takram/three-atmosphere';
import type { DepthMaskMaterial } from 'postprocessing';
import { BackSide, BufferGeometry, Color, DoubleSide, FrontSide, Mesh, MeshBasicMaterial,
  PerspectiveCamera, Scene, Texture, type ColorRepresentation, type WebGLRenderer } from 'three';
import { stableLightingMaskDepth, StableLightingMaskPass } from './libraryLightingMask';
import { CAMERA_NEAR, CAMERA_FAR } from './sky/skyConfig';

const f = Math.fround;
// Installed perspectiveDepthToViewZ followed by viewZToOrthographicDepth.
function oldComparisonDepth(depth: number) {
  const near = f(CAMERA_NEAR), far = f(CAMERA_FAR);
  const viewZ = f(f(near * far) / f(f(f(far - near) * depth) - far));
  return f(f(viewZ + near) / f(near - far));
}
const shaderMaterial = (pass: LightingMaskPass) =>
  (pass as unknown as { depthMaskMaterial: DepthMaskMaterial }).depthMaskMaterial;

describe('lighting exclusion surface coverage', () => {
  it.each(['none', 'clear', 'draw'])('preserves material groups, selection, and caller state after %s failure', failure => {
    const scene = new Scene(), camera = new PerspectiveCamera();
    camera.layers.enable(7);
    const sources = [FrontSide, BackSide, DoubleSide].map(side => new MeshBasicMaterial({ side }));
    sources.push(new MeshBasicMaterial({ transparent: true, depthWrite: false }), new MeshBasicMaterial({ visible: false }));
    const geometry = new BufferGeometry();
    sources.forEach((_, i) => geometry.addGroup(i * 3, 3, i));
    const mesh = new Mesh(geometry, sources), unselected = new Mesh(geometry, sources[0]);
    scene.add(mesh, unselected);
    const pass = new StableLightingMaskPass(scene, camera);
    pass.selection.add(mesh);
    scene.overrideMaterial = sources[0]; scene.background = new Color(0x123456);
    const background = scene.background, cameraMask = camera.layers.mask, meshMask = mesh.layers.mask;
    const color = new Color(0x654321), savedColor = color.clone(); let alpha = 0.3;
    const draw = vi.fn((drawScene: Scene, drawCamera: PerspectiveCamera) => {
      if (drawScene !== scene) return;
      expect(drawCamera).toBe(camera); expect(camera.layers.mask).toBe(1 << pass.selectionLayer);
      expect(scene.overrideMaterial).toBeNull(); expect(scene.background).toBeNull();
      expect(mesh.material).not.toBe(sources);
      expect(mesh.material.map(m => m.side)).toEqual(sources.map(m => m.side));
      expect(mesh.material.map(m => m.visible)).toEqual([true, true, true, false, false]);
      expect(unselected.material).toBe(sources[0]);
      if (failure === 'draw' && first) { first = false; throw new Error('draw failed'); }
    });
    let first = true;
    const stub = {
      autoClear: true, shadowMap: { enabled: true, autoUpdate: true },
      getClearColor: (target: Color) => target.copy(color), getClearAlpha: () => alpha,
      setClearColor: (value: ColorRepresentation, a?: number) => { color.set(value); if (a !== undefined) alpha = a; },
      setClearAlpha: (a: number) => { alpha = a; }, setRenderTarget: vi.fn(), render: draw,
      clear: () => { if (failure === 'clear' && first) { first = false; throw new Error('clear failed'); } },
    };
    const render = () => pass.render(stub as unknown as WebGLRenderer, null, null);
    try {
      if (failure === 'none') render(); else expect(render).toThrow(`${failure} failed`);
      expect(mesh.material).toBe(sources); expect(unselected.material).toBe(sources[0]);
      expect(scene.overrideMaterial).toBe(sources[0]); expect(scene.background).toBe(background);
      expect(camera.layers.mask).toBe(cameraMask); expect(mesh.layers.mask).toBe(meshMask);
      expect(stub.autoClear).toBe(true); expect(stub.shadowMap).toEqual({ enabled: true, autoUpdate: true });
      expect(color).toEqual(savedColor); expect(alpha).toBe(0.3);
      sources[0].side = BackSide;
      render();
      expect(mesh.material).toBe(sources);
      expect(pass.selection.has(mesh)).toBe(true);
    } finally { pass.dispose(); geometry.dispose(); sources.forEach(m => m.dispose()); }
  });

  it('follows scene/camera changes and releases cached replacements/listeners exactly once', () => {
    const pass = new StableLightingMaskPass(new Scene(), new PerspectiveCamera());
    const scene = new Scene(), camera = new PerspectiveCamera(), source = new MeshBasicMaterial({ side: DoubleSide });
    const geometry = new BufferGeometry(), mesh = new Mesh(geometry, source); scene.add(mesh);
    pass.mainScene = scene; pass.mainCamera = camera; pass.selection.add(mesh);
    const add = vi.spyOn(source, 'addEventListener'), remove = vi.spyOn(source, 'removeEventListener');
    let active!: MeshBasicMaterial;
    const renderer = {
      autoClear: true, shadowMap: { enabled: true, autoUpdate: true },
      getClearColor: (c: Color) => c.set(0), getClearAlpha: () => 1,
      setClearColor() {}, setClearAlpha() {}, setRenderTarget() {}, clear() {},
      render(s: Scene, c: PerspectiveCamera) { if (s === scene) { expect(c).toBe(camera); active = mesh.material; } },
    } as unknown as WebGLRenderer;
    try {
      pass.render(renderer, null, null); const original = active;
      const dispose = vi.spyOn(original, 'dispose');
      pass.render(renderer, null, null); expect(active).toBe(original); expect(add).toHaveBeenCalledTimes(1);
      source.dispose(); source.dispose(); expect(dispose).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
      pass.render(renderer, null, null); expect(active).not.toBe(original);
      const nextDispose = vi.spyOn(active, 'dispose'), sourceDispose = vi.spyOn(source, 'dispose');
      pass.dispose(); pass.dispose();
      expect(nextDispose).toHaveBeenCalledTimes(1); expect(sourceDispose).not.toHaveBeenCalled();
      expect(remove).toHaveBeenCalledTimes(2); expect(mesh.material).toBe(source);
    } finally { pass.dispose(); geometry.dispose(); source.dispose(); }
  });
});

describe('mixed-lighting mask at planetary depth ranges', () => {
  it('keeps terrain unmasked when no selected object covers it, including cleared depth', () => {
    expect(oldComparisonDepth(1)).toBe(-Infinity);
    for (const distance of [50, 3000, 20000, 400000, 12000000]) {
      const depth = f(Math.log2(distance + 1) / Math.log2(CAMERA_FAR + 1));
      expect(oldComparisonDepth(depth) >= oldComparisonDepth(1)).toBe(true); // Bug.
      expect(depth >= 1).toBe(false); // No object in the exclusion pass.
      const objectInFront = f(Math.log2(distance * 0.5 + 1) / Math.log2(CAMERA_FAR + 1));
      const objectBehind = f(Math.log2(distance * 2 + 1) / Math.log2(CAMERA_FAR + 1));
      expect(depth >= objectInFront).toBe(true);
      expect(depth >= objectBehind).toBe(false);
      expect(depth >= depth).toBe(true); // The selected object's visible pixel.
    }
  });

  it('adapts the installed shader while preserving selection and inversion behavior', () => {
    const camera = new PerspectiveCamera(45, 1, CAMERA_NEAR, CAMERA_FAR);
    const original = new LightingMaskPass(new Scene(), camera);
    const fixed = new StableLightingMaskPass(new Scene(), camera);
    try {
      expect(shaderMaterial(fixed).fragmentShader).toBe(stableLightingMaskDepth(shaderMaterial(original).fragmentShader));
      expect(shaderMaterial(fixed).defines['depthTest(d0, d1)']).toBe('d0 >= d1');
      expect(shaderMaterial(fixed).fragmentShader).toContain('bool isMaxDepth = depth.x == 1.0;');
      expect(shaderMaterial(fixed).fragmentShader).toContain('keep = !keep;');
      expect(fixed.inverted).toBe(false);
      expect(() => stableLightingMaskDepth(shaderMaterial(fixed).fragmentShader)).toThrow('Pinned lighting mask changed');
    } finally { original.dispose(); fixed.dispose(); }
  });

  it('uses the normal-buffer setter to enable the pinned effect’s normals feature', () => {
    const texture = new Texture();
    const effect = new AerialPerspectiveEffect(new PerspectiveCamera(), { normalBuffer: texture });
    try {
      expect(effect.hasNormals).toBe(false); // Constructor stores the uniform only.
      effect.normalBuffer = texture;
      expect(effect.hasNormals).toBe(true);
      expect(effect.defines.has('HAS_NORMALS')).toBe(true);
    } finally { effect.dispose(); texture.dispose(); }
  });
});
