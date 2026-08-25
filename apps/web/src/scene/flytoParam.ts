import { EARTH_CENTER_DISTANCE_M, EARTH_RADIUS_M } from './sky/skyConfig';
import { flyPoseFromDirection, type FlyVector3 } from './flyCamera';
import { directionFromLatLon } from './terrain/heightField';

export interface FlytoSpawn {
  positionM: FlyVector3;
  yawRad: number;
  pitchRad: number;
}

/**
 * Geodetic -> engine world direction, matching the terrain/texture
 * registration: raster u = (lon + 180) / 360 together with the engine's
 * `atan2(z, -x)` equirect convention implies z = -sin(lon) (see the
 * space-to-ground plan's registration notes).
 */
export function directionFromGeodetic(latDeg: number, lonDeg: number): FlyVector3 {
  // Single source of truth: the terrain module's registration-proven mapping.
  return directionFromLatLon(latDeg * Math.PI / 180, lonDeg * Math.PI / 180);
}

/**
 * Parse a `flyto=lat,lon,altitudeM` search parameter into a FLY spawn pose
 * at that geodetic position, facing due east along the local horizon.
 * Returns null when the parameter is absent or malformed — the caller keeps
 * the default view. Debug affordance: deep-linkable reproducible framings.
 */
export function parseFlytoParam(search: string): FlytoSpawn | null {
  const raw = new URLSearchParams(search).get('flyto');
  if (raw === null) return null;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) return null;
  const [latDeg, lonDeg, altitudeM] = parts as [number, number, number];
  if (latDeg < -90 || latDeg > 90) return null;

  const up = directionFromGeodetic(latDeg, lonDeg);
  const radius = EARTH_RADIUS_M + Math.max(0, altitudeM);
  const positionM: FlyVector3 = [
    -EARTH_CENTER_DISTANCE_M + up[0] * radius,
    up[1] * radius,
    up[2] * radius,
  ];

  // Local east tangent: d(direction)/d(lon) normalized; degenerate at the
  // poles, where north-facing [1, 0, 0]-projected fallback is fine.
  const lon = lonDeg * Math.PI / 180;
  const east: FlyVector3 = Math.abs(latDeg) > 89.9
    ? [1, 0, 0]
    : [-Math.sin(lon), 0, -Math.cos(lon)];
  const pose = flyPoseFromDirection(east, up);
  return { positionM, yawRad: pose.yawRad, pitchRad: pose.pitchRad };
}
