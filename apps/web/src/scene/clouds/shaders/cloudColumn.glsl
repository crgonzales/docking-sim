// Equirectangular radial-column preparation for the distant cloud path.
// Requires the canonical cloudDensity.glsl include (volumetricSampleWeather,
// sampleCloudMedia, profile tables and the VOLUMETRIC cloud media ABI).
//
// Payload channels are all linearly mip-safe:
//   R = column opacity (1 - T)
//   G = opacity-weighted first-event altitude, kilometres
//   B = opacity-weighted authored profile thickness, kilometres
//   A = opacity-weighted single-scattering albedo
// Consumers recover conditional means by dividing GBA by R when R > 0.


const int VOLUMETRIC_COLUMN_MAX_SEGMENTS = 48;

vec3 volumetricColumnDirectionFromUv(const vec2 uv) {
  float longitude = (uv.x - 0.5) * (2.0 * PI);
  float latitude = (uv.y - 0.5) * PI;
  float latitudeRadius = cos(latitude);
  // This is the inverse of volumetricWeatherUv: north (+Z) is V=1 and longitude
  // follows the same -X seam / +X midpoint convention.
  return vec3(
    latitudeRadius * cos(longitude),
    latitudeRadius * sin(longitude),
    sin(latitude)
  );
}

vec4 volumetricIntegrateRadialColumn(const vec3 radial, const int requestedSegments, const float footprintM) {
  vec2 weather = volumetricSampleWeather(
    radial * volumetricWeatherPlanetRadiusM,
    footprintM,
    0.0
  );
  float coverage = clamp(weather.x, 0.0, 1.0);
  if (coverage <= 0.0) {
    return vec4(0.0);
  }

  // Restrict every column to its sampled, interpolated authored profile.
  // Thus all 32/48 midpoint samples resolve even thin high-altitude profiles
  // instead of being spent across the complete multi-profile support range.
  float typeScalar = clamp(weather.y, 0.0, 1.0) *
    float(VOLUMETRIC_CLOUD_PROFILE_COUNT - 1);
  int leftIndex = min(VOLUMETRIC_CLOUD_PROFILE_COUNT - 1, int(floor(typeScalar)));
  int rightIndex = min(VOLUMETRIC_CLOUD_PROFILE_COUNT - 1, leftIndex + 1);
  float typeBlend = typeScalar - float(leftIndex);
  float baseAltitudeM = mix(
    volumetricCloudBaseAltitudeM[leftIndex],
    volumetricCloudBaseAltitudeM[rightIndex],
    typeBlend
  );
  float topAltitudeM = mix(
    volumetricCloudTopAltitudeM[leftIndex],
    volumetricCloudTopAltitudeM[rightIndex],
    typeBlend
  );
  float thicknessM = topAltitudeM - baseAltitudeM;
  if (thicknessM <= 0.0) {
    return vec4(0.0);
  }

  int segmentCount = clamp(requestedSegments, 1, VOLUMETRIC_COLUMN_MAX_SEGMENTS);
  float segmentLengthM = thicknessM / float(segmentCount);
  float transmittance = 1.0;
  vec3 weightedMoments = vec3(0.0);

  // Integrate from space toward the surface. Each segment uses the analytical
  // Beer solution for constant midpoint media, and its lost transmittance is
  // the probability weight of the first event in that segment.
  for (int segment = 0; segment < VOLUMETRIC_COLUMN_MAX_SEGMENTS; ++segment) {
    if (segment >= segmentCount) break;
    float altitudeM = topAltitudeM -
      (float(segment) + 0.5) * segmentLengthM;
    MediaSample media = sampleCloudMedia(
      radial * (volumetricWeatherPlanetRadiusM + altitudeM),
      footprintM,
      0.0,
      0.5
    );
    float extinctionMInv = max(media.extinction, 0.0);
    if (extinctionMInv <= 0.0) continue;

    float segmentTransmittance = exp(-extinctionMInv * segmentLengthM);
    float eventOpacity = transmittance * (1.0 - segmentTransmittance);
    float singleScatteringAlbedo = clamp(
      max(media.scattering, 0.0) / extinctionMInv,
      0.0,
      1.0
    );
    float tau = extinctionMInv * segmentLengthM;
    float firstFraction = tau < 0.01 ? 0.5 - tau / 12.0
      : 1.0 / tau - segmentTransmittance / max(1.0 - segmentTransmittance, 1e-20);
    float firstAltitudeM = topAltitudeM - (float(segment) + firstFraction) * segmentLengthM;
    weightedMoments += eventOpacity * vec3(
      firstAltitudeM * 0.001,
      thicknessM * 0.001,
      singleScatteringAlbedo
    );
    transmittance *= segmentTransmittance;
  }

  float opacity = clamp(1.0 - transmittance, 0.0, 1.0);
  // Preserve the exact all-zero empty sentinel even when a covered weather
  // texel has no density support after canonical noise and erosion evaluation.
  return opacity > 0.0
    ? vec4(opacity, max(weightedMoments, vec3(0.0)))
    : vec4(0.0);
}

