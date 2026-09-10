// A curved, preintegrated representation of the SAME medium as the near view.
// Its mip chain averages finished opacity and weighted moments, never density
// noise before the nonlinear coverage threshold. Lighting remains live.
#define EVE_DISTANT_CLOUDS
uniform sampler2D eveColumnTexture;
uniform vec2 eveColumnDimensions;
uniform float eveColumnReady;
uniform float eveColumnGeneration;

// Implemented by the host immediately after its lighting hook.
float cloudSunOpticalDepth(const vec3 position, const float footprintM,
  const float mipLevel, const float jitter, out CloudLightingSample lighting);

vec4 eveReadColumn(const vec3 p, const float footprintM) {
  float lod = eveWeatherMapLod(p, footprintM, 0.0,
    eveColumnDimensions, vec2(2.0 * PI, PI));
  return textureLod(eveColumnTexture, eveWeatherUv(p), lod);
}

// Height stays conditional on coverage through filtering; an empty texel must
// not drag its neighbor's cloud altitude down to sea level.
float eveColumnHeightM(const vec4 column) {
  return column.r > 1e-5 ? 1000.0 * column.g / column.r : 0.0;
}

float eveColumnHalfChord(const float radius, const float impactRadius) {
  // Factor r^2 - b^2 instead of subtracting Earth-sized squares as the generic
  // raySphere helper does. Callers test support before using the clamped root.
  return sqrt(max(0.0, (radius - impactRadius) * (radius + impactRadius)));
}

float eveColumnRadius(const vec3 position) {
  // Avoid squaring Earth-sized components before the norm. Sub-metre radius
  // roundoff is amplified into tens of metres of depth for grazing rays.
  float scale = max(max(abs(position.x), abs(position.y)), abs(position.z));
  vec3 scaled = position / max(scale, 1.0);
  return scale * sqrt(dot(scaled, scaled));
}

vec2 eveColumnShellInterval(
  const float closestDistance, const float impactRadius,
  const vec2 heightsM, const int crossing
) {
  float outerRadius = eveWeatherPlanetRadiusM + heightsM.y;
  if (outerRadius <= impactRadius || heightsM.y <= heightsM.x) return vec2(-1.0);
  float outerChord = eveColumnHalfChord(outerRadius, impactRadius);
  float innerChord = eveColumnHalfChord(eveWeatherPlanetRadiusM + heightsM.x, impactRadius);
  // The closest-approach plane divides a grazing chord into disjoint halves,
  // including when the ray never reaches the inner sphere. Never switch roots
  // just because a first intersection is negative (the camera may be inside).
  return crossing == 0
    ? closestDistance - vec2(outerChord, innerChord)
    : closestDistance + vec2(innerChord, outerChord);
}

vec4 eveRenderDistantCrossing(
  const vec3 physicalOrigin, const vec3 rayDirection, const vec2 rayNearFar,
  const float closestDistance, const float impactRadius,
  const vec2 searchInterval, const int crossing,
  const float cosTheta, const float jitter,
  out float frontDepth, out float secondaryOpticalDepth
) {
  frontDepth = -1.0;
  secondaryOpticalDepth = 0.0;
  // Search from each OUTER support crossing, not the global mean sphere:
  // a ray above that mean can still intersect a high cirrus column.
  float distanceM = crossing == 0 ? searchInterval.x : searchInterval.y;
  vec2 interval = searchInterval;
  vec4 column = vec4(0.0);
  float footprintM = 0.0;
  vec2 weather = vec2(0.0);
  // Three atlas projections and at most ONE 16-sample canonical radial integral
  // per crossing. An empty column cannot prevent evaluation of the other half.
  for (int i = 0; i < 4; ++i) {
    vec3 p = physicalOrigin + distanceM * rayDirection;
    footprintM = max(cloudEntryFootprintM, (rayNearFar.x + distanceM) * cloudRaySlope);
    column = eveReadColumn(p, footprintM);
    if (i == 3) {
      // Recover subtexel coverage from the SAME medium, retaining the existing
      // footprint transition into the preintegrated opacity mip chain.
      float atlasTexelM = PI * eveWeatherPlanetRadiusM / eveColumnDimensions.y;
      float detailWeight = 1.0 - smoothstep(0.4 * atlasTexelM, atlasTexelM, footprintM);
      if (detailWeight > 0.0) {
        column = mix(column, eveIntegrateRadialColumn(normalize(p), 16, footprintM), detailWeight);
      }
    }
    weather = eveSampleWeather(p, footprintM, 0.0);
    float type = clamp(weather.y, 0.0, 1.0) * float(EVE_CLOUD_PROFILE_COUNT - 1);
    int left = min(EVE_CLOUD_PROFILE_COUNT - 1, int(floor(type)));
    int right = min(EVE_CLOUD_PROFILE_COUNT - 1, left + 1);
    vec2 heightsM = vec2(
      mix(eveCloudBaseAltitudeM[left], eveCloudBaseAltitudeM[right], fract(type)),
      mix(eveCloudTopAltitudeM[left], eveCloudTopAltitudeM[right], fract(type)));
    vec2 support = eveColumnShellInterval(closestDistance, impactRadius, heightsM, crossing);
    interval = vec2(max(searchInterval.x, support.x), min(searchInterval.y, support.y));
    if (interval.y <= interval.x) return vec4(0.0);
    // The first-event moment is a representative depth, NOT a support bound.
    // If the ray grazes above it, use the midpoint of the actual shell segment.
    // The same finite segment handles a scene-depth cut through a column.
    float heightM = column.r > 1e-5 ? eveColumnHeightM(column) : 0.5 * (heightsM.x + heightsM.y);
    float radius = eveWeatherPlanetRadiusM + heightM;
    float projected = closestDistance + (crossing == 0 ? -1.0 : 1.0) * eveColumnHalfChord(radius, impactRadius);
    distanceM = radius > impactRadius && projected >= interval.x && projected <= interval.y
      ? projected : 0.5 * (interval.x + interval.y);
  }
  float verticalOpacity = clamp(column.r, 0.0, 1.0);
  if (verticalOpacity <= 1e-5) return vec4(0.0);
  vec3 p = physicalOrigin + distanceM * rayDirection;
  float thicknessM = max(1.0, 1000.0 * column.b / verticalOpacity);
  float albedo = clamp(column.a / verticalOpacity, 0.0, 1.0);
  // Exact finite shell length per half: no divergent 1/cos(theta), no doubled
  // tangent segment, and opacity tends to zero as the outer chord vanishes.
  float slant = (interval.y - interval.x) / thicknessM;
  float tau = -log(max(1.0 - verticalOpacity, 1e-5));
  float opacity = 1.0 - exp(-tau * slant);

  weather = eveSampleWeather(p, footprintM, 0.0);
  float type = clamp(weather.y, 0.0, 1.0) * float(EVE_CLOUD_PROFILE_COUNT - 1);
  int left = min(EVE_CLOUD_PROFILE_COUNT - 1, int(floor(type)));
  int right = min(EVE_CLOUD_PROFILE_COUNT - 1, left + 1);
  float blend = fract(type);
  vec2 anisotropy = vec2(
    mix(eveCloudPhaseAnisotropyX[left], eveCloudPhaseAnisotropyX[right], blend),
    mix(eveCloudPhaseAnisotropyY[left], eveCloudPhaseAnisotropyY[right], blend));
  float phaseMix = mix(eveCloudPhaseMix[left], eveCloudPhaseMix[right], blend);
  vec3 atmospherePoint = p + altitudeCorrection;
  vec3 skyIrradiance;
  // A single orbital lookup is cheap enough to retain the local terminator;
  // interpolating the camera's irradiance across an entire planet is not.
  vec3 sunIrradiance = GetSunAndSkyScalarIrradiance(
    atmospherePoint * METER_TO_LENGTH_UNIT, sunDirection, skyIrradiance);
  CloudLightingSample lighting;
  float opticalDepth = cloudSunOpticalDepth(atmospherePoint, footprintM, 0.0, jitter, lighting);
  // Retain the local atmosphere irradiance here; the lower-quality near path's
  // lighting sample may use camera-vertex irradiance over an entire hemisphere.
  skyIrradiance *= eveSkyVisibility(p, footprintM);
  vec3 radiance = sunIrradiance * approximateMultipleScattering(
    opticalDepth, cosTheta, anisotropy, phaseMix);
  radiance += skyIrradiance * RECIPROCAL_PI4 * skyLightScale;
  secondaryOpticalDepth = opticalDepth;
  frontDepth = distanceM;
  return vec4(max(vec3(0.0), radiance * albedo) * opacity, opacity);
}

vec4 renderDistantClouds(
  const vec3 rayOrigin, const vec3 rayDirection, const vec2 rayNearFar,
  const float cosTheta, const float jitter,
  out float frontDepth, out ivec3 sampleCount,
  out float secondaryOpticalDepth, out vec3 composedLighting
) {
  frontDepth = -1.0;
  sampleCount = ivec3(0);
  secondaryOpticalDepth = 0.0;
  composedLighting = vec3(0.0);
  if (eveColumnReady < 0.5) return vec4(0.0);
  vec3 physicalOrigin = rayOrigin - altitudeCorrection;
  float closestDistance = -dot(physicalOrigin, rayDirection);
  float impactRadius = eveColumnRadius(physicalOrigin + closestDistance * rayDirection);
  float endDistance = rayNearFar.y - rayNearFar.x;
  // Scene depth is already relative to the host's entry point. Also stop at
  // the physical solid planet, even if no terrain depth was written there.
  if (eveColumnRadius(physicalOrigin) < eveWeatherPlanetRadiusM) return vec4(0.0);
  if (impactRadius <= eveWeatherPlanetRadiusM) {
    float groundDistance = closestDistance - eveColumnHalfChord(eveWeatherPlanetRadiusM, impactRadius);
    if (groundDistance >= 0.0) endDistance = min(endDistance, groundDistance);
  }
  vec4 result = vec4(0.0);
  float weightedDepth = 0.0;
  for (int crossing = 0; crossing < 2; ++crossing) {
    vec2 support = eveColumnShellInterval(closestDistance, impactRadius, vec2(minHeight, maxHeight), crossing);
    vec2 interval = vec2(max(0.0, support.x), min(endDistance, support.y));
    if (interval.y <= interval.x) continue;
    float depth, opticalDepth;
    vec4 layer = eveRenderDistantCrossing(physicalOrigin, rayDirection, rayNearFar,
      closestDistance, impactRadius, interval, crossing, cosTheta, jitter, depth, opticalDepth);
    float weight = (1.0 - result.a) * layer.a;
    if (weight <= 0.0) continue;
    result.rgb += (1.0 - result.a) * layer.rgb;
    result.a += weight;
    weightedDepth += depth * weight;
    secondaryOpticalDepth += opticalDepth * weight;
    ++sampleCount.x;
    if (result.a >= 1.0) break;
  }
  if (result.a > 0.0) {
    frontDepth = weightedDepth / result.a;
    secondaryOpticalDepth /= result.a;
    composedLighting = result.rgb / result.a;
  }
  // Host applies aerial perspective ONCE at this visible-opacity-weighted
  // representative depth, then crossfades the near/far alternatives once.
  return result;
}
