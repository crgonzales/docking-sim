import type { CloudLightQuality } from './clouds/cloudLightVolumeLayout';
import { resolveCloudSystem, type CloudSystemSelection } from './clouds/cloudSystemSelection';

/** Normal play renders medium cloud quality; `quality=low` is the explicit budget override. */
export function resolveCloudQuality(value: string | null | undefined): CloudLightQuality {
  return value === 'low' ? 'low' : 'medium';
}

/** Numeric diagnostics: missing, empty or non-numeric values use the default; numbers are clamped. */
export function resolveBoundedNumber(value: string | null | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === null || value === undefined || value.trim() === '' ? Number.NaN : Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
}

export interface RenderProbeConfig {
  readonly renderProbe: boolean;
  readonly profile: boolean;
  readonly clouds: boolean;
  readonly dpr: number;
  readonly exposure: number;
  readonly quality: CloudLightQuality;
  readonly weather: 'demo' | 'global';
  readonly weatherStructure: 'structured' | 'legacy';
  readonly waterReflections: boolean;
}

// One photographic exposure for the entire game, including spacecraft. The
// brighter presentation is art direction; it does not alter cloud density.
export const DEFAULT_EXPOSURE = 2;
// Library full-screen buffers follow canvas DPR, so normal play pins the
// measured pixel budget instead of silently tripling work on Retina.
export const DEFAULT_RENDER_DPR = 1;

/**
 * Resolve every query-driven render setting from one search string (testable
 * without a window). The library atmosphere pipeline with our volumetric
 * weather is the only renderer; there is no query switch back to the retired
 * v0.8.0 renderer. Missing, empty and unknown values resolve to normal play.
 */
export function resolveRenderProbeConfig(search: string): RenderProbeConfig {
  const query = new URLSearchParams(search);
  return {
    renderProbe: query.get('probe') === '1',
    /** Phase 1 profiling is deliberately opt-in; normal flights add no timers. */
    profile: query.get('profile') === '1',
    clouds: query.get('clouds') !== '0',
    dpr: resolveBoundedNumber(query.get('dpr'), DEFAULT_RENDER_DPR, 0.5, 1.75),
    exposure: resolveBoundedNumber(query.get('exposure'), DEFAULT_EXPOSURE, 0.01, 10),
    quality: resolveCloudQuality(query.get('quality')),
    weather: query.get('weather') === 'demo' ? 'demo' : 'global',
    // The structured candidate still needs orbital art acceptance; keep A/B explicit.
    weatherStructure: query.get('weatherStructure') === 'structured' ? 'structured' : 'legacy',
    waterReflections: query.get('water') !== 'diffuse',
  };
}

export interface LibraryEffectsSelectionInput {
  readonly cloudSystem?: CloudSystemSelection;
  readonly quality?: CloudLightQuality;
  readonly exposure?: number;
  readonly dpr?: number;
}

export interface LibraryEffectsSelection {
  readonly cloudSystem: CloudSystemSelection;
  readonly quality: CloudLightQuality;
  readonly exposure: number;
  readonly dpr: number;
}

/** Explicit props (FLIGHT) win; otherwise the URL selector and the shared query defaults apply. */
export function resolveLibraryEffectsSelection(
  props: LibraryEffectsSelectionInput, search: string, defaults: Pick<RenderProbeConfig, 'quality' | 'exposure' | 'dpr'>,
): LibraryEffectsSelection {
  const query = new URLSearchParams(search);
  return {
    cloudSystem: resolveCloudSystem(props.cloudSystem ?? query.get('cloudSystem')),
    quality: props.quality ?? defaults.quality,
    exposure: props.exposure ?? defaults.exposure,
    dpr: props.dpr ?? defaults.dpr,
  };
}
