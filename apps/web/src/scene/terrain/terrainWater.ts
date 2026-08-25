import { TERRAIN_PATCH_GRID_SIZE } from './terrainWorker';
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
  const sourcePositions = new Float32Array(result.positions);
  const sourceNormals = new Float32Array(result.normals);
  const sourceUvs = new Float32Array(result.uvs);
  const sourceIndices = new Uint32Array(result.indices);
  const positions = new Float32Array(sourcePositions.length);
  const normals = new Float32Array(sourceNormals.length);
  const waterMask = new Float32Array(result.vertexCount);
  const baseCount = result.baseVertexCount;
  const baseWater = new Array<boolean>(baseCount).fill(false);
  let hasWater = false;

  const edgeBaseIndex = (skirtIndex: number): number => {
    const offset = skirtIndex - baseCount;
    const edge = Math.floor(offset / TERRAIN_PATCH_GRID_SIZE);
    const along = offset % TERRAIN_PATCH_GRID_SIZE;
    switch (edge) {
      case 0: return (TERRAIN_PATCH_GRID_SIZE - 1) * TERRAIN_PATCH_GRID_SIZE + along;
      case 1: return along * TERRAIN_PATCH_GRID_SIZE + TERRAIN_PATCH_GRID_SIZE - 1;
      case 2: return along;
      default: return along * TERRAIN_PATCH_GRID_SIZE;
    }
  };

  for (let index = 0; index < result.vertexCount; index += 1) {
    const offset = index * 3;
    const absolute: Vec3 = [
      result.patchCenterF64[0] + sourcePositions[offset],
      result.patchCenterF64[1] + sourcePositions[offset + 1],
      result.patchCenterF64[2] + sourcePositions[offset + 2],
    ];
    const heightM = Math.hypot(absolute[0], absolute[1], absolute[2]) - planetRadiusM;
    const water = index < baseCount
      ? isWaterHeight(heightM)
      : baseWater[edgeBaseIndex(index)]!;
    if (index < baseCount) baseWater[index] = water;
    waterMask[index] = water ? 1 : 0;
    hasWater ||= water;
    const surface = water ? geoidSurfacePosition(absolute, planetRadiusM) : absolute;
    positions[offset] = surface[0] - result.patchCenterF64[0];
    positions[offset + 1] = surface[1] - result.patchCenterF64[1];
    positions[offset + 2] = surface[2] - result.patchCenterF64[2];
    const radialLength = Math.hypot(surface[0], surface[1], surface[2]);
    if (water) {
      normals[offset] = surface[0] / radialLength;
      normals[offset + 1] = surface[1] / radialLength;
      normals[offset + 2] = surface[2] / radialLength;
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
    positions: positions.buffer,
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
