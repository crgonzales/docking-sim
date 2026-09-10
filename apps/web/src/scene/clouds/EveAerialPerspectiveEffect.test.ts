import { afterEach, describe, expect, it, vi } from 'vitest';
import { EffectPass, ToneMappingEffect } from 'postprocessing';
import { PerspectiveCamera, ShaderMaterial, Texture, Uniform, Vector2, Vector3,
  WebGLRenderTarget, type WebGLRenderer } from 'three';
import { ShadowDiagnosticAerialEffect } from '../libraryCloudShadowDiagnostics';
import { CloudLightVolume } from './CloudLightVolume';
import { createWeatherBindingUniforms, createWeatherSnapshot } from './cloudWeather';
import { EveAerialPerspectiveEffect, eveAerialCloudLighting } from './EveAerialPerspectiveEffect';
import mediaGLSL from './shaders/cloudDensity.glsl?raw';
import transportGLSL from './shaders/cloudTransport.glsl?raw';
import lookupGLSL from './shaders/cloudLightLookup.glsl?raw';

const disposables: { dispose(): void }[] = [];
function own<T extends { dispose(): void }>(value: T): T { disposables.push(value); return value; }
afterEach(() => disposables.splice(0).reverse().forEach(value => value.dispose()));

function binding(effect: EveAerialPerspectiveEffect, name: string): Uniform {
  return (effect.uniforms as Map<string, Uniform>).get(name)!;
}

function bindings(): Record<string, Uniform> {
  const snapshot = createWeatherSnapshot({ planetRadiusM: 6_371_000,
    visualTimeS: 0, generation: 7, sunDirectionECEF: [1, 0, 0] });
  const weather = createWeatherBindingUniforms(snapshot);
  const volume = own(new CloudLightVolume({ quality: 'low', mediaGLSL, reservedCloudBytes: 0 }));
  return { ...weather, ...volume.uniforms,
    eveCloudAltitudeBoundsM: new Uniform(new Vector2(snapshot.bounds.minAltitudeM, snapshot.bounds.maxAltitudeM)) };
}

describe('EVE atmosphere bridge against the pinned diagnostic/water shader', () => {
  it('ignores commented-out uniforms when validating the real shared bindings', () => {
    const aerial = own(new EveAerialPerspectiveEffect(new PerspectiveCamera()));
    const commentedMedia = `// uniform float unusedSingleLine;\n/* uniform vec3 unusedBlock; */\n${mediaGLSL}`;
    expect(() => aerial.installCloudLighting(bindings(), commentedMedia)).not.toThrow();
    expect(aerial.uniforms.has('unusedSingleLine')).toBe(false);
    expect(aerial.uniforms.has('unusedBlock')).toBe(false);
  });

  it('accepts the single-argument shared bindings and preserves the diagnostic ABI', () => {
    const aerial = own(new EveAerialPerspectiveEffect(new PerspectiveCamera()));
    const diagnostic: ShadowDiagnosticAerialEffect = aerial;
    expect(diagnostic).toBeInstanceOf(ShadowDiagnosticAerialEffect);
    const uniforms = bindings();
    const atmosphereRadius = aerial.uniforms.get('bottomRadius');
    const originalRadius = atmosphereRadius.value;
    const originalAtmosphere = aerial.uniforms.get('ATMOSPHERE');
    const texture = own(new Texture());
    const disposeTexture = vi.spyOn(texture, 'dispose');
    uniforms.eveLightVolumeTexture.value = texture;
    // The owner fills this uniform on its first volume request, after install.
    expect(uniforms.eveCloudPlanetRadiusM.value).toBe(0);
    aerial.installCloudLighting(uniforms);
    for (const [name, uniform] of Object.entries(uniforms)) {
      expect(binding(aerial, name), name).toBe(uniform);
    }
    expect(aerial.uniforms.get('sunDirection')).toBe(uniforms.eveWeatherSunDirectionECEF);
    uniforms.eveCloudPlanetRadiusM.value = 6_371_000;
    uniforms.eveLightGeneration.value = 8;
    expect(binding(aerial, 'eveCloudPlanetRadiusM').value).toBe(6_371_000);
    expect(binding(aerial, 'eveLightGeneration').value).toBe(8);
    expect(aerial.uniforms.get('bottomRadius')).toBe(atmosphereRadius);
    expect(atmosphereRadius.value).toBe(originalRadius);
    expect(aerial.uniforms.get('ATMOSPHERE')).toBe(originalAtmosphere);
    for (const [name, uniform] of Object.entries({
      cloudSurfaceShadowStrength: aerial.shadowStrength,
      cloudSurfaceShadowDiagnostic: aerial.shadowDiagnostic,
      cloudOverlayEnabled: aerial.cloudOverlay, waterLightingEnabled: aerial.waterLighting,
    })) expect(binding(aerial, name)).toBe(uniform);
    aerial.dispose();
    expect(disposeTexture).not.toHaveBeenCalled();
  });

  it('queries physical metres before either atmosphere correction and includes canonical fallback transport', () => {
    const aerial = own(new EveAerialPerspectiveEffect(new PerspectiveCamera()));
    aerial.installCloudLighting(bindings());
    const source = aerial.getFragmentShader();
    expect(source).toContain(mediaGLSL.replace(/\bbottomRadius\b/g, 'eveCloudPlanetRadiusM'));
    expect(source).toContain(transportGLSL);
    expect(source).toContain(lookupGLSL);
    expect(source.match(/struct MediaSample\s*\{/g)).toHaveLength(1);
    const main = source.slice(source.indexOf('void mainImage('));
    const physical = main.indexOf('vec3 evePhysicalPositionECEFM = positionECEF;');
    expect(physical).toBeGreaterThan(main.indexOf('(worldToECEFMatrix * vec4(worldPosition, 1.0)).xyz'));
    expect(physical).toBeLessThan(main.indexOf('positionECEF * METER_TO_LENGTH_UNIT + vGeometryAltitudeCorrection'));
    expect(physical).toBeLessThan(main.indexOf('correctGeometricError(positionECEF, normalECEF)'));
    expect(main.match(/eveSunTransmittance\(evePhysicalPositionECEFM, 0\.0, eveSurfaceFootprintM\)/g)).toHaveLength(1);
    expect(main.match(/eveSkyVisibility\(evePhysicalPositionECEFM, eveSurfaceFootprintM\)/g)).toHaveLength(1);
    expect(main).not.toContain('sampleShadowOpticalDepth(');
    expect(main).not.toContain('texture(shadowLengthBuffer');
    expect(main).toContain('viewPosition = viewRay * (viewZ / viewRay.z)');
  });

  it('attenuates ground and water inputs once, preserving atmosphere and overlay composition', () => {
    const aerial = own(new EveAerialPerspectiveEffect(new PerspectiveCamera()));
    const original = aerial.getFragmentShader();
    aerial.installCloudLighting(bindings());
    const source = aerial.getFragmentShader();
    expect(source.match(/sunIrradiance \*= sunTransmittance;/g)).toHaveLength(1);
    expect(source.match(/skyIrradiance \*= cloudSkyVisibility;/g)).toHaveLength(1);
    const irradiance = source.slice(source.indexOf('vec3 getSunSkyIrradiance('), source.indexOf('void applyTransmittanceInscatter('));
    expect(irradiance).not.toContain('HAS_SHADOW');
    expect(irradiance.indexOf('skyIrradiance *= cloudSkyVisibility')).toBeLessThan(irradiance.indexOf('vec3 diffuseRadiance'));
    expect(irradiance).toContain('waterViewDirection, sunIrradiance, skyIrradiance, cloudSkyVisibility)');
    const water = source.slice(source.indexOf('vec3 waterSurfaceRadiance('), source.indexOf('vec3 getSunSkyIrradiance('));
    expect(water.match(/reflectedSky \*= cloudSkyVisibility;/g)).toHaveLength(1);
    expect(water.indexOf('reflectedSky *= cloudSkyVisibility')).toBeLessThan(water.indexOf('reflectedSky = mix('));
    expect(water).not.toContain('eveSunTransmittance(');
    expect(water).not.toContain('eveSkyVisibility(');
    // The aerial-to-point helper is untouched, and each mutually exclusive
    // sky/surface overlay branch retains the pretreated premultiplied ABI.
    const atmosphere = (s: string) => s.slice(s.indexOf('void applyTransmittanceInscatter('), s.indexOf('float getSTBN('));
    expect(atmosphere(source)).toBe(atmosphere(original));
    const overlayLines = (s: string) => s.split('\n').filter(line => line.includes('overlay'));
    expect(overlayLines(source)).toEqual(overlayLines(original));
    expect(source.match(/applyTransmittanceInscatter\(positionECEF, shadowLength, radiance\);/g)).toHaveLength(1);
    expect(source).toContain('waterOpaque ? 1.0 : inputColor.a');
  });

  it.each([[true, true], [true, false], [false, true], [false, false]])(
    'assembles with tone mapping, sun=%s and sky=%s, without the legacy shadow define', (sunLight, skyLight) => {
      const camera = new PerspectiveCamera();
      const aerial = new EveAerialPerspectiveEffect(camera, { sunLight, skyLight });
      const uniforms = bindings();
      aerial.installCloudLighting(uniforms);
      const pass = own(new EffectPass(camera, aerial, new ToneMappingEffect()));
      pass.recompile();
      const material = pass.fullscreenMaterial as ShaderMaterial;
      expect(material.fragmentShader).toContain('e0EveSunTransmittance(evePhysicalPositionECEFM');
      expect(material.fragmentShader).toContain('e0SampleCloudMedia(');
      expect(material.fragmentShader).toContain('uniform float e0EveCloudPlanetRadiusM;');
      expect(material.fragmentShader).not.toContain('length(positionECEFM) - e0BottomRadius');
      expect(material.uniforms.e0EveLightVolumeTexture).toBe(uniforms.eveLightVolumeTexture);
      expect(material.uniforms.e0SunDirection).toBe(uniforms.eveWeatherSunDirectionECEF);
      expect(aerial.defines.has('HAS_SHADOW')).toBe(false);
      expect(aerial.defines.has('HAS_SHADOW_LENGTH')).toBe(false);
      expect(aerial.defines.has('SUN_LIGHT')).toBe(sunLight);
      expect(aerial.defines.has('SKY_LIGHT')).toBe(skyLight);
    });

  it('clears legacy cloud event assignments while retaining the overlay', () => {
    const camera = new PerspectiveCamera();
    camera.position.set(6_372_000, 0, 0);
    camera.updateMatrixWorld();
    const aerial = own(new EveAerialPerspectiveEffect(camera));
    aerial.installCloudLighting(bindings());
    const overlay = { map: own(new Texture()) };
    aerial.overlay = overlay;
    // A deliberately invalid legacy shadow proves it is never consumed.
    aerial.shadow = {} as NonNullable<typeof aerial.shadow>;
    aerial.shadowLength = { map: own(new Texture()) };
    const input = own(new WebGLRenderTarget());
    aerial.update({} as WebGLRenderer, input, 0);
    expect(aerial.shadow).toBeNull();
    expect(aerial.shadowLength).toBeNull();
    expect(aerial.overlay).toBe(overlay);
    expect(aerial.uniforms.get('overlayBuffer').value).toBe(overlay.map);
    expect(aerial.defines.has('HAS_SHADOW')).toBe(false);
    expect(aerial.defines.has('HAS_SHADOW_LENGTH')).toBe(false);
  });

  it('rejects missing bindings, atmosphere collisions and changed shader seams atomically', () => {
    const aerial = own(new EveAerialPerspectiveEffect(new PerspectiveCamera()));
    const uniforms = bindings();
    const original = aerial.getFragmentShader();
    const { eveLightVolumeTexture: omitted, ...missing } = uniforms;
    expect(() => aerial.installCloudLighting(missing)).toThrow('Missing EVE aerial uniform: eveLightVolumeTexture');
    expect(() => aerial.installCloudLighting({ ...uniforms, bottomRadius: new Uniform(6_371_000) })).toThrow('atmosphere uniform: bottomRadius');
    expect(aerial.getFragmentShader()).toBe(original);
    expect(aerial.uniforms.has('eveCloudPlanetRadiusM')).toBe(false);
    expect(() => eveAerialCloudLighting(original.replace('  reflectedSky = max', '  reflectedSky = changed'), '')).toThrow('canonical sampleCloudMedia');
    const seam = '  const float sunTransmittance,\n';
    for (const source of [original.replace(seam, ''), original + seam]) {
      expect(() => eveAerialCloudLighting(source, mediaGLSL)).toThrow('Pinned EVE aerial shader changed');
    }
    const sunDirection = new Uniform(new Vector3(0, 1, 0));
    aerial.installCloudLighting({ ...uniforms, sunDirection });
    expect(aerial.uniforms.get('sunDirection')).toBe(sunDirection);
    const installed = aerial.getFragmentShader();
    expect(() => aerial.installCloudLighting(uniforms)).toThrow();
    expect(() => eveAerialCloudLighting(installed, mediaGLSL)).toThrow('already installed');
    expect(aerial.getFragmentShader()).toBe(installed);
  });
});
