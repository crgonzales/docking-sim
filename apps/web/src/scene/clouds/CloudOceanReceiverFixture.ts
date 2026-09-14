import { EffectPass } from 'postprocessing';
import { BasicDepthPacking, DataArrayTexture, FloatType, Matrix3, RGBAFormat,
  Uniform, Vector2, Vector3, WebGLRenderTarget, type WebGLRenderer } from 'three';
import { Ellipsoid } from '@takram/three-geospatial';
import { VolumetricAerialPerspectiveEffect } from './VolumetricAerialPerspectiveEffect';
import type { CloudsMaterial } from './takramCloudBackend';
import type { CloudConformanceResources } from './CloudConformanceResources';

class OceanReceiverDiagnostic extends VolumetricAerialPerspectiveEffect {
  readonly originalReceiver = new Uniform(0);
  observeReceiver(): void {
    const source = this.getFragmentShader();
    if (source.split('  vec3 radiance;').length !== 2) throw new Error('Ocean fixture observation seam changed');
    const correction = 'if (waterOpaque && waterFraction > 0.0)';
    if (source.split(correction).length !== 2) throw new Error('Ocean receiver correction seam changed');
    this.uniforms.set('fixtureOriginalReceiver', this.originalReceiver);
    this.setFragmentShader('uniform float fixtureOriginalReceiver;\n' + source.replace(correction,
      'if (fixtureOriginalReceiver < 0.5 && waterOpaque && waterFraction > 0.0)').replace('  vec3 radiance;',
      '  outputColor = vec4(volumetricSurfaceSkyVisibility, sunTransmittance, waterFraction, 1.0); return;\n  vec3 radiance;'));
  }
}

/** Earth-scale depth reconstruction + the actual surface shader. A deliberately
 * distinct cache/fallback sentinel exposes accidental cache-boundary switching;
 * no duplicate receiver math is used to manufacture the expected result. */
export async function verifyOceanShadowReceiver(
  renderer: WebGLRenderer, resources: CloudConformanceResources,
  params: ConstructorParameters<typeof CloudsMaterial>[0],
  atmosphere: ConstructorParameters<typeof CloudsMaterial>[1],
  record: (name: string, measured: readonly number[], expected: readonly number[]) => void,
): Promise<void> {
  const radius = params.atmosphereUniforms.bottomRadius.value;
  const data = new Float32Array(8 * 8 * 4 * 4);
  for (let layer = 0; layer < 4; ++layer) {
    data.fill(layer < 2 ? 0.25 : 0.5, layer * 8 * 8 * 4, (layer + 1) * 8 * 8 * 4);
  }
  const cache = new DataArrayTexture(data, 8, 8, 4);
  cache.type = FloatType; cache.format = RGBAFormat; cache.needsUpdate = true;
  const aerial = new OceanReceiverDiagnostic(resources.camera, {
    ellipsoid: new Ellipsoid(radius, radius, radius), correctAltitude: false, correctGeometricError: false,
    normalBuffer: resources.one2D, reconstructNormal: false,
    sunLight: true, skyLight: true, transmittance: false, inscatter: false,
    sky: false, sun: false, moon: false,
    transmittanceTexture: resources.one2D, irradianceTexture: resources.one2D,
    scatteringTexture: resources.zero3D,
  }, atmosphere);
  const target = new WebGLRenderTarget(resources.size, resources.size, { type: FloatType, depthBuffer: false });
  const pass = new EffectPass(resources.camera, aerial);
  try {
    aerial.installCloudLighting({
      volumetricWeatherSunDirectionECEF: new Uniform(new Vector3(1, 0, 0)),
      volumetricCloudPlanetRadiusM: new Uniform(radius), volumetricCloudAltitudeBoundsM: new Uniform(new Vector2(1000, 2000)),
      volumetricLightVolumeTexture: new Uniform(cache),
      volumetricLightFrame: new Uniform(new Matrix3().set(0, 0, 1, 1, 0, 0, 0, 1, 0)),
      volumetricLightCapRadius: new Uniform(1), volumetricLightAltitudeBoundsM: new Uniform(new Vector2(0, 2000)),
      volumetricLightSlices: new Uniform(2), volumetricLightValid: new Uniform(1), volumetricLightGeneration: new Uniform(1),
    }, `MediaSample sampleCloudMedia(const vec3 p, const float footprintM, const float lod, const float jitter) {
      MediaSample m; m.density = 0.0; m.weight = vec4(0.0); m.scattering = 0.0;
      m.extinction = 0.0; m.phaseAnisotropy = vec2(0.0); m.phaseMix = 0.0; return m;
    }`);
    // Observe the production decisions after both queries and classification.
    // Only the fixture's output changes; receiver, depth and lookup stay intact.
    aerial.observeReceiver();
    aerial.worldToECEFMatrix.copy(params.atmosphereUniforms.worldToECEFMatrix.value);
    aerial.sunDirection.set(1, 0, 0);
    aerial.stbnTexture = resources.noise3D;
    aerial.lightingMask = { map: resources.one2D, channel: 'r' };
    pass.initialize(renderer, true, FloatType);
    pass.setSize(resources.size, resources.size);
    pass.setDepthTexture(resources.depth.depthTexture!, BasicDepthPacking);
    for (const height of [-8, -0.5, 0, 0.5, 8]) {
      resources.renderTerrain(3000 - height, [0.2, 0.3, 0.4], 0.5);
      resources.draw(() => pass.render(renderer, resources.depth, target, 0, false));
      record(`ocean-shadow-cache-at-${height}m`, (await resources.readCenter(target)).slice(0, 3), [0.5, 0.25, 1]);
    }
    for (const height of [-8, 8]) {
      resources.renderTerrain(3000 - height, [0.2, 0.3, 0.4], 1);
      resources.draw(() => pass.render(renderer, resources.depth, target, 0, false));
      record(`land-shadow-physical-receiver-at-${height}m`, (await resources.readCenter(target)).slice(0, 3),
        [height < 0 ? 1 : 0.5, 0.25, 0]);
    }
    for (const fraction of [0.25, 0.5, 0.75]) {
      resources.renderTerrain(3008, [0.2, 0.3, 0.4], 1 - fraction / 2);
      resources.draw(() => pass.render(renderer, resources.depth, target, 0, false));
      record(`coast-blends-shadow-visibility-${fraction}`, (await resources.readCenter(target)).slice(0, 3),
        [1 - 0.5 * fraction, 0.25, fraction]);
    }
    resources.renderTerrain(3008, [0.2, 0.3, 0.4], 0.5);
    for (const strength of [0, 0.5]) {
      aerial.shadowStrength.value = strength;
      resources.draw(() => pass.render(renderer, resources.depth, target, 0, false));
      record(`ocean-direct-and-ambient-strength-${strength}`, (await resources.readCenter(target)).slice(0, 3),
        [1 - 0.5 * strength, 1 - 0.75 * strength, 1]);
    }
    aerial.shadowStrength.value = 1;
    // Negative control: bypass only the correction in the actual shader.
    // The old -8m ocean receiver must select fallback instead of cached sky.
    aerial.originalReceiver.value = 1;
    resources.draw(() => pass.render(renderer, resources.depth, target, 0, false));
    record('ocean-original-receiver-reproduces-cache-miss',
      (await resources.readCenter(target)).slice(0, 3), [1, 0.25, 1]);
    aerial.originalReceiver.value = 0;
    aerial.lightingMask = { map: resources.zero2D, channel: 'r' };
    resources.renderTerrain(3008, [0.2, 0.3, 0.4], 0.5);
    resources.draw(() => pass.render(renderer, resources.depth, target, 0, false));
    // Masked local PBR bypasses both cloud queries; alpha still must not be
    // interpreted as the opaque-ocean marker. Atmosphere composition is separate.
    record('unmasked-pbr-skips-lighting-and-ocean-classification',
      (await resources.readCenter(target)).slice(0, 3), [1, 1, 0]);
  } finally { pass.dispose(); aerial.dispose(); target.dispose(); cache.dispose(); }
}
