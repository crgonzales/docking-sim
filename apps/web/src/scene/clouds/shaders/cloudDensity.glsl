// VOLUMETRIC media hook. This source-only include consumes finite profile tables from
// the WeatherSnapshot bindings. Coverage and typeField are independent maps;
// typeField is blended into one profile before any height curve is evaluated.
// Visual time and motion are caller-owned uniforms. The opt-in path rotates
// physical ECEF lookups into this stable canonical frame.

uniform sampler2D volumetricWeatherCoverageTexture;
uniform sampler2D volumetricWeatherTypeFieldTexture;
uniform sampler2D volumetricWeatherReferenceFieldTexture;
uniform sampler3D volumetricWeatherNoiseTexture;
uniform float volumetricWeatherPlanetRadiusM;
uniform float volumetricWeatherMotionTimeS;
uniform float volumetricWeatherMotionAngleRad;
uniform float volumetricWeatherMotionEnabled;
uniform vec2 volumetricWeatherMapDimensions;
uniform vec2 volumetricWeatherReferenceMapDimensions;
uniform vec3 volumetricWeatherNoiseDimensions;
uniform vec4 volumetricWeatherReferenceBoundsDeg;
uniform float volumetricWeatherReferenceFieldEnabled;

uniform vec4 volumetricCloudBaseAltitudeM;
uniform vec4 volumetricCloudTopAltitudeM;
uniform vec4 volumetricCloudPrimaryNoiseScaleM;
uniform vec4 volumetricCloudDetailNoiseScaleM;
uniform float volumetricCloudPrimaryWorleyMix;
uniform float volumetricCloudDetailSupportMix;
uniform float volumetricCloudErosionWorleyMix;
uniform vec4 volumetricCloudErosionDepth;
uniform vec4 volumetricCloudBaseNoiseThreshold;
uniform vec4 volumetricCloudBaseNoiseSoftness;
uniform float volumetricCloudCoverageEdgeSoftness;
uniform vec4 volumetricCloudErosionThreshold;
uniform vec4 volumetricCloudErosionSoftness;
uniform vec4 volumetricCloudSupportFade01;
uniform vec4 volumetricCloudScatteringCoefficientMInv;
uniform vec4 volumetricCloudAbsorptionCoefficientMInv;
uniform vec4 volumetricCloudPhaseAnisotropyX;
uniform vec4 volumetricCloudPhaseAnisotropyY;
uniform vec4 volumetricCloudPhaseMix;
uniform vec4 volumetricCloudCoverageKnots[4];
uniform vec4 volumetricCloudCoverageValues[4];
uniform vec4 volumetricCloudDensityKnots[4];
uniform vec4 volumetricCloudDensityValues[4];

const int VOLUMETRIC_CLOUD_PROFILE_COUNT = 4;

vec3 volumetricWeatherCanonicalPositionECEFM(const vec3 positionECEFM) {
  if (volumetricWeatherMotionEnabled <= 0.5) return positionECEFM;
  // Inverse of the physical eastward +Z rotation. The same result feeds both
  // authored coverage/type maps and both primary/detail noise domains.
  float cosine = cos(volumetricWeatherMotionAngleRad);
  float sine = sin(volumetricWeatherMotionAngleRad);
  return vec3(
    cosine * positionECEFM.x + sine * positionECEFM.y,
    -sine * positionECEFM.x + cosine * positionECEFM.y,
    positionECEFM.z
  );
}

// Orthonormal rotation plus a fixed physical offset keeps the erosion field in
// ECEF while preventing the primary cube's exact repeat from surviving.
vec3 volumetricDetailNoisePositionECEFM(const vec3 p) {
  return vec3(
    dot(p, vec3(0.36, -0.48, 0.8)) + 17300.0,
    dot(p, vec3(0.8, 0.6, 0.0)) - 29100.0,
    dot(p, vec3(-0.48, 0.64, 0.6)) + 47600.0
  );
}

// Canonical shape terms mirrored by evaluateCloudNoiseShape on the CPU.
vec2 volumetricCloudNoiseShape(const vec4 primaryNoise, const vec4 detailNoise) {
  float primaryBillow = mix(primaryNoise.r, primaryNoise.g, volumetricCloudPrimaryWorleyMix);
  float detailBillow = mix(detailNoise.r, detailNoise.g, volumetricCloudPrimaryWorleyMix);
  float support = mix(primaryBillow, detailBillow, volumetricCloudDetailSupportMix);
  float erosion = mix(detailNoise.a, 1.0 - detailNoise.g, volumetricCloudErosionWorleyMix);
  return clamp(vec2(support, erosion), 0.0, 1.0);
}

float volumetricCurve(const vec4 knots, const vec4 values, const float height01) {
  float h = clamp(height01, 0.0, 1.0);
  if (h <= knots.x) return values.x;
  for (int index = 1; index < 4; ++index) {
    if (h <= knots[index]) {
      float span = max(knots[index] - knots[index - 1], 1e-6);
      return mix(values[index - 1], values[index], (h - knots[index - 1]) / span);
    }
  }
  return values.w;
}

vec2 volumetricWeatherUv(const vec3 positionECEFM) {
  vec3 normal = normalize(positionECEFM);
  float horizontal = length(normal.xy);
  if (horizontal < 1e-6) return vec2(0.5, normal.z < 0.0 ? 0.0 : 1.0);
  // ECEF +Z is north and therefore maps to V=1. Longitude wraps in U.
  float longitude = atan(normal.y, normal.x);
  return vec2(fract(longitude * RECIPROCAL_PI2 + 0.5), asin(normal.z) * RECIPROCAL_PI + 0.5);
}

float volumetricWeatherMapLod(
  const vec3 positionECEFM,
  const float footprintM,
  const float weatherLod,
  const vec2 dimensions,
  const vec2 angularSpanRad
) {
  // weatherLod is the host's angular/detail request. The physical footprint
  // is converted independently using actual map dimensions; the horizontal
  // clamp keeps longitude filtering conservative at both poles.
  float radiusM = max(length(positionECEFM), 1.0);
  float horizontal = max(length(normalize(positionECEFM).xy), 0.02);
  float angularFootprint = max(footprintM, 0.0) / radiusM;
  float texelsX = angularFootprint * dimensions.x / (angularSpanRad.x * horizontal);
  float texelsY = angularFootprint * dimensions.y / angularSpanRad.y;
  float angularLod = max(0.0, log2(max(1.0, max(texelsX, texelsY))));
  return max(0.0, weatherLod) + angularLod;
}

vec2 volumetricSeededWeatherFront(const vec3 canonicalPositionECEFM) {
  vec3 normal = normalize(canonicalPositionECEFM);
  const float seed = 8.5896983;
  // Restrict continuous 3D waves to the sphere; longitude seams and poles agree.
  float broad = 0.5 + 0.5 * sin(dot(normal, vec3(9.0, 31.0, 13.0)) + seed
    + 0.8 * sin(dot(normal, vec3(17.0, -11.0, 7.0))));
  float secondary = 0.5 + 0.5 * sin(dot(normal, vec3(37.0, -19.0, -23.0)) + 1.7 + seed * 0.37);
  float meridional = 0.5 + 0.5 * sin(dot(normal, vec3(5.0, 8.0, 13.0)) + 0.91);
  float organized = smoothstep(0.32, 0.72, broad);
  float broken = 0.65 + 0.35 * secondary;
  return clamp(vec2(
    0.06 + 0.85 * organized * broken + 0.03 * meridional,
    0.04 + 0.78 * organized + 0.12 * meridional + 0.04 * secondary
  ), 0.0, 1.0);
}

vec2 volumetricApplySeededWeatherFront(
  const vec2 authoredField,
  const vec3 canonicalPositionECEFM
) {
  if (volumetricWeatherMotionEnabled <= 0.5) return authoredField;
  vec2 front = volumetricSeededWeatherFront(canonicalPositionECEFM);
  return clamp(vec2(
    authoredField.x * (0.12 + 1.5 * front.x),
    authoredField.y * 0.55 + front.y * 0.45
  ), 0.0, 1.0);
}

vec2 volumetricSampleWeatherCanonical(
  const vec3 canonicalPositionECEFM,
  const float footprintM,
  const float weatherLod
) {
  vec2 uv = volumetricWeatherUv(canonicalPositionECEFM);
  float mapLod = volumetricWeatherMapLod(canonicalPositionECEFM, footprintM, weatherLod,
    volumetricWeatherMapDimensions, vec2(2.0 * PI, PI));
  vec2 globalField = vec2(
    textureLod(volumetricWeatherCoverageTexture, uv, mapLod).r,
    textureLod(volumetricWeatherTypeFieldTexture, uv, mapLod).r
  );
  vec2 selectedField = globalField;
  if (volumetricWeatherReferenceFieldEnabled <= 0.5) {
    return volumetricApplySeededWeatherFront(selectedField, canonicalPositionECEFM);
  }

  // The reference asset is authored south-first and is uploaded without a
  // second vertical flip. Global assets are north-first and are oriented once
  // by their loader before reaching this shared sampler. Empty support refers
  // to sampled zero coverage; the finite bilinear/mip footprint can mix covered
  // texels across an authored clear boundary. No analytic zone exclusions here.
  float longitudeDeg = (uv.x - 0.5) * 360.0;
  float latitudeDeg = (uv.y - 0.5) * 180.0;
  vec2 referenceUv = (vec2(longitudeDeg, latitudeDeg) - volumetricWeatherReferenceBoundsDeg.xy) /
    max(volumetricWeatherReferenceBoundsDeg.zw - volumetricWeatherReferenceBoundsDeg.xy, vec2(1e-6));
  float inside = step(0.0, referenceUv.x) * step(referenceUv.x, 1.0) *
    step(0.0, referenceUv.y) * step(referenceUv.y, 1.0);
  if (inside <= 0.0) return volumetricApplySeededWeatherFront(selectedField, canonicalPositionECEFM);
  float edge = min(min(referenceUv.x, 1.0 - referenceUv.x), min(referenceUv.y, 1.0 - referenceUv.y));
  float boundaryBlend = inside * smoothstep(0.0, 0.08, edge);
  // The local map covers only its authored angular bounds. Reusing the global
  // LOD undersamples its much finer physical texels, despite fewer total pixels.
  vec2 referenceSpanRad = radians(max(
    volumetricWeatherReferenceBoundsDeg.zw - volumetricWeatherReferenceBoundsDeg.xy, vec2(1e-6)));
  float referenceLod = volumetricWeatherMapLod(canonicalPositionECEFM, footprintM, weatherLod,
    volumetricWeatherReferenceMapDimensions, referenceSpanRad);
  vec2 referenceField = textureLod(volumetricWeatherReferenceFieldTexture, referenceUv, referenceLod).rg;
  selectedField = mix(globalField, referenceField, boundaryBlend);
  return volumetricApplySeededWeatherFront(selectedField, canonicalPositionECEFM);
}

vec2 volumetricSampleWeather(
  const vec3 positionECEFM,
  const float footprintM,
  const float weatherLod
) {
  return volumetricSampleWeatherCanonical(
    volumetricWeatherCanonicalPositionECEFM(positionECEFM), footprintM, weatherLod);
}

// Stock-equivalent signature. Every production marcher calls this same hook.
MediaSample sampleCloudMedia(
  const vec3 positionECEFM,
  const float footprintM,
  const float weatherLod,
  const float jitter
) {
  MediaSample media;
  media.density = 0.0;
  media.weight = vec4(0.0);
  media.scattering = 0.0;
  media.extinction = 0.0;
  media.phaseAnisotropy = vec2(0.0);
  media.phaseMix = 0.0;

  vec3 canonicalPositionECEFM = volumetricWeatherCanonicalPositionECEFM(positionECEFM);
  vec2 weather = volumetricSampleWeatherCanonical(canonicalPositionECEFM, footprintM, weatherLod);
  float coverage = clamp(weather.x, 0.0, 1.0);
  if (coverage <= 0.0) return media;

  float typeScalar = clamp(weather.y, 0.0, 1.0) * float(VOLUMETRIC_CLOUD_PROFILE_COUNT - 1);
  int leftIndex = min(VOLUMETRIC_CLOUD_PROFILE_COUNT - 1, int(floor(typeScalar)));
  int rightIndex = min(VOLUMETRIC_CLOUD_PROFILE_COUNT - 1, leftIndex + 1);
  float typeBlend = typeScalar - float(leftIndex);

  // Interpolate the profile tables first, including knot positions. Both CPU
  // fixtures and this hook evaluate the resulting curves exactly once.
  float baseAltitudeM = mix(volumetricCloudBaseAltitudeM[leftIndex], volumetricCloudBaseAltitudeM[rightIndex], typeBlend);
  float topAltitudeM = mix(volumetricCloudTopAltitudeM[leftIndex], volumetricCloudTopAltitudeM[rightIndex], typeBlend);
  float heightM = length(positionECEFM) - volumetricWeatherPlanetRadiusM;
  float height01 = (heightM - baseAltitudeM) / max(topAltitudeM - baseAltitudeM, 1e-6);
  if (height01 <= 0.0 || height01 >= 1.0) return media;

  vec4 coverageKnots = mix(volumetricCloudCoverageKnots[leftIndex], volumetricCloudCoverageKnots[rightIndex], typeBlend);
  vec4 coverageValues = mix(volumetricCloudCoverageValues[leftIndex], volumetricCloudCoverageValues[rightIndex], typeBlend);
  vec4 densityKnots = mix(volumetricCloudDensityKnots[leftIndex], volumetricCloudDensityKnots[rightIndex], typeBlend);
  vec4 densityValues = mix(volumetricCloudDensityValues[leftIndex], volumetricCloudDensityValues[rightIndex], typeBlend);
  float coverageCurve = clamp(volumetricCurve(coverageKnots, coverageValues, height01), 0.0, 1.0);
  float densityCurve = clamp(volumetricCurve(densityKnots, densityValues, height01), 0.0, 1.0);
  float heightCoverage = coverage * coverageCurve;
  if (heightCoverage <= 0.0) return media;

  // Blend fixed domains, never their coordinate scale. Interpolating the
  // divisor of Earth-sized ECEF coordinates turns a gentle type gradient into
  // thousands of texture wraps and produces streaks instead of cloud shapes.
  vec2 leftScalesM = max(vec2(
    volumetricCloudPrimaryNoiseScaleM[leftIndex], volumetricCloudDetailNoiseScaleM[leftIndex]), vec2(1.0));
  vec2 rightScalesM = max(vec2(
    volumetricCloudPrimaryNoiseScaleM[rightIndex], volumetricCloudDetailNoiseScaleM[rightIndex]), vec2(1.0));
  vec2 leftLod = max(vec2(0.0), log2(max(vec2(1.0),
    max(footprintM, 0.0) * volumetricWeatherNoiseDimensions.x / leftScalesM)));
  vec2 rightLod = max(vec2(0.0), log2(max(vec2(1.0),
    max(footprintM, 0.0) * volumetricWeatherNoiseDimensions.x / rightScalesM)));
  vec3 detailPositionECEFM = volumetricDetailNoisePositionECEFM(canonicalPositionECEFM);
  vec4 primaryNoise = textureLod(
    volumetricWeatherNoiseTexture, fract(canonicalPositionECEFM / leftScalesM.x), leftLod.x);
  vec4 detailNoise = textureLod(
    volumetricWeatherNoiseTexture, fract(detailPositionECEFM / leftScalesM.y), leftLod.y);
  if (typeBlend > 0.0) {
    primaryNoise = mix(primaryNoise, textureLod(
      volumetricWeatherNoiseTexture, fract(canonicalPositionECEFM / rightScalesM.x), rightLod.x), typeBlend);
    detailNoise = mix(detailNoise, textureLod(
      volumetricWeatherNoiseTexture, fract(detailPositionECEFM / rightScalesM.y), rightLod.y), typeBlend);
  }
  vec2 noiseShape = volumetricCloudNoiseShape(primaryNoise, detailNoise);

  // Retained uniform names now denote the support-noise normalization centre and
  // half-width. Coverage-edge softness is an independent authored uniform.
  float noiseCenter = mix(volumetricCloudBaseNoiseThreshold[leftIndex], volumetricCloudBaseNoiseThreshold[rightIndex], typeBlend);
  float noiseHalfWidth = mix(volumetricCloudBaseNoiseSoftness[leftIndex], volumetricCloudBaseNoiseSoftness[rightIndex], typeBlend);
  float erosionThreshold = mix(volumetricCloudErosionThreshold[leftIndex], volumetricCloudErosionThreshold[rightIndex], typeBlend);
  float erosionSoftness = mix(volumetricCloudErosionSoftness[leftIndex], volumetricCloudErosionSoftness[rightIndex], typeBlend);
  float erosionDepth = mix(volumetricCloudErosionDepth[leftIndex], volumetricCloudErosionDepth[rightIndex], typeBlend);
  float normalizedNoise = clamp(
    (noiseShape.x - (noiseCenter - noiseHalfWidth)) /
      max(2.0 * noiseHalfWidth, 1e-6), 0.0, 1.0
  );
  float baseShape = smoothstep(
    1.0 - heightCoverage - volumetricCloudCoverageEdgeSoftness,
    1.0 - heightCoverage + volumetricCloudCoverageEdgeSoftness,
    normalizedNoise
  );
  float erosionMask = smoothstep(
    erosionThreshold - erosionSoftness,
    erosionThreshold + erosionSoftness,
    noiseShape.y
  );
  float shapedNoise = clamp(baseShape - erosionDepth * erosionMask, 0.0, 1.0);
  float supportFade = mix(volumetricCloudSupportFade01[leftIndex], volumetricCloudSupportFade01[rightIndex], typeBlend);
  float supportTaper = smoothstep(0.0, supportFade, height01) *
    (1.0 - smoothstep(1.0 - supportFade, 1.0, height01));
  float density = densityCurve * shapedNoise * supportTaper;
  if (density <= 0.0) return media;

  float scattering = mix(volumetricCloudScatteringCoefficientMInv[leftIndex], volumetricCloudScatteringCoefficientMInv[rightIndex], typeBlend);
  float absorption = mix(volumetricCloudAbsorptionCoefficientMInv[leftIndex], volumetricCloudAbsorptionCoefficientMInv[rightIndex], typeBlend);
  media.density = density;
  media.weight[leftIndex] = 1.0 - typeBlend;
  media.weight[rightIndex] += typeBlend;
  media.scattering = density * scattering;
  media.extinction = density * (scattering + absorption);
  media.phaseAnisotropy = vec2(
    mix(volumetricCloudPhaseAnisotropyX[leftIndex], volumetricCloudPhaseAnisotropyX[rightIndex], typeBlend),
    mix(volumetricCloudPhaseAnisotropyY[leftIndex], volumetricCloudPhaseAnisotropyY[rightIndex], typeBlend)
  );
  media.phaseMix = mix(volumetricCloudPhaseMix[leftIndex], volumetricCloudPhaseMix[rightIndex], typeBlend);
  return media;
}
