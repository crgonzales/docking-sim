import { describe, expect, it, vi } from 'vitest';
import { EffectPass, SMAAEffect, SMAAPreset } from 'postprocessing';
import { Color, HalfFloatType, LinearSRGBColorSpace, NoColorSpace, PerspectiveCamera, SRGBColorSpace,
  Texture, WebGLRenderTarget, type WebGLRenderer } from 'three';
import { createSceneSmaa, onSceneSmaaLoad, perceptualSmaaEdges, sceneSmaaReady } from './librarySmaa';

describe('scene SMAA integration', () => {
  it('subscribes to and releases the installed runtime lookup-load event', () => {
    const effect = createSceneSmaa(), loaded = vi.fn();
    const remove = onSceneSmaaLoad(effect, loaded);
    // Exercise Three's real dispatcher; postprocessing omits this event in its declarations.
    const events = effect as unknown as { dispatchEvent(event: { type: 'load' }): void };
    try {
      events.dispatchEvent({ type: 'load' });
      expect(loaded).toHaveBeenCalledTimes(1);
      remove(); remove();
      events.dispatchEvent({ type: 'load' });
      expect(loaded).toHaveBeenCalledTimes(1);
    } finally { remove(); effect.dispose(); }
  });

  it('changes only the detector, retaining the installed linear blending and preset controls', () => {
    const stock = new SMAAEffect({ preset: SMAAPreset.HIGH }), fixed = createSceneSmaa();
    try {
      expect(fixed.getFragmentShader()).toBe(stock.getFragmentShader());
      expect(fixed.getVertexShader()).toBe(stock.getVertexShader());
      expect(fixed.inputColorSpace).toBe(LinearSRGBColorSpace);
      expect(fixed.outputColorSpace).toBe(NoColorSpace);
      expect(fixed.blendMode.blendFunction).toBe(stock.blendMode.blendFunction);
      expect(fixed.weightsMaterial.diagonalDetection).toBe(true);
      expect(fixed.weightsMaterial.cornerDetection).toBe(true);
      const shader = fixed.edgeDetectionMaterial.fragmentShader;
      fixed.applyPreset(SMAAPreset.MEDIUM);
      expect(fixed.weightsMaterial.diagonalDetection).toBe(false);
      expect(fixed.weightsMaterial.orthogonalSearchSteps).toBe(8);
      expect(fixed.edgeDetectionMaterial.fragmentShader).toBe(shader);
      expect(() => perceptualSmaaEdges(shader)).toThrow('Pinned SMAA');
      expect(() => perceptualSmaaEdges('void main(){}')).toThrow('Pinned SMAA');
    } finally { stock.dispose(); fixed.dispose(); }
  });

  it('executes the installed edge/weight/blend passes against the original buffer after resizing', () => {
    const effect = createSceneSmaa('medium'), pass = new EffectPass(new PerspectiveCamera(), effect);
    const input = new WebGLRenderTarget(45, 35, { type: HalfFloatType }), output = input.clone();
    const draws: { name: string; input: unknown }[] = [];
    const renderer = {
      getClearColor: (c: Color) => c.set(0), getClearAlpha: () => 1,
      setClearColor() {}, setClearAlpha() {}, clear() {}, setRenderTarget: vi.fn(),
      render(scene: { children: { material: { name: string; uniforms: Record<string, { value: unknown }> } }[] }) {
        const material = scene.children[0].material;
        draws.push({ name: material.name, input: material.uniforms.inputBuffer?.value });
      },
    } as unknown as WebGLRenderer;
    try {
      pass.initialize(renderer, true, HalfFloatType); pass.setSize(45, 35);
      pass.render(renderer, input, output, 0, false);
      expect(draws.map(d => d.name)).toEqual(['EdgeDetectionMaterial', 'SMAAWeightsMaterial', 'EffectMaterial']);
      expect(draws[0].input).toBe(input.texture);
      expect(draws[1].input).toBe(effect.edgesTexture);
      expect(draws[2].input).toBe(input.texture);
      expect(effect.uniforms.get('weightMap')!.value).toBe(effect.weightsTexture);
      expect(effect.edgesTexture.image).toMatchObject({ width: 45, height: 35 });
      expect(effect.weightsTexture.image).toMatchObject({ width: 45, height: 35 });
      expect(pass.needsSwap).toBe(true); expect(pass.enabled).toBe(true); expect(pass.encodeOutput).toBe(true);
      expect(sceneSmaaReady(effect)).toBe(false);
      effect.weightsMaterial.areaTexture = new Texture(); effect.weightsMaterial.searchTexture = new Texture();
      expect(sceneSmaaReady(effect)).toBe(true);
    } finally { pass.dispose(); input.dispose(); output.dispose(); }
  });

  it('establishes the dark-trunk regression input using Three’s color transform, independently of GLSL text', () => {
    const dark = new Color().setRGB(3 / 255, 3 / 255, 11 / 255, SRGBColorSpace);
    const ocean = new Color().setRGB(33 / 255, 44 / 255, 72 / 255, SRGBColorSpace);
    const delta = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    expect(delta(dark.toArray(), ocean.toArray())).toBeCloseTo(0.0614567, 6);
    expect(delta(dark.toArray(), ocean.toArray())).toBeLessThan(0.1);
    // Three's CPU transfer uses rounded coefficients (a few parts per million).
    expect(delta(dark.clone().convertLinearToSRGB().toArray(), ocean.clone().convertLinearToSRGB().toArray())).toBeCloseTo(61 / 255, 5);
    // Actual edge/weight readback and linear blend checks live in SceneSmaaFixture.
  });
});
