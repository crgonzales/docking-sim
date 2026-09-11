import { describe, expect, it } from 'vitest';
import {
  FLIGHT_GRAPHICS_STORAGE_KEY, readFlightGraphicsPreset, resolveFlightGraphics,
  resolveFlightRenderSize, writeFlightGraphicsPreset,
} from './flightGraphics';

const hardware = { maxTextureSize: 4096, maxAnisotropy: 16 };
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return { getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); } } as Storage;
}

describe('flight graphics selection', () => {
  it('defaults to Balanced and persists choices, with explicit links taking precedence', () => {
    const storage = memoryStorage();
    expect(resolveFlightGraphics('', { storage }).preset).toBe('balanced');
    expect(writeFlightGraphicsPreset('high', storage)).toBe(true);
    expect(readFlightGraphicsPreset(storage)).toBe('high');
    expect(resolveFlightGraphics('', { storage }).source).toBe('storage');
    expect(resolveFlightGraphics('graphics=balanced', { storage }).preset).toBe('balanced');
    expect(resolveFlightGraphics('graphics=invalid', { storage }).preset).toBe('high');
    storage.setItem(FLIGHT_GRAPHICS_STORAGE_KEY, 'invalid');
    expect(resolveFlightGraphics('', { storage }).preset).toBe('balanced');
  });

  it('preserves the frozen fixture unless the user explicitly chooses graphics', () => {
    const storage = memoryStorage(); writeFlightGraphicsPreset('high', storage);
    const legacy = resolveFlightGraphics('', { fixture: true, storage });
    expect(legacy.source).toBe('legacy-fixture');
    expect(legacy.smaa.enabled).toBe(false);
    expect(legacy.dpr).toBe(1);
    expect(resolveFlightGraphics('graphics=high', { fixture: true, storage }).smaa.enabled).toBe(true);
    expect(resolveFlightGraphics('', { fixture: true, selectedPreset: 'balanced', storage }).smaa.enabled).toBe(true);
  });

  it('applies diagnostic overrides after the chosen preset and rejects invalid values', () => {
    const config = resolveFlightGraphics('graphics=high&dpr=1&quality=low&exposure=0.7', { storage: null, hardware });
    expect([config.dpr, config.quality, config.exposure]).toEqual([1, 'low', 0.7]);
    const invalid = resolveFlightGraphics('dpr=NaN&quality=ultra&exposure=Infinity', { storage: null, hardware });
    expect([invalid.dpr, invalid.quality, invalid.exposure]).toEqual([1, 'medium', 2]);
    expect(invalid.diagnosticOverrides).toEqual({ dpr: null, quality: null, exposure: null });
    expect(resolveFlightGraphics('graphics=balanced', { selectedPreset: 'high', storage: null }).preset).toBe('high');
  });

  it('survives unavailable storage', () => {
    const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } as unknown as Storage;
    expect(readFlightGraphicsPreset(storage)).toBeNull();
    expect(writeFlightGraphicsPreset('high', storage)).toBe(false);
    expect(resolveFlightGraphics('', { storage }).preset).toBe('balanced');
  });
});

describe('render allocation limits', () => {
  it('keeps High at least as sharp as Balanced across ordinary and large displays', () => {
    const balanced = resolveFlightGraphics('graphics=balanced', { storage: null, hardware });
    const high = resolveFlightGraphics('graphics=high', { storage: null, hardware });
    for (const [width, height] of [[981, 1115], [1920, 1080], [3840, 2160], [8000, 1000]]) {
      const a = resolveFlightRenderSize(width, height, balanced.dpr, 4096, balanced.scenePixelCap);
      const b = resolveFlightRenderSize(width, height, high.dpr, 4096, high.scenePixelCap);
      expect(b.pixels).toBeGreaterThanOrEqual(a.pixels);
      expect(b.pixels).toBeLessThanOrEqual(2_500_000);
      expect(Math.max(b.width, b.height)).toBeLessThanOrEqual(4096);
    }
    expect(high.cloudPixelCap).toBe(balanced.cloudPixelCap);
    expect(high.composerMultisampling).toBe(0);
    expect(high.canvasAntialias).toBe(false);
    expect(high.anisotropy).toBeGreaterThan(balanced.anisotropy);
  });

  it('returns finite, positive allocation dimensions for invalid requests and weak hardware', () => {
    for (const inputs of [[0, NaN, Infinity, NaN, 0], [800, 600, 2, 256, 1], [100, 100, 1, 64, 0.5]]) {
      const [w, h, dpr, max, cap] = inputs;
      const size = resolveFlightRenderSize(w, h, dpr, max, cap);
      expect([size.width, size.height, size.dpr, size.pixels].every(Number.isFinite)).toBe(true);
      expect(size.width).toBeGreaterThanOrEqual(1);
      expect(size.height).toBeGreaterThanOrEqual(1);
      expect(size.pixels).toBeLessThanOrEqual(size.pixelCap);
    }
    const config = resolveFlightGraphics('graphics=high', { storage: null, hardware: { maxTextureSize: 512, maxAnisotropy: 2 } });
    expect(config.shadowMapSize).toBe(512);
    expect(config.anisotropy).toBe(2);
  });
});
