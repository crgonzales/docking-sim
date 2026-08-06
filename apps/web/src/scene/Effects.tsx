import { Bloom, EffectComposer } from '@react-three/postprocessing';

/**
 * Post-processing stack. HDR contract (see plan §4): bloom threshold sits at
 * luminance 1.0; only outputs pushed above 1.0 (night city lights, sun
 * glints — see Earth.tsx gains) bloom. Day albedo and the clamped starfield
 * stay below the threshold by construction. Half-resolution for the
 * integrated-GPU budget.
 */
export function Effects() {
  return (
    <EffectComposer resolutionScale={0.5}>
      <Bloom
        luminanceThreshold={1.0}
        luminanceSmoothing={0.15}
        intensity={0.9}
        mipmapBlur
      />
    </EffectComposer>
  );
}
