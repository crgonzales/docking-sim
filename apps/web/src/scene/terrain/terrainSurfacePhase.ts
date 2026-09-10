import { Vector3 } from 'three';

// Shared by CPU phase reduction and the generated GLSL domain transforms.
export const TERRAIN_SURFACE_DOMAINS = [
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  [[0.36, -0.48, 0.80], [0.80, 0.60, 0], [-0.48, 0.64, 0.60]],
  [[0.64, 0.48, -0.60], [-0.684, 0, -0.730], [-0.350, 0.877, 0.328]],
  [[0, -0.80, 0.60], [0.936, 0.211, 0.281], [-0.351, 0.562, 0.749]],
] as const;
export const TERRAIN_SURFACE_WAVELENGTHS_M = [1000, 150, 24, 3] as const;
export const TERRAIN_SURFACE_PERIOD_CELLS = 8;

/** Reduce the patch origin in double precision before sending phase to GPU. */
export function terrainSurfacePhases(centerM: readonly number[]): Vector3[] {
  if (centerM.length !== 3 || !centerM.every(Number.isFinite)) throw new Error('Terrain surface center must be a finite 3-vector');
  return TERRAIN_SURFACE_DOMAINS.map((rows, band) => {
    const period = TERRAIN_SURFACE_WAVELENGTHS_M[band]! * TERRAIN_SURFACE_PERIOD_CELLS;
    const components = rows.map(row => {
      const value = row.reduce<number>((sum, axis, i) => sum + axis * centerM[i]!, 0) / period;
      return value - Math.floor(value);
    });
    return new Vector3(...components);
  });
}

export const TERRAIN_SURFACE_DOMAIN_GLSL = TERRAIN_SURFACE_DOMAINS.slice(1).map((rows, i) =>
  `vec3 terrainSurfaceDomain${i + 1}(vec3 p) { return vec3(${rows.map(row =>
    `dot(p, vec3(${row.map(v => v.toFixed(6)).join(', ')}))`).join(', ')}); }`,
).join('\n');

/** Chain-rule transform from each rotated noise domain back to world axes. */
export const TERRAIN_SURFACE_GRADIENT_GLSL = TERRAIN_SURFACE_DOMAINS.slice(1).map((rows, i) =>
  `vec3 terrainSurfaceGradient${i + 1}(vec3 g) { return vec3(${[0, 1, 2].map(axis =>
    `dot(g, vec3(${rows.map(row => row[axis]!.toFixed(6)).join(', ')}))`).join(', ')}); }`,
).join('\n');
