precision highp float;
precision highp sampler3D;
precision highp sampler2DArray;

#include <common>
#include <packing>

#include "core/depth"
#include "core/math"
#include "core/turbo"
#include "core/generators"
#include "core/raySphereIntersection"
#include "core/cascadedShadowMaps"
#include "core/interleavedGradientNoise"
#include "core/vogelDisk"

#include "atmosphere/bruneton/definitions"

uniform AtmosphereParameters ATMOSPHERE;
uniform vec3 SUN_SPECTRAL_RADIANCE_TO_LUMINANCE;
uniform vec3 SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;

uniform sampler2D transmittance_texture;
uniform sampler3D scattering_texture;
uniform sampler2D irradiance_texture;
uniform sampler3D single_mie_scattering_texture;
uniform sampler3D higher_order_scattering_texture;

#include "atmosphere/bruneton/common"
#include "atmosphere/bruneton/runtime"

#include "types"
#include "parameters"
#include "clouds"

#if !defined(RECIPROCAL_PI4)
#define RECIPROCAL_PI4 0.07957747154594767
#endif // !defined(RECIPROCAL_PI4)

uniform sampler2D depthBuffer;
uniform mat4 viewMatrix;
uniform mat4 reprojectionMatrix;
uniform mat3 mediaReprojectionMatrix;
uniform float mediaMotionEnabled;
uniform mat4 viewReprojectionMatrix;
uniform float cameraNear;
uniform float cameraFar;
uniform float cameraHeight;
uniform vec2 temporalJitter;
uniform vec2 targetUvScale;
uniform float mipLevelScale;
uniform int diagnosticMode;
uniform vec3 diagnosticRayOrigin;
uniform vec3 diagnosticRayDirection;
uniform float diagnosticRayLength;

// Scattering
const vec2 scatterAnisotropy = vec2(SCATTER_ANISOTROPY_1, SCATTER_ANISOTROPY_2);
const float scatterAnisotropyMix = SCATTER_ANISOTROPY_MIX;
uniform float skyLightScale;
uniform float groundBounceScale;
uniform float powderScale;
uniform float powderExponent;

#include "media"

// Primary raymarch
uniform int maxIterationCount;
uniform float minStepSize;
uniform float maxStepSize;
uniform float maxRayDistance;
uniform float perspectiveStepScale;
uniform float farRepresentationMix;
uniform int farIterationCount;

// Secondary raymarch
uniform int maxIterationCountToSun;
uniform int maxIterationCountToGround;
uniform float minSecondaryStepSize;
uniform float secondaryStepScale;

// Beer shadow map
uniform sampler2DArray shadowBuffer;
uniform vec2 shadowTexelSize;
uniform vec2 shadowIntervals[SHADOW_CASCADE_COUNT];
uniform mat4 shadowMatrices[SHADOW_CASCADE_COUNT];
uniform float shadowFar;
uniform float maxShadowFilterRadius;

// Shadow length
#ifdef SHADOW_LENGTH
uniform int maxShadowLengthIterationCount;
uniform float minShadowLengthStepSize;
uniform float maxShadowLengthRayDistance;
#endif // SHADOW_LENGTH

in vec2 vUv;
in vec3 vCameraPosition;
in vec3 vCameraDirection; // Direction to the center of screen
in vec3 vRayDirection; // Direction to the texel
in vec3 vViewPosition;
in GroundIrradiance vGroundIrradiance;
in CloudsIrradiance vCloudsIrradiance;
float cloudRaySlope;
float cloudEntryFootprintM;

// This is assigned from the corrected spherical cloud frame in main().
// The uniform remains part of the material ABI for host-side compatibility.
float correctedCameraHeight;

layout(location = 0) out vec4 outputColor;
layout(location = 1) out vec4 outputDepthVelocity;
#ifdef SHADOW_LENGTH
layout(location = 2) out float outputShadowLength;
#endif // SHADOW_LENGTH

float getViewZ(const float depth) {
  #ifdef PERSPECTIVE_CAMERA
  return perspectiveDepthToViewZ(depth, cameraNear, cameraFar);
  #else // PERSPECTIVE_CAMERA
  return orthographicDepthToViewZ(depth, cameraNear, cameraFar);
  #endif // PERSPECTIVE_CAMERA
}

vec3 ecefToWorld(const vec3 positionECEF) {
  return (ecefToWorldMatrix * vec4(positionECEF - altitudeCorrection, 1.0)).xyz;
}

vec2 getShadowUv(const vec3 worldPosition, const int cascadeIndex) {
  vec4 clip = shadowMatrices[cascadeIndex] * vec4(worldPosition, 1.0);
  clip /= clip.w;
  return clip.xy * 0.5 + 0.5;
}

float getDistanceToShadowTop(const vec3 rayPosition) {
  // Distance to the top of the shadows along the sun direction, which matches
  // the ray origin of BSM.
  return raySphereSecondIntersection(
    rayPosition,
    sunDirection,
    vec3(0.0),
    bottomRadius + shadowTopHeight
  );
}

#ifdef DEBUG_SHOW_CASCADES

const vec3 cascadeColors[4] = vec3[4](
  vec3(1.0, 0.0, 0.0),
  vec3(0.0, 1.0, 0.0),
  vec3(0.0, 0.0, 1.0),
  vec3(1.0, 1.0, 0.0)
);

vec3 getCascadeColor(const vec3 rayPosition) {
  vec3 worldPosition = ecefToWorld(rayPosition);
  int cascadeIndex = getCascadeIndex(
    viewMatrix,
    worldPosition,
    shadowIntervals,
    cameraNear,
    shadowFar
  );
  vec2 uv = getShadowUv(worldPosition, cascadeIndex);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return vec3(1.0);
  }
  return cascadeColors[cascadeIndex];
}

vec3 getFadedCascadeColor(const vec3 rayPosition, const float jitter) {
  vec3 worldPosition = ecefToWorld(rayPosition);
  int cascadeIndex = getFadedCascadeIndex(
    viewMatrix,
    worldPosition,
    shadowIntervals,
    cameraNear,
    shadowFar,
    jitter
  );
  return cascadeIndex >= 0
    ? cascadeColors[cascadeIndex]
    : vec3(1.0);
}

#endif // DEBUG_SHOW_CASCADES

float readShadowOpticalDepth(
  const vec2 uv,
  const float distanceToTop,
  const float distanceOffset,
  const int cascadeIndex
) {
  // r: frontDepth, g: meanExtinction, b: maxOpticalDepth, a: maxOpticalDepthTail
  // Also see the discussion here: https://x.com/shotamatsuda/status/1885322308908442106
  vec4 shadow = texture(shadowBuffer, vec3(uv, float(cascadeIndex)));
  shadow *= vec4(1e3, 1e-3, 1e3, 1e3);
  float distanceToFront = max(0.0, distanceToTop - distanceOffset - shadow.r);
  return min(shadow.b + shadow.a, shadow.g * distanceToFront);
}

float sampleShadowOpticalDepthPCF(
  const vec3 worldPosition,
  const float distanceToTop,
  const float distanceOffset,
  const float radius,
  const int cascadeIndex
) {
  vec2 uv = getShadowUv(worldPosition, cascadeIndex);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return 0.0;
  }
  if (radius < 0.1) {
    return readShadowOpticalDepth(uv, distanceToTop, distanceOffset, cascadeIndex);
  }
  float sum = 0.0;
  vec2 offset;
  #pragma unroll_loop_start
  for (int i = 0; i < 16; ++i) {
    #if UNROLLED_LOOP_INDEX < SHADOW_SAMPLE_COUNT
    offset = vogelDisk(
      UNROLLED_LOOP_INDEX,
      SHADOW_SAMPLE_COUNT,
      interleavedGradientNoise(gl_FragCoord.xy + temporalJitter * resolution) * PI2
    );
    sum += readShadowOpticalDepth(
      uv + offset * radius * shadowTexelSize,
      distanceToTop,
      distanceOffset,
      cascadeIndex
    );
    #endif // UNROLLED_LOOP_INDEX < SHADOW_SAMPLE_COUNT
  }
  #pragma unroll_loop_end
  return sum / float(SHADOW_SAMPLE_COUNT);
}

float sampleShadowOpticalDepth(
  const vec3 rayPosition,
  const float distanceOffset,
  const float radius,
  const float jitter
) {
  float distanceToTop = getDistanceToShadowTop(rayPosition);
  if (distanceToTop <= 0.0) {
    return 0.0;
  }
  vec3 worldPosition = ecefToWorld(rayPosition);
  int cascadeIndex = getFadedCascadeIndex(
    viewMatrix,
    worldPosition,
    shadowIntervals,
    cameraNear,
    shadowFar,
    jitter
  );
  return cascadeIndex >= 0
    ? sampleShadowOpticalDepthPCF(
      worldPosition,
      distanceToTop,
      distanceOffset,
      radius,
      cascadeIndex
    )
    : 0.0;
}

#ifdef DEBUG_SHOW_SHADOW_MAP
vec4 getCascadedShadowMaps(vec2 uv) {
  vec4 coord = vec4(vUv, vUv - 0.5) * 2.0;
  vec4 shadow = vec4(0.0);
  if (uv.y > 0.5) {
    if (uv.x < 0.5) {
      shadow = texture(shadowBuffer, vec3(coord.xw, 0.0));
    } else {
      #if SHADOW_CASCADE_COUNT > 1
      shadow = texture(shadowBuffer, vec3(coord.zw, 1.0));
      #endif // SHADOW_CASCADE_COUNT > 1
    }
  } else {
    if (uv.x < 0.5) {
      #if SHADOW_CASCADE_COUNT > 2
      shadow = texture(shadowBuffer, vec3(coord.xy, 2.0));
      #endif // SHADOW_CASCADE_COUNT > 2
    } else {
      #if SHADOW_CASCADE_COUNT > 3
      shadow = texture(shadowBuffer, vec3(coord.zy, 3.0));
      #endif // SHADOW_CASCADE_COUNT > 3
    }
  }

  #if !defined(DEBUG_SHOW_SHADOW_MAP_TYPE)
  #define DEBUG_SHOW_SHADOW_MAP_TYPE 0
  #endif // !defined(DEBUG_SHOW_SHADOW_MAP_TYPE

  shadow *= vec4(1e3, 1e-3, 1e3, 1e3);
  const float frontDepthScale = 1e-5;
  const float meanExtinctionScale = 10.0;
  const float maxOpticalDepthScale = 0.01;
  vec3 color;
  #if DEBUG_SHOW_SHADOW_MAP_TYPE == 1
  color = vec3(shadow.r * frontDepthScale);
  #elif DEBUG_SHOW_SHADOW_MAP_TYPE == 2
  color = vec3(shadow.g * meanExtinctionScale);
  #elif DEBUG_SHOW_SHADOW_MAP_TYPE == 3
  color = vec3((shadow.b + shadow.a) * maxOpticalDepthScale);
  #else // DEBUG_SHOW_SHADOW_MAP_TYPE
  color =
    (shadow.rgb + vec3(0.0, 0.0, shadow.a)) *
    vec3(frontDepthScale, meanExtinctionScale, maxOpticalDepthScale);
  #endif // DEBUG_SHOW_SHADOW_MAP_TYPE
  return vec4(color, 1.0);
}
#endif // DEBUG_SHOW_SHADOW_MAP

vec2 henyeyGreenstein(const vec2 g, const float cosTheta) {
  vec2 g2 = g * g;
  // prettier-ignore
  return RECIPROCAL_PI4 *
    ((1.0 - g2) / max(vec2(1e-7), pow(1.0 + g2 - 2.0 * g * cosTheta, vec2(1.5))));
}

#ifdef ACCURATE_PHASE_FUNCTION

float draine(float u, float g, float a) {
  float g2 = g * g;
  // prettier-ignore
  return (1.0 - g2) *
    (1.0 + a * u * u) /
    (4.0 * (1.0 + a * (1.0 + 2.0 * g2) / 3.0) * PI * pow(1.0 + g2 - 2.0 * g * u, 1.5));
}

// Numerically-fitted large particles (d=10) phase function It won't be
// plausible without a more precise multiple scattering.
// Reference: https://research.nvidia.com/labs/rtr/approximate-mie/
float phaseFunction(const float cosTheta, const float attenuation) {
  const float gHG = 0.988176691700256; // exp(-0.0990567/(d-1.67154))
  const float gD = 0.5556712547839497; // exp(-2.20679/(d+3.91029) - 0.428934)
  const float alpha = 21.995520856274638; // exp(3.62489 - 8.29288/(d+5.52825))
  const float weight = 0.4819554318404214; // exp(-0.599085/(d-0.641583)-0.665888)
  return mix(
    henyeyGreenstein(vec2(gHG) * attenuation, cosTheta).x,
    draine(cosTheta, gD * attenuation, alpha),
    weight
  );
}

#else // ACCURATE_PHASE_FUNCTION

float phaseFunction(const float cosTheta, const float attenuation) {
  const vec2 g = scatterAnisotropy;
  const vec2 weights = vec2(1.0 - scatterAnisotropyMix, scatterAnisotropyMix);
  // A similar approximation is described in the Frostbite's paper, where phase
  // angle is attenuated instead of anisotropy.
  return dot(henyeyGreenstein(g * attenuation, cosTheta), weights);
}

#endif // ACCURATE_PHASE_FUNCTION

float phaseFunction(const float cosTheta) {
  return phaseFunction(cosTheta, 1.0);
}

float phaseFunction(
  const float cosTheta,
  const float attenuation,
  const vec2 anisotropy,
  const float anisotropyMix
) {
  #ifdef ACCURATE_PHASE_FUNCTION
  return phaseFunction(cosTheta, attenuation);
  #else // ACCURATE_PHASE_FUNCTION
  return dot(
    henyeyGreenstein(anisotropy * attenuation, cosTheta),
    vec2(1.0 - anisotropyMix, anisotropyMix)
  );
  #endif // ACCURATE_PHASE_FUNCTION
}

// All secondary consumers integrate explicit, disjoint physical intervals.
float cloudSupportExitDistance(const vec3 position, const vec3 direction) {
  float exitDistance = max(0.0, raySphereSecondIntersection(position, direction, bottomRadius + maxHeight));
  float groundDistance = raySphereFirstIntersection(position, direction, bottomRadius);
  if (groundDistance >= 0.0) exitDistance = min(exitDistance, groundDistance);
  return exitDistance;
}

float integrateCloudOpticalDepth(
  const vec3 rayOrigin,
  const vec3 rayDirection,
  const float endDistance,
  const int iterationBudget,
  const float mipLevel,
  const float jitter,
  out float integratedEndpoint
) {
  integratedEndpoint = 0.0;
  if (iterationBudget <= 0 || endDistance <= 0.0) return 0.0;
  float opticalDepth = 0.0;
  int count = min(iterationBudget, 1024);
  float stepSize = referenceSampling != 0
    ? max(max(referenceStepSize, 1e-4), endDistance / float(count))
    : endDistance / float(count);
  for (int i = 0; i < 1024; ++i) {
    if (i >= count || integratedEndpoint >= endDistance) break;
    float segmentLength = min(stepSize, endDistance - integratedEndpoint);
    float sampleFraction = referenceSampling != 0 ? 0.5 : clamp(jitter, 0.0, 1.0);
    vec3 position = rayOrigin + (integratedEndpoint + sampleFraction * segmentLength) * rayDirection;
    MediaSample media = sampleCloudMedia(position - altitudeCorrection, segmentLength, mipLevel, jitter);
    opticalDepth += max(0.0, media.extinction) * segmentLength;
    integratedEndpoint += segmentLength;
  }
  return opticalDepth;
}

float marchOpticalDepth(
  const vec3 rayOrigin,
  const vec3 rayDirection,
  const int iterationCount,
  const float mipLevel,
  const float jitter,
  out float integratedEndpoint
) {
  return integrateCloudOpticalDepth(rayOrigin, rayDirection,
    min(minSecondaryStepSize, cloudSupportExitDistance(rayOrigin, rayDirection)),
    iterationCount, mipLevel, jitter, integratedEndpoint);
}

float marchOpticalDepth(
  const vec3 rayOrigin,
  const vec3 rayDirection,
  const int iterationCount,
  const float mipLevel,
  const float jitter
) {
  float integratedEndpoint;
  return marchOpticalDepth(rayOrigin, rayDirection, iterationCount, mipLevel, jitter, integratedEndpoint);
}

float approximateMultipleScattering(
  const float opticalDepth,
  const float cosTheta,
  const vec2 anisotropy,
  const float anisotropyMix
) {
  // Multiple scattering approximation
  // See: https://fpsunflower.github.io/ckulla/data/oz_volumes.pdf
  // a: attenuation, b: contribution, c: phase attenuation
  vec3 coeffs = vec3(1.0); // [a, b, c]
  const vec3 attenuation = vec3(0.5, 0.5, 0.5); // Should satisfy a <= b
  float scattering = 0.0;
  float beerLambert;
  #pragma unroll_loop_start
  for (int i = 0; i < 12; ++i) {
    #if UNROLLED_LOOP_INDEX < MULTI_SCATTERING_OCTAVES
    beerLambert = exp(-opticalDepth * coeffs.y);
    scattering += coeffs.x * beerLambert * phaseFunction(
      cosTheta,
      coeffs.z,
      anisotropy,
      anisotropyMix
    );
    coeffs *= attenuation;
    #endif // UNROLLED_LOOP_INDEX < MULTI_SCATTERING_OCTAVES
  }
  #pragma unroll_loop_end
  return scattering;
}

// TODO: Construct spherical harmonics of degree 2 using 2 sample points
// positioned near the horizon occlusion points on the sun direction plane.
vec3 getGroundSunSkyIrradiance(
  const vec3 position,
  const vec3 surfaceNormal,
  const float height,
  out vec3 skyIrradiance
) {
  #ifdef ACCURATE_SUN_SKY_LIGHT
  return GetSunAndSkyIrradiance(
    (position - surfaceNormal * height) * METER_TO_LENGTH_UNIT,
    surfaceNormal,
    sunDirection,
    skyIrradiance
  );
  #else // ACCURATE_SUN_SKY_LIGHT
  skyIrradiance = vGroundIrradiance.sky;
  return vGroundIrradiance.sun;
  #endif // ACCURATE_SUN_SKY_LIGHT
}

vec3 getCloudsSunSkyIrradiance(const vec3 position, const float height, out vec3 skyIrradiance) {
  #ifdef ACCURATE_SUN_SKY_LIGHT
  return GetSunAndSkyScalarIrradiance(position * METER_TO_LENGTH_UNIT, sunDirection, skyIrradiance);
  #else // ACCURATE_SUN_SKY_LIGHT
  float alpha = remapClamped(height, minHeight, maxHeight);
  skyIrradiance = mix(vCloudsIrradiance.minSky, vCloudsIrradiance.maxSky, alpha);
  return mix(vCloudsIrradiance.minSun, vCloudsIrradiance.maxSun, alpha);
  #endif // ACCURATE_SUN_SKY_LIGHT
}

#include "lighting"

// Shared by the view marcher, shaft marcher and conformance diagnostics.
float cloudSunOpticalDepth(
  const vec3 position, const float footprintM, const float mipLevel,
  const float jitter, out CloudLightingSample lighting
) {
  float nearEndpoint;
  float opticalDepth = marchOpticalDepth(position, sunDirection,
    maxIterationCountToSun, mipLevel, jitter, nearEndpoint);
  lighting = sampleCloudLighting(position - altitudeCorrection, footprintM, nearEndpoint);
  if (lighting.valid > 0.5 && !isnan(lighting.directTransmittance) && !isinf(lighting.directTransmittance)) {
    return opticalDepth - log(max(clamp(lighting.directTransmittance, 0.0, 1.0), 1e-30));
  }
  lighting.valid = 0.0;
  if (lighting.stockFallback < 0.5) {
    float remainderEndpoint;
    float remainderLength = max(0.0, cloudSupportExitDistance(position, sunDirection) - nearEndpoint);
    opticalDepth += integrateCloudOpticalDepth(position + nearEndpoint * sunDirection,
      sunDirection, remainderLength, referenceSampling != 0 ? 1024 : 32,
      mipLevel, jitter, remainderEndpoint);
  } else if (length(position) - bottomRadius < shadowTopHeight) {
    opticalDepth += sampleShadowOpticalDepth(position, nearEndpoint,
      maxShadowFilterRadius * remapClamped(dot(sunDirection, normalize(position)), 0.1, 0.0), jitter);
  }
  return opticalDepth;
}

#ifdef GROUND_BOUNCE
vec3 approximateRadianceFromGround(
  const vec3 position,
  const vec3 surfaceNormal,
  const float height,
  const float mipLevel,
  const float jitter
) {
  float opticalDepthToGround = marchOpticalDepth(
    position,
    -surfaceNormal,
    maxIterationCountToGround,
    mipLevel,
    jitter
  );
  vec3 skyIrradiance;
  vec3 sunIrradiance = getGroundSunSkyIrradiance(position, surfaceNormal, height, skyIrradiance);
  const float groundAlbedo = 0.3;
  vec3 groundIrradiance = skyIrradiance + (1.0 - coverage) * sunIrradiance;
  vec3 bouncedRadiance = groundAlbedo * RECIPROCAL_PI * groundIrradiance;
  return bouncedRadiance * exp(-opticalDepthToGround);
}
#endif // GROUND_BOUNCE

vec4 marchClouds(
  const vec3 rayOrigin,
  const vec3 rayDirection,
  const vec2 rayNearFar,
  const float cosTheta,
  const float jitter,
  const float rayStartTexelsPerPixel,
  const bool distantRepresentation,
  out float frontDepth,
  out ivec3 sampleCount,
  out float secondaryOpticalDepth,
  out vec3 composedLighting
) {
  vec3 radianceIntegral = vec3(0.0);
  float transmittanceIntegral = 1.0;
  float weightedDistanceSum = 0.0;
  float transmittanceSum = 0.0;
  secondaryOpticalDepth = 0.0;
  composedLighting = vec3(0.0);
  float diagnosticWeight = 0.0;
  sampleCount = ivec3(0);

  float maxRayDistance = rayNearFar.y - rayNearFar.x;
  // Start at the physical cloud boundary. Jitter the sample inside each
  // segment, never its integrated endpoints (which would leave gaps).
  float stepSize = minStepSize;
  float rayDistance = 0.0;
  // Both schedules use exactly the same media, lighting and transport below.
  // Reference sampling always retains its fixed midpoint schedule.
  bool distant = distantRepresentation && referenceSampling == 0;
  int iterationCount = distant ? clamp(farIterationCount, 1, 128) : maxIterationCount;

  for (int i = 0; i < iterationCount; ++i) {
    if (rayDistance > maxRayDistance) {
      break; // Termination
    }

    float segmentStart = rayDistance;
    float segmentSize = referenceSampling != 0
      ? max(referenceStepSize, 1e-4)
      : clamp(stepSize, minStepSize, maxStepSize);
    if (referenceSampling == 0) {
      // The step cap is a quality preference; the remaining budget must never
      // leave an unintegrated suffix. Endpoints stay contiguous even in gaps.
      float remainingLength = maxRayDistance - segmentStart;
      float remainingSteps = float(iterationCount - i);
      float budgetStep = cloudBudgetStep(remainingLength, remainingSteps, perspectiveStepScale);
      segmentSize = distant ? remainingLength / remainingSteps : max(segmentSize, budgetStep);
    }
    float segmentLength = min(segmentSize, maxRayDistance - segmentStart);
    if (segmentLength <= 0.0) {
      break;
    }
    float sampleDistance = segmentStart + segmentLength *
      (referenceSampling != 0 ? 0.5 : clamp(jitter, 0.0, 1.0));
    float integratedEndpoint = segmentStart + segmentLength;
    if (referenceSampling == 0 && i == iterationCount - 1) {
      integratedEndpoint = maxRayDistance;
    }

    vec3 position = sampleDistance * rayDirection + rayOrigin;
    float height = length(position) - bottomRadius;
    float mipLevel = log2(max(1.0, rayStartTexelsPerPixel + sampleDistance * 1e-5));

    #ifdef DEBUG_SHOW_SAMPLE_COUNT
    ++sampleCount.x;
    #endif // DEBUG_SHOW_SAMPLE_COUNT

    // The stock hook performs weather/layer rejection. Custom hooks receive
    // every bounded sample and own their conservative support test.
    float footprintM = max(cloudEntryFootprintM, (rayNearFar.x + sampleDistance) * cloudRaySlope);
    MediaSample media = sampleCloudMedia(position - altitudeCorrection, footprintM, mipLevel, jitter);

    if (media.extinction <= minExtinction) {
      if (referenceSampling != 0) {
        rayDistance = integratedEndpoint;
      } else {
        // Preserve the stock empty-space acceleration without applying a
        // stock weather or SHADOW mask before the custom hook is evaluated.
        stepSize = min(maxStepSize, mix(stepSize * perspectiveStepScale, maxStepSize, min(1.0, mipLevel)));
        rayDistance = integratedEndpoint;
      }
      continue;
    }

    if (media.extinction > minExtinction) {
      vec3 skyIrradiance;
      vec3 sunIrradiance = getCloudsSunSkyIrradiance(position, height, skyIrradiance);
      vec3 surfaceNormal = normalize(position);

      CloudLightingSample suppliedLighting;
      float opticalDepth = cloudSunOpticalDepth(position, footprintM, mipLevel, jitter, suppliedLighting);
      bool hasSuppliedLighting = suppliedLighting.valid > 0.5;
      if (hasSuppliedLighting) skyIrradiance = suppliedLighting.skyIrradiance;

      vec3 radiance = sunIrradiance * approximateMultipleScattering(
        opticalDepth,
        cosTheta,
        media.phaseAnisotropy,
        media.phaseMix
      );

      #ifdef GROUND_BOUNCE
      // Fudge factor for the irradiance from ground.
      if (suppliedLighting.stockFallback > 0.5 && height < shadowTopHeight && mipLevel < 0.5) {
        vec3 groundRadiance = approximateRadianceFromGround(
          position,
          surfaceNormal,
          height,
          mipLevel,
          jitter
        );
        radiance += groundRadiance * RECIPROCAL_PI4 * groundBounceScale;
      }
      #endif // GROUND_BOUNCE

      if (hasSuppliedLighting) {
        radiance += skyIrradiance * RECIPROCAL_PI4 * skyLightScale;
      } else {
        // Crude approximation of sky gradient. Better than none in the shadows.
        vec4 heightFraction = clamp((vec4(height) - minLayerHeights) / max(maxLayerHeights - minLayerHeights, vec4(1e-4)), 0.0, 1.0);
        float skyGradient = dot(heightFraction * 0.5 + 0.5, media.weight);
        radiance += skyIrradiance * RECIPROCAL_PI4 * skyGradient * skyLightScale;
      }

      // Finally multiply by scattering.
      radiance *= media.scattering;

      #ifdef POWDER
      radiance *= 1.0 - powderScale * exp(-media.extinction * powderExponent);
      #endif // POWDER

      #ifdef DEBUG_SHOW_CASCADES
      if (height < shadowTopHeight) {
        radiance = 1e-3 * getFadedCascadeColor(position, jitter);
      }
      #endif // DEBUG_SHOW_CASCADES

      // Energy-conserving analytical integration of scattered light
      // See 5.6.3 in https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016-pbs-frostbite-sky-clouds-new.pdf
      float transmittance = exp(-media.extinction * segmentLength);
      float opacityWeight = transmittanceIntegral * (1.0 - transmittance);
      float clampedExtinction = max(media.extinction, 1e-7);
      vec3 scatteringIntegral = (radiance - radiance * transmittance) / clampedExtinction;
      radianceIntegral += transmittanceIntegral * scatteringIntegral;
      transmittanceIntegral *= transmittance;
      secondaryOpticalDepth += opticalDepth * transmittanceIntegral;
      composedLighting += radiance * transmittanceIntegral;
      diagnosticWeight += transmittanceIntegral;

      // Aerial perspective affecting clouds
      // See 5.9.1 in https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016-pbs-frostbite-sky-clouds-new.pdf
      if (referenceSampling != 0) {
        weightedDistanceSum += sampleDistance * transmittanceIntegral;
        transmittanceSum += transmittanceIntegral;
      } else {
        // The analytic first opacity moment is independent of segmentation
        // for a homogeneous slab and remains valid when a coarse cell is opaque.
        float opticalThickness = media.extinction * segmentLength;
        float meanFraction = opticalThickness < 0.01
          ? 0.5 - opticalThickness / 12.0
          : 1.0 / opticalThickness - transmittance / (1.0 - transmittance);
        weightedDistanceSum += (segmentStart + segmentLength * meanFraction) * opacityWeight;
        transmittanceSum += opacityWeight;
      }
    }

    if (!distant && transmittanceIntegral <= minTransmittance) {
      break; // Early termination
    }

    if (referenceSampling != 0) {
      // Fixed midpoint segments use the explicitly clipped integrated endpoint.
      rayDistance = integratedEndpoint;
    } else {
      // Take a shorter step because we've already hit the clouds.
      stepSize = min(maxStepSize, stepSize * perspectiveStepScale);
      rayDistance = integratedEndpoint;
    }
  }

  // The final product of 5.9.1 and we'll evaluate this in aerial perspective.
  frontDepth = transmittanceSum > 0.0 ? weightedDistanceSum / transmittanceSum : -1.0;

  if (diagnosticWeight > 0.0) {
    secondaryOpticalDepth /= diagnosticWeight;
    composedLighting /= diagnosticWeight;
  }
  return vec4(radianceIntegral, 1.0 - transmittanceIntegral);
}

#ifdef SHADOW_LENGTH

float marchShadowLength(
  const vec3 rayOrigin,
  const vec3 rayDirection,
  const vec2 rayNearFar,
  const float jitter
) {
  float shadowLength = 0.0;
  float maxRayDistance = rayNearFar.y - rayNearFar.x;
  float stepSize = minShadowLengthStepSize;
  float rayDistance = stepSize * jitter;
  const float attenuationFactor = 1.0 - 5e-4;
  float attenuation = 1.0;

  // TODO: This march is closed, and sample resolution can be much lower.
  // Refining the termination by binary search will make it much more efficient.
  for (int i = 0; i < maxShadowLengthIterationCount; ++i) {
    if (rayDistance > maxRayDistance) {
      break; // Termination
    }
    vec3 position = rayDistance * rayDirection + rayOrigin;
    CloudLightingSample lighting;
    float opticalDepth = cloudSunOpticalDepth(position, stepSize, 0.0, jitter, lighting);
    shadowLength += (1.0 - exp(-opticalDepth)) * stepSize * attenuation;
    stepSize *= perspectiveStepScale;
    rayDistance += stepSize;
  }
  return shadowLength;
}

float getRepresentationShadowLength(
  const vec3 cameraPosition,
  const vec3 rayDirection,
  const vec2 shadowRayNearFar,
  const float frontDepth,
  const float opacity,
  const float jitter
) {
  vec2 interval = shadowRayNearFar;
  if (frontDepth >= 0.0) {
    interval.y = mix(interval.y, min(frontDepth, interval.y), opacity);
  }
  if (any(lessThan(interval, vec2(0.0)))) return 0.0;
  return marchShadowLength(
    interval.x * rayDirection + cameraPosition,
    rayDirection,
    interval,
    jitter
  );
}

#endif // SHADOW_LENGTH

#ifdef HAZE

vec4 approximateHaze(
  const vec3 rayOrigin,
  const vec3 rayDirection,
  const float maxRayDistance,
  const float cosTheta,
  const float shadowLength
) {
  float modulation = remapClamped(coverage, 0.2, 0.4);
  if (correctedCameraHeight * modulation < 0.0) {
    return vec4(0.0);
  }
  float density = modulation * hazeDensityScale * exp(-correctedCameraHeight * hazeExponent);
  if (density < 1e-7) {
    return vec4(0.0); // Prevent artifact in views from space
  }

  // Blend two normals by the difference in angle so that normal near the
  // ground becomes that of the origin, and in the sky that of the horizon.
  vec3 normalAtOrigin = normalize(rayOrigin);
  vec3 normalAtHorizon = (rayOrigin - dot(rayOrigin, rayDirection) * rayDirection) / bottomRadius;
  float alpha = remapClamped(dot(normalAtOrigin, normalAtHorizon), 0.9, 1.0);
  vec3 normal = mix(normalAtOrigin, normalAtHorizon, alpha);

  // Analytical optical depth where density exponentially decreases with height.
  // Based on: https://iquilezles.org/articles/fog/
  float angle = max(dot(normal, rayDirection), 1e-5);
  float exponent = angle * hazeExponent;
  float linearTerm = density / hazeExponent / angle;

  // Derive the optical depths separately for with and without shadow length.
  float expTerm = 1.0 - exp(-maxRayDistance * exponent);
  float shadowExpTerm = 1.0 - exp(-min(maxRayDistance, shadowLength) * exponent);
  float opticalDepth = expTerm * linearTerm;
  float shadowOpticalDepth = max((expTerm - shadowExpTerm) * linearTerm, 0.0);
  float transmittance = saturate(1.0 - exp(-opticalDepth));
  float shadowTransmittance = saturate(1.0 - exp(-shadowOpticalDepth));

  vec3 skyIrradiance = vGroundIrradiance.sky;
  vec3 sunIrradiance = vGroundIrradiance.sun;
  vec3 inscatter = sunIrradiance * phaseFunction(cosTheta) * shadowTransmittance;
  inscatter += skyIrradiance * RECIPROCAL_PI4 * skyLightScale * transmittance;
  inscatter *= hazeScatteringCoefficient / (hazeAbsorptionCoefficient + hazeScatteringCoefficient);
  return vec4(inscatter, transmittance);
}

#endif // HAZE

void applyAerialPerspective(
  const vec3 cameraPosition,
  const vec3 frontPosition,
  const float shadowLength,
  inout vec4 color
) {
  vec3 transmittance;
  vec3 inscatter = GetSkyRadianceToPoint(
    cameraPosition * METER_TO_LENGTH_UNIT,
    frontPosition * METER_TO_LENGTH_UNIT,
    shadowLength * METER_TO_LENGTH_UNIT,
    sunDirection,
    transmittance
  );
  color.rgb = color.rgb * transmittance + inscatter * color.a;
}

bool rayIntersectsGround(const vec3 cameraPosition, const vec3 rayDirection) {
  float r = length(cameraPosition);
  float mu = dot(cameraPosition, rayDirection) / r;
  return mu < 0.0 && r * r * (mu * mu - 1.0) + bottomRadius * bottomRadius >= 0.0;
}

struct IntersectionResult {
  bool ground;
  vec4 first;
  vec4 second;
};

IntersectionResult getIntersections(const vec3 cameraPosition, const vec3 rayDirection) {
  IntersectionResult intersections;
  intersections.ground = rayIntersectsGround(cameraPosition, rayDirection);
  raySphereIntersections(
    cameraPosition,
    rayDirection,
    bottomRadius + vec4(0.0, minHeight, maxHeight, shadowTopHeight),
    intersections.first,
    intersections.second
  );
  return intersections;
}

vec2 getRayNearFar(const IntersectionResult intersections) {
  vec2 nearFar;
  if (correctedCameraHeight < minHeight) {
    // View below the clouds
    if (intersections.ground) {
      nearFar = vec2(-1.0); // No clouds to the ground
    } else {
      nearFar = vec2(intersections.second.y, intersections.second.z);
      nearFar.y = min(nearFar.y, maxRayDistance);
    }
  } else if (correctedCameraHeight < maxHeight) {
    // View inside the total cloud layer
    if (intersections.ground) {
      nearFar = vec2(cameraNear, intersections.first.y);
    } else {
      nearFar = vec2(cameraNear, intersections.second.z);
    }
  } else {
    // View above the clouds
    nearFar = vec2(intersections.first.z, intersections.second.z);
    if (intersections.ground) {
      // Clamp the ray at the min height.
      nearFar.y = intersections.first.y;
    }
  }
  return nearFar;
}

#ifdef SHADOW_LENGTH
vec2 getShadowRayNearFar(const IntersectionResult intersections) {
  vec2 nearFar;
  if (correctedCameraHeight < shadowTopHeight) {
    if (intersections.ground) {
      nearFar = vec2(cameraNear, intersections.first.x);
    } else {
      nearFar = vec2(cameraNear, intersections.second.w);
    }
  } else {
    nearFar = vec2(intersections.first.w, intersections.second.w);
    if (intersections.ground) {
      // Clamp the ray at the ground.
      nearFar.y = intersections.first.x;
    }
  }
  nearFar.y = min(nearFar.y, maxShadowLengthRayDistance);
  return nearFar;
}
#endif // SHADOW_LENGTH

#ifdef HAZE
vec2 getHazeRayNearFar(const IntersectionResult intersections) {
  vec2 nearFar;
  if (correctedCameraHeight < maxHeight) {
    if (intersections.ground) {
      nearFar = vec2(cameraNear, intersections.first.x);
    } else {
      nearFar = vec2(cameraNear, intersections.second.z);
    }
  } else {
    nearFar = vec2(cameraNear, intersections.second.z);
    if (intersections.ground) {
      // Clamp the ray at the ground.
      nearFar.y = intersections.first.x;
    }
  }
  return nearFar;
}
#endif // HAZE

float getRayDistanceToScene(const vec3 rayDirection, out float viewZ) {
  float depth = readDepthValue(depthBuffer, vUv * targetUvScale + temporalJitter);
  if (depth < 1.0 - 1e-7) {
    #if (defined(USE_LOGDEPTHBUF) || defined(USE_LOGARITHMIC_DEPTH_BUFFER)) && defined(PERSPECTIVE_CAMERA)
    viewZ = -(exp2(depth * log2(cameraFar + 1.0)) - 1.0);
    #else
    viewZ = getViewZ(depth);
    #endif
    return -viewZ / dot(rayDirection, vCameraDirection);
  }
  viewZ = 0.0;
  return 0.0;
}

void main() {
  #ifdef DEBUG_SHOW_SHADOW_MAP
  outputColor = getCascadedShadowMaps(vUv);
  outputDepthVelocity = vec4(0.0);
  #ifdef SHADOW_LENGTH
  outputShadowLength = 0.0;
  #endif // SHADOW_LENGTH
  return;
  #endif // DEBUG_SHOW_SHADOW_MAP

  // These modes call the same integration/transport used by the view shader.
  if (diagnosticMode == 3 || diagnosticMode == 4) {
    float value;
    if (diagnosticMode == 3) {
      float endpoint;
      value = integrateCloudOpticalDepth(diagnosticRayOrigin, normalize(diagnosticRayDirection),
        diagnosticRayLength, 1024, 0.0, 0.5, endpoint);
    } else {
      CloudLightingSample lighting;
      value = exp(-cloudSunOpticalDepth(diagnosticRayOrigin, referenceStepSize, 0.0, 0.5, lighting));
    }
    outputColor = vec4(vec3(value), 1.0);
    outputDepthVelocity = vec4(0.0);
    #ifdef SHADOW_LENGTH
    outputShadowLength = 0.0;
    #endif
    return;
  }

  vec3 cameraPosition = vCameraPosition + altitudeCorrection;
  correctedCameraHeight = length(cameraPosition) - bottomRadius;
  vec3 rayDirection = normalize(vRayDirection);
  float cosTheta = dot(sunDirection, rayDirection);

  IntersectionResult intersections = getIntersections(cameraPosition, rayDirection);
  vec2 rayNearFar = getRayNearFar(intersections);
  // A temporal sample covers one final-resolution pixel, not its entire 4x4
  // reconstruction block. Evaluate derivatives before divergent ray branches.
  #ifdef TEMPORAL_UPSCALE
  const float footprintScale = 0.25;
  #else
  const float footprintScale = 1.0;
  #endif
  cloudRaySlope = max(length(dFdx(rayDirection)), length(dFdy(rayDirection))) * footprintScale;
  vec3 entryPoint = cameraPosition + max(0.0, rayNearFar.x) * rayDirection;
  cloudEntryFootprintM = max(length(dFdx(entryPoint)), length(dFdy(entryPoint))) * footprintScale;
  #ifdef SHADOW_LENGTH
  vec2 shadowRayNearFar = getShadowRayNearFar(intersections);
  #endif // SHADOW_LENGTH
  #ifdef HAZE
  vec2 hazeRayNearFar = getHazeRayNearFar(intersections);
  #endif // HAZE

  float sceneViewZ;
  float rayDistanceToScene = getRayDistanceToScene(rayDirection, sceneViewZ);
  if (rayDistanceToScene > 0.0) {
    rayNearFar.y = min(rayNearFar.y, rayDistanceToScene);
    #ifdef SHADOW_LENGTH
    shadowRayNearFar.y = min(shadowRayNearFar.y, rayDistanceToScene);
    #endif // SHADOW_LENGTH
    #ifdef HAZE
    hazeRayNearFar.y = min(hazeRayNearFar.y, rayDistanceToScene);
    #endif // HAZE
  }

  bool intersectsGround = any(lessThan(rayNearFar, vec2(0.0)));
  bool intersectsScene = rayNearFar.y < rayNearFar.x;

  #ifdef TEMPORAL_UPSCALE
  vec2 fullPixel = gl_FragCoord.xy * 4.0 + temporalJitter * resolution;
  float stbn = samplePrimarySTBN(fullPixel, frame);
  #else
  float stbn = getSTBN();
  #endif

  vec4 color = vec4(0.0);
  float frontDepth = rayNearFar.y;
  vec4 depthVelocity = vec4(0.0);
  float shadowLength = 0.0;
  bool hitClouds = false;

  if (!intersectsGround && !intersectsScene) {
    vec3 rayOrigin = rayNearFar.x * rayDirection + cameraPosition;

    vec2 globeUv = getGlobeUv(rayOrigin);
    #ifdef DEBUG_SHOW_UV
    outputColor = vec4(vec3(checker(globeUv, localWeatherRepeat + localWeatherOffset)), 1.0);
    outputDepthVelocity = vec4(0.0);
    #ifdef SHADOW_LENGTH
    outputShadowLength = 0.0;
    #endif // SHADOW_LENGTH
    return;
    #endif // DEBUG_SHOW_UV

    float mipLevel = getMipLevel(globeUv * localWeatherRepeat) * mipLevelScale;
    mipLevel = mix(0.0, mipLevel, min(1.0, 0.2 * correctedCameraHeight / maxHeight));

    // Reference mode is an independent, fixed-sampling oracle. The default
    // zero mix executes only the adaptive representation; one executes only far.
    float representationMix = referenceSampling != 0 ? 0.0 : clamp(farRepresentationMix, 0.0, 1.0);
    vec4 nearColor = vec4(0.0);
    vec4 farColor = vec4(0.0);
    float nearFrontDepth = -1.0;
    float farFrontDepth = -1.0;
    ivec3 nearSampleCount = ivec3(0);
    ivec3 farSampleCount = ivec3(0);
    ivec3 sampleCount = ivec3(0);
    float nearOpticalDepth = 0.0;
    float farOpticalDepth = 0.0;
    vec3 nearLighting = vec3(0.0);
    vec3 farLighting = vec3(0.0);
    if (representationMix < 1.0) {
      nearColor = marchClouds(
        rayOrigin, rayDirection, rayNearFar, cosTheta, stbn,
        pow(2.0, mipLevel), false, nearFrontDepth, nearSampleCount,
        nearOpticalDepth, nearLighting
      );
    }
    if (representationMix > 0.0) {
      #ifdef EVE_DISTANT_CLOUDS
      farColor = renderDistantClouds(
        rayOrigin, rayDirection, rayNearFar, cosTheta, stbn,
        farFrontDepth, farSampleCount, farOpticalDepth, farLighting
      );
      #else
      farColor = marchClouds(
        rayOrigin, rayDirection, rayNearFar, cosTheta, stbn,
        pow(2.0, mipLevel), true, farFrontDepth, farSampleCount,
        farOpticalDepth, farLighting
      );
      #endif
    }
    sampleCount = nearSampleCount + farSampleCount;
    float secondaryOpticalDepth = mix(nearOpticalDepth, farOpticalDepth, representationMix);
    vec3 composedLighting = mix(nearLighting, farLighting, representationMix);

    if (diagnosticMode == 1) {
      outputColor = vec4(vec3(secondaryOpticalDepth), 1.0);
      outputDepthVelocity = vec4(0.0);
      #ifdef SHADOW_LENGTH
      outputShadowLength = 0.0;
      #endif // SHADOW_LENGTH
      return;
    }
    if (diagnosticMode == 2) {
      outputColor = vec4(composedLighting, 1.0);
      outputDepthVelocity = vec4(0.0);
      #ifdef SHADOW_LENGTH
      outputShadowLength = 0.0;
      #endif // SHADOW_LENGTH
      return;
    }

    #ifdef DEBUG_SHOW_SAMPLE_COUNT
    outputColor = vec4(vec3(sampleCount) / vec3(500.0, 5.0, 5.0), 1.0);
    outputDepthVelocity = vec4(0.0);
    #ifdef SHADOW_LENGTH
    outputShadowLength = 0.0;
    #endif // SHADOW_LENGTH
    return;
    #endif // DEBUG_SHOW_SAMPLE_COUNT

    // Reconstruction follows each alternative's visible opacity contribution.
    // Empty/skipped or nonfinite samples contribute no depth weight.
    bool nearValid = nearFrontDepth >= 0.0 && !isinf(nearFrontDepth);
    bool farValid = farFrontDepth >= 0.0 && !isinf(farFrontDepth);
    float nearOpacity = nearValid && !isnan(nearColor.a) && !isinf(nearColor.a)
      ? clamp(nearColor.a, 0.0, 1.0) : 0.0;
    float farOpacity = farValid && !isnan(farColor.a) && !isinf(farColor.a)
      ? clamp(farColor.a, 0.0, 1.0) : 0.0;
    float nearDepthWeight = (1.0 - representationMix) * nearOpacity;
    float farDepthWeight = representationMix * farOpacity;
    float validDepthWeight = nearDepthWeight + farDepthWeight;
    hitClouds = validDepthWeight > 0.0;
    if (hitClouds) {
      // Preserve single-contributor endpoints exactly and never multiply a
      // sentinel/nonfinite depth by zero.
      float weightedDepth;
      if (farDepthWeight <= 0.0) {
        weightedDepth = nearFrontDepth;
      } else if (nearDepthWeight <= 0.0) {
        weightedDepth = farFrontDepth;
      } else {
        weightedDepth = (nearFrontDepth * nearDepthWeight + farFrontDepth * farDepthWeight) / validDepthWeight;
      }
      frontDepth = rayNearFar.x + weightedDepth;

      float nearShadowLength = 0.0;
      float farShadowLength = 0.0;
      #ifdef SHADOW_LENGTH
      // Each representation's atmosphere query uses its own shaft interval.
      if (representationMix < 1.0) {
        nearShadowLength = getRepresentationShadowLength(
          cameraPosition, rayDirection, shadowRayNearFar,
          nearValid ? rayNearFar.x + nearFrontDepth : -1.0, nearColor.a, stbn
        );
      }
      if (representationMix > 0.0) {
        farShadowLength = getRepresentationShadowLength(
          cameraPosition, rayDirection, shadowRayNearFar,
          farValid ? rayNearFar.x + farFrontDepth : -1.0, farColor.a, stbn
        );
      }
      shadowLength = mix(nearShadowLength, farShadowLength, representationMix);
      #endif // SHADOW_LENGTH

      // Treat premultiplied radiance at each valid depth BEFORE mixing. The
      // final overlay must not receive a second aerial-perspective treatment.
      if (nearValid) {
        applyAerialPerspective(cameraPosition,
          cameraPosition + (rayNearFar.x + nearFrontDepth) * rayDirection,
          nearShadowLength, nearColor);
      }
      if (farValid) {
        applyAerialPerspective(cameraPosition,
          cameraPosition + (rayNearFar.x + farFrontDepth) * rayDirection,
          farShadowLength, farColor);
      }

      // The mixed representative depth is used only for reconstruction.
      vec3 frontPosition = cameraPosition + frontDepth * rayDirection;

      // Velocity for temporal resolution.
      // Current visible cloud fronts move with the canonical weather field.
      // Project that physical front at its previous position for history;
      // scene-depth/no-cloud reprojection below deliberately remains unchanged.
      vec3 previousFrontPosition = mediaMotionEnabled > 0.5
        ? mediaReprojectionMatrix * (frontPosition - altitudeCorrection) + altitudeCorrection
        : frontPosition;
      vec3 frontPositionWorld = ecefToWorld(previousFrontPosition);
      vec4 prevClip = reprojectionMatrix * vec4(frontPositionWorld, 1.0);
      float previousViewDepthM = prevClip.w * length(worldToECEFMatrix[0].xyz);
      prevClip /= prevClip.w;
      vec2 prevUv = prevClip.xy * 0.5 + 0.5;
      vec2 velocity = vUv - prevUv;
      depthVelocity = vec4(frontDepth * dot(rayDirection, normalize(vCameraDirection)) * 1e-4, velocity, previousViewDepthM * 1e-4);
    }

    // Alternatives covering the same ray: lerp premultiplied L and physical T,
    // never compose one representation over the other. Keep endpoints exact.
    if (representationMix <= 0.0) {
      color = nearColor;
    } else if (representationMix >= 1.0) {
      color = farColor;
    } else {
      color = vec4(
        mix(nearColor.rgb, farColor.rgb, representationMix),
        1.0 - mix(1.0 - nearColor.a, 1.0 - farColor.a, representationMix)
      );
    }

    #ifdef HAZE
    if (hitClouds) {
      hazeRayNearFar.y = mix(
        hazeRayNearFar.y, min(frontDepth, hazeRayNearFar.y), color.a
      );
    }
    #endif // HAZE
  }

  if (!hitClouds) {
    #ifdef SHADOW_LENGTH
    if (all(greaterThanEqual(shadowRayNearFar, vec2(0.0)))) {
      shadowLength = marchShadowLength(
        shadowRayNearFar.x * rayDirection + cameraPosition,
        rayDirection,
        shadowRayNearFar,
        stbn
      );
    }
    #endif // SHADOW_LENGTH

    // Velocity for temporal resolution. Here reproject in the view space for
    // greatly reducing the precision errors.
    frontDepth = sceneViewZ < 0.0 ? -sceneViewZ : cameraFar;
    vec3 frontView = vViewPosition * frontDepth;
    vec4 prevClip = viewReprojectionMatrix * vec4(frontView, 1.0);
    float previousViewDepthM = prevClip.w * length(worldToECEFMatrix[0].xyz);
    prevClip /= prevClip.w;
    vec2 prevUv = prevClip.xy * 0.5 + 0.5;
    vec2 velocity = vUv - prevUv;
    depthVelocity = vec4(frontDepth * 1e-4, velocity, previousViewDepthM * 1e-4);
  }

  #ifdef DEBUG_SHOW_FRONT_DEPTH
  outputColor = vec4(turbo(frontDepth / maxRayDistance), 1.0);
  outputDepthVelocity = vec4(0.0);
  #ifdef SHADOW_LENGTH
  outputShadowLength = 0.0;
  #endif // SHADOW_LENGTH
  return;
  #endif // DEBUG_SHOW_FRONT_DEPTH

  #ifdef HAZE
  vec4 haze = approximateHaze(
    cameraNear * rayDirection + cameraPosition,
    rayDirection,
    hazeRayNearFar.y - hazeRayNearFar.x,
    cosTheta,
    shadowLength
  );
  color.rgb = mix(color.rgb, haze.rgb, haze.a);
  color.a = color.a * (1.0 - haze.a) + haze.a;
  #endif // HAZE

  #ifdef EVE_CLOUD_PRESENTATION
  if (hitClouds) {
    // Apply the same weight to premultiplied light and opacity. Only the view
    // fades into its atmospheric background; weather and shadows stay physical.
    color *= eveCloudHorizonVisibility(cameraPosition - altitudeCorrection, rayDirection, frontDepth);
  }
  #endif

  // Cloud overlay ABI: RGB is atmosphere-treated at each representation's
  // depth; alpha is 1 - Tcloud before optional presentation. Empty is RGB=0,T=1.
  outputColor = color;
  outputDepthVelocity = depthVelocity;
  #ifdef SHADOW_LENGTH
  outputShadowLength = shadowLength * METER_TO_LENGTH_UNIT;
  #endif // SHADOW_LENGTH
}
