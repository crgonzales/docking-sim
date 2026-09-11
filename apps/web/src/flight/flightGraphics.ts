export const FLIGHT_GRAPHICS_STORAGE_KEY = 'docking.flight.graphics.v1';
export const FLIGHT_GRAPHICS_PRESETS = ['balanced', 'high'] as const;
export type FlightGraphicsPreset = (typeof FLIGHT_GRAPHICS_PRESETS)[number];
export type FlightSmaaPreset = 'medium' | 'high';
export type FlightCloudQuality = 'low' | 'medium';

export const FLIGHT_CLOUD_PIXEL_CAP = 1_500_000;
export const FLIGHT_HIGH_SCENE_PIXEL_CAP = 2_500_000;
const DEFAULT_MAX_TEXTURE_SIZE = 4096;
const DEFAULT_MAX_ANISOTROPY = 1;
const MIN_DIAGNOSTIC_DPR = 0.5;
const MAX_DIAGNOSTIC_DPR = 1.75;
const MIN_EXPOSURE = 0.01;
const MAX_EXPOSURE = 10;

export interface FlightGraphicsHardware {
  readonly maxTextureSize?: number;
  readonly maxAnisotropy?: number;
}

export interface FlightGraphicsOverrides {
  readonly dpr: number | null;
  readonly quality: FlightCloudQuality | null;
  readonly exposure: number | null;
}

export interface FlightGraphicsConfig {
  readonly preset: FlightGraphicsPreset;
  readonly source: 'query' | 'storage' | 'default' | 'legacy-fixture' | 'ui';
  /** Requested DPR after diagnostic overrides and before viewport pixel caps. */
  readonly dpr: number;
  readonly quality: FlightCloudQuality;
  readonly exposure: number;
  readonly smaa: {
    readonly enabled: boolean;
    readonly preset: FlightSmaaPreset;
  };
  /** Resolved for the current device. */
  readonly shadowMapSize: number;
  /** Resolved for the current device. */
  readonly anisotropy: number;
  readonly requestedAnisotropy: number;
  readonly maxTextureSize: number;
  readonly scenePixelCap: number;
  readonly cloudPixelCap: number;
  readonly canvasAntialias: false;
  readonly composerMultisampling: 0;
  readonly diagnosticOverrides: FlightGraphicsOverrides;
}

export interface FlightRenderSize {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly pixels: number;
  readonly maxTextureSize: number;
  readonly pixelCap: number;
}

interface ResolveFlightGraphicsOptions {
  readonly fixture?: boolean;
  readonly hardware?: FlightGraphicsHardware;
  /** Set only after a user changes the in-flight control. */
  readonly selectedPreset?: FlightGraphicsPreset;
  readonly storage?: Storage | null;
}

interface SelectFlightGraphicsPresetOptions {
  readonly fixture?: boolean;
  readonly storage?: Storage | null;
}

const PRESET_VALUES: Readonly<Record<FlightGraphicsPreset, {
  readonly dpr: number;
  readonly quality: FlightCloudQuality;
  readonly exposure: number;
  readonly smaa: { readonly enabled: boolean; readonly preset: FlightSmaaPreset };
  readonly shadowMapSize: number;
  readonly requestedAnisotropy: number;
  readonly scenePixelCap: number;
}>> = {
  balanced: {
    dpr: 1,
    quality: 'medium',
    exposure: 2,
    smaa: { enabled: true, preset: 'medium' },
    shadowMapSize: 1024,
    requestedAnisotropy: 8,
    scenePixelCap: FLIGHT_HIGH_SCENE_PIXEL_CAP,
  },
  high: {
    dpr: 1.5,
    quality: 'medium',
    exposure: 2,
    smaa: { enabled: true, preset: 'high' },
    shadowMapSize: 2048,
    requestedAnisotropy: 16,
    scenePixelCap: FLIGHT_HIGH_SCENE_PIXEL_CAP,
  },
};

function queryFrom(value?: URLSearchParams | string): URLSearchParams {
  if (value instanceof URLSearchParams) return value;
  return new URLSearchParams(value ?? (typeof window === 'undefined' ? '' : window.location.search));
}

function isPreset(value: string | null): value is FlightGraphicsPreset {
  return value === 'balanced' || value === 'high';
}

function finitePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteInteger(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(finitePositive(value, fallback)));
}

function diagnosticNumber(value: string | null, lo: number, hi: number): number | null {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(lo, Math.min(hi, parsed)) : null;
}

export function readFlightGraphicsPreset(storage?: Storage | null): FlightGraphicsPreset | null {
  let source = storage;
  if (source === undefined && typeof window !== 'undefined') {
    try {
      source = window.localStorage;
    } catch {
      source = null;
    }
  }
  if (source === null || source === undefined) return null;
  try {
    const value = source.getItem(FLIGHT_GRAPHICS_STORAGE_KEY);
    return isPreset(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeFlightGraphicsPreset(preset: FlightGraphicsPreset, storage?: Storage | null): boolean {
  let source = storage;
  if (source === undefined && typeof window !== 'undefined') {
    try {
      source = window.localStorage;
    } catch {
      source = null;
    }
  }
  if (source === null || source === undefined) return false;
  try {
    source.setItem(FLIGHT_GRAPHICS_STORAGE_KEY, preset);
    return true;
  } catch {
    return false;
  }
}

export function selectFlightGraphicsPreset(
  value?: URLSearchParams | string,
  { fixture = false, storage }: SelectFlightGraphicsPresetOptions = {},
): FlightGraphicsPreset {
  const query = queryFrom(value);
  const explicit = query.get('graphics');
  if (isPreset(explicit)) return explicit;
  if (!fixture) return readFlightGraphicsPreset(storage) ?? 'balanced';
  return 'balanced';
}

export function resolveFlightGraphics(
  value?: URLSearchParams | string,
  { fixture = false, hardware, selectedPreset, storage }: ResolveFlightGraphicsOptions = {},
): FlightGraphicsConfig {
  const query = queryFrom(value);
  const explicitQueryPreset = query.get('graphics');
  const storedPreset = fixture ? null : readFlightGraphicsPreset(storage);
  const preset = selectedPreset ?? (isPreset(explicitQueryPreset) ? explicitQueryPreset : storedPreset ?? 'balanced');
  const legacyFixture = fixture && selectedPreset === undefined && !isPreset(explicitQueryPreset);
  const base = PRESET_VALUES[preset];
  const qualityOverride = query.get('quality');
  const diagnosticOverrides: FlightGraphicsOverrides = {
    dpr: diagnosticNumber(query.get('dpr'), MIN_DIAGNOSTIC_DPR, MAX_DIAGNOSTIC_DPR),
    quality: qualityOverride === 'low' || qualityOverride === 'medium' ? qualityOverride : null,
    exposure: diagnosticNumber(query.get('exposure'), MIN_EXPOSURE, MAX_EXPOSURE),
  };
  const maxTextureSize = finiteInteger(hardware?.maxTextureSize, DEFAULT_MAX_TEXTURE_SIZE);
  const maxAnisotropy = finitePositive(hardware?.maxAnisotropy, DEFAULT_MAX_ANISOTROPY);
  const requestedAnisotropy = base.requestedAnisotropy;
  const source = selectedPreset !== undefined
    ? 'ui'
    : legacyFixture
      ? 'legacy-fixture'
      : isPreset(explicitQueryPreset)
        ? 'query'
        : storedPreset !== null
          ? 'storage'
          : 'default';
  return {
    preset,
    source,
    dpr: diagnosticOverrides.dpr ?? base.dpr,
    quality: diagnosticOverrides.quality ?? base.quality,
    exposure: diagnosticOverrides.exposure ?? base.exposure,
    smaa: {
      enabled: legacyFixture ? false : base.smaa.enabled,
      preset: base.smaa.preset,
    },
    shadowMapSize: Math.min(base.shadowMapSize, maxTextureSize),
    anisotropy: Math.min(requestedAnisotropy, maxAnisotropy),
    requestedAnisotropy,
    maxTextureSize,
    scenePixelCap: base.scenePixelCap,
    cloudPixelCap: FLIGHT_CLOUD_PIXEL_CAP,
    canvasAntialias: false,
    composerMultisampling: 0,
    diagnosticOverrides,
  };
}

export function resolveFlightRenderSize(
  cssWidth: number,
  cssHeight: number,
  requestedDpr: number,
  maxTextureSize: number,
  pixelCap = Number.POSITIVE_INFINITY,
): FlightRenderSize {
  const width = finitePositive(cssWidth, 1);
  const height = finitePositive(cssHeight, 1);
  const textureCap = finiteInteger(maxTextureSize, DEFAULT_MAX_TEXTURE_SIZE);
  const dpr = finitePositive(requestedDpr, 1);
  const safePixelCap = Number.isFinite(pixelCap) && pixelCap > 0 ? Math.max(1, Math.floor(pixelCap)) : Number.POSITIVE_INFINITY;
  const dimensionDpr = Math.min(textureCap / width, textureCap / height);
  const areaDpr = Number.isFinite(safePixelCap) ? Math.sqrt(safePixelCap / (width * height)) : Number.POSITIVE_INFINITY;
  const effectiveDpr = Math.max(Number.MIN_VALUE, Math.min(dpr, dimensionDpr, areaDpr));
  const renderWidth = Math.max(1, Math.min(textureCap, Math.floor(width * effectiveDpr)));
  const renderHeight = Math.max(1, Math.min(textureCap, Math.floor(height * effectiveDpr)));
  return {
    width: renderWidth,
    height: renderHeight,
    dpr: effectiveDpr,
    pixels: renderWidth * renderHeight,
    maxTextureSize: textureCap,
    pixelCap: safePixelCap,
  };
}
