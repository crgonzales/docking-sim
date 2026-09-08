import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { directionToECEF, updateWorldToECEF } from './libraryFrame';
import { WorldFrame } from './worldFrame';
import { parseFlytoParam } from './flytoParam';
import { EARTH_RADIUS_M } from './sky/skyConfig';
describe('render to library ECEF adapter', () => {
  it.each([[28.6, -80.6, 50], [28.6, -80.6, 100000], [-28.6, 99.4, 3000], [27.98, 86.92, 12000]])('preserves geodetic position through rebases: %j', (lat, lon, height) => {
    const spawn = parseFlytoParam(`?flyto=${lat},${lon},${height}`)!;
    const frame = new WorldFrame();
    const expected = new Vector3(Math.cos(lat * Math.PI / 180) * Math.cos(lon * Math.PI / 180), Math.cos(lat * Math.PI / 180) * Math.sin(lon * Math.PI / 180), Math.sin(lat * Math.PI / 180)).multiplyScalar(EARTH_RADIUS_M + height);
    for (const anchor of [[0, 0, 0], spawn.positionM, [123456, 987654, -876543]] as const) {
      frame.setAnchor(anchor);
      const result = new Vector3(...frame.toRender(spawn.positionM)).applyMatrix4(updateWorldToECEF(frame, new Matrix4()));
      expect(result.distanceTo(expected)).toBeLessThan(1e-7);
    }
  });
  it('preserves surface-to-sun angle', () => {
    const normal = new Vector3(.4, .5, -.6).normalize(); const sun = new Vector3(.35, .85, .15).normalize();
    expect(directionToECEF(normal).dot(directionToECEF(sun))).toBeCloseTo(normal.dot(sun), 14);
  });
});
