// Query-driven render settings. Defaults are normal play (library atmosphere
// pipeline, volumetric weather, medium quality, DPR 1, exposure 2); the
// remaining switches are research diagnostics that stay opt-in. Resolution
// logic lives in renderSelection.ts so it can be tested without a window.
import { resolveRenderProbeConfig } from './renderSelection';

const config = resolveRenderProbeConfig(typeof window === 'undefined' ? '' : window.location.search);
/**
 * The library pipeline is the only renderer. The v0.8.0 renderer is retired
 * and no longer selectable; consumers that still branch on this constant keep
 * their library path and their legacy branch is dead code pending removal.
 */
export const LIBRARY_RENDERER = true;
export const RENDER_PROBE = config.renderProbe;
export const PROBE_PROFILE = config.profile;
export const PROBE_CLOUDS = config.clouds;
export const PROBE_DPR = config.dpr;
export const PROBE_EXPOSURE = config.exposure;
export const PROBE_QUALITY = config.quality;
export const PROBE_WEATHER = config.weather;
export const PROBE_WEATHER_STRUCTURE = config.weatherStructure;
export const PROBE_WATER_REFLECTIONS = config.waterReflections;
