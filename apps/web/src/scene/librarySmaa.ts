import { EdgeDetectionMode, SMAAEffect, SMAAPreset } from 'postprocessing';

export type SceneSmaaPreset = 'medium' | 'high';

/** postprocessing 6.39.4's COLOR detector directly samples the linear composer
 * buffer in update(), before mainImage/inputColorSpace conversion can run.
 * Encode ONLY its seven color taps. Neighborhood blending stays linear and the
 * final EffectPass still performs the sole display encoding. No extra target.
 */
export function perceptualSmaaEdges(source: string): string {
  const marker = 'sceneSmaaPerceptualColor';
  const sample = /texture2D\(inputBuffer,\s*(vUv[0-5]?)\)\.rgb/g;
  // Seven taps in each of the installed luma/color preprocessor branches.
  if (source.includes(marker) || [...source.matchAll(sample)].length !== 14 || source.split('void main(){').length !== 2) {
    throw new Error('Pinned SMAA edge shader changed; review color-space adapter');
  }
  source = source.replace(sample, `${marker}(texture2D(inputBuffer,$1).rgb)`);
  return source.replace('void main(){', `
vec3 ${marker}(const vec3 linearColor) {
  vec3 c = max(linearColor, vec3(0.0));
  return mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, 12.92 * c,
    lessThanEqual(c, vec3(0.0031308)));
}
void main(){`);
}

/** High is the spacecraft default at every DPR. Explicit flight/user medium
 * retains its eight-step search and disabled diagonal/corner detection.
 */
export function createSceneSmaa(preset: SceneSmaaPreset = 'high'): SMAAEffect {
  const effect = new SMAAEffect({
    preset: preset === 'high' ? SMAAPreset.HIGH : SMAAPreset.MEDIUM,
    edgeDetectionMode: EdgeDetectionMode.COLOR,
  });
  effect.edgeDetectionMaterial.fragmentShader = perceptualSmaaEdges(effect.edgeDetectionMaterial.fragmentShader);
  effect.edgeDetectionMaterial.needsUpdate = true;
  return effect;
}

export function sceneSmaaReady(effect?: SMAAEffect): boolean {
  return effect != null && effect.weightsMaterial.searchTexture != null && effect.weightsMaterial.areaTexture != null;
}

/** Installed 6.39.4 dispatches `load` after both lookup textures are assigned,
 * but its declarations only expose Effect's `change` event. Keep that verified
 * runtime/declaration mismatch local instead of widening the effect's type.
 */
export function onSceneSmaaLoad(effect: SMAAEffect, listener: () => void): () => void {
  const events = effect as unknown as {
    addEventListener(type: 'load', listener: () => void): void;
    removeEventListener(type: 'load', listener: () => void): void;
  };
  events.addEventListener('load', listener);
  return () => events.removeEventListener('load', listener);
}
