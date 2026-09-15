const TAU = Math.PI * 2;

function wrap(value: number): number {
  return ((value % 1) + 1) % 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Equirectangular mapping shared by the Earth surface, terrain and weather
 * lookups (three.js SphereGeometry convention: −x̂ → u=0, +x̂ → u=0.5, no
 * offset). The GLSL `sphericalUv` helpers mirror this function; tests pin them
 * against it.
 */
export function cloudSphericalUv(x: number, y: number, z: number): readonly [number, number] {
  return [
    wrap(Math.atan2(z, -x) / TAU),
    clamp(0.5 + Math.asin(clamp(y, -1, 1)) / Math.PI, 0, 1),
  ];
}
