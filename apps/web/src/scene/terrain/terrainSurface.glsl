// First-pass procedural terrain material. It adds no lighting, shadowing or
// displacement: regional linear imagery remains the large-scale albedo owner.

uniform sampler3D terrainSurfaceNoiseTexture;
uniform sampler3D terrainSurfaceBand1;
uniform sampler3D terrainSurfaceBand2;
uniform sampler3D terrainSurfaceBand3;
uniform vec3 terrainSurfaceNoisePhase[4];
uniform float terrainSurfacePlanetRadiusM;
uniform vec3 terrainSurfaceCameraPositionM;
uniform float terrainSurfaceEnabled;
uniform float terrainSurfaceDetailStrength;

const float TERRAIN_SURFACE_F32_EPSILON = 1.1920928955078125e-7;
const float TERRAIN_SURFACE_NOISE_PERIOD_CELLS = 8.0;

struct TerrainSurfaceSample {
  vec4 noise;
  vec3 gradient;
  vec4 resolved;
  float altitudeM;
  float latitude;
  float slope;
  float contribution;
};

/* TERRAIN_SURFACE_DOMAINS */

float terrainSurfaceFootprintM(const vec3 localPositionM) {
  float pixelFootprintM = max(
    length(dFdx(localPositionM)),
    length(dFdy(localPositionM))
  );
  // Fine derivatives use patch-local coordinates. CPU-reduced phase preserves
  // the same planet-fixed field without Earth-scale float quantization.
  float precisionFootprintM = max(
    max(abs(localPositionM.x), abs(localPositionM.y)),
    abs(localPositionM.z)
  ) * TERRAIN_SURFACE_F32_EPSILON;
  return max(pixelFootprintM, precisionFootprintM);
}

float terrainSurfaceBandVisibility(const float wavelengthM, const float footprintM) {
  return 1.0 - smoothstep(wavelengthM * 0.18, wavelengthM * 0.55, footprintM);
}

vec4 terrainSurfaceNoiseSample(
  const sampler3D bandTexture,
  const vec3 domainPositionM,
  const vec3 domainDxM,
  const vec3 domainDyM,
  const float wavelengthM,
  const vec3 offset,
  const int channel
) {
  float repeatM = wavelengthM * TERRAIN_SURFACE_NOISE_PERIOD_CELLS;
  vec3 coordinate = domainPositionM / repeatM + terrainSurfaceNoisePhase[channel] + offset;
  vec3 coordinateDx = domainDxM / repeatM;
  vec3 coordinateDy = domainDyM / repeatM;
  return textureGrad(
    bandTexture,
    coordinate,
    coordinateDx,
    coordinateDy
  );
}

TerrainSurfaceSample terrainSurfaceSample(
  const vec3 planetPositionM,
  const vec3 geometricNormalWorld,
  const vec3 localPositionM
) {
  vec3 radial = normalize(planetPositionM);
  vec3 normal = normalize(geometricNormalWorld);
  vec3 positionDx = dFdx(localPositionM);
  vec3 positionDy = dFdy(localPositionM);
  float footprintM = terrainSurfaceFootprintM(localPositionM);

  vec3 domain1 = terrainSurfaceDomain1(localPositionM);
  vec3 domain1Dx = terrainSurfaceDomain1(positionDx);
  vec3 domain1Dy = terrainSurfaceDomain1(positionDy);
  vec3 domain2 = terrainSurfaceDomain2(localPositionM);
  vec3 domain2Dx = terrainSurfaceDomain2(positionDx);
  vec3 domain2Dy = terrainSurfaceDomain2(positionDy);
  vec3 domain3 = terrainSurfaceDomain3(localPositionM);
  vec3 domain3Dx = terrainSurfaceDomain3(positionDx);
  vec3 domain3Dy = terrainSurfaceDomain3(positionDy);

  TerrainSurfaceSample result;
  vec4 band0 = terrainSurfaceNoiseSample(terrainSurfaceNoiseTexture,
    localPositionM, positionDx, positionDy, 1000.0, vec3(0.07, 0.31, 0.53), 0);
  vec4 band1 = terrainSurfaceNoiseSample(terrainSurfaceBand1,
    domain1, domain1Dx, domain1Dy, 150.0, vec3(0.61, 0.13, 0.37), 1);
  vec4 band2 = terrainSurfaceNoiseSample(terrainSurfaceBand2,
    domain2, domain2Dx, domain2Dy, 24.0, vec3(0.29, 0.71, 0.17), 2);
  vec4 band3 = terrainSurfaceNoiseSample(terrainSurfaceBand3,
    domain3, domain3Dx, domain3Dy, 3.0, vec3(0.83, 0.43, 0.23), 3);
  result.noise = vec4(band0.w, band1.w, band2.w, band3.w);
  result.resolved = vec4(
    terrainSurfaceBandVisibility(1000.0, footprintM),
    terrainSurfaceBandVisibility(150.0, footprintM),
    terrainSurfaceBandVisibility(24.0, footprintM),
    terrainSurfaceBandVisibility(3.0, footprintM)
  );
  result.gradient = band0.xyz * (24.0 / 1000.0) * result.resolved.x
    + terrainSurfaceGradient1(band1.xyz) * (5.0 / 150.0) * result.resolved.y
    + terrainSurfaceGradient2(band2.xyz) * (0.75 / 24.0) * result.resolved.z
    + terrainSurfaceGradient3(band3.xyz) * (0.08 / 3.0) * result.resolved.w;
  result.altitudeM = length(planetPositionM) - terrainSurfacePlanetRadiusM;
  result.latitude = abs(radial.y);
  result.slope = 1.0 - clamp(dot(normal, radial), 0.0, 1.0);
  float cameraDistanceM = distance(terrainSurfaceCameraPositionM, planetPositionM);
  float distanceFade = 1.0 - smoothstep(30000.0, 70000.0, cameraDistanceM);
  float footprintFade = 1.0 - smoothstep(500.0, 1800.0, footprintM);
  result.contribution = clamp(
    terrainSurfaceEnabled * terrainSurfaceDetailStrength,
    0.0,
    1.0
  ) * distanceFade * footprintFade;
  return result;
}

vec4 terrainSurfaceMaterialWeights(
  const vec3 baseLinearRGB,
  const TerrainSurfaceSample surface
) {
  float redBlueMean = max(0.5 * (baseLinearRGB.r + baseLinearRGB.b), 0.015);
  float greenRatio = baseLinearRGB.g / redBlueMean;
  float warmRatio = baseLinearRGB.r / max(baseLinearRGB.g, 0.015);
  float flatness = 1.0 - smoothstep(0.12, 0.48, surface.slope);
  float low = 1.0 - smoothstep(1800.0, 3600.0, surface.altitudeM);
  float vegetation = smoothstep(1.01, 1.22, greenRatio) * flatness * low;
  float soil = smoothstep(1.02, 1.24, warmRatio) * flatness * low * (1.0 - vegetation);
  float rock = max(
    smoothstep(0.10, 0.52, surface.slope),
    smoothstep(1800.0, 4200.0, surface.altitudeM)
  );
  float polar = smoothstep(0.62, 0.96, surface.latitude);
  float snowLineM = mix(4300.0, 900.0, polar);
  float snow = smoothstep(snowLineM, snowLineM + 1100.0, surface.altitudeM) *
    (1.0 - smoothstep(0.48, 0.82, surface.slope));
  return clamp(vec4(vegetation, soil, rock, snow), 0.0, 1.0);
}

vec3 terrainSurfaceAlbedo(
  const vec3 baseLinearRGB,
  const vec3 planetPositionM,
  const vec3 geometricNormalWorld,
  const vec3 localPositionM
) {
  if (terrainSurfaceEnabled <= 0.0) return baseLinearRGB;
  TerrainSurfaceSample surface = terrainSurfaceSample(
    planetPositionM,
    geometricNormalWorld,
    localPositionM
  );
  vec4 material = terrainSurfaceMaterialWeights(baseLinearRGB, surface);
  float luminance = dot(baseLinearRGB, vec3(0.2126, 0.7152, 0.0722));
  float variation = dot(
    surface.noise * surface.resolved,
    vec4(0.55, 0.32, 0.18, 0.08)
  );
  vec3 tint = material.x * vec3(-0.025, 0.035, -0.018) +
    material.y * vec3(0.035, 0.006, -0.025);
  vec3 generated = clamp(
    baseLinearRGB * (1.0 + variation) + luminance * tint,
    vec3(0.0),
    vec3(1.0)
  );
  generated = mix(generated, vec3(dot(generated, vec3(0.3333))) * 1.02,
    0.08 * material.z);
  generated = mix(generated, mix(baseLinearRGB, vec3(luminance * 1.12), 0.25),
    0.18 * material.w);
  // Detail is a modest local perturbation around imagery, never a replacement
  // palette, and is exactly absent by the 70 km orbital fade endpoint.
  return mix(baseLinearRGB, clamp(generated, 0.0, 1.0), surface.contribution);
}

vec3 terrainSurfaceNormal(
  const vec3 geometricNormalWorld,
  const vec3 planetPositionM,
  const vec3 baseLinearRGB,
  const vec3 localPositionM
) {
  vec3 normal = normalize(geometricNormalWorld);
  if (terrainSurfaceEnabled <= 0.0) return normal;
  TerrainSurfaceSample surface = terrainSurfaceSample(planetPositionM, normal, localPositionM);
  vec4 material = terrainSurfaceMaterialWeights(baseLinearRGB, surface);
  float roughness = mix(0.72, 1.20, material.z) * mix(1.0, 0.68, material.w);
  vec3 gradient = surface.gradient * roughness;
  vec3 surfaceGradient = gradient - normal * dot(normal, gradient);
  vec3 detailNormal = normalize(normal - surfaceGradient);
  return normalize(mix(normal, detailNormal, surface.contribution));
}
