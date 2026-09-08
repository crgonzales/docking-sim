import type { CloudsEffect } from '@takram/three-clouds';

/** Keep depth ordering finite in RGBA16F and accumulate fresh Bayer samples.
 * The depth channel only chooses the nearest motion vector. Units of 10 km
 * keep the scene's 100,000 km far plane finite while retaining linear ordering. */
export function configureCloudTemporal(clouds: CloudsEffect, accumulate = false): void {
  const current = clouds.cloudsPass.currentMaterial;
  const resolve = clouds.cloudsPass.resolveMaterial;
  const depth = 'depthVelocity = vec3(frontDepth, velocity);';
  const fresh = `  if (currentFrame) {
    // Use the texel just rendered without any accumulation.
    outputColor = currentColor;
    #ifdef SHADOW_LENGTH
    outputShadowLength = currentShadowLength.r;
    #endif // SHADOW_LENGTH
    return;
  }`;
  const output = '  outputColor = clippedColor;';
  if (current.fragmentShader.split(depth).length !== 3 ||
      resolve.fragmentShader.split(fresh).length !== 2 ||
      resolve.fragmentShader.split(output).length !== 2) {
    throw new Error('Pinned cloud temporal shader changed; review history adapter');
  }
  current.fragmentShader = current.fragmentShader.replaceAll(depth,
    'depthVelocity = vec3(frontDepth * 1e-4, velocity);');
  if (accumulate) {
    resolve.fragmentShader = resolve.fragmentShader.replace(fresh, '')
      .replace(output, '  outputColor = currentFrame ? mix(clippedColor, currentColor, temporalAlpha) : clippedColor;');
    resolve.uniforms.temporalAlpha.value = 0.25;
  }
  current.needsUpdate = resolve.needsUpdate = true;
}
