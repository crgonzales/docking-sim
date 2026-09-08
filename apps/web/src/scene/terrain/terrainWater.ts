import { patchWaterMask, patchWaterPositions } from './terrainWorker';
import type { PatchBuildResult } from './terrainWorker';
import type { Vec3 } from './quadtree';

export function isWaterHeight(heightM: number): boolean {
  if (!Number.isFinite(heightM)) throw new Error('Water selection height must be finite');
  return heightM <= 0;
}

export function geoidSurfacePosition(position: Vec3, planetRadiusM: number): Vec3 {
  if (!Number.isFinite(planetRadiusM) || planetRadiusM <= 0) throw new Error('Geoid radius must be positive');
  const radius = Math.hypot(position[0], position[1], position[2]);
  if (!Number.isFinite(radius) || radius === 0) throw new Error('Water position must have a non-zero radius');
  return [
    position[0] * planetRadiusM / radius,
    position[1] * planetRadiusM / radius,
    position[2] * planetRadiusM / radius,
  ];
}

export interface WaterPatchGeometry {
  readonly positions: ArrayBuffer;
  readonly normals: ArrayBuffer;
  readonly uvs: ArrayBuffer;
  readonly indices: ArrayBuffer;
  readonly waterMask: ArrayBuffer;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly boundingSphereRadiusM: number;
  readonly hasWater: boolean;
}

/** Lift only non-positive DEM vertices to the geoid; land remains discarded. */
export function buildWaterPatchGeometry(
  result: PatchBuildResult,
  planetRadiusM: number,
): WaterPatchGeometry {
  if (!Number.isFinite(planetRadiusM) || planetRadiusM <= 0) throw new Error('Geoid radius must be positive');
  const sourceNormals = new Float32Array(result.normals);
  const sourceUvs = new Float32Array(result.uvs);
  const sourceIndices = new Uint32Array(result.indices);
  const positions = patchWaterPositions(result);
  const normals = new Float32Array(sourceNormals.length);
  const waterMask = new Float32Array(result.vertexCount);
  const semanticMask = patchWaterMask(result);
  let hasWater = false;

  for (let index = 0; index < result.vertexCount; index += 1) {
    const offset = index * 3;
    const absolute: Vec3 = [
      result.patchCenterF64[0] + positions[offset],
      result.patchCenterF64[1] + positions[offset + 1],
      result.patchCenterF64[2] + positions[offset + 2],
    ];
    // Geometry remains RTC Float32, but land/water classification is the
    // worker's pre-quantization decision, including inherited skirt masks.
    const water = semanticMask[index] === 1;
    waterMask[index] = water ? 1 : 0;
    hasWater ||= water;
    // Positions already came from the original f64 directions in the worker.
    // Only reconstruct a direction for shading; never round the geometry again.
    const radialLength = Math.hypot(absolute[0], absolute[1], absolute[2]);
    if (water) {
      normals[offset] = absolute[0] / radialLength;
      normals[offset + 1] = absolute[1] / radialLength;
      normals[offset + 2] = absolute[2] / radialLength;
    } else {
      normals[offset] = sourceNormals[offset];
      normals[offset + 1] = sourceNormals[offset + 1];
      normals[offset + 2] = sourceNormals[offset + 2];
    }
  }

  let boundingSphereRadiusM = 0;
  for (let index = 0; index < positions.length; index += 3) {
    boundingSphereRadiusM = Math.max(
      boundingSphereRadiusM,
      Math.hypot(positions[index], positions[index + 1], positions[index + 2]),
    );
  }
  return {
    positions: result.waterPositions,
    normals: normals.buffer,
    uvs: sourceUvs.buffer,
    indices: sourceIndices.buffer,
    waterMask: waterMask.buffer,
    vertexCount: result.vertexCount,
    indexCount: sourceIndices.length,
    boundingSphereRadiusM,
    hasWater,
  };
}
