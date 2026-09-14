uniform highp sampler2DArray volumetricLightVolumeTexture;
uniform mat3 volumetricLightFrame;
uniform float volumetricLightCapRadius;
uniform vec2 volumetricLightAltitudeBoundsM;
uniform int volumetricLightSlices;
uniform float volumetricLightValid;
uniform float volumetricLightGeneration;

// Each quantity occupies a disjoint slice range. Array layers require explicit
// interpolation; sampling across the direct/ambient boundary is forbidden.
float volumetricLookupLight(vec3 p, int quantity, out bool valid) {
  valid = false;
  if (volumetricLightValid < 0.5) return 1.0;
  float altitude = length(p) - volumetricCloudPlanetRadiusM;
  if (altitude < volumetricLightAltitudeBoundsM.x || altitude > volumetricLightAltitudeBoundsM.y) return 1.0;
  vec3 d = transpose(volumetricLightFrame) * normalize(p);
  if (d.z < 0.0) return 1.0;
  vec2 q = d.xy / (1.0 + d.z);
  // Keep the bilinear footprint inside the valid disc; edge texels outside
  // the disc are never mistaken for initialized lighting samples.
  float texel = 2.0 * volumetricLightCapRadius / float(textureSize(volumetricLightVolumeTexture, 0).x);
  if (length(q) > volumetricLightCapRadius - 1.5 * texel) return 1.0;
  vec2 uv = 0.5 + q / (2.0 * volumetricLightCapRadius);
  float z = clamp((altitude - volumetricLightAltitudeBoundsM.x) /
    (volumetricLightAltitudeBoundsM.y - volumetricLightAltitudeBoundsM.x), 0.0, 1.0) * float(volumetricLightSlices - 1);
  float lower = floor(z);
  float upper = min(lower + 1.0, float(volumetricLightSlices - 1));
  float offset = float(quantity * volumetricLightSlices);
  float a = texture(volumetricLightVolumeTexture, vec3(uv, lower + offset)).r;
  float b = texture(volumetricLightVolumeTexture, vec3(uv, upper + offset)).r;
  valid = true;
  return clamp(mix(a, b, z - lower), 0.0, 1.0);
}

float volumetricSunTransmittance(vec3 p, float startM, float footprintM) {
  vec2 interval = volumetricCloudRayInterval(p, sunDirection, startM);
  if (interval.y <= interval.x) return 1.0;
  vec3 start = p + interval.x * sunDirection;
  // Move the lookup just inside support to absorb Earth-scale float rounding.
  vec3 lookup = p + min(interval.y, interval.x + 2.0) * sunDirection;
  bool valid;
  float cached = volumetricLookupLight(lookup, 0, valid);
  if (valid) {
    MediaSample entry = sampleCloudMedia(start, footprintM, 0.0, 0.5);
    return exp(-max(0.0, entry.extinction) * min(2.0, interval.y - interval.x)) * cached;
  }
  return volumetricDirectIntegration(p, sunDirection, startM, 24, footprintM);
}

float volumetricSkyVisibility(vec3 p, float footprintM) {
  bool valid;
  float cached = volumetricLookupLight(p, 1, valid);
  return valid ? cached : volumetricAmbientIntegration(p, 2, 12, footprintM);
}
