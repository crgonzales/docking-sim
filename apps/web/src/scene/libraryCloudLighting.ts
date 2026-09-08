import type { CloudsEffect } from '@takram/three-clouds';

/** Cache sunlight/sky illumination at the viewed cloud column, rather than at
 * the camera's longitude. This keeps the cheap preset's height interpolation,
 * with three LUT queries per ray instead of queries at every occupied step.
 * Nearly tangent rays still approximate the change along the cloud column.
 */
export function configureCloudLighting(clouds: CloudsEffect): void {
  const material = clouds.cloudsPass.currentMaterial;
  const replacements: [string, string][] = [
    ['in CloudsIrradiance vCloudsIrradiance;', `in CloudsIrradiance vCloudsIrradiance;
GroundIrradiance rayGroundIrradiance;
CloudsIrradiance rayCloudsIrradiance;

void sampleRayIrradiance(const vec3 cloudPosition) {
  vec3 normal = normalize(cloudPosition);
  rayGroundIrradiance.sun = GetSunAndSkyIrradiance(
    normal * bottomRadius * METER_TO_LENGTH_UNIT, normal, sunDirection,
    rayGroundIrradiance.sky);
  rayCloudsIrradiance.minSun = GetSunAndSkyScalarIrradiance(
    normal * (bottomRadius + minHeight) * METER_TO_LENGTH_UNIT, sunDirection,
    rayCloudsIrradiance.minSky);
  rayCloudsIrradiance.maxSun = GetSunAndSkyScalarIrradiance(
    normal * (bottomRadius + maxHeight) * METER_TO_LENGTH_UNIT, sunDirection,
    rayCloudsIrradiance.maxSky);
}`],
    ['  skyIrradiance = vGroundIrradiance.sky;\n  return vGroundIrradiance.sun;',
      '  skyIrradiance = rayGroundIrradiance.sky;\n  return rayGroundIrradiance.sun;'],
    ['  skyIrradiance = mix(vCloudsIrradiance.minSky, vCloudsIrradiance.maxSky, alpha);\n  return mix(vCloudsIrradiance.minSun, vCloudsIrradiance.maxSun, alpha);',
      '  skyIrradiance = mix(rayCloudsIrradiance.minSky, rayCloudsIrradiance.maxSky, alpha);\n  return mix(rayCloudsIrradiance.minSun, rayCloudsIrradiance.maxSun, alpha);'],
    ['    vec3 rayOrigin = rayNearFar.x * rayDirection + cameraPosition;',
      `    vec3 rayOrigin = rayNearFar.x * rayDirection + cameraPosition;
    #ifndef ACCURATE_SUN_SKY_LIGHT
    sampleRayIrradiance(rayOrigin);
    #endif`],
  ];
  let shader = material.fragmentShader;
  for (const [before, after] of replacements) {
    if (shader.split(before).length !== 2) throw new Error('Pinned cloud lighting changed; review ray illumination adapter');
    shader = shader.replace(before, after);
  }
  material.fragmentShader = shader;
  material.needsUpdate = true;
}
