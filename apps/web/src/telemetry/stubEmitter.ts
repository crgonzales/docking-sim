import { FSW_HZ } from '@docking/sim-core';
import type { TelemetryFrame, Vec3 } from '@docking/sim-core';
import { useTelemetryBus } from './bus';

/**
 * Stub telemetry source for Phase 1: publishes plausible fake TelemetryFrames
 * at FSW rate so visuals and HUD develop against the real bus interface.
 * Phase 2 replaces this file with the actual sim loop; nothing else changes.
 *
 * Deterministic: seeded PRNG, sim time derived from the frame counter —
 * no wall clock anywhere, so screenshots are reproducible.
 */

/** mulberry32 — tiny seeded PRNG, plenty for cosmetic noise. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20260806;
/** V-bar approach profile: start 250 m behind, 12 m cross-track offset. */
const R0: Vec3 = [0, -250, 12];
const CLOSING_MPS = 0.85;      // initial closing rate along +y
const BRAKE_RANGE_M = 60;      // begin decelerating inside this range
const HOLD_RANGE_M = 25;       // stand off here (Phase 1 never docks)

let timer: ReturnType<typeof setInterval> | null = null;

export function startStubEmitter(): void {
  if (timer !== null) return;
  const rand = mulberry32(SEED);
  let n = 0;

  timer = setInterval(() => {
    n += 1;
    const t_s = n / FSW_HZ;

    // Along-track closure with a smooth brake to a hold point.
    const travelled = CLOSING_MPS * t_s;
    const rawY = R0[1] + travelled;
    const dist = -rawY; // distance behind target, positive
    let y: number;
    if (dist > BRAKE_RANGE_M) {
      y = rawY;
    } else {
      // exponential flare from the brake gate down to the hold range
      const over = BRAKE_RANGE_M - HOLD_RANGE_M;
      const into = BRAKE_RANGE_M - dist;
      y = -(HOLD_RANGE_M + over * Math.exp(-into / over));
    }
    // Cross-track and radial errors decay as the approach tightens.
    const tighten = Math.min(1, Math.abs(y) / Math.abs(R0[1]));
    const x = 0.4 * Math.sin(t_s * 0.05) * tighten;
    const z = R0[2] * tighten;

    // Nav noise: ~0.5% of range per axis, seeded.
    const range = Math.hypot(x, y, z);
    const sigma = Math.max(0.05, 0.005 * range);
    const noise = () => (rand() * 2 - 1) * sigma;
    const nav_r_hill_m: Vec3 = [x + noise(), y + noise(), z + noise()];
    const nav_cov_pos_m2: Vec3 = [sigma * sigma, sigma * sigma, sigma * sigma];

    const frame: TelemetryFrame = {
      t_s,
      nav_r_hill_m,
      nav_cov_pos_m2,
      nees: null,          // honest placeholder: no filter exists yet
      corridor_err_m: null, // honest placeholder: no corridor monitor yet
      controller: 'LQR',
      control_mode: 'AUTO',
    };
    useTelemetryBus.getState().publish(frame);
  }, 1000 / FSW_HZ);
}

export function stopStubEmitter(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
