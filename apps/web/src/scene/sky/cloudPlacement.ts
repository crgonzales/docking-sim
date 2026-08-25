import { directionFromLatLon } from '../terrain/heightField';

export interface CoverageMask {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface CloudPlacementResult {
  positions: Float32Array;
  seeds: Float32Array;
  bandFractions: Float32Array;
  coverages: Float32Array;
  attempts: number;
}

export interface CloudPlacementCap {
  readonly center: readonly [number, number, number];
  readonly capCosine: number;
  /** Optional authored minimum density for a static hero weather cap. */
  readonly coverageFloor?: number;
}

const TAU = Math.PI * 2;
const MIN_ACCEPTED_COVERAGE = 1 / 255;

export function nextCloudRandom(state: { value: number }): number {
  state.value = (1664525 * state.value + 1013904223) >>> 0;
  return state.value / 4294967296;
}

function wrap(value: number): number {
  return ((value % 1) + 1) % 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalize(vector: readonly [number, number, number]): readonly [number, number, number] {
  const size = Math.hypot(vector[0], vector[1], vector[2]);
  if (!Number.isFinite(size) || size === 0) throw new Error('Cloud cap center must be a non-zero vector');
  return [vector[0] / size, vector[1] / size, vector[2] / size];
}

function cross(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): readonly [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function capBasis(center: readonly [number, number, number]): {
  readonly center: readonly [number, number, number];
  readonly tangent: readonly [number, number, number];
  readonly bitangent: readonly [number, number, number];
} {
  const normalized = normalize(center);
  const reference: readonly [number, number, number] = Math.abs(normalized[2]) < 0.9
    ? [0, 0, 1]
    : [0, 1, 0];
  const tangent = normalize(cross(reference, normalized));
  return { center: normalized, tangent, bitangent: cross(normalized, tangent) };
}

/** Equirectangular mapping shared with Earth and the cloud shaders
 *  (SphereGeometry convention: +x maps to u=0.5, no offset). */
export function cloudSphericalUv(x: number, y: number, z: number): readonly [number, number] {
  return [
    wrap(Math.atan2(z, -x) / TAU),
    clamp(0.5 + Math.asin(clamp(y, -1, 1)) / Math.PI, 0, 1),
  ];
}

export function sampleCoverageMask(mask: CoverageMask, u: number, v: number): number {
  const x = wrap(u) * (mask.width - 1);
  const y = clamp(v, 0, 1) * (mask.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = (x0 + 1) % mask.width;
  const y1 = Math.min(y0 + 1, mask.height - 1);
  const tx = x - x0;
  const ty = y - y0;
  const at = (ix: number, iy: number) => mask.data[iy * mask.width + ix] / 255;
  const top = at(x0, y0) * (1 - tx) + at(x1, y0) * tx;
  const bottom = at(x0, y1) * (1 - tx) + at(x1, y1) * tx;
  return top * (1 - ty) + bottom * ty;
}

/**
 * Puffs reserved for every cap before the solid-angle split below, so a tiny
 * hero-region disc's proportional share doesn't round all the way down to
 * zero against the near-hemisphere orbital cap (it otherwise would: at
 * count=12000 a ~25km-radius cap's raw share is a few tenths of a puff).
 * Small enough not to reintroduce the oversaturation the even split had.
 */
const MIN_PUFFS_PER_CAP = 150;

/**
 * Splits `count` puffs across caps proportional to each cap's solid angle
 * (2*pi*(1 - capCosine)), so a small hero-region disc doesn't draw the same
 * instance budget as the near-hemisphere orbital cap. Uses largest-remainder
 * rounding so the per-cap counts still sum to exactly `count`.
 */
export function areaWeightedCapCounts(caps: readonly CloudPlacementCap[], count: number): number[] {
  if (caps.length === 0) return [];
  const minPerCap = Math.min(MIN_PUFFS_PER_CAP, Math.floor(count / caps.length));
  const reserved = minPerCap * caps.length;
  const weights = caps.map((cap) => Math.max(1 - cap.capCosine, 0));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) {
    return caps.map((_, index) => Math.floor(count / caps.length) + (index < count % caps.length ? 1 : 0));
  }
  const remainingBudget = count - reserved;
  const raw = weights.map((weight) => minPerCap + (weight / totalWeight) * remainingBudget);
  const counts = raw.map((value) => Math.floor(value));
  let remaining = count - counts.reduce((sum, value) => sum + value, 0);
  const byRemainder = raw
    .map((value, index) => ({ index, remainder: value - counts[index]! }))
    .sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < byRemainder.length && remaining > 0; i += 1) {
    counts[byRemainder[i]!.index]! += 1;
    remaining -= 1;
  }
  return counts;
}

/**
 * Deterministic rejection sampling over the world-anchored flight cap. The
 * mask is already the final coverage transfer function, so accepting with
 * probability coverage gives the instances the same spatial density as the
 * authored cloud field while leaving the GPU map lookup as a fine term.
 */
export function sampleCloudPlacements(
  count: number,
  capCosine: number,
  mask: CoverageMask,
  seed = 0x4d41524c,
  additionalCaps: readonly CloudPlacementCap[] = [],
): CloudPlacementResult {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Cloud placement count must be non-negative');
  if (!Number.isFinite(capCosine) || capCosine < -1 || capCosine > 1) throw new Error('Orbital cap cosine must be in [-1, 1]');
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const bandFractions = new Float32Array(count);
  const coverages = new Float32Array(count);
  const randomState = { value: seed >>> 0 };
  let accepted = 0;
  let attempts = 0;
  const maxAttempts = Math.max(count * 2000, 100_000);
  const caps: readonly CloudPlacementCap[] = [
    { center: [1, 0, 0], capCosine },
    ...additionalCaps,
  ];
  const capCounts = areaWeightedCapCounts(caps, count);

  for (let capIndex = 0; capIndex < caps.length; capIndex += 1) {
    const cap = caps[capIndex]!;
    const basis = capBasis(cap.center);
    const target = capCounts[capIndex]!;
    let capAccepted = 0;
    while (capAccepted < target && attempts < maxAttempts) {
      attempts += 1;
      const cosine = cap.capCosine + (1 - cap.capCosine) * nextCloudRandom(randomState);
      const sine = Math.sqrt(Math.max(1 - cosine * cosine, 0));
      const azimuth = TAU * nextCloudRandom(randomState);
      const aroundTangent = sine * Math.cos(azimuth);
      const aroundBitangent = sine * Math.sin(azimuth);
      const x = basis.center[0] * cosine + basis.tangent[0] * aroundTangent + basis.bitangent[0] * aroundBitangent;
      const y = basis.center[1] * cosine + basis.tangent[1] * aroundTangent + basis.bitangent[1] * aroundBitangent;
      const z = basis.center[2] * cosine + basis.tangent[2] * aroundTangent + basis.bitangent[2] * aroundBitangent;
      const [u, v] = cloudSphericalUv(x, y, z);
      const coverage = Math.max(sampleCoverageMask(mask, u, v), cap.coverageFloor ?? 0);
      if (coverage <= MIN_ACCEPTED_COVERAGE || nextCloudRandom(randomState) > coverage) continue;

      const index = accepted * 3;
      positions[index] = x;
      positions[index + 1] = y;
      positions[index + 2] = z;
      seeds[accepted] = nextCloudRandom(randomState);
      bandFractions[accepted] = nextCloudRandom(randomState) ** 1.6;
      coverages[accepted] = coverage;
      accepted += 1;
      capAccepted += 1;
    }
  }

  if (accepted !== count) {
    throw new Error(`Cloud mask accepted ${accepted}/${count} placements after ${attempts} attempts`);
  }
  return { positions, seeds, bandFractions, coverages, attempts };
}

/** Convert a geographic hero-region centre and feathered radius to a static cloud cap. */
export function cloudCapFromHeroRegion(
  centerLatDeg: number,
  centerLonDeg: number,
  radiusKm: number,
  featherKm: number,
  earthRadiusKm: number,
  coverageFloor = 0.55,
): CloudPlacementCap {
  if (![centerLatDeg, centerLonDeg, radiusKm, featherKm, earthRadiusKm].every(Number.isFinite)
    || radiusKm < 0 || featherKm < 0 || earthRadiusKm <= 0
    || !Number.isFinite(coverageFloor) || coverageFloor < 0 || coverageFloor > 1) {
    throw new Error('Invalid hero cloud cap configuration');
  }
  const lat = centerLatDeg * Math.PI / 180;
  const lon = centerLonDeg * Math.PI / 180;
  const angularRadius = (radiusKm + featherKm) / earthRadiusKm;
  return {
    center: directionFromLatLon(lat, lon),
    capCosine: Math.cos(angularRadius),
    coverageFloor,
  };
}

export const CLOUD_PLACEMENT_MIN_COVERAGE = MIN_ACCEPTED_COVERAGE;
