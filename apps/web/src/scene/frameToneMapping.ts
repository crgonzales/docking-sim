import { ToneMappingMode } from 'postprocessing';

/**
 * One tone-mapping selection shared by the library composer and the
 * post-composer docking-camera PiP, which re-applies the same curve to its
 * own render target so both views agree.
 */
export const FRAME_TONE_MAPPING = {
  mode: ToneMappingMode.ACES_FILMIC,
  function: 'ACESFilmicToneMapping',
} as const;
