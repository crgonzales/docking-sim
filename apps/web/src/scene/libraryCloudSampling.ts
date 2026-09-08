import type { CloudsEffect } from '@takram/three-clouds';

/**
 * Apply after the quality preset and weather layers are configured.
 * Begin at the cloud boundary instead of growing the first step through the
 * empty camera-to-cloud distance. Retain adaptive growth inside the cloud span;
 * constant steps exhausted the budget and cut off clouds along the horizon.
 * A finite iteration budget still cannot guarantee traversal of long limb rays.
 */
export function configureCloudSampling(clouds: CloudsEffect): void {
  // CloudLayers is an Array subclass whose filter() constructs default layers.
  const activeLayers = Array.from(clouds.cloudLayers)
    .filter(layer => layer.height > 0 && layer.densityScale > 0);
  const material = clouds.cloudsPass.currentMaterial;
  const original = '  float stepSize = minStepSize + (perspectiveStepScale - 1.0) * rayNearFar.x;';
  if (material.fragmentShader.split(original).length !== 2) {
    throw new Error('Pinned Takram cloud march changed; review initial-step patch');
  }
  material.fragmentShader = material.fragmentShader.replace(original,
    '  float stepSize = minStepSize; // Start sampling at the cloud boundary.');
  material.needsUpdate = true;
  clouds.clouds.maxStepSize = Math.min(
    clouds.clouds.maxStepSize,
    ...activeLayers.map(layer => layer.height * 0.5),
  );
  clouds.clouds.maxIterationCount = Math.max(500, clouds.clouds.maxIterationCount);
}
