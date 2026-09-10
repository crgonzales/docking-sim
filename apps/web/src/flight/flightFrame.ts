import type { Vec3 } from '@docking/sim-core';
import { EARTH_CENTER_DISTANCE_M, EARTH_RADIUS_M } from '../scene/sky/skyConfig';

/** Local equatorial-ocean NED chart. Physics is flat; presentation follows the
 * existing spherical Earth. This is intentionally bounded to a 50 km radius. */
export function flightWorldFrame(position_N_m: Vec3) {
  const latitude = position_N_m[0] / EARTH_RADIUS_M;
  const longitude = position_N_m[1] / EARTH_RADIUS_M;
  const c = Math.cos(latitude), s = Math.sin(latitude);
  const cl = Math.cos(longitude), sl = Math.sin(longitude);
  const up: Vec3 = [c * cl, s, -c * sl];
  const north: Vec3 = [-s * cl, c, s * sl];
  const east: Vec3 = [-sl, 0, -cl];
  const radius = EARTH_RADIUS_M - position_N_m[2];
  const position: Vec3 = [radius * up[0] - EARTH_CENTER_DISTANCE_M, radius * up[1], radius * up[2]];
  const direction = (ned: Vec3): Vec3 => [0, 1, 2].map((i) => north[i] * ned[0] + east[i] * ned[1] - up[i] * ned[2]) as Vec3;
  return { position, up, direction };
}
