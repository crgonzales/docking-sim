import type { CloudsEffect } from '@takram/three-clouds';
import { LinearMipmapLinearFilter, type Data3DTexture } from 'three';

/** Explicit noise LOD from a pixel's footprint in metres. Global weather UVs
 * have a different scale from the local 3D shape and cannot select its LOD. */
export function configureCloudFootprint(clouds: CloudsEffect): void {
  const material = clouds.cloudsPass.currentMaterial;
  const replacements: [string, string][] = [
    ['float getSTBN() {', `float cloudPixelFootprint;
float cloudPixelRaySlope;
vec3 cloudCameraECEF;
float noiseLod(sampler3D field, vec3 repeat, vec3 position) {
  vec3 texelsPerMeter = repeat * vec3(textureSize(field, 0));
  float density = max(texelsPerMeter.x, max(texelsPerMeter.y, texelsPerMeter.z));
  float footprint = max(cloudPixelFootprint, length(position - cloudCameraECEF) * cloudPixelRaySlope);
  return log2(max(1.0, footprint * density));
}
float getSTBN() {`],
    ['  vec2 rayNearFar = getRayNearFar(intersections);', `  vec2 rayNearFar = getRayNearFar(intersections);
  vec3 footprintPoint = cameraPosition + max(0.0, rayNearFar.x) * rayDirection;
  cloudPixelFootprint = max(length(dFdx(footprintPoint)), length(dFdy(footprintPoint))) / ${clouds.temporalUpscale ? '4.0' : '1.0'};
  cloudPixelRaySlope = max(length(dFdx(rayDirection)), length(dFdy(rayDirection))) / ${clouds.temporalUpscale ? '4.0' : '1.0'};
  cloudCameraECEF = cameraPosition;`],
    ['texture(shapeTexture, shapePosition).r', 'textureLod(shapeTexture, shapePosition, noiseLod(shapeTexture, shapeRepeat, position)).r'],
    ['texture(shapeDetailTexture, detailPosition).r', 'textureLod(shapeDetailTexture, detailPosition, noiseLod(shapeDetailTexture, shapeDetailRepeat, position)).r'],
  ];
  let shader = material.fragmentShader;
  for (const [before, after] of replacements) {
    if (shader.split(before).length !== 2) throw new Error('Pinned cloud noise changed; review footprint adapter');
    shader = shader.replace(before, after);
  }
  material.fragmentShader = shader;
  material.needsUpdate = true;
}

export function configureCloudNoiseMipmaps(texture: Data3DTexture): Data3DTexture {
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.needsUpdate = true;
  return texture;
}
