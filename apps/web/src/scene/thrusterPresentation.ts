import { CREW_DRAGON_THRUSTERS, type Vec3 } from '@docking/sim-core';

/** Primitive fallback only. The production capsule has its own modeled bells. */
export const CHASER_HULL = {
  capsuleTopRadiusM: 1.1, capsuleBottomRadiusM: 1.9, capsuleHeightM: 3.4,
  trunkRadiusM: 1.9, trunkHeightM: 1.4, trunkCenterYM: -2.4,
} as const;
export const NOZZLE_EXIT_RADIUS_M = 0.085;
export const PLUME_LENGTH_M = 2.4;
export const PLUME_END_RADIUS_M = 0.65;

/** The renderer, allocator and truth dynamics all use the registered mouth.
 * Hardware is already present in the GLB: do not add a second set of bells.
 */
export const THRUSTER_NOZZLES = CREW_DRAGON_THRUSTERS.map(jet => ({
  id: jet.id,
  mount: jet.position_body_m,
  exit: jet.position_body_m,
  exhaust: jet.direction_body.map(value => -value) as Vec3,
  radiusM: jet.nozzleRadiusM,
}));

export function boundedThrusterDuty(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value!)) : 0;
}
