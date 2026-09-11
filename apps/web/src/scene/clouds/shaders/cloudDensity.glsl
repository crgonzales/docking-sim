// EVE media hook. This source-only include consumes finite profile tables from
// the WeatherSnapshot bindings. Coverage and typeField are independent maps;
// typeField is blended into one profile before any height curve is evaluated.
// Visual time and motion are caller-owned uniforms. The opt-in path rotates
// physical ECEF lookups into this stable canonical frame.

uniform sampler2D eveWeatherCoverageTexture;
uniform sampler2D eveWeatherTypeFieldTexture;
uniform sampler2D eveWeatherReferenceFieldTexture;
uniform sampler3D eveWeatherNoiseTexture;
uniform float eveWeatherPlanetRadiusM;
uniform float eveWeatherMotionTimeS;
uniform float eveWeatherMotionAngleRad;
uniform float eveWeatherMotionEnabled;
uniform vec2 eveWeatherMapDimensions;
uniform vec2 eveWeatherReferenceMapDimensions;
uniform vec3 eveWeatherNoiseDimensions;
uniform vec4 eveWeatherReferenceBoundsDeg;
uniform float eveWeatherReferenceFieldEnabled;

uniform vec4 eveCloudBaseAltitudeM;
uniform vec4 eveCloudTopAltitudeM;
uniform vec4 eveCloudPrimaryNoiseScaleM;
uniform vec4 eveCloudDetailNoiseScaleM;
uniform float eveCloudPrimaryWorleyMix;
uniform float eveCloudDetailSupportMix;
uniform float eveCloudErosionWorleyMix;
uniform vec4 eveCloudErosionDepth;
uniform vec4 eveCloudBaseNoiseThreshold;
uniform vec4 eveCloudBaseNoiseSoftness;
uniform float eveCloudCoverageEdgeSoftness;
uniform vec4 eveCloudErosionThreshold;
uniform vec4 eveCloudErosionSoftness;
uniform vec4 eveCloudSupportFade01;
uniform vec4 eveCloudScatteringCoefficientMInv;
uniform vec4 eveCloudAbsorptionCoefficientMInv;
uniform vec4 eveCloudPhaseAnisotropyX;
uniform vec4 eveCloudPhaseAnisotropyY;
uniform vec4 eveCloudPhaseMix;
uniform vec4 eveCloudCoverageKnots[4];
uniform vec4 eveCloudCoverageValues[4];
uniform vec4 eveCloudDensityKnots[4];
uniform vec4 eveCloudDensityValues[4];

const int EVE_CLOUD_PROFILE_COUNT = 4;

vec3 eveWeatherCanonicalPositionECEFM(const vec3 positionECEFM) {
  if (eveWeatherMotionEnabled <= 0.5) return positionECEFM;
  // Inverse of the physical eastward +Z rotation. The same result feeds both
  // authored coverage/type maps and both primary/detail noise domains.
  float cosine = cos(eveWeatherMotionAngleRad);
  float sine = sin(eveWeatherMotionAngleRad);
  return vec3(
    cosine * positionECEFM.x + sine * positionECEFM.y,
    -sine * positionECEFM.x + cosine * positionECEFM.y,
    positionECEFM.z
  );
}

// Orthonormal rotation plus a fixed physical offset keeps the erosion field in
// ECEF while preventing the primary cube's exact repeat from surviving.
vec3 eveDetailNoisePositionECEFM(const vec3 p) {
  return vec3(
    dot(p, vec3(0.36, -0.48, 0.8)) + 17300.0,
    dot(p, vec3(0.8, 0.6, 0.0)) - 29100.0,
    dot(p, vec3(-0.48, 0.64, 0.6)) + 47600.0
  );
}

// Canonical shape terms mirrored by evaluateCloudNoiseShape on the CPU.
vec2 eveCloudNoiseShape(const vec4 primaryNoise, const vec4 detailNoise) {
  float primaryBillow = mix(primaryNoise.r, primaryNoise.g, eveCloudPrimaryWorleyMix);
  float detailBillow = mix(detailNoise.r, detailNoise.g, eveCloudPrimaryWorleyMix);
  float support = mix(primaryBillow, detailBillow, eveCloudDetailSupportMix);
  float erosion = mix(detailNoise.a, 1.0 - detailNoise.g, eveCloudErosionWorleyMix);
  return clamp(vec2(support, erosion), 0.0, 1.0);
}

float eveCurve(const vec4 knots, const vec4 values, const float height01) {
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

vec2 eveWeatherUv(const vec3 positionECEFM) {
  vec3 normal = normalize(positionECEFM);
  float horizontal = length(normal.xy);
  if (horizontal < 1e-6) return vec2(0.5, normal.z < 0.0 ? 0.0 : 1.0);
  // ECEF +Z is north and therefore maps to V=1. Longitude wraps in U.
  float longitude = atan(normal.y, normal.x);
  return vec2(fract(longitude * RECIPROCAL_PI2 + 0.5), asin(normal.z) * RECIPROCAL_PI + 0.5);
}

float eveWeatherMapLod(
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

vec2 eveSeededWeatherFront(const vec3 canonicalPositionECEFM) {
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

vec2 eveApplySeededWeatherFront(
  const vec2 authoredField,
  const vec3 canonicalPositionECEFM
) {
  if (eveWeatherMotionEnabled <= 0.5) return authoredField;
  vec2 front = eveSeededWeatherFront(canonicalPositionECEFM);
  return clamp(vec2(
    authoredField.x * (0.12 + 1.5 * front.x),
    authoredField.y * 0.55 + front.y * 0.45
  ), 0.0, 1.0);
}

vec2 eveSampleWeatherCanonical(
  const vec3 canonicalPositionECEFM,
  const float footprintM,
  const float weatherLod
) {
  vec2 uv = eveWeatherUv(canonicalPositionECEFM);
  float mapLod = eveWeatherMapLod(canonicalPositionECEFM, footprintM, weatherLod,
    eveWeatherMapDimensions, vec2(2.0 * PI, PI));
  vec2 globalField = vec2(
    textureLod(eveWeatherCoverageTexture, uv, mapLod).r,
    textureLod(eveWeatherTypeFieldTexture, uv, mapLod).r
  );
  vec2 selectedField = globalField;
  if (eveWeatherReferenceFieldEnabled <= 0.5) {
    return eveApplySeededWeatherFront(selectedField, canonicalPositionECEFM);
  }

  // The reference asset is authored south-first and is uploaded without a
  // second vertical flip. Global assets are north-first and are oriented once
  // by their loader before reaching this shared sampler. Empty support refers
  // to sampled zero coverage; the finite bilinear/mip footprint can mix covered
  // texels across an authored clear boundary. No analytic zone exclusions here.
  float longitudeDeg = (uv.x - 0.5) * 360.0;
  float latitudeDeg = (uv.y - 0.5) * 180.0;
  vec2 referenceUv = (vec2(longitudeDeg, latitudeDeg) - eveWeatherReferenceBoundsDeg.xy) /
    max(eveWeatherReferenceBoundsDeg.zw - eveWeatherReferenceBoundsDeg.xy, vec2(1e-6));
  float inside = step(0.0, referenceUv.x) * step(referenceUv.x, 1.0) *
    step(0.0, referenceUv.y) * step(referenceUv.y, 1.0);
  if (inside <= 0.0) return eveApplySeededWeatherFront(selectedField, canonicalPositionECEFM);
  float edge = min(min(referenceUv.x, 1.0 - referenceUv.x), min(referenceUv.y, 1.0 - referenceUv.y));
  float boundaryBlend = inside * smoothstep(0.0, 0.08, edge);
  // The local map covers only its authored angular bounds. Reusing the global
  // LOD undersamples its much finer physical texels, despite fewer total pixels.
  vec2 referenceSpanRad = radians(max(
    eveWeatherReferenceBoundsDeg.zw - eveWeatherReferenceBoundsDeg.xy, vec2(1e-6)));
  float referenceLod = eveWeatherMapLod(canonicalPositionECEFM, footprintM, weatherLod,
    eveWeatherReferenceMapDimensions, referenceSpanRad);
  vec2 referenceField = textureLod(eveWeatherReferenceFieldTexture, referenceUv, referenceLod).rg;
  selectedField = mix(globalField, referenceField, boundaryBlend);
  return eveApplySeededWeatherFront(selectedField, canonicalPositionECEFM);
}

vec2 eveSampleWeather(
  const vec3 positionECEFM,
  const float footprintM,
  const float weatherLod
) {
  return eveSampleWeatherCanonical(
    eveWeatherCanonicalPositionECEFM(positionECEFM), footprintM, weatherLod);
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

  vec3 canonicalPositionECEFM = eveWeatherCanonicalPositionECEFM(positionECEFM);
  vec2 weather = eveSampleWeatherCanonical(canonicalPositionECEFM, footprintM, weatherLod);
  float coverage = clamp(weather.x, 0.0, 1.0);
  if (coverage <= 0.0) return media;

  float typeScalar = clamp(weather.y, 0.0, 1.0) * float(EVE_CLOUD_PROFILE_COUNT - 1);
  int leftIndex = min(EVE_CLOUD_PROFILE_COUNT - 1, int(floor(typeScalar)));
  int rightIndex = min(EVE_CLOUD_PROFILE_COUNT - 1, leftIndex + 1);
  float typeBlend = typeScalar - float(leftIndex);

  // Interpolate the profile tables first, including knot positions. Both CPU
  // fixtures and this hook evaluate the resulting curves exactly once.
  float baseAltitudeM = mix(eveCloudBaseAltitudeM[leftIndex], eveCloudBaseAltitudeM[rightIndex], typeBlend);
  float topAltitudeM = mix(eveCloudTopAltitudeM[leftIndex], eveCloudTopAltitudeM[rightIndex], typeBlend);
  float heightM = length(positionECEFM) - eveWeatherPlanetRadiusM;
  float height01 = (heightM - baseAltitudeM) / max(topAltitudeM - baseAltitudeM, 1e-6);
  if (height01 <= 0.0 || height01 >= 1.0) return media;

  vec4 coverageKnots = mix(eveCloudCoverageKnots[leftIndex], eveCloudCoverageKnots[rightIndex], typeBlend);
  vec4 coverageValues = mix(eveCloudCoverageValues[leftIndex], eveCloudCoverageValues[rightIndex], typeBlend);
  vec4 densityKnots = mix(eveCloudDensityKnots[leftIndex], eveCloudDensityKnots[rightIndex], typeBlend);
  vec4 densityValues = mix(eveCloudDensityValues[leftIndex], eveCloudDensityValues[rightIndex], typeBlend);
  float coverageCurve = clamp(eveCurve(coverageKnots, coverageValues, height01), 0.0, 1.0);
  float densityCurve = clamp(eveCurve(densityKnots, densityValues, height01), 0.0, 1.0);
  float heightCoverage = coverage * coverageCurve;
  if (heightCoverage <= 0.0) return media;

  // Blend fixed domains, never their coordinate scale. Interpolating the
  // divisor of Earth-sized ECEF coordinates turns a gentle type gradient into
  // thousands of texture wraps and produces streaks instead of cloud shapes.
  vec2 leftScalesM = max(vec2(
    eveCloudPrimaryNoiseScaleM[leftIndex], eveCloudDetailNoiseScaleM[leftIndex]), vec2(1.0));
  vec2 rightScalesM = max(vec2(
    eveCloudPrimaryNoiseScaleM[rightIndex], eveCloudDetailNoiseScaleM[rightIndex]), vec2(1.0));
  vec2 leftLod = max(vec2(0.0), log2(max(vec2(1.0),
    max(footprintM, 0.0) * eveWeatherNoiseDimensions.x / leftScalesM)));
  vec2 rightLod = max(vec2(0.0), log2(max(vec2(1.0),
    max(footprintM, 0.0) * eveWeatherNoiseDimensions.x / rightScalesM)));
  vec3 detailPositionECEFM = eveDetailNoisePositionECEFM(canonicalPositionECEFM);
  vec4 primaryNoise = textureLod(
    eveWeatherNoiseTexture, fract(canonicalPositionECEFM / leftScalesM.x), leftLod.x);
  vec4 detailNoise = textureLod(
    eveWeatherNoiseTexture, fract(detailPositionECEFM / leftScalesM.y), leftLod.y);
  if (typeBlend > 0.0) {
    primaryNoise = mix(primaryNoise, textureLod(
      eveWeatherNoiseTexture, fract(canonicalPositionECEFM / rightScalesM.x), rightLod.x), typeBlend);
    detailNoise = mix(detailNoise, textureLod(
      eveWeatherNoiseTexture, fract(detailPositionECEFM / rightScalesM.y), rightLod.y), typeBlend);
  }
  vec2 noiseShape = eveCloudNoiseShape(primaryNoise, detailNoise);

  // Retained uniform names now denote the support-noise normalization centre and
  // half-width. Coverage-edge softness is an independent authored uniform.
  float noiseCenter = mix(eveCloudBaseNoiseThreshold[leftIndex], eveCloudBaseNoiseThreshold[rightIndex], typeBlend);
  float noiseHalfWidth = mix(eveCloudBaseNoiseSoftness[leftIndex], eveCloudBaseNoiseSoftness[rightIndex], typeBlend);
  float erosionThreshold = mix(eveCloudErosionThreshold[leftIndex], eveCloudErosionThreshold[rightIndex], typeBlend);
  float erosionSoftness = mix(eveCloudErosionSoftness[leftIndex], eveCloudErosionSoftness[rightIndex], typeBlend);
  float erosionDepth = mix(eveCloudErosionDepth[leftIndex], eveCloudErosionDepth[rightIndex], typeBlend);
  float normalizedNoise = clamp(
    (noiseShape.x - (noiseCenter - noiseHalfWidth)) /
      max(2.0 * noiseHalfWidth, 1e-6), 0.0, 1.0
  );
  float baseShape = smoothstep(
    1.0 - heightCoverage - eveCloudCoverageEdgeSoftness,
    1.0 - heightCoverage + eveCloudCoverageEdgeSoftness,
    normalizedNoise
  );
  float erosionMask = smoothstep(
    erosionThreshold - erosionSoftness,
    erosionThreshold + erosionSoftness,
    noiseShape.y
  );
  float shapedNoise = clamp(baseShape - erosionDepth * erosionMask, 0.0, 1.0);
  float supportFade = mix(eveCloudSupportFade01[leftIndex], eveCloudSupportFade01[rightIndex], typeBlend);
  float supportTaper = smoothstep(0.0, supportFade, height01) *
    (1.0 - smoothstep(1.0 - supportFade, 1.0, height01));
  float density = densityCurve * shapedNoise * supportTaper;
  if (density <= 0.0) return media;

  float scattering = mix(eveCloudScatteringCoefficientMInv[leftIndex], eveCloudScatteringCoefficientMInv[rightIndex], typeBlend);
  float absorption = mix(eveCloudAbsorptionCoefficientMInv[leftIndex], eveCloudAbsorptionCoefficientMInv[rightIndex], typeBlend);
  media.density = density;
  media.weight[leftIndex] = 1.0 - typeBlend;
  media.weight[rightIndex] += typeBlend;
  media.scattering = density * scattering;
  media.extinction = density * (scattering + absorption);
  media.phaseAnisotropy = vec2(
    mix(eveCloudPhaseAnisotropyX[leftIndex], eveCloudPhaseAnisotropyX[rightIndex], typeBlend),
    mix(eveCloudPhaseAnisotropyY[leftIndex], eveCloudPhaseAnisotropyY[rightIndex], typeBlend)
  );
  media.phaseMix = mix(eveCloudPhaseMix[leftIndex], eveCloudPhaseMix[rightIndex], typeBlend);
  return media;
}
