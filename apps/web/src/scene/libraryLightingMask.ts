import { LightingMaskPass } from '@takram/three-atmosphere';
import type { DepthMaskMaterial } from 'postprocessing';

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
  constructor(...args: ConstructorParameters<typeof LightingMaskPass>) {
    super(...args);
    // This shader is private in the pinned release. Validate its packing and
    // unique source seam before adapting; never silently patch another ABI.
    const material = (this as unknown as { depthMaskMaterial: DepthMaskMaterial }).depthMaskMaterial;
    if (!material || Number(material.defines.DEPTH_PACKING_0) !== 3201 || Number(material.defines.DEPTH_PACKING_1) !== 3201) {
      throw new Error('Pinned lighting mask packing changed; review depth comparison');
    }
    material.fragmentShader = stableLightingMaskDepth(material.fragmentShader);
    material.needsUpdate = true;
  }
}
