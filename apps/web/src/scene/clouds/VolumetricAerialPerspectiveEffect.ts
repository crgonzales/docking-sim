import { Uniform, type Texture } from 'three';
import { ShadowDiagnosticAerialEffect } from '../libraryCloudShadowDiagnostics';
import mediaGLSL from './shaders/cloudDensity.glsl?raw';
import transportGLSL from './shaders/cloudTransport.glsl?raw';
import lookupGLSL from './shaders/cloudLightLookup.glsl?raw';

const MARKER = '// VOLUMETRIC_AERIAL_CLOUD_LIGHTING';

// The atmosphere already supplies PI/RECIPROCAL_PI/RECIPROCAL_PI2. Do not
// include the cloud view's stock media machinery or redeclare those constants.
const MEDIA_ABI = /* glsl */ `
struct MediaSample {
  float density;
  vec4 weight;
  float scattering;
  float extinction;
  vec2 phaseAnisotropy;
  float phaseMix;
};
MediaSample sampleCloudMedia(
  const vec3 positionECEFM, const float footprintM,
  const float weatherLod, const float jitter
);
`;

function once(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) {
    throw new Error('Pinned VOLUMETRIC aerial shader changed; review cloud lighting bridge');
  }
  return source.replace(before, after);
}

/** Transform the diagnostic/depth/water-adapted pinned atmosphere shader.
 * Cloud transport is in physical ECEF metres; only atmosphere queries use the
 * library's corrected position and length units. Invalid light-volume samples
 * use the very same canonical-media integration fallback as the cloud view.
 */
export function volumetricAerialCloudLighting(source: string, mediaGLSL: string): string {
  if (source.includes(MARKER)) throw new Error('VOLUMETRIC aerial cloud lighting is already installed');
  if (!/\bMediaSample\s+sampleCloudMedia\s*\(/.test(mediaGLSL)) {
    throw new Error('VOLUMETRIC aerial lighting requires the canonical sampleCloudMedia include');
  }
  // The media hook's legacy bottomRadius name means the physical radius. Alias
  // that token ONLY inside this include, never the atmosphere's own uniform.
  // New media hooks using volumetricCloudPlanetRadiusM already pass through unchanged.
  const physicalMediaGLSL = mediaGLSL.replace(/\bbottomRadius\b/g, 'volumetricCloudPlanetRadiusM');
  source = once(source, 'vec3 readNormal(', `${MARKER}
precision highp sampler3D;
${MEDIA_ABI}
${transportGLSL}
${physicalMediaGLSL}
${lookupGLSL}
vec3 readNormal(`);

  source = once(source,
    '  positionECEF = positionECEF * METER_TO_LENGTH_UNIT + vGeometryAltitudeCorrection;',
    `  vec3 volumetricPhysicalPositionECEFM = positionECEF;
  float volumetricSurfaceFootprintM = max(1.0, max(
    length(dFdx(volumetricPhysicalPositionECEFM)), length(dFdy(volumetricPhysicalPositionECEFM))));
  positionECEF = positionECEF * METER_TO_LENGTH_UNIT + vGeometryAltitudeCorrection;`);

  source = once(source, `  #ifdef HAS_SHADOW
  float stbn = getSTBN();
  float radius = getShadowRadius(worldPosition);
  float opticalDepth = sampleShadowOpticalDepth(worldPosition, positionECEF, radius, stbn);
  float sunTransmittance = mix(1.0, exp(-opticalDepth), cloudSurfaceShadowStrength);
  #else // HAS_SHADOW
  float sunTransmittance = 1.0;
  #endif // HAS_SHADOW`, `  float sunTransmittance = 1.0;
  #ifdef HAS_LIGHTING_MASK
  float volumetricLightingMask = texture(lightingMaskBuffer, uv).LIGHTING_MASK_CHANNEL_;
  #else
  float volumetricLightingMask = 1.0;
  #endif
  // Ocean vertices can round just below the light volume's geoid boundary.
  // Keep the physical position for atmosphere/depth/BRDF, and lift only the
  // shared opaque-water shadow receiver by a small precision guard.
  vec3 volumetricShadowReceiverECEFM = volumetricPhysicalPositionECEFM;
  if (waterOpaque && waterFraction > 0.0) {
    vec3 volumetricGeoidReceiverECEFM = normalize(volumetricPhysicalPositionECEFM) *
      (volumetricCloudPlanetRadiusM + 2.0);
    volumetricShadowReceiverECEFM = volumetricGeoidReceiverECEFM;
  }
  float volumetricSurfaceSkyVisibility = 1.0;
  float volumetricSurfaceShadowStrength = clamp(cloudSurfaceShadowStrength, 0.0, 1.0);
  if (!degenerateNormal && volumetricSurfaceShadowStrength > 0.0 && volumetricLightingMask > 0.0) {
    sunTransmittance = volumetricSunTransmittance(volumetricShadowReceiverECEFM, 0.0, volumetricSurfaceFootprintM);
    #ifdef SKY_LIGHT
    volumetricSurfaceSkyVisibility = volumetricSkyVisibility(volumetricShadowReceiverECEFM, volumetricSurfaceFootprintM);
    #endif
    // Blend visibility, not receiver height: an interpolated height would
    // still cross the cache's hard sea-level boundary along fractional shores.
    // Only mixed coastal pixels pay for both physical land and geoid queries.
    if (waterFraction > 0.0 && waterFraction < 1.0) {
      sunTransmittance = mix(volumetricSunTransmittance(volumetricPhysicalPositionECEFM, 0.0, volumetricSurfaceFootprintM),
        sunTransmittance, waterFraction);
      #ifdef SKY_LIGHT
      volumetricSurfaceSkyVisibility = mix(volumetricSkyVisibility(volumetricPhysicalPositionECEFM, volumetricSurfaceFootprintM),
        volumetricSurfaceSkyVisibility, waterFraction);
      #endif
    }
    sunTransmittance = mix(1.0, sunTransmittance, volumetricSurfaceShadowStrength);
    #ifdef SKY_LIGHT
    volumetricSurfaceSkyVisibility = mix(1.0, volumetricSurfaceSkyVisibility, volumetricSurfaceShadowStrength);
    #endif
  }`);

  // These inputs now belong to VOLUMETRIC, independently of HAS_SHADOW. Apply them
  // before BOTH diffuse lighting and water's body/specular BRDF, exactly once.
  source = once(source, `  #ifdef HAS_SHADOW
  sunIrradiance *= sunTransmittance;
  #endif // HAS_SHADOW`, `  sunIrradiance *= sunTransmittance;
  skyIrradiance *= cloudSkyVisibility;`);
  source = once(source, '  const float sunTransmittance,\n',
    '  const float sunTransmittance,\n  const float cloudSkyVisibility,\n');
  source = once(source,
    'getSunSkyIrradiance(positionECEF, normalECEF, inputColor.rgb, sunTransmittance, waterViewDirection, waterFraction)',
    'getSunSkyIrradiance(positionECEF, normalECEF, inputColor.rgb, sunTransmittance, volumetricSurfaceSkyVisibility, waterViewDirection, waterFraction)');
  source = once(source, `  if (!degenerateNormal) {
    radiance = getSunSkyIrradiance(positionECEF, normalECEF, inputColor.rgb, sunTransmittance, volumetricSurfaceSkyVisibility, waterViewDirection, waterFraction);
  } else {
    radiance = inputColor.rgb;
  }`, `  if (!degenerateNormal && volumetricLightingMask > 0.0) {
    radiance = getSunSkyIrradiance(positionECEF, normalECEF, inputColor.rgb, sunTransmittance, volumetricSurfaceSkyVisibility, waterViewDirection, waterFraction);
  } else {
    // Local PBR receivers already applied cloud direct/sky visibility. Keep
    // their atmospheric transmittance and inscatter below.
    radiance = inputColor.rgb;
  }`);

  // The mirror-sky approximation shares the surface ambient visibility. Its
  // roughness blend already receives attenuated hemispherical sky irradiance,
  // so attenuate ONLY the fresh mirror LUT query before that blend.
  source = once(source, '  vec3 sunIrradiance, vec3 skyIrradiance) {',
    '  vec3 sunIrradiance, vec3 skyIrradiance, float cloudSkyVisibility) {');
  source = once(source, '    sunDirection, skyTransmittance));',
    '    sunDirection, skyTransmittance));\n  reflectedSky *= cloudSkyVisibility;');
  source = once(source, '    waterViewDirection, sunIrradiance, skyIrradiance),',
    '    waterViewDirection, sunIrradiance, skyIrradiance, cloudSkyVisibility),');

  // Stock shaft textures were produced from a different lighting backend.
  // Keep clear-atmosphere aerial perspective and the pretreated overlay intact.
  return once(source, `  float shadowLength = 0.0;
  #ifdef HAS_SHADOW_LENGTH
  shadowLength = texture(shadowLengthBuffer, uv).r;
  #endif // HAS_SHADOW_LENGTH`, '  float shadowLength = 0.0; // VOLUMETRIC shafts await a shared-backend producer.');
}

/** Drop-in diagnostic aerial effect; call installCloudLighting before rendering.
 * Pass the view's merged weather + CloudLightVolume uniforms, including
 * volumetricCloudPlanetRadiusM and volumetricCloudAltitudeBoundsM. Uniforms are borrowed by
 * identity, not cloned or owned. Keep their generation/values synchronized with
 * the view. An explicit sunDirection binding takes precedence over the canonical
 * volumetricWeatherSunDirectionECEF binding; otherwise the existing aerial sun is used.
 *
 * shadowStrength controls direct AND ambient cloud attenuation. The inherited
 * shadowDiagnostic, cloudOverlay and waterLighting controls retain their ABI.
 * Continue assigning the atmosphere-treated overlay, but leave shadow and
 * shadowLength null. update() also clears legacy cloud change-event assignments.
 * The cloud producer's own shaft work must be disabled by the integrator.
 * Ground below the light-volume altitude range uses the shared bounded ambient
 * fallback (currently 2 rays x 12 steps per shaded pixel). This can be expensive
 * at full resolution; no projection to cloud base or separate approximation is
 * introduced here. Water's reflected sky uses that same scalar sky visibility.
 */
export class VolumetricAerialPerspectiveEffect extends ShadowDiagnosticAerialEffect {
  /** Borrow the depth texture paired with this frame's resolved cloud color. */
  cloudOverlayDepthSource?: () => Texture | null;
  readonly cloudOverlayDepth = new Uniform<Texture | null>(null);
  readonly cloudOverlayDepthEnabled = new Uniform(false);
  constructor(...args: ConstructorParameters<typeof ShadowDiagnosticAerialEffect>) {
    super(...args);
    this.uniforms.set('cloudOverlayDepthBuffer', this.cloudOverlayDepth);
    this.uniforms.set('cloudOverlayDepthEnabled', this.cloudOverlayDepthEnabled);
    let source = this.getFragmentShader();
    source = once(source, 'void mainImage(', `
uniform sampler2D cloudOverlayDepthBuffer;
uniform bool cloudOverlayDepthEnabled;
#ifdef HAS_OVERLAY
vec4 readCloudOverlay(const vec2 uv) {
  if (!cloudOverlayDepthEnabled) return texture(overlayBuffer, uv);
  float depth = readDepthValue(depthBuffer, uv);
  float sceneM = 0.0;
  if (depth < 1.0 - 1e-7) {
    #if defined(USE_LOGDEPTHBUF) || defined(USE_LOGARITHMIC_DEPTH_BUFFER)
    sceneM = projectionMatrix[2][3] != 0.0 ? exp2(depth * log2(cameraFar + 1.0)) - 1.0 : -getViewZ(depth);
    #else
    sceneM = -getViewZ(depth);
    #endif
  }
  vec2 size = vec2(textureSize(overlayBuffer, 0));
  vec2 position = uv * size - 0.5;
  vec2 base = floor(position), fraction = fract(position);
  vec4 result = vec4(0.0);
  float total = 0.0;
  for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
    ivec2 tap = ivec2(clamp(base + vec2(x, y), vec2(0.0), size - 1.0));
    vec2 depthsM = texelFetch(cloudOverlayDepthBuffer, tap, 0).rg * 1e4;
    // The cloud output may be resolution-capped. Its final bilinear footprint
    // must obey the full scene silhouette too, including at high screen DPR.
    bool sameSurface = sceneM == 0.0 || depthsM.g == 0.0 ? sceneM == depthsM.g :
      abs(sceneM - depthsM.g) <= max(0.5, 0.02 * sceneM);
    if (!sameSurface || (sceneM > 0.0 && depthsM.r > sceneM + 0.5)) continue;
    float weight = (x == 0 ? 1.0 - fraction.x : fraction.x) *
      (y == 0 ? 1.0 - fraction.y : fraction.y);
    result += texelFetch(overlayBuffer, tap, 0) * weight;
    total += weight;
  }
  return total > 0.0 ? result / total : vec4(0.0);
}
#endif
void mainImage(`);
    source = once(source, 'vec4 overlay = texture(overlayBuffer, uv)', 'vec4 overlay = readCloudOverlay(uv)');
    this.setFragmentShader(source);
    this.shadow = null;
    this.shadowLength = null;
  }

  installCloudLighting(uniforms: Readonly<Record<string, Uniform>>, canonicalMediaGLSL = mediaGLSL): void {
    // Validate/prepare everything before modifying the live effect.
    const declarations = `${canonicalMediaGLSL}\n${transportGLSL}\n${lookupGLSL}`
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '');
    const required = declarations.matchAll(/\buniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(\w+)/g);
    for (const [, name] of required) {
      if (uniforms[name] == null) throw new Error(`Missing VOLUMETRIC aerial uniform: ${name}`);
    }
    for (const name of Object.keys(uniforms)) {
      if (this.uniforms.has(name) && name !== 'sunDirection') {
        throw new Error(`VOLUMETRIC cloud binding would replace an atmosphere uniform: ${name}`);
      }
    }
    const source = volumetricAerialCloudLighting(this.getFragmentShader(), canonicalMediaGLSL);
    for (const [name, uniform] of Object.entries(uniforms)) this.uniforms.set(name, uniform);
    const sun = uniforms.sunDirection ?? uniforms.volumetricWeatherSunDirectionECEF;
    if (sun != null) this.uniforms.set('sunDirection', sun);
    this.shadow = null;
    this.shadowLength = null;
    this.setFragmentShader(source);
  }

  override update(...args: Parameters<ShadowDiagnosticAerialEffect['update']>): void {
    this.cloudOverlayDepth.value = this.cloudOverlayDepthSource?.() ?? null;
    this.cloudOverlayDepthEnabled.value = this.cloudOverlayDepth.value !== null;
    this.shadow = null;
    this.shadowLength = null;
    super.update(...args);
  }
}
