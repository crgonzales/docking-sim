import type { Uniform } from 'three';
import { ShadowDiagnosticAerialEffect } from '../libraryCloudShadowDiagnostics';
import mediaGLSL from './shaders/cloudDensity.glsl?raw';
import transportGLSL from './shaders/cloudTransport.glsl?raw';
import lookupGLSL from './shaders/cloudLightLookup.glsl?raw';

const MARKER = '// EVE_AERIAL_CLOUD_LIGHTING';

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
    throw new Error('Pinned EVE aerial shader changed; review cloud lighting bridge');
  }
  return source.replace(before, after);
}

/** Transform the diagnostic/depth/water-adapted pinned atmosphere shader.
 * Cloud transport is in physical ECEF metres; only atmosphere queries use the
 * library's corrected position and length units. Invalid light-volume samples
 * use the very same canonical-media integration fallback as the cloud view.
 */
export function eveAerialCloudLighting(source: string, mediaGLSL: string): string {
  if (source.includes(MARKER)) throw new Error('EVE aerial cloud lighting is already installed');
  if (!/\bMediaSample\s+sampleCloudMedia\s*\(/.test(mediaGLSL)) {
    throw new Error('EVE aerial lighting requires the canonical sampleCloudMedia include');
  }
  // The media hook's legacy bottomRadius name means the physical radius. Alias
  // that token ONLY inside this include, never the atmosphere's own uniform.
  // New media hooks using eveCloudPlanetRadiusM already pass through unchanged.
  const physicalMediaGLSL = mediaGLSL.replace(/\bbottomRadius\b/g, 'eveCloudPlanetRadiusM');
  source = once(source, 'vec3 readNormal(', `${MARKER}
precision highp sampler3D;
${MEDIA_ABI}
${transportGLSL}
${physicalMediaGLSL}
${lookupGLSL}
vec3 readNormal(`);

  source = once(source,
    '  positionECEF = positionECEF * METER_TO_LENGTH_UNIT + vGeometryAltitudeCorrection;',
    `  vec3 evePhysicalPositionECEFM = positionECEF;
  float eveSurfaceFootprintM = max(1.0, max(
    length(dFdx(evePhysicalPositionECEFM)), length(dFdy(evePhysicalPositionECEFM))));
  positionECEF = positionECEF * METER_TO_LENGTH_UNIT + vGeometryAltitudeCorrection;`);

  source = once(source, `  #ifdef HAS_SHADOW
  float stbn = getSTBN();
  float radius = getShadowRadius(worldPosition);
  float opticalDepth = sampleShadowOpticalDepth(worldPosition, positionECEF, radius, stbn);
  float sunTransmittance = mix(1.0, exp(-opticalDepth), cloudSurfaceShadowStrength);
  #else // HAS_SHADOW
  float sunTransmittance = 1.0;
  #endif // HAS_SHADOW`, `  float sunTransmittance = 1.0;
  float eveSurfaceSkyVisibility = 1.0;
  float eveSurfaceShadowStrength = clamp(cloudSurfaceShadowStrength, 0.0, 1.0);
  if (!degenerateNormal && eveSurfaceShadowStrength > 0.0) {
    sunTransmittance = mix(1.0,
      eveSunTransmittance(evePhysicalPositionECEFM, 0.0, eveSurfaceFootprintM),
      eveSurfaceShadowStrength);
    #ifdef SKY_LIGHT
    eveSurfaceSkyVisibility = mix(1.0,
      eveSkyVisibility(evePhysicalPositionECEFM, eveSurfaceFootprintM),
      eveSurfaceShadowStrength);
    #endif
  }`);

  // These inputs now belong to EVE, independently of HAS_SHADOW. Apply them
  // before BOTH diffuse lighting and water's body/specular BRDF, exactly once.
  source = once(source, `  #ifdef HAS_SHADOW
  sunIrradiance *= sunTransmittance;
  #endif // HAS_SHADOW`, `  sunIrradiance *= sunTransmittance;
  skyIrradiance *= cloudSkyVisibility;`);
  source = once(source, '  const float sunTransmittance,\n',
    '  const float sunTransmittance,\n  const float cloudSkyVisibility,\n');
  source = once(source,
    'getSunSkyIrradiance(positionECEF, normalECEF, inputColor.rgb, sunTransmittance, waterViewDirection, waterFraction)',
    'getSunSkyIrradiance(positionECEF, normalECEF, inputColor.rgb, sunTransmittance, eveSurfaceSkyVisibility, waterViewDirection, waterFraction)');

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
  #endif // HAS_SHADOW_LENGTH`, '  float shadowLength = 0.0; // EVE shafts await a shared-backend producer.');
}

/** Drop-in diagnostic aerial effect; call installCloudLighting before rendering.
 * Pass the view's merged weather + CloudLightVolume uniforms, including
 * eveCloudPlanetRadiusM and eveCloudAltitudeBoundsM. Uniforms are borrowed by
 * identity, not cloned or owned. Keep their generation/values synchronized with
 * the view. An explicit sunDirection binding takes precedence over the canonical
 * eveWeatherSunDirectionECEF binding; otherwise the existing aerial sun is used.
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
export class EveAerialPerspectiveEffect extends ShadowDiagnosticAerialEffect {
  constructor(...args: ConstructorParameters<typeof ShadowDiagnosticAerialEffect>) {
    super(...args);
    this.shadow = null;
    this.shadowLength = null;
  }

  installCloudLighting(uniforms: Readonly<Record<string, Uniform>>, canonicalMediaGLSL = mediaGLSL): void {
    // Validate/prepare everything before modifying the live effect.
    const declarations = `${canonicalMediaGLSL}\n${transportGLSL}\n${lookupGLSL}`
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '');
    const required = declarations.matchAll(/\buniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(\w+)/g);
    for (const [, name] of required) {
      if (uniforms[name] == null) throw new Error(`Missing EVE aerial uniform: ${name}`);
    }
    for (const name of Object.keys(uniforms)) {
      if (this.uniforms.has(name) && name !== 'sunDirection') {
        throw new Error(`EVE cloud binding would replace an atmosphere uniform: ${name}`);
      }
    }
    const source = eveAerialCloudLighting(this.getFragmentShader(), canonicalMediaGLSL);
    for (const [name, uniform] of Object.entries(uniforms)) this.uniforms.set(name, uniform);
    const sun = uniforms.sunDirection ?? uniforms.eveWeatherSunDirectionECEF;
    if (sun != null) this.uniforms.set('sunDirection', sun);
    this.shadow = null;
    this.shadowLength = null;
    this.setFragmentShader(source);
  }

  override update(...args: Parameters<ShadowDiagnosticAerialEffect['update']>): void {
    this.shadow = null;
    this.shadowLength = null;
    super.update(...args);
  }
}
