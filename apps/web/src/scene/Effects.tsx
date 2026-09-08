import { useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, ToneMapping } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';

/** One tone-mapping selection shared by the composer and the post-composer PiP. */
export const FRAME_TONE_MAPPING = {
  mode: ToneMappingMode.ACES_FILMIC,
  function: 'ACESFilmicToneMapping',
} as const;

interface EffectsProps {
  readonly exposureRef: { readonly current: number };
}

function FrameExposureUniform({ exposureRef }: EffectsProps) {
  const { gl } = useThree();

  useFrame(() => {
    // `gl.toneMappingExposure` is the only channel into the ACES curve:
    // postprocessing's tone-mapping shader pulls in three's
    // <tonemapping_pars_fragment>, whose ACESFilmicToneMapping multiplies by
    // that uniform, and ToneMappingEffect exposes no exposure option of its
    // own. Three pushes the uniform in setProgram only when it refreshes a
    // material, which holds here because scene geometry is always drawn
    // between composer passes — so the effect material is re-bound, and
    // refreshed, every frame. Worth knowing if the render graph ever changes.
    gl.toneMappingExposure = exposureRef.current;
  });

  return null;
}

/**
 * Post-processing stack. Shaders emit scene-referred radiance normalized to
 * top-of-atmosphere solar irradiance 1.0. Bloom therefore operates on that
 * radiance at its luminance-1.0 threshold, and the frame exposure plus ACES
 * tonemap are applied exactly once here. Half-resolution keeps the existing
 * integrated-GPU budget.
 */
export function Effects({ exposureRef }: EffectsProps) {
  return (
    <>
      <FrameExposureUniform exposureRef={exposureRef} />
      <EffectComposer resolutionScale={0.5}>
        <Bloom
          luminanceThreshold={1.0}
          luminanceSmoothing={0.15}
          intensity={0.9}
          mipmapBlur
        />
        <ToneMapping mode={FRAME_TONE_MAPPING.mode} />
      </EffectComposer>
    </>
  );
}
