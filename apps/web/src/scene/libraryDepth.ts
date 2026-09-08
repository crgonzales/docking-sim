import { AerialPerspectiveEffect } from '@takram/three-atmosphere';
import type { CloudsEffect } from '@takram/three-clouds';
// Compatibility patch for the pinned library's perspective-depth reconstruction.
// Keep log depth linearization in eye-space metres. Converting through ordinary
// [0,1] depth first discards kilometre-scale precision with near=.5/far=1e8.
function replaceOnce(source: string, search: string, replacement: string): string {
  if (source.split(search).length !== 2) throw new Error('Pinned Takram depth shader changed; review compatibility patch');
  return source.replace(search, replacement);
}
export const AERIAL_DEPTH_BLOCK = `  depth = reverseLogDepth(depth, cameraNear, cameraFar);

  // Reconstruct position and normal in world space.
  vec3 viewPosition = screenToView(
    uv,
    depth,
    getViewZ(depth),
    projectionMatrix,
    inverseProjectionMatrix
  );`;
export function stableAerialDepth(source: string): string {
  return replaceOnce(source, AERIAL_DEPTH_BLOCK, `
  vec3 viewPosition;
  #if defined(USE_LOGDEPTHBUF) || defined(USE_LOGARITHMIC_DEPTH_BUFFER)
  if (projectionMatrix[2][3] != 0.0) {
    float viewZ = -(exp2(depth * log2(cameraFar + 1.0)) - 1.0);
    vec3 viewRay = (inverseProjectionMatrix * vec4(uv * 2.0 - 1.0, 1.0, 1.0)).xyz;
    viewPosition = viewRay * (viewZ / viewRay.z);
  } else {
    viewPosition = screenToView(uv, depth, getViewZ(depth), projectionMatrix, inverseProjectionMatrix);
  }
  #else
  viewPosition = screenToView(uv, depth, getViewZ(depth), projectionMatrix, inverseProjectionMatrix);
  #endif`);
}
export class StableAerialPerspectiveEffect extends AerialPerspectiveEffect {
  constructor(...args: ConstructorParameters<typeof AerialPerspectiveEffect>) {
    super(...args);
    this.setFragmentShader(stableAerialDepth(this.getFragmentShader()));
  }
}
export function stabilizeCloudDepth(clouds: CloudsEffect): void {
  const material = clouds.cloudsPass.currentMaterial;
  material.fragmentShader = replaceOnce(material.fragmentShader,
    '    depth = reverseLogDepth(depth, cameraNear, cameraFar);\n    viewZ = getViewZ(depth);',
    `    #if (defined(USE_LOGDEPTHBUF) || defined(USE_LOGARITHMIC_DEPTH_BUFFER)) && defined(PERSPECTIVE_CAMERA)
    viewZ = -(exp2(depth * log2(cameraFar + 1.0)) - 1.0);
    #else
    viewZ = getViewZ(depth);
    #endif`);
  material.needsUpdate = true;
}

/** Use the cloud intersection sphere for layer classification too. The stock
 * cameraHeight is geodetic height above WGS84 even with a custom ellipsoid. */
export function stabilizeCloudHeight(clouds: CloudsEffect): void {
  const material = clouds.cloudsPass.currentMaterial;
  material.fragmentShader = replaceOnce(material.fragmentShader,
    'uniform float cameraHeight;', 'float cameraHeight; // Assigned in the corrected cloud frame in main().');
  material.fragmentShader = replaceOnce(material.fragmentShader,
    '  vec3 cameraPosition = vCameraPosition + altitudeCorrection;',
    '  vec3 cameraPosition = vCameraPosition + altitudeCorrection;\n  cameraHeight = length(cameraPosition) - bottomRadius;');
  material.needsUpdate = true;
}
