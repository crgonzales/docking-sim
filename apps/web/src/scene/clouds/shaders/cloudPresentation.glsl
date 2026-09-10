// Optional view styling, applied after physical transport and aerial perspective.
// It softens the low-flight horizon by blending the cloud overlay into the
// existing atmospheric background. Weather density and shadow transport stay
// camera-independent.
#define EVE_CLOUD_PRESENTATION
uniform vec4 eveHorizonRangesM; // distance start/end, altitude full/disabled
uniform float eveHorizonThinning;

float eveCloudHorizonVisibility(vec3 physicalCamera, vec3 rayDirection, float distanceM) {
  float altitudeM = length(physicalCamera) - eveCloudPlanetRadiusM;
  float lowFlight = 1.0 - smoothstep(eveHorizonRangesM.z, eveHorizonRangesM.w, altitudeM);
  float horizon = 1.0 - smoothstep(0.04, 0.18,
    abs(dot(normalize(physicalCamera), rayDirection)));
  float distant = smoothstep(eveHorizonRangesM.x, eveHorizonRangesM.y, distanceM);
  return 1.0 - clamp(eveHorizonThinning, 0.0, 1.0) * lowFlight * horizon * distant;
}
