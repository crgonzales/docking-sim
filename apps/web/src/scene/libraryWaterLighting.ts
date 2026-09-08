/** Statistical, flat water: no animated normals, new light or atmosphere pass.
 * GGX/Smith equations: https://www.cs.cornell.edu/~srm/publications/EGSR07-btdf.html
 * The mirror sky lookup is a bounded approximation to a rough sky convolution;
 * roughness blends it toward the existing hemispherical irradiance / pi.
 * Clouds attenuate direct light; reflected clouds are deliberately not modeled.
 */
export const WATER_ROUGHNESS = 0.28;

// Scalar GLSL is exported so energy tests execute the actual shader equations.
export const WATER_BRDF_GLSL = /* glsl */ `
float waterFresnel(float cosine) {
  float c = clamp(cosine, 0.0, 1.0);
  float eta = 1.333;
  float ct = sqrt(max(0.0, 1.0 - (1.0 - c * c) / (eta * eta)));
  float rs = (c - eta * ct) / (c + eta * ct);
  float rp = (eta * c - ct) / (eta * c + ct);
  return 0.5 * (rs * rs + rp * rp);
}

float waterGgx(float nv, float nl, float nh, float vh, float roughness) {
  if (nv <= 0.0 || nl <= 0.0) return 0.0;
  nv = clamp(nv, 0.0, 1.0);
  nl = clamp(nl, 0.0, 1.0);
  nh = clamp(nh, 0.0, 1.0);
  float r = clamp(roughness, 0.12, 0.65);
  float alpha = r * r;
  float a2 = alpha * alpha;
  float denominator = nh * nh * (a2 - 1.0) + 1.0;
  float distribution = a2 / (3.141592653589793 * denominator * denominator);
  // Smith G1(v) G1(l) / (4 nv nl), algebraically cancelling the cosines.
  float visibility = 1.0 / ((nv + sqrt(a2 + (1.0 - a2) * nv * nv))
    * (nl + sqrt(a2 + (1.0 - a2) * nl * nl)));
  return waterFresnel(vh) * distribution * visibility;
}

float waterRadianceChannel(float albedo, float sun, float sky, float reflected,
  float nv, float nl, float specular) {
  float fresnel = waterFresnel(nv);
  return albedo / 3.141592653589793 * (1.0 - fresnel)
    * ((1.0 - waterFresnel(nl)) * sun + sky)
    + fresnel * reflected + specular * sun;
}
`;

const WATER_RADIANCE_GLSL = /* glsl */ `
${WATER_BRDF_GLSL}
vec3 waterSurfaceRadiance(vec3 positionECEF, vec3 normal, vec3 viewDirection,
  vec3 sunIrradiance, vec3 skyIrradiance) {
  vec3 n = normalize(normal);
  float nv = clamp(dot(n, viewDirection), 0.0, 1.0);
  float nl = clamp(dot(n, sunDirection), 0.0, 1.0);
  vec3 halfSum = viewDirection + sunDirection;
  vec3 h = halfSum / max(length(halfSum), 1e-6);
  float specular = waterGgx(nv, nl, dot(n, h), dot(viewDirection, h), ${WATER_ROUGHNESS});
  vec3 reflectedSky = vec3(0.0);
  #ifdef SKY_LIGHT
  // Keep the LUT query outside the solid planet even at sea-level depth error.
  vec3 radial = normalize(positionECEF);
  vec3 skyPosition = radial * max(length(positionECEF), ATMOSPHERE.bottom_radius + METER_TO_LENGTH_UNIT);
  vec3 reflected = reflect(-viewDirection, n);
  // A geometric normal discrepancy must not send a sky ray through the ground.
  reflected = normalize(reflected + radial * max(0.0, 1e-5 - dot(reflected, radial)));
  vec3 skyTransmittance;
  reflectedSky = max(vec3(0.0), GetSkyRadiance(skyPosition, reflected, 0.0,
    sunDirection, skyTransmittance));
  // This is incident sky at the surface, not another view-path haze composite.
  reflectedSky = mix(reflectedSky, max(skyIrradiance, vec3(0.0)) * RECIPROCAL_PI,
    ${WATER_ROUGHNESS * WATER_ROUGHNESS});
  #endif
  vec3 bodyAlbedo = clamp(vec3(0.006, 0.018, 0.026) * albedoScale, 0.0, 1.0);
  return vec3(
    waterRadianceChannel(bodyAlbedo.r, sunIrradiance.r, skyIrradiance.r, reflectedSky.r, nv, nl, specular),
    waterRadianceChannel(bodyAlbedo.g, sunIrradiance.g, skyIrradiance.g, reflectedSky.g, nv, nl, specular),
    waterRadianceChannel(bodyAlbedo.b, sunIrradiance.b, skyIrradiance.b, reflectedSky.b, nv, nl, specular));
}
`;

function once(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) {
    throw new Error('Pinned Takram water lighting shader changed; review material adapter');
  }
  return source.replace(before, after);
}

/** Parent calls setFragmentShader(waterAerialLighting(source)) after its other
 * adapters, and installs Uniform<number>('waterLightingEnabled', 1). Setting 0
 * restores the exact old diffuse RGB. Alpha is metadata in either mode.
 *
 * Requires the current opaque RenderPass -> CloudsEffect(skipRendering=true)
 * -> aerial NORMAL blend, opacity=1 pipeline. No transparent material may opt
 * into the lighting mask. Normal/mask passes must not overwrite color. Albedo
 * debug mode bypasses this decoder and consequently exposes encoded alpha.
 */
export function waterAerialLighting(source: string): string {
  if (source.includes('// WATER_AERIAL_LIGHTING')) {
    throw new Error('Pinned Takram water lighting shader changed; adapter already applied');
  }
  // Parent may already declare the uniform alongside its diagnostic uniforms.
  if (!source.includes('uniform float waterLightingEnabled;')) {
    source = 'uniform float waterLightingEnabled;\n' + source;
  }
  source = once(source, 'vec3 getSunSkyIrradiance(',
    '// WATER_AERIAL_LIGHTING\n' + WATER_RADIANCE_GLSL + '\nvec3 getSunSkyIrradiance(');
  source = once(source, '  const float sunTransmittance\n) {',
    '  const float sunTransmittance,\n  const vec3 waterViewDirection,\n  const float waterFraction\n) {');
  const lightReturn = `  #if defined(SUN_LIGHT) && defined(SKY_LIGHT)
  return diffuse * (sunIrradiance + skyIrradiance);
  #elif defined(SUN_LIGHT)
  return diffuse * sunIrradiance;
  #elif defined(SKY_LIGHT)
  return diffuse * skyIrradiance;
  #endif // defined(SUN_LIGHT) && defined(SKY_LIGHT)`;
  source = once(source, lightReturn, `  #ifndef SUN_LIGHT
  sunIrradiance = vec3(0.0);
  #endif
  #ifndef SKY_LIGHT
  skyIrradiance = vec3(0.0);
  #endif
  vec3 diffuseRadiance = diffuse * (sunIrradiance + skyIrradiance);
  if (waterFraction <= 0.0 || waterLightingEnabled <= 0.0) return diffuseRadiance;
  return mix(diffuseRadiance, waterSurfaceRadiance(positionECEF, normal,
    waterViewDirection, sunIrradiance, skyIrradiance),
    waterFraction * clamp(waterLightingEnabled, 0.0, 1.0));`);
  source = once(source, '  vec3 radiance;\n  #if defined(SUN_LIGHT) || defined(SKY_LIGHT)', `  bool waterOpaque = false;
  #ifdef HAS_LIGHTING_MASK
  waterOpaque = !degenerateNormal && inputColor.a >= 0.5 && inputColor.a <= 1.0
    && texture(lightingMaskBuffer, uv).LIGHTING_MASK_CHANNEL_ > 0.5;
  #endif
  float waterFraction = waterOpaque ? clamp(2.0 * (1.0 - inputColor.a), 0.0, 1.0) : 0.0;
  vec3 waterViewDelta = vCameraPosition - positionECEF;
  vec3 waterViewDirection = waterViewDelta / max(length(waterViewDelta), 1e-6);
  vec3 radiance;
  #if defined(SUN_LIGHT) || defined(SKY_LIGHT)`);
  source = once(source,
    'getSunSkyIrradiance(positionECEF, normalECEF, inputColor.rgb, sunTransmittance)',
    'getSunSkyIrradiance(positionECEF, normalECEF, inputColor.rgb, sunTransmittance, waterViewDirection, waterFraction)');
  return once(source, 'outputColor = vec4(radiance, inputColor.a);',
    'outputColor = vec4(radiance, waterOpaque ? 1.0 : inputColor.a);');
}
