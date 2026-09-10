// Isolated research switches; these are not part of the production interface.
const query = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
export const LIBRARY_RENDERER = query.get('renderer') === 'library';
export const RENDER_PROBE = query.get('probe') === '1';
/** Phase 1 profiling is deliberately opt-in; normal flights add no timers. */
export const PROBE_PROFILE = query.get('profile') === '1';
export const PROBE_CLOUDS = query.get('clouds') !== '0';
export const PROBE_DPR = Math.max(0.5, Math.min(1.75, Number(query.get('dpr') ?? '1')));
// One photographic exposure for the entire prototype, including spacecraft.
// The brighter presentation is art direction; it does not alter cloud density.
export const PROBE_EXPOSURE = Math.max(0.01, Math.min(10, Number(query.get('exposure') ?? (LIBRARY_RENDERER ? '2' : '1'))));

export const PROBE_QUALITY = query.get('quality') === 'medium' ? 'medium' : 'low';

export const PROBE_WEATHER = query.get('weather') === 'demo' ? 'demo' : 'global';
// The structured candidate still needs orbital art acceptance; keep A/B explicit.
export const PROBE_WEATHER_STRUCTURE = query.get('weatherStructure') === 'structured' ? 'structured' : 'legacy';
export const PROBE_WATER_REFLECTIONS = query.get('water') !== 'diffuse';
