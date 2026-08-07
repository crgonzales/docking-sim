import type { Vec3 } from './types.js';

const DEG_TO_RAD = Math.PI / 180;

/**
 * Shared terminal-approach geometry. Values mirror
 * docs/scenario-mode-spec.md §4 (FINAL_APPROACH_01 monitors).
 */
export const CORRIDOR = {
  halfAngle_deg: 10,
  halfAngle_rad: 10 * DEG_TO_RAD,
  hardOuterAngle_deg: 15,
  hardOuterAngle_rad: 15 * DEG_TO_RAD,
  engagementRange_m: 250,
  apex_hill_m: [0, -8.7, 0] as Vec3,
  axis_hill: [0, -1, 0] as Vec3,
  /** Corridor geometry is disengaged at the port to avoid its cone apex singularity. */
  captureDisengageRange_m: 2,
} as const;

export const CAPTURE_ENVELOPE = {
  closing_mps: [0.03, 0.10] as readonly [number, number],
  lateral_m: 0.10,
  misalign_deg: 4,
  rate_dps: 0.15,
} as const;

export interface CaptureEnvelopeResult {
  inside: boolean;
  perCriterion: {
    closing_mps: boolean;
    lateral_m: boolean;
    misalign_deg: boolean;
    rate_dps: boolean;
  };
}

function coneSurfaceDistance_m(r_hill: Vec3, halfAngle_rad: number): number {
  const dx = r_hill[0] - CORRIDOR.apex_hill_m[0];
  const relativeAlongAxis_m = -(r_hill[1] - CORRIDOR.apex_hill_m[1]);
  const dz = r_hill[2] - CORRIDOR.apex_hill_m[2];
  const lateral_m = Math.hypot(dx, dz);
  const distanceFromApex_m = Math.hypot(dx, r_hill[1] - CORRIDOR.apex_hill_m[1], dz);
  if (distanceFromApex_m <= CORRIDOR.captureDisengageRange_m) return 0;

  const signedSurfaceDistance_m = lateral_m * Math.cos(halfAngle_rad)
    - relativeAlongAxis_m * Math.sin(halfAngle_rad);
  const insideForwardCone = relativeAlongAxis_m >= 0 && signedSurfaceDistance_m <= 0;
  if (insideForwardCone) return 0;

  // For a point behind the apex, the nearest point can be either the apex or
  // the forward generatrix. This keeps the helper a true distance to the cone.
  const generatrixProjection_m = relativeAlongAxis_m * Math.cos(halfAngle_rad)
    + lateral_m * Math.sin(halfAngle_rad);
  if (generatrixProjection_m <= 0) return distanceFromApex_m;
  return Math.abs(signedSurfaceDistance_m);
}

/** Distance outside the 10° approach-cone surface, in metres. */
export function corridorError_m(r_hill: Vec3): number {
  return coneSurfaceDistance_m(r_hill, CORRIDOR.halfAngle_rad);
}

/** Distance outside the 15° hard outer-cone surface, in metres. */
export function corridorErrorOuter_m(r_hill: Vec3): number {
  return coneSurfaceDistance_m(r_hill, CORRIDOR.hardOuterAngle_rad);
}

/** Evaluate every capture-envelope criterion independently and as a whole. */
export function insideCaptureEnvelope(
  closing_mps: number,
  lateral_m: number,
  misalign_deg: number,
  rate_dps: number,
): CaptureEnvelopeResult {
  const perCriterion = {
    closing_mps: closing_mps >= CAPTURE_ENVELOPE.closing_mps[0]
      && closing_mps <= CAPTURE_ENVELOPE.closing_mps[1],
    lateral_m: Math.abs(lateral_m) <= CAPTURE_ENVELOPE.lateral_m,
    misalign_deg: Math.abs(misalign_deg) <= CAPTURE_ENVELOPE.misalign_deg,
    rate_dps: Math.abs(rate_dps) <= CAPTURE_ENVELOPE.rate_dps,
  };
  return { inside: Object.values(perCriterion).every(Boolean), perCriterion };
}
