import { EARTH_RADIUS_M, SKY_CONFIG } from '../scene/sky/skyConfig';
import { height, type HeightField } from '../scene/terrain/heightField';
import type { TerrainTileSource } from '../scene/terrain/tileSource';
import type { Vec3 } from '@docking/sim-core';

/** The character's terrain seam is deliberately resident-only and side effect free. */
export type GroundSampler = (position_N_m: Vec3) => number | null;

export interface TerrainSourceRef {
  current: TerrainTileSource | null;
}

function isFiniteVector(position_N_m: Vec3): boolean {
  return position_N_m.every((value) => Number.isFinite(value));
}

/**
 * Sample the existing height pipeline at a local flight-chart NED position.
 * N/R and E/R are the chart's latitude/longitude approximation used by
 * flightWorldFrame. The down component is intentionally not used to sample.
 */
export function sampleGroundHeight(
  position_N_m: Vec3,
  source: TerrainTileSource | null,
  earthRadiusM = EARTH_RADIUS_M,
): number | null {
  if (source === null || !isFiniteVector(position_N_m) || !Number.isFinite(earthRadiusM) || earthRadiusM <= 0) return null;
  const latitude = position_N_m[0] / earthRadiusM;
  if (latitude < -Math.PI / 2 || latitude > Math.PI / 2) return null;
  const field: HeightField = {
    tiles: source,
    level: source.manifest.maxLevel,
    detail: SKY_CONFIG.terrain.detail,
  };
  const sampled = height(latitude, position_N_m[1] / earthRadiusM, field);
  return sampled !== null && Number.isFinite(sampled) && sampled > 0 ? sampled : null;
}

/**
 * Keep the source lookup live. TerrainPatches may replace the source object
 * or populate its cache after this closure has been created.
 */
export function createGroundSampler(
  sourceRef: TerrainSourceRef,
  earthRadiusM = EARTH_RADIUS_M,
): GroundSampler {
  return (position_N_m) => sampleGroundHeight(position_N_m, sourceRef.current, earthRadiusM);
}

/**
 * A small resident neighborhood is enough to distinguish known stable ground
 * from a tile boundary or a newly exposed water/no-data sample. It does not
 * claim mesh-perfect collision.
 */
export function sampleStableGround(
  sampler: GroundSampler,
  position_N_m: Vec3,
  radiusM = 1,
): number | null {
  if (!Number.isFinite(radiusM) || radiusM <= 0 || !isFiniteVector(position_N_m)) return null;
  const center = sampler(position_N_m);
  if (center === null || !Number.isFinite(center) || center <= 0) return null;
  const neighbors: readonly Vec3[] = [
    [position_N_m[0] + radiusM, position_N_m[1], position_N_m[2]],
    [position_N_m[0] - radiusM, position_N_m[1], position_N_m[2]],
    [position_N_m[0], position_N_m[1] + radiusM, position_N_m[2]],
    [position_N_m[0], position_N_m[1] - radiusM, position_N_m[2]],
  ];
  for (const neighbor of neighbors) {
    const sampled = sampler([...neighbor]);
    if (sampled === null || !Number.isFinite(sampled) || sampled <= 0 || Math.abs(sampled - center) > 2) return null;
  }
  return center;
}
