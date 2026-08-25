/** Shared surface-layer lighting. The atmosphere shell intentionally does not use this. */
export const SKY_LIGHTING_GLSL = /* glsl */ `
  const float SKY_AMBIENT_NIGHT_FLOOR = 0.04;

  float skyTerminatorRamp(float ndotl) {
    return smoothstep(-0.12, 0.18, ndotl);
  }

  float skyLightingAmount(float ndotl) {
    return mix(SKY_AMBIENT_NIGHT_FLOOR, 1.0, skyTerminatorRamp(ndotl));
  }

  vec3 skySunTint(float ndotl) {
    float warmth = 1.0 - clamp((ndotl + 0.05) / 0.65, 0.0, 1.0);
    return mix(vec3(1.0), vec3(1.0, 0.78, 0.56), 0.45 * warmth);
  }

  float skyExposureCurve(
    float altitude,
    float groundAltitude,
    float spaceAltitude,
    float groundExposure,
    float spaceExposure,
    float curvePower
  ) {
    float t = clamp((altitude - groundAltitude) / max(spaceAltitude - groundAltitude, 0.0001), 0.0, 1.0);
    float eased = t * t * (3.0 - 2.0 * t);
    return groundExposure + (spaceExposure - groundExposure) * pow(eased, curvePower);
  }

  // Exponential distance parameterisation for camera-inside atmosphere rays.
  // The increasing warp spends more samples near the camera, where the
  // Rayleigh density is highest, while callers retain the warped interval
  // length for unbiased integration.
  float densityWarpedDistance(
    float fraction,
    float pathLength,
    float rayleighScaleHeight
  ) {
    float t = clamp(fraction, 0.0, 1.0);
    float warp = min(pathLength / max(rayleighScaleHeight, 0.0001), 8.0);
    if (warp < 0.00001) return pathLength * t;
    return pathLength * (exp(warp * t) - 1.0) / max(exp(warp) - 1.0, 0.0001);
  }

  // Bruneton's transmittance-ratio identity. The LUT stores transmission from
  // a point to the top of the atmosphere; dividing the point value by the
  // camera value gives the camera-to-point segment without a second raymarch.
  vec2 skyAtmosphereLutUv(
    vec3 point,
    vec3 direction,
    vec3 planetCenter,
    float surfaceRadius,
    float atmosphereRadius
  ) {
    vec3 radial = point - planetCenter;
    float altitude = clamp(length(radial) - surfaceRadius, 0.0, atmosphereRadius - surfaceRadius);
    float altitudeUv = altitude / max(atmosphereRadius - surfaceRadius, 0.0001);
    float mu = dot(normalize(radial), normalize(direction));
    return vec2(mu * 0.5 + 0.5, altitudeUv);
  }

  vec3 skyTransmittanceRatio(
    sampler2D transmittanceLut,
    vec3 cameraPoint,
    vec3 surfacePoint,
    vec3 planetCenter,
    float surfaceRadius,
    float atmosphereRadius
  ) {
    vec3 direction = normalize(cameraPoint - surfacePoint);
    vec3 cameraToTop = texture2D(
      transmittanceLut,
      skyAtmosphereLutUv(cameraPoint, direction, planetCenter, surfaceRadius, atmosphereRadius)
    ).rgb;
    vec3 pointToTop = texture2D(
      transmittanceLut,
      skyAtmosphereLutUv(surfacePoint, direction, planetCenter, surfaceRadius, atmosphereRadius)
    ).rgb;
    return clamp(pointToTop / max(cameraToTop, vec3(0.0001)), 0.0, 1.0);
  }
`;
