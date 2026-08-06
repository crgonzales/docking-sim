import { describe, expect, it } from 'vitest';
import { propagateCW } from './cw.js';
import type { Vec3 } from './types.js';

/** ~415 km LEO mean motion, rad/s. */
const N = 1.13e-3;
const close = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe('propagateCW (analytic oracle)', () => {
  it('t = 0 is the identity', () => {
    const r0: Vec3 = [12, -250, 7];
    const v0: Vec3 = [0.02, 0.85, -0.05];
    const { r, v } = propagateCW(r0, v0, N, 0);
    r.forEach((ri, i) => close(ri, r0[i]!));
    v.forEach((vi, i) => close(vi, v0[i]!));
  });

  it('composes: step(dt) twice equals step(2dt)', () => {
    const r0: Vec3 = [5, -100, 3];
    const v0: Vec3 = [0.01, 0.4, -0.02];
    const a = propagateCW(r0, v0, N, 120);
    const b = propagateCW(a.r, a.v, N, 120);
    const direct = propagateCW(r0, v0, N, 240);
    b.r.forEach((ri, i) => close(ri, direct.r[i]!, 1e-7));
    b.v.forEach((vi, i) => close(vi, direct.v[i]!, 1e-9));
  });

  it('origin with zero velocity station-keeps', () => {
    const { r, v } = propagateCW([0, 0, 0], [0, 0, 0], N, 3600);
    [...r, ...v].forEach((x) => close(x, 0));
  });

  it('cross-track is simple harmonic: n^2 z^2 + vz^2 invariant', () => {
    const r0: Vec3 = [0, 0, 9];
    const v0: Vec3 = [0, 0, 0.004];
    const e0 = N * N * r0[2] * r0[2] + v0[2] * v0[2];
    const { r, v } = propagateCW(r0, v0, N, 1234);
    close(N * N * r[2] * r[2] + v[2] * v[2], e0, 1e-12);
  });
});
