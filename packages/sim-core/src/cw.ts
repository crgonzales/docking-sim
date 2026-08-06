import type { Vec3 } from './types.js';

/**
 * Closed-form Clohessy-Wiltshire propagation (circular target orbit).
 * Frame: x radial outward, y along-track, z cross-track. n = mean motion (rad/s).
 * This is the analytic reference used as a test oracle for the numeric propagator.
 */
export function propagateCW(
  r0: Vec3, v0: Vec3, n: number, t_s: number,
): { r: Vec3; v: Vec3 } {
  const c = Math.cos(n * t_s);
  const s = Math.sin(n * t_s);
  const [x0, y0, z0] = r0;
  const [vx0, vy0, vz0] = v0;

  const x = (4 - 3 * c) * x0 + (s / n) * vx0 + (2 / n) * (1 - c) * vy0;
  const y = 6 * (s - n * t_s) * x0 + y0 + (2 / n) * (c - 1) * vx0 + ((4 * s - 3 * n * t_s) / n) * vy0;
  const z = c * z0 + (s / n) * vz0;

  const vx = 3 * n * s * x0 + c * vx0 + 2 * s * vy0;
  const vy = 6 * n * (c - 1) * x0 - 2 * s * vx0 + (4 * c - 3) * vy0;
  const vz = -n * s * z0 + c * vz0;

  return { r: [x, y, z], v: [vx, vy, vz] };
}
