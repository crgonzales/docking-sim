uniform highp sampler2DArray eveLightVolumeTexture;
uniform mat3 eveLightFrame;
uniform float eveLightCapRadius;
uniform vec2 eveLightAltitudeBoundsM;
uniform int eveLightSlices;
uniform float eveLightValid;
uniform float eveLightGeneration;

// Each quantity occupies a disjoint slice range. Array layers require explicit
// interpolation; sampling across the direct/ambient boundary is forbidden.
float eveLookupLight(vec3 p, int quantity, out bool valid) {
  valid = false;
  if (eveLightValid < 0.5) return 1.0;
  float altitude = length(p) - eveCloudPlanetRadiusM;
  if (altitude < eveLightAltitudeBoundsM.x || altitude > eveLightAltitudeBoundsM.y) return 1.0;
  vec3 d = transpose(eveLightFrame) * normalize(p);
  if (d.z < 0.0) return 1.0;
  vec2 q = d.xy / (1.0 + d.z);
  // Keep the bilinear footprint inside the valid disc; edge texels outside
  // the disc are never mistaken for initialized lighting samples.
  float texel = 2.0 * eveLightCapRadius / float(textureSize(eveLightVolumeTexture, 0).x);
  if (length(q) > eveLightCapRadius - 1.5 * texel) return 1.0;
  vec2 uv = 0.5 + q / (2.0 * eveLightCapRadius);
  float z = clamp((altitude - eveLightAltitudeBoundsM.x) /
    (eveLightAltitudeBoundsM.y - eveLightAltitudeBoundsM.x), 0.0, 1.0) * float(eveLightSlices - 1);
  float lower = floor(z);
  float upper = min(lower + 1.0, float(eveLightSlices - 1));
  float offset = float(quantity * eveLightSlices);
  float a = texture(eveLightVolumeTexture, vec3(uv, lower + offset)).r;
  float b = texture(eveLightVolumeTexture, vec3(uv, upper + offset)).r;
  valid = true;
  return clamp(mix(a, b, z - lower), 0.0, 1.0);
}

float eveSunTransmittance(vec3 p, float startM, float footprintM) {
  vec2 interval = eveCloudRayInterval(p, sunDirection, startM);
  if (interval.y <= interval.x) return 1.0;
  vec3 start = p + interval.x * sunDirection;
  // Move the lookup just inside support to absorb Earth-scale float rounding.
  vec3 lookup = p + min(interval.y, interval.x + 2.0) * sunDirection;
  bool valid;
  float cached = eveLookupLight(lookup, 0, valid);
  if (valid) {
    MediaSample entry = sampleCloudMedia(start, footprintM, 0.0, 0.5);
    return exp(-max(0.0, entry.extinction) * min(2.0, interval.y - interval.x)) * cached;
  }
  return eveDirectIntegration(p, sunDirection, startM, 24, footprintM);
}

float eveSkyVisibility(vec3 p, float footprintM) {
  bool valid;
  float cached = eveLookupLight(p, 1, valid);
  return valid ? cached : eveAmbientIntegration(p, 2, 12, footprintM);
}
