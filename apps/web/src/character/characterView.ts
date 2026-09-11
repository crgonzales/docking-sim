import type { Vec3 } from '@docking/sim-core';
import { flightWorldFrame } from '../flight/flightFrame';
import type { WorldPositionF64 } from '../scene/worldFrame';

export const CHARACTER_EYE_HEIGHT_M = 1.7;
export const CHARACTER_MAX_PITCH_RAD = 85 * Math.PI / 180;

export interface CharacterCameraPose {
  readonly eyeWorld: WorldPositionF64;
  readonly forwardWorld: Vec3;
  readonly upWorld: Vec3;
}

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

export function clampCharacterPitch(pitchRad: number): number {
  finite(pitchRad, 'Character pitch');
  return Math.max(-CHARACTER_MAX_PITCH_RAD, Math.min(CHARACTER_MAX_PITCH_RAD, pitchRad));
}

/** Wrap a heading into the half-open interval [-π, π). */
export function wrapCharacterYaw(yawRad: number): number {
  finite(yawRad, 'Character yaw');
  const wrapped = ((yawRad + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return wrapped === Math.PI ? -Math.PI : wrapped;
}

/**
 * Convert a feet position in the local NED chart into the one active camera
 * pose. Yaw zero looks north, positive yaw looks east, and positive pitch
 * looks up. The aircraft and renderer continue to use flightWorldFrame.
 */
export function characterCameraPose(
  feetPosition_N_m: Vec3,
  yawRad: number,
  pitchRad: number,
  eyeHeightM = CHARACTER_EYE_HEIGHT_M,
): CharacterCameraPose {
  if (!feetPosition_N_m.every((value) => Number.isFinite(value))) throw new RangeError('Character feet position must be finite');
  finite(eyeHeightM, 'Character eye height');
  if (eyeHeightM < 0) throw new RangeError('Character eye height must be non-negative');
  const pitch = clampCharacterPitch(pitchRad);
  const yaw = wrapCharacterYaw(yawRad);
  const eyePosition_N_m: Vec3 = [feetPosition_N_m[0], feetPosition_N_m[1], feetPosition_N_m[2] - eyeHeightM];
  const frame = flightWorldFrame(eyePosition_N_m);
  const horizontal = Math.cos(pitch);
  const forward_NED: Vec3 = [horizontal * Math.cos(yaw), horizontal * Math.sin(yaw), -Math.sin(pitch)];
  return {
    eyeWorld: [...frame.position],
    forwardWorld: frame.direction(forward_NED),
    upWorld: [...frame.up],
  };
}

/** A named alias keeps the view seam discoverable to the FlightMode integrator. */
export const createCharacterCameraPose = characterCameraPose;
