import type { CloudsEffect } from '@takram/three-clouds';
import { Camera, Matrix4 } from 'three';

/** Previous camera and shadow matrices must describe the new render origin.
 * Re-express them before the library samples history, preserving physical
 * camera motion rather than resetting the temporal buffers on every rebase. */
export class CloudReprojectionFrame {
  private readonly previousCamera = new Camera();
  private readonly translation = new Matrix4();
  private readonly anchor = [0, 0, 0];
  private ready = false;

  beforeRender(clouds: CloudsEffect, anchor: readonly number[], metersPerUnit: number): void {
    if (!this.ready) return;
    const dx = (anchor[0] - this.anchor[0]) / metersPerUnit;
    const dy = (anchor[1] - this.anchor[1]) / metersPerUnit;
    const dz = (anchor[2] - this.anchor[2]) / metersPerUnit;
    if (dx === 0 && dy === 0 && dz === 0) return;
    this.translation.makeTranslation(dx, dy, dz);
    this.previousCamera.matrixWorldInverse.multiply(this.translation);
    clouds.cloudsPass.currentMaterial.copyReprojectionMatrix(this.previousCamera);
    for (const matrix of clouds.shadowPass.currentMaterial.uniforms.reprojectionMatrices.value) {
      matrix.multiply(this.translation);
    }
  }

  afterRender(camera: Camera, anchor: readonly number[]): void {
    this.previousCamera.projectionMatrix.copy(camera.projectionMatrix);
    this.previousCamera.matrixWorldInverse.copy(camera.matrixWorldInverse);
    this.anchor[0] = anchor[0]; this.anchor[1] = anchor[1]; this.anchor[2] = anchor[2];
    this.ready = true;
  }
}
