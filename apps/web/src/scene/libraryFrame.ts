import { Matrix4, Vector3 } from 'three';
import { EARTH_CENTER_DISTANCE_M, SKY_CONFIG } from './sky/skyConfig';
import { WorldFrame } from './worldFrame';
/** Hill/render frame: x=east-equator origin, y=north, z=-ECEF y. */
export function updateWorldToECEF(frame: WorldFrame, result: Matrix4): Matrix4 {
  const [x, y, z] = frame.anchor;
  const s = SKY_CONFIG.renderScaleMPerUnit;
  return result.set(s, 0, 0, x + EARTH_CENTER_DISTANCE_M,
    0, 0, -s, -z, 0, s, 0, y, 0, 0, 0, 1);
}
export function directionToECEF(direction: Vector3): Vector3 {
  return new Vector3(direction.x, -direction.z, direction.y);
}
