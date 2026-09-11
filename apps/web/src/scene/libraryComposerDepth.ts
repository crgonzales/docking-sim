import { Source, type Texture } from 'three';
import type { EffectComposer } from 'postprocessing';

/** postprocessing 6.39 clones its three depth textures. Three r170 shares a
 * cloned Texture's Source and therefore its GPU storage. The supposedly stable
 * sampled depth then aliases the render attachment: blits/draws are rejected.
 * Detach storage BEFORE first GPU use, retaining the texture objects already
 * borrowed by the passes. Resize and disposal remain composer-owned.
 */
export function isolateComposerDepthStorage(composer: EffectComposer): void {
  // This getter is present in the installed runtime but omitted by its types.
  const stable = (composer as unknown as { stableDepthTexture?: Texture | null }).stableDepthTexture;
  const textures = [composer.inputBuffer.depthTexture, composer.outputBuffer.depthTexture, stable];
  const seen = new Set<Source>();
  for (const texture of textures) {
    if (!texture) continue;
    if (seen.has(texture.source)) {
      texture.source = new Source({ ...texture.image });
      texture.needsUpdate = true;
    }
    seen.add(texture.source);
  }
}
