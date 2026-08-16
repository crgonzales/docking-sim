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
`;
