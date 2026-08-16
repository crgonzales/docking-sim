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
): CloudPlacementResult {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const bandFractions = new Float32Array(count);
  const coverages = new Float32Array(count);
  const randomState = { value: seed >>> 0 };
  let accepted = 0;
  let attempts = 0;
  const maxAttempts = Math.max(count * 2000, 100_000);

  while (accepted < count && attempts < maxAttempts) {
    attempts += 1;
    const cosine = capCosine + (1 - capCosine) * nextCloudRandom(randomState);
    const sine = Math.sqrt(Math.max(1 - cosine * cosine, 0));
    const azimuth = TAU * nextCloudRandom(randomState);
    const x = cosine;
    const y = sine * Math.cos(azimuth);
    const z = sine * Math.sin(azimuth);
    const [u, v] = cloudSphericalUv(x, y, z);
    const coverage = sampleCoverageMask(mask, u, v);
    if (coverage <= MIN_ACCEPTED_COVERAGE || nextCloudRandom(randomState) > coverage) continue;

    const index = accepted * 3;
    positions[index] = x;
    positions[index + 1] = y;
    positions[index + 2] = z;
    seeds[accepted] = nextCloudRandom(randomState);
    bandFractions[accepted] = nextCloudRandom(randomState) ** 1.6;
    coverages[accepted] = coverage;
    accepted += 1;
  }

  if (accepted !== count) {
    throw new Error(`Cloud mask accepted ${accepted}/${count} placements after ${attempts} attempts`);
  }
  return { positions, seeds, bandFractions, coverages, attempts };
}

export const CLOUD_PLACEMENT_MIN_COVERAGE = MIN_ACCEPTED_COVERAGE;
