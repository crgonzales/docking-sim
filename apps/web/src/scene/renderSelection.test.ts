import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPOSURE, DEFAULT_RENDER_DPR,
  resolveBoundedNumber, resolveCloudQuality, resolveLibraryEffectsSelection, resolveRenderProbeConfig,
} from './renderSelection';
import { PROBE_DPR, PROBE_EXPOSURE, PROBE_QUALITY } from './renderProbeConfig';

describe('render selection resolvers', () => {
  it.each([null, undefined, '', 'medium', 'high', 'unknown'])('defaults %s cloud quality to medium', value => {
    expect(resolveCloudQuality(value)).toBe('medium');
  });
  it('honours the explicit low quality override', () => {
    expect(resolveCloudQuality('low')).toBe('low');
  });
  it('falls back for missing, empty and non-numeric numbers and clamps real ones', () => {
    expect(resolveBoundedNumber(null, 1, 0.5, 1.75)).toBe(1);
    expect(resolveBoundedNumber('', 1, 0.5, 1.75)).toBe(1);
    expect(resolveBoundedNumber('abc', 1, 0.5, 1.75)).toBe(1);
    expect(resolveBoundedNumber('3', 1, 0.5, 1.75)).toBe(1.75);
    expect(resolveBoundedNumber('0.25', 1, 0.5, 1.75)).toBe(0.5);
    expect(resolveBoundedNumber('1.5', 1, 0.5, 1.75)).toBe(1.5);
  });
});

describe('bare entry configuration consumed by SceneRoot', () => {
  it('opens ordinary play at medium quality, DPR 1 and exposure 2 with diagnostics off', () => {
    expect(resolveRenderProbeConfig('')).toEqual({
      renderProbe: false, profile: false, clouds: true,
      dpr: DEFAULT_RENDER_DPR, exposure: DEFAULT_EXPOSURE, quality: 'medium',
      weather: 'global', weatherStructure: 'legacy', waterReflections: true,
    });
  });
  it('treats mission entry, empty selectors and retired renderer selectors like the bare URL', () => {
    const bare = resolveRenderProbeConfig('');
    expect(resolveRenderProbeConfig('?mode=mission')).toEqual(bare);
    expect(resolveRenderProbeConfig('?renderer=&cloudSystem=&quality=&dpr=&exposure=')).toEqual(bare);
    expect(resolveRenderProbeConfig('?renderer=legacy')).toEqual(bare);
    expect(resolveRenderProbeConfig('?renderer=library&cloudSystem=volumetric&quality=medium&dpr=1&exposure=2')).toEqual(bare);
  });
  it('keeps diagnostics opt-in and honours explicit overrides', () => {
    expect(resolveRenderProbeConfig('?probe=1&profile=1&clouds=0&quality=low&dpr=1.5&exposure=0.7&weather=demo&weatherStructure=structured&water=diffuse')).toEqual({
      renderProbe: true, profile: true, clouds: false, quality: 'low', dpr: 1.5, exposure: 0.7,
      weather: 'demo', weatherStructure: 'structured', waterReflections: false,
    });
  });
  it('exposes the same defaults through the module constants SceneRoot and LibraryEffects import', () => {
    expect(PROBE_DPR).toBe(DEFAULT_RENDER_DPR);
    expect(PROBE_EXPOSURE).toBe(DEFAULT_EXPOSURE);
    expect(PROBE_QUALITY).toBe('medium');
  });
});

describe('LibraryEffects selection', () => {
  const defaults = resolveRenderProbeConfig('');
  it('selects the volumetric weather system at medium quality, exposure 2 and DPR 1 for the bare URL', () => {
    expect(resolveLibraryEffectsSelection({}, '', defaults)).toEqual({ cloudSystem: 'volumetric', quality: 'medium', exposure: 2, dpr: 1 });
  });
  it.each(['', '?cloudSystem=', '?cloudSystem=unknown', '?cloudSystem=eve', '?cloudSystem=volumetric'])('resolves %s to the volumetric system', search => {
    expect(resolveLibraryEffectsSelection({}, search, defaults).cloudSystem).toBe('volumetric');
  });
  it('keeps the earlier library cloud backend as an explicit comparison override', () => {
    expect(resolveLibraryEffectsSelection({}, '?cloudSystem=legacy', defaults).cloudSystem).toBe('legacy');
  });
  it('lets FLIGHT-style explicit props win over the URL and defaults', () => {
    const flight = resolveLibraryEffectsSelection({ cloudSystem: 'volumetric', quality: 'low', exposure: 2, dpr: 1.5 },
      '?cloudSystem=legacy&quality=medium&dpr=1', resolveRenderProbeConfig('?quality=medium&dpr=1'));
    expect(flight).toEqual({ cloudSystem: 'volumetric', quality: 'low', exposure: 2, dpr: 1.5 });
  });
  it('applies the shared query defaults when props are absent', () => {
    expect(resolveLibraryEffectsSelection({}, '?quality=low&dpr=1.25&exposure=1.5', resolveRenderProbeConfig('?quality=low&dpr=1.25&exposure=1.5')))
      .toEqual({ cloudSystem: 'volumetric', quality: 'low', exposure: 1.5, dpr: 1.25 });
  });
});
