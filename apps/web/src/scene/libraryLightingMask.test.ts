import { describe, expect, it } from 'vitest';
import { AerialPerspectiveEffect, LightingMaskPass } from '@takram/three-atmosphere';
import type { DepthMaskMaterial } from 'postprocessing';
import { PerspectiveCamera, Scene, Texture } from 'three';
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
