import { clampFlyPositionToGround, type FlyVector3 } from './flyCamera';

export interface FlyGroundPose {
  readonly mode: string;
  readonly debugSubmode: string;
  readonly flyPositionM: FlyVector3;
  readonly flyPoseEpoch: number;
  readonly flyYawRad: number;
  readonly flyPitchRad: number;
  readonly flyMoveInput: FlyVector3;
}

export interface FlySpawnGroundCorrection {
  /** User's world-space teleport position, before any resident-ground clamp. */
  readonly requestedPositionM: FlyVector3;
}

/** Only an explicit, idle FLY teleport may acquire a reversible ground lift. */
export function beginFlySpawnCorrection(pose: FlyGroundPose): FlySpawnGroundCorrection | null {
  return pose.mode === 'DEBUG' && pose.debugSubmode === 'FLY' && pose.flyPoseEpoch > 0
    && pose.flyMoveInput.every(value => value === 0)
    ? { requestedPositionM: pose.flyPositionM }
    : null;
}

/** Observe store updates, including commands that happen between render frames. */
export function trackFlySpawnCorrection(
  correction: FlySpawnGroundCorrection | null,
  previous: FlyGroundPose,
  next: FlyGroundPose,
  cameraOwnedWrite = false,
): FlySpawnGroundCorrection | null {
  if (cameraOwnedWrite) return correction;
  if (next.flyPoseEpoch !== previous.flyPoseEpoch) return beginFlySpawnCorrection(next);
  // setFlyPosition copies its tuple. Identity also detects continuous external
  // updates that explicitly command the same coordinates as our last clamp.
  if (next.mode !== previous.mode || next.debugSubmode !== previous.debugSubmode
    || next.flyPositionM !== previous.flyPositionM
    || next.flyYawRad !== previous.flyYawRad || next.flyPitchRad !== previous.flyPitchRad
    // The input timer republishes [0, 0, 0] even while the pilot is idle.
    || next.flyMoveInput.some(value => value !== 0)) return null;
  return correction;
}

/** Re-clamp the requested spawn only while its lift is still camera-owned. */
export function groundClampedFlyPosition(
  positionM: FlyVector3,
  groundHeightM: number | null,
  planetCenterM: FlyVector3,
  planetRadiusM: number,
  clearanceM: number,
  correction: FlySpawnGroundCorrection | null,
): FlyVector3 {
  // Missing ground must neither invent a floor nor undo a previously safe lift.
  if (groundHeightM === null) return positionM;
  const candidate = correction?.requestedPositionM ?? positionM;
  const relative: FlyVector3 = [
    candidate[0] - planetCenterM[0],
    candidate[1] - planetCenterM[1],
    candidate[2] - planetCenterM[2],
  ];
  const clamped = clampFlyPositionToGround(relative, planetRadiusM, groundHeightM, clearanceM);
  if (clamped === relative) return candidate;
  return [clamped[0] + planetCenterM[0], clamped[1] + planetCenterM[1], clamped[2] + planetCenterM[2]];
}
