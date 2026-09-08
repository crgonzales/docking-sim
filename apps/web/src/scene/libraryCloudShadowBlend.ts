const ORIGINAL = `float sampleShadowOpticalDepth(
  const vec3 worldPosition,
  const vec3 positionECEF,
  const float radius,
  const float jitter
) {
  float distanceToTop = getDistanceToShadowTop(positionECEF);
  if (distanceToTop <= 0.0) {
    return 0.0;
  }
  int cascadeIndex = getFadedCascadeIndex(
    viewMatrix,
    worldPosition,
    shadowIntervals,
    cameraNear,
    shadowFar,
    jitter
  );
  return cascadeIndex >= 0
    ? sampleShadowOpticalDepthPCF(worldPosition, distanceToTop, radius, cascadeIndex)
    : 0.0;
}`;

const MARKER = '// CLOUD_SURFACE_SHADOW_BLEND';

/**
 * Pure source transform for the pinned three-atmosphere 0.19.1 receiver used
 * by three-clouds 0.7.6. Install once via a subclass's setFragmentShader().
 * Composes with depth reconstruction, storage decoding and diagnostic adapters.
 * No cloud producer, density, map matrices, sampling radius or mainImage edits.
 *
 * Blend over the final 20% of the near interval, ending at its nominal split:
 * do not rely on CSM's tiny fade enlargement to extend the near map beyond it.
 * The next map may not cover the beginning of this wider region. Its weight
 * ramps in over two texels inside its actual UV edge, and invalid maps/taps
 * never contribute artificial white. Only the two adjacent maps are eligible.
 *
 * Both PCF taps and cascades average exp(-tau), then return -log(T) for the
 * existing caller's single exp(-opticalDepth). Bilinear RGBA filtering remains
 * the library's approximation. This softens, but cannot correct, differing
 * density/LOD bias in the shadow maps. A broad blend requires actual overlap;
 * UV rejection can narrow it, and cannot create coverage where both maps miss.
 * The last cascade keeps the library's UV-only far-coverage policy.
 */
export function blendAerialCloudShadows(source: string, blendFraction = 0.2): string {
  if (!Number.isFinite(blendFraction) || blendFraction < 0.01 || blendFraction > 0.5) {
    throw new RangeError('Cloud shadow blend fraction must be in [0.01, 0.5]');
  }
  if (source.includes(MARKER) || source.split(ORIGINAL).length !== 2
    || source.split('float readShadowOpticalDepth(').length !== 2
    || source.split('float getShadowRadius(').length !== 2) {
    throw new Error('Pinned Takram aerial shadow shader changed; review cascade blend adapter');
  }
  return source.replace(ORIGINAL, `${MARKER}
bool cloudSurfaceShadowUvValid(const vec2 uv) {
  return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
}

float cloudSurfaceShadowCoverage(const vec2 uv) {
  vec2 size = vec2(textureSize(shadowBuffer, 0).xy);
  float edge = min(min(uv.x, 1.0 - uv.x) * size.x, min(uv.y, 1.0 - uv.y) * size.y);
  return smoothstep(0.0, 2.0, edge);
}

float cloudSurfaceShadowTransmittance(
  const vec3 worldPosition,
  const float distanceToTop,
  const float radius,
  const int cascadeIndex
) {
  // The caller has already validated the receiver's UV in this map.
  vec2 uv = getShadowUv(worldPosition, cascadeIndex);
  vec2 size = vec2(textureSize(shadowBuffer, 0).xy);
  float sum = 0.0;
  float count = 0.0;
  for (int i = 0; i < SHADOW_SAMPLE_COUNT; ++i) {
    vec2 offset = vogelDisk(i, SHADOW_SAMPLE_COUNT, interleavedGradientNoise(gl_FragCoord.xy) * PI2);
    vec2 tapUv = vec2(uv.x + offset.x * radius / size.x, uv.y + offset.y * radius / size.y);
    if (cloudSurfaceShadowUvValid(tapUv)) {
      sum += exp(-max(0.0, readShadowOpticalDepth(tapUv, distanceToTop, cascadeIndex)));
      count += 1.0;
    }
  }
  // Renormalize valid taps; an extreme kernel with no valid taps uses its
  // valid center. Neither missing taps nor another map's miss add white light.
  return count > 0.0 ? sum / count
    : exp(-max(0.0, readShadowOpticalDepth(uv, distanceToTop, cascadeIndex)));
}

float cloudSurfaceShadowOpticalDepth(const float transmittance) {
  // Keep the optical-depth ABI finite even when exp(-tau) underflows to zero.
  return -log(max(transmittance, 1e-30));
}

float sampleShadowOpticalDepth(
  const vec3 worldPosition,
  const vec3 positionECEF,
  const float radius,
  const float jitter
) {
  float distanceToTop = getDistanceToShadowTop(positionECEF);
  if (distanceToTop <= 0.0) return 0.0;
  float viewDepth = -(viewMatrix * vec4(worldPosition, 1.0)).z;
  float depth = (viewDepth - cameraNear) / (shadowFar - cameraNear);
  if (depth < 0.0) return 0.0;
  int nearIndex = SHADOW_CASCADE_COUNT - 1;
  for (int i = 0; i < SHADOW_CASCADE_COUNT - 1; ++i) {
    if (depth < shadowIntervals[i].y) {
      nearIndex = i;
      break;
    }
  }
  vec2 nearUv = getShadowUv(worldPosition, nearIndex);
  bool nearValid = cloudSurfaceShadowUvValid(nearUv);
  float nearT = nearValid
    ? cloudSurfaceShadowTransmittance(worldPosition, distanceToTop, radius, nearIndex) : 1.0;
  if (nearIndex == SHADOW_CASCADE_COUNT - 1) return cloudSurfaceShadowOpticalDepth(nearT);

  vec2 interval = shadowIntervals[nearIndex];
  float width = (interval.y - interval.x) * ${blendFraction.toFixed(8)};
  float progress = smoothstep(interval.y - width, interval.y, depth);
  if (progress <= 0.0) return cloudSurfaceShadowOpticalDepth(nearT);
  int farIndex = nearIndex + 1;
  vec2 farUv = getShadowUv(worldPosition, farIndex);
  if (!cloudSurfaceShadowUvValid(farUv)) return cloudSurfaceShadowOpticalDepth(nearT);
  float farT = cloudSurfaceShadowTransmittance(worldPosition, distanceToTop, radius, farIndex);
  if (!nearValid) return cloudSurfaceShadowOpticalDepth(farT);

  float farWeight = progress * cloudSurfaceShadowCoverage(farUv);
  float weightSum = 1.0 - progress + farWeight;
  float weight = weightSum > 0.0 ? farWeight / weightSum : 0.0;
  return cloudSurfaceShadowOpticalDepth(mix(nearT, farT, weight));
}`);
}
