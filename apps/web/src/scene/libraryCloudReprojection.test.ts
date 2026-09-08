import { describe, expect, it } from 'vitest';
import { CloudsEffect } from '@takram/three-clouds';
import { Matrix4, PerspectiveCamera, Vector3, Vector4 } from 'three';
import { CloudReprojectionFrame } from './libraryCloudReprojection';

function clip(matrix: Matrix4, point: Vector3) {
  const p = new Vector4(point.x, point.y, point.z, 1).applyMatrix4(matrix);
  return p.divideScalar(p.w);
}
describe('cloud history across floating-origin changes', () => {
  it.each([1, 1000])('preserves previous cloud and shadow projections with %s metres per render unit', (scale) => {
    const camera = new PerspectiveCamera(45, 1.3, 0.5, 1e8);
    camera.position.set(1000 / scale, 500 / scale, 2000 / scale);
    camera.lookAt(new Vector3(0, 0, -20000 / scale)); camera.updateMatrixWorld(true);
    const clouds = new CloudsEffect(camera);
    clouds.cloudsPass.currentMaterial.setSize(1292, 1060);
    const tracker = new CloudReprojectionFrame();
    const previous = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const shadow = clouds.shadowPass.currentMaterial.uniforms.reprojectionMatrices.value;
    for (const m of shadow) m.copy(previous);
    tracker.afterRender(camera, [0, 0, 0]);
    const world = new Vector3(4000 / scale, 2000 / scale, -20000 / scale);
    const expected = clip(previous, world);
    const delta = new Vector3(11000 / scale, -2500 / scale, 3200 / scale);
    // Include actual camera motion alongside the origin shift: reprojection
    // must still target the previous physical camera, not the current pose.
    camera.position.sub(delta).add(new Vector3(300 / scale, 0, 0));
    camera.updateMatrixWorld(true);
    tracker.beforeRender(clouds, [11000, -2500, 3200], scale);
    clouds.cloudsPass.currentMaterial.copyCameraSettings(camera);
    const actual = clip(clouds.cloudsPass.currentMaterial.uniforms.reprojectionMatrix.value, world.clone().sub(delta));
    // Remove the library's current Bayer projection jitter for the oracle.
    const jitter = clouds.cloudsPass.currentMaterial.uniforms.temporalJitter.value;
    expect(actual.x + jitter.x * 2).toBeCloseTo(expected.x, 10);
    expect(actual.y + jitter.y * 2).toBeCloseTo(expected.y, 10);
    for (const m of shadow) expect(clip(m, world.clone().sub(delta)).sub(expected).length()).toBeLessThan(1e-10);
    clouds.dispose();
  });
});
