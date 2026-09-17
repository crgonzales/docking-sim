precision highp float;
precision highp sampler2D;
precision highp sampler2DArray;

#include "core/turbo"
#include "catmullRomSampling"
#include "varianceClipping"

uniform sampler2D colorBuffer;
uniform sampler2D depthVelocityBuffer;
uniform sampler2D colorHistoryBuffer;
uniform sampler2D depthHistoryBuffer;
uniform bool historyValid;
uniform bool historyEnabled;
uniform bool stationaryCamera;
uniform bool accumulateFreshSamples;
// Opt-in for the fully prepared orbital column representation.
uniform bool orbitalReconstruction;
uniform sampler2D sceneDepthBuffer;
uniform bool sceneDepthEnabled;
uniform vec2 sceneCameraRange;
uniform bool sceneLogDepth;
uniform bool scenePerspective;
uniform float depthAbsoluteThresholdM;
uniform float stationaryDepthAbsoluteThresholdM;
uniform float depthRelativeThreshold;
uniform float historyOpacityThreshold;

#ifdef SHADOW_LENGTH
uniform sampler2D shadowLengthBuffer;
uniform sampler2D shadowLengthHistoryBuffer;
#endif // SHADOW_LENGTH

uniform vec2 texelSize;
uniform int frame;
uniform float varianceGamma;
uniform float temporalAlpha;
uniform vec2 jitterOffset;

in vec2 vUv;

layout(location = 0) out vec4 outputColor;
layout(location = 1) out vec2 outputDepth;
float resolvedDepth;
#ifdef SHADOW_LENGTH
layout(location = 2) out float outputShadowLength;
#endif // SHADOW_LENGTH

const ivec2 neighborOffsets[9] = ivec2[9](
  ivec2(-1, -1),
  ivec2(-1, 0),
  ivec2(-1, 1),
  ivec2(0, -1),
  ivec2(0, 0),
  ivec2(0, 1),
  ivec2(1, -1),
  ivec2(1, 0),
  ivec2(1, 1)
);

const ivec4[4] bayerIndices = ivec4[4](
  ivec4(0, 12, 3, 15),
  ivec4(8, 4, 11, 7),
  ivec4(2, 14, 1, 13),
  ivec4(10, 6, 9, 5)
);

ivec2 clampCoord(const sampler2D inputBuffer, const ivec2 coord) {
  return clamp(coord, ivec2(0), textureSize(inputBuffer, 0) - 1);
}

// Full-resolution opaque depth owns the silhouette. The sparse cloud ray
// lattice must never spread an occluded ray into neighboring background pixels.
float sceneViewDepth(const vec2 uv) {
  if (!sceneDepthEnabled) return 0.0;
  float d = texture(sceneDepthBuffer, uv).r;
  if (d >= 1.0 - 1e-7) return 0.0;
  float n = sceneCameraRange.x, f = sceneCameraRange.y;
  if (!scenePerspective) return n + d * (f - n);
  if (sceneLogDepth) return exp2(d * log2(f + 1.0)) - 1.0;
  return n * f / (f - d * (f - n));
}

bool sameOpaqueSurface(const float a, const float b) {
  if (!sceneDepthEnabled) return true;
  if (a == 0.0 || b == 0.0) return a == b;
  return abs(a - b) <= max(0.5, 0.02 * b);
}

vec2 currentRayUv(const ivec2 tap) {
  #ifdef TEMPORAL_UPSCALE
  return (vec2(tap * 4) + jitterOffset + 2.0) * texelSize;
  #else
  return (vec2(tap) + 0.5) * texelSize;
  #endif
}

bool compatibleRay(const ivec2 tap) {
  if (!sceneDepthEnabled) return true;
  float target = sceneViewDepth(vUv);
  if (orbitalReconstruction) {
    vec4 color = texelFetch(colorBuffer, tap, 0);
    float front = texelFetch(depthVelocityBuffer, tap, 0).r * 1e4;
    // An unclipped empty ray carries the far-plane depth. A scene-clipped
    // empty ray is useful only as far as its measured endpoint; never spread
    // an occluded zero into background behind terrain or embedded geometry.
    if (any(isnan(color)) || any(isinf(color)) || !(front > 0.0) || isinf(front) || isnan(front)) return false;
    if (color.a <= historyOpacityThreshold)
      return target == 0.0 ? front >= sceneCameraRange.y * 0.999 :
        front >= target - max(0.5, 0.02 * target);
    // Carve cloudy taps using each destination's full-resolution depth.
    if (color.a > historyOpacityThreshold && front > 0.0)
      return target == 0.0 || front <= target + 0.5;
  }
  return sameOpaqueSurface(sceneViewDepth(currentRayUv(tap)), target);
}

bool positiveDepth(const float depth) {
  // The paired encoders store positive view metres * 1e-4 in half floats.
  return depth > 0.0 && !isnan(depth) && !isinf(depth);
}

bool depthMatches(const float stored, const float expected) {
  if (!positiveDepth(stored) || !positiveDepth(expected)) {
    return false;
  }
  float expectedM = expected * 1e4;
  float thresholdM = max(max(depthAbsoluteThresholdM, 0.0), max(depthRelativeThreshold, 0.0) * expectedM);
  return abs(stored - expected) * 1e4 <= thresholdM;
}

bool historyDepthMatches(const float stored, const float expected) {
  if (depthMatches(stored, expected)) return true;
  // Opt-in quadrature error budget, not a depth bypass. Restrict it to exact
  // stationary history texels; spatial motion dilation keeps depthMatches.
  return stationaryCamera && positiveDepth(stored) && positiveDepth(expected) &&
    stationaryDepthAbsoluteThresholdM > 0.0 &&
    !isnan(stationaryDepthAbsoluteThresholdM) && !isinf(stationaryDepthAbsoluteThresholdM) &&
    abs(stored - expected) * 1e4 <= stationaryDepthAbsoluteThresholdM;
}

vec4 getClosestFragment(const ivec2 coord, const vec4 center) {
  vec4 result = center;
  vec4 neighbor;
  ivec2 neighborCoord;
  #pragma unroll_loop_start
  for (int i = 0; i < 9; ++i) {
    neighborCoord = clampCoord(depthVelocityBuffer, coord + neighborOffsets[i]);
    neighbor = texelFetch(depthVelocityBuffer, neighborCoord, 0);
    // Dilate motion only within the current surface. Clear/foreground neighbors
    // must not lend their motion or depth to an unrelated reconstructed pixel.
    if (neighbor.r < result.r && depthMatches(neighbor.r, center.r) &&
        depthMatches(neighbor.a, center.a) &&
        texelFetch(colorBuffer, neighborCoord, 0).a > historyOpacityThreshold) {
      result = neighbor;
    }
  }
  #pragma unroll_loop_end
  return result;
}

// Keep the upstream moment/AABB reconstruction, but bound it to the actual
// neighborhood (including opacity) and clamp every integer fetch at the edge.
vec4 boundedVarianceClipping(
  const sampler2D inputBuffer,
  const ivec2 coord,
  const vec4 current,
  const vec4 history,
  const float gamma
) {
  vec4 moment1 = vec4(0.0);
  vec4 moment2 = vec4(0.0);
  vec4 neighborhoodMin = current;
  vec4 neighborhoodMax = current;
  vec4 neighbor;
  float count = 0.0;
  ivec2 tap;
  #pragma unroll_loop_start
  for (int i = 0; i < 9; ++i) {
    tap = clampCoord(inputBuffer, coord + neighborOffsets[i]);
    if (compatibleRay(tap)) {
      neighbor = texelFetch(inputBuffer, tap, 0);
      count += 1.0;
      moment1 += neighbor;
      moment2 += neighbor * neighbor;
      neighborhoodMin = min(neighborhoodMin, neighbor);
      neighborhoodMax = max(neighborhoodMax, neighbor);
    }
  }
  #pragma unroll_loop_end
  if (count == 0.0) return current;
  vec4 mean = moment1 / count;
  vec4 sigma = sqrt(max(moment2 / count - mean * mean, 0.0)) * clamp(gamma, 0.0, 2.0);
  mean = clamp(mean, neighborhoodMin, neighborhoodMax);
  vec4 minColor = max(neighborhoodMin, mean - sigma);
  vec4 maxColor = min(neighborhoodMax, mean + sigma);
  return clamp(clipAABB(mean, history, minColor, maxColor), minColor, maxColor);
}

bool sampleHistory(
  const vec2 prevUv,
  const float expectedDepth,
  out vec4 historyColor,
  out float historyShadowLength
) {
  historyColor = vec4(0.0);
  historyShadowLength = 0.0;
  if (any(isnan(prevUv)) || any(isinf(prevUv)) ||
      any(lessThan(prevUv, vec2(0.0))) || any(greaterThan(prevUv, vec2(1.0)))) {
    return false;
  }

  // Reconstruct the same bilinear footprint for color/depth/shadow. Validating
  // only a nearest depth then filtering color can admit a different surface.
  // Near volumes retain strict rejection. Orbital clear gaps are valid only
  // when their previous opaque depth lies behind the expected cloud front;
  // renormalize compatible taps, never interpolate incompatible depths.
  vec2 position = prevUv * vec2(textureSize(colorHistoryBuffer, 0)) - 0.5;
  // An unchanged physical camera has an exact same-pixel correspondence.
  // ECEF roundoff (or UV multiplication alone) must not introduce a tiny tap
  // across a clear/depth edge and reject all useful history. Keep the checks
  // above and below: this changes the footprint, never depth/opacity tolerance.
  if (stationaryCamera) position = floor(gl_FragCoord.xy);
  float historyWeight = 0.0;
  ivec2 baseCoord = ivec2(floor(position));
  vec2 fraction = fract(position);
  for (int y = 0; y < 2; ++y) {
    for (int x = 0; x < 2; ++x) {
      float weight = (x == 0 ? 1.0 - fraction.x : fraction.x) *
        (y == 0 ? 1.0 - fraction.y : fraction.y);
      if (weight <= 0.0) {
        continue;
      }
      ivec2 tap = clampCoord(colorHistoryBuffer, baseCoord + ivec2(x, y));
      vec4 color = texelFetch(colorHistoryBuffer, tap, 0);
      float depth = texelFetch(depthHistoryBuffer, tap, 0).r;
      float opaqueDepth = texelFetch(depthHistoryBuffer, tap, 0).g;
      bool clear = color.a <= historyOpacityThreshold && depth == 0.0;
      bool valid = !any(isnan(color)) && !any(isinf(color)) &&
        (orbitalReconstruction
          ? (opaqueDepth <= 0.0 || expectedDepth <= opaqueDepth + 0.00005) &&
            (clear || historyDepthMatches(depth, expectedDepth))
          : color.a > historyOpacityThreshold && historyDepthMatches(depth, expectedDepth));
      if (!valid) {
        if (orbitalReconstruction) continue;
        return false;
      }
      historyWeight += weight;
      historyColor += color * weight;
      #ifdef SHADOW_LENGTH
      float shadowLength = texelFetch(shadowLengthHistoryBuffer, tap, 0).r;
      if (isnan(shadowLength) || isinf(shadowLength)) {
        return false;
      }
      historyShadowLength += shadowLength * weight;
      #endif // SHADOW_LENGTH
    }
  }
  if (historyWeight < 0.25) return false;
  historyColor /= historyWeight;
  // Sharper history only when every contributing texel is compatible. Fall
  // back to the guarded positive bilinear footprint at depth disocclusions.
  if (orbitalReconstruction && !stationaryCamera && historyWeight > 0.999) {
    vec2 f = fraction;
    vec2 w[4];
    w[0] = f * (-0.5 + f * (1.0 - 0.5 * f));
    w[1] = 1.0 + f * f * (-2.5 + 1.5 * f);
    w[2] = f * (0.5 + f * (2.0 - 1.5 * f));
    w[3] = f * f * (-0.5 + 0.5 * f);
    vec4 cubic = vec4(0.0);
    vec4 lo = vec4(1e20), hi = vec4(-1e20);
    bool compatible = true;
    for (int y = 0; y < 4; ++y) for (int x = 0; x < 4; ++x) {
      float weight = w[x].x * w[y].y;
      if (abs(weight) < 1e-6) continue;
      ivec2 tap = clampCoord(colorHistoryBuffer, baseCoord + ivec2(x - 1, y - 1));
      vec4 color = texelFetch(colorHistoryBuffer, tap, 0);
      vec2 depths = texelFetch(depthHistoryBuffer, tap, 0).rg;
      bool clear = color.a <= historyOpacityThreshold && depths.r == 0.0;
      if (any(isnan(color)) || any(isinf(color)) ||
          (depths.g > 0.0 && expectedDepth > depths.g + 0.00005) ||
          (!clear && !historyDepthMatches(depths.r, expectedDepth))) compatible = false;
      cubic += color * weight;
      lo = min(lo, color); hi = max(hi, color);
    }
    if (compatible) historyColor = clamp(cubic, max(lo, vec4(0.0)), hi);
  }
  historyShadowLength /= historyWeight;
  return true;
}

bool stationaryHistory(
  const ivec2 coord,
  out vec4 color,
  out float depth,
  out float shadowLength
) {
  // There is no current ray at this Bayer position. With an unchanged camera,
  // its exact previous pixel is stronger evidence than a different coarse ray.
  // Keep the complete tuple, including clear pixels and their zero depth. Do
  // not bilinearly mix surfaces or clip against today's other Bayer positions.
  color = texelFetch(colorHistoryBuffer, coord, 0);
  vec2 previousDepths = texelFetch(depthHistoryBuffer, coord, 0).rg;
  depth = previousDepths.r;
  // A stationary camera does not imply stationary vehicles. Reject their old
  // occlusion immediately, including formerly clear pixels behind a moved ship.
  if (!sameOpaqueSurface(previousDepths.g * 1e4, sceneViewDepth(vUv))) return false;
  shadowLength = 0.0;
  if (any(isnan(color)) || any(isinf(color)) || color.a < 0.0 || color.a > 1.0 ||
      (color.a > historyOpacityThreshold ? !positiveDepth(depth) : depth != 0.0)) {
    return false;
  }
  #ifdef SHADOW_LENGTH
  shadowLength = texelFetch(shadowLengthHistoryBuffer, coord, 0).r;
  if (isnan(shadowLength) || isinf(shadowLength)) {
    return false;
  }
  #endif // SHADOW_LENGTH
  return true;
}

// Reconstruct unsampled pixels at their position relative to today's jittered
// ray lattice. A rejected history pixel has no exact current ray; broadcasting
// the block's ray both erases gaps and creates square silhouettes during motion.
// Interpolate premultiplied color and shafts, with opacity-weighted metadata.
void spatialCurrent(
  const ivec2 coord,
  out vec4 color,
  out vec4 depthVelocity,
  out float shadowLength
) {
  vec2 latticePosition = (vec2(coord) - (jitterOffset + 1.5)) * 0.25;
  ivec2 baseCoord = ivec2(floor(latticePosition));
  vec2 fraction = fract(latticePosition);
  color = vec4(0.0);
  depthVelocity = vec4(0.0);
  shadowLength = 0.0;
  float depthWeight = 0.0;
  float spatialWeight = 0.0;
  bool validReprojection = true;
  for (int y = 0; y < 2; ++y) {
    for (int x = 0; x < 2; ++x) {
      float weight = (x == 0 ? 1.0 - fraction.x : fraction.x) *
        (y == 0 ? 1.0 - fraction.y : fraction.y);
      if (weight <= 0.0) continue;
      ivec2 tap = clampCoord(colorBuffer, baseCoord + ivec2(x, y));
      if (!compatibleRay(tap)) continue;
      spatialWeight += weight;
      vec4 sampleColor = texelFetch(colorBuffer, tap, 0);
      vec4 sampleDepth = texelFetch(depthVelocityBuffer, tap, 0);
      color += sampleColor * weight;
      #ifdef SHADOW_LENGTH
      shadowLength += texelFetch(shadowLengthBuffer, tap, 0).r * weight;
      #endif // SHADOW_LENGTH
      if (sampleColor.a > historyOpacityThreshold && positiveDepth(sampleDepth.r)) {
        float contribution = weight * sampleColor.a;
        depthVelocity.r += sampleDepth.r * contribution;
        depthWeight += contribution;
        if (positiveDepth(sampleDepth.a) &&
            !any(isnan(sampleDepth.gb)) && !any(isinf(sampleDepth.gb))) {
          depthVelocity.gba += sampleDepth.gba * contribution;
        } else {
          validReprojection = false;
        }
      }
    }
  }
  if (spatialWeight > 0.0) {
    color /= spatialWeight;
    shadowLength /= spatialWeight;
  }
  if (depthWeight > 0.0) depthVelocity /= depthWeight;
  // Do not turn a behind-camera/nonfinite contributing ray into valid history
  // by averaging its metadata with a valid neighbor.
  if (!validReprojection) depthVelocity.a = -1.0;
}

void temporalUpscale(
  const ivec2 coord,
  const ivec2 lowResCoord,
  const bool currentFrame,
  out vec4 outputColor,
  out float outputShadowLength
) {
  vec4 currentColor = texelFetch(colorBuffer, lowResCoord, 0);
  vec4 centerDepthVelocity = texelFetch(depthVelocityBuffer, lowResCoord, 0);
  bool currentCloud = currentColor.a > historyOpacityThreshold && positiveDepth(centerDepthVelocity.r);
  outputColor = currentColor;
  resolvedDepth = currentCloud ? centerDepthVelocity.r : 0.0;
  outputShadowLength = 0.0;
  #ifdef SHADOW_LENGTH
  vec4 currentShadowLength = vec4(texelFetch(shadowLengthBuffer, lowResCoord, 0).rgb, 1.0);
  outputShadowLength = currentShadowLength.r;
  #endif // SHADOW_LENGTH

  if (historyEnabled && historyValid && !currentFrame && stationaryCamera) {
    // Every pixel is freshly measured once per consecutive 16-frame cycle.
    // Cuts/disabled history bypass this path; fresh rays still clear/reject
    // immediately. Motion and invalid reprojection must use the guarded path.
    // The CPU physical-camera comparison is more precise than velocity from
    // float ECEF positions. Still reject nonfinite/out-of-screen reprojection.
    vec2 prevUv = vUv - centerDepthVelocity.gb;
    bool validUv = !any(isnan(prevUv)) && !any(isinf(prevUv)) &&
      all(greaterThanEqual(prevUv, vec2(0.0))) && all(lessThanEqual(prevUv, vec2(1.0)));
    bool validRay = currentColor.a > historyOpacityThreshold ? currentCloud && positiveDepth(centerDepthVelocity.a) :
      centerDepthVelocity.a >= 0.0 && !isnan(centerDepthVelocity.a) && !isinf(centerDepthVelocity.a);
    vec4 retainedColor;
    float retainedDepth;
    float retainedShadow;
    if (validRay && validUv &&
        stationaryHistory(coord, retainedColor, retainedDepth, retainedShadow)) {
      outputColor = retainedColor;
      resolvedDepth = retainedDepth;
      outputShadowLength = retainedShadow;
      return;
    }
  }

  if (!currentFrame) {
    spatialCurrent(coord, currentColor, centerDepthVelocity, outputShadowLength);
    currentCloud = currentColor.a > historyOpacityThreshold && positiveDepth(centerDepthVelocity.r);
    outputColor = currentColor;
    resolvedDepth = currentCloud ? centerDepthVelocity.r : 0.0;
    #ifdef SHADOW_LENGTH
    currentShadowLength = vec4(outputShadowLength, 0.0, 0.0, 1.0);
    #endif // SHADOW_LENGTH
  }

  if (!historyEnabled || !historyValid || !currentCloud || !positiveDepth(centerDepthVelocity.a) ||
      (currentFrame && !accumulateFreshSamples && !(orbitalReconstruction && stationaryCamera))) {
    // First use, clear gaps, reference mode, and optionally fresh Bayer texels
    // never read history. The current color/depth/shadow remain matched.
    return;
  }

  vec4 depthVelocity = getClosestFragment(lowResCoord, centerDepthVelocity);
  vec2 velocity = depthVelocity.gb;
  vec2 prevUv = vUv - velocity;
  vec4 historyColor;
  float historyShadowLength;
  if (!sampleHistory(prevUv, centerDepthVelocity.a, historyColor, historyShadowLength)) {
    return; // Rejection
  }

  vec4 clippedColor = boundedVarianceClipping(colorBuffer, lowResCoord, currentColor, historyColor, varianceGamma);
  float alpha = currentFrame ? clamp(temporalAlpha, 0.0, 1.0) : 0.0;
  outputColor = mix(clippedColor, currentColor, alpha);

  #ifdef SHADOW_LENGTH
  vec4 clippedShadowLength = boundedVarianceClipping(
    shadowLengthBuffer,
    lowResCoord,
    currentShadowLength,
    vec4(historyShadowLength, 0.0, 0.0, 1.0),
    varianceGamma
  );
  outputShadowLength = mix(clippedShadowLength.r, currentShadowLength.r, alpha);
  #endif // SHADOW_LENGTH
}

void temporalAntialiasing(const ivec2 coord, out vec4 outputColor, out float outputShadowLength) {
  vec4 currentColor = texelFetch(colorBuffer, coord, 0);
  vec4 centerDepthVelocity = texelFetch(depthVelocityBuffer, coord, 0);
  bool currentCloud = currentColor.a > historyOpacityThreshold && positiveDepth(centerDepthVelocity.r);
  outputColor = currentColor;
  resolvedDepth = currentCloud ? centerDepthVelocity.r : 0.0;
  outputShadowLength = 0.0;
  #ifdef SHADOW_LENGTH
  vec4 currentShadowLength = vec4(texelFetch(shadowLengthBuffer, coord, 0).rgb, 1.0);
  outputShadowLength = currentShadowLength.r;
  #endif // SHADOW_LENGTH

  if (!historyEnabled || !historyValid || !currentCloud || !positiveDepth(centerDepthVelocity.a)) {
    return;
  }

  vec4 depthVelocity = getClosestFragment(coord, centerDepthVelocity);
  vec2 velocity = depthVelocity.gb;

  vec2 prevUv = vUv - velocity;
  vec4 historyColor;
  float historyShadowLength;
  if (!sampleHistory(prevUv, centerDepthVelocity.a, historyColor, historyShadowLength)) {
    return; // Rejection
  }

  vec4 clippedColor = boundedVarianceClipping(colorBuffer, coord, currentColor, historyColor, varianceGamma);
  float alpha = clamp(temporalAlpha, 0.0, 1.0);
  outputColor = mix(clippedColor, currentColor, alpha);

  #ifdef SHADOW_LENGTH
  vec4 clippedShadowLength = boundedVarianceClipping(
    shadowLengthBuffer,
    coord,
    currentShadowLength,
    vec4(historyShadowLength, 0.0, 0.0, 1.0),
    varianceGamma
  );
  outputShadowLength = mix(clippedShadowLength.r, currentShadowLength.r, alpha);
  #endif // SHADOW_LENGTH
}

void main() {
  ivec2 coord = ivec2(gl_FragCoord.xy);

  #if !defined(SHADOW_LENGTH)
  float outputShadowLength;
  #endif // !defined(SHADOW_LENGTH)

  #ifdef TEMPORAL_UPSCALE
  ivec2 lowResCoord = clampCoord(colorBuffer, coord / 4);
  int bayerValue = bayerIndices[coord.x % 4][coord.y % 4];
  bool currentFrame = bayerValue == frame % 16;
  temporalUpscale(coord, lowResCoord, currentFrame, outputColor, outputShadowLength);
  #else // TEMPORAL_UPSCALE
  temporalAntialiasing(coord, outputColor, outputShadowLength);
  #endif // TEMPORAL_UPSCALE

  float opaqueDepthM = sceneViewDepth(vUv);
  if (sceneDepthEnabled && opaqueDepthM > 0.0 && resolvedDepth * 1e4 > opaqueDepthM + 0.5) {
    outputColor = vec4(0.0);
    outputShadowLength = 0.0;
  }
  if (!(outputColor.a > historyOpacityThreshold)) resolvedDepth = 0.0;
  outputDepth = vec2(resolvedDepth, opaqueDepthM * 1e-4);

  #if defined(SHADOW_LENGTH) && defined(DEBUG_SHOW_SHADOW_LENGTH)
  outputColor = vec4(turbo(outputShadowLength * 0.05), 1.0);
  #endif // defined(SHADOW_LENGTH) && defined(DEBUG_SHOW_SHADOW_LENGTH)

  #ifdef DEBUG_SHOW_VELOCITY
  outputColor.rgb = outputColor.rgb + vec3(abs(texture(depthVelocityBuffer, vUv).gb) * 10.0, 0.0);
  #endif // DEBUG_SHOW_VELOCITY
}
