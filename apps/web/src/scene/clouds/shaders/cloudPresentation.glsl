// Optional view styling, applied after physical transport and aerial perspective.
// It softens the low-flight horizon by blending the cloud overlay into the
// existing atmospheric background. Weather density and shadow transport stay
// camera-independent.
#define VOLUMETRIC_CLOUD_PRESENTATION
uniform vec4 volumetricHorizonRangesM; // distance start/end, altitude full/disabled
uniform float volumetricHorizonThinning;

float volumetricCloudHorizonVisibility(vec3 physicalCamera, vec3 rayDirection, float distanceM) {
  float altitudeM = length(physicalCamera) - volumetricCloudPlanetRadiusM;
  float lowFlight = 1.0 - smoothstep(volumetricHorizonRangesM.z, volumetricHorizonRangesM.w, altitudeM);
  float horizon = 1.0 - smoothstep(0.04, 0.18,
    abs(dot(normalize(physicalCamera), rayDirection)));
  float distant = smoothstep(volumetricHorizonRangesM.x, volumetricHorizonRangesM.y, distanceM);
  return 1.0 - clamp(volumetricHorizonThinning, 0.0, 1.0) * lowFlight * horizon * distant;
}
