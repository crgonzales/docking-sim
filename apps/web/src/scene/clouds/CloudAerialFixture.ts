import { EffectPass } from 'postprocessing';
import { BasicDepthPacking, FloatType, Matrix3, Uniform, Vector2, Vector3, WebGLRenderTarget, type WebGLRenderer } from 'three';
import { Ellipsoid } from '@takram/three-geospatial';
import { EveAerialPerspectiveEffect } from './EveAerialPerspectiveEffect';
import type { CloudsMaterial } from './takramCloudBackend';
import type { CloudConformanceResources } from './CloudConformanceResources';

/** Actual surface/aerial consumer; the same homogeneous cloud fixture has a
 * closed-form sun transmittance. No atmosphere LUT approximation enters this diagnostic. */
export async function verifyCloudAerialTransport(
  renderer: WebGLRenderer, resources: CloudConformanceResources,
  params: ConstructorParameters<typeof CloudsMaterial>[0],
  atmosphere: ConstructorParameters<typeof CloudsMaterial>[1],
  record: (name: string, measured: readonly number[], expected: readonly number[]) => void,
): Promise<void> {
  const radius = params.atmosphereUniforms.bottomRadius.value;
  const aerial = new EveAerialPerspectiveEffect(resources.camera, {
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
    aerial.installCloudLighting({ ...params.shaderHooks!.uniforms,
      eveWeatherSunDirectionECEF: new Uniform(new Vector3(1, 0, 0)),
      eveCloudPlanetRadiusM: new Uniform(radius), eveCloudAltitudeBoundsM: new Uniform(new Vector2(1000, 2000)),
      eveLightVolumeTexture: new Uniform(resources.shadowArray), eveLightFrame: new Uniform(new Matrix3()),
      eveLightCapRadius: new Uniform(1), eveLightAltitudeBoundsM: new Uniform(new Vector2(1000, 2000)),
      eveLightSlices: new Uniform(1), eveLightValid: new Uniform(0), eveLightGeneration: new Uniform(-1),
    }, params.shaderHooks!.mediaGLSL);
    aerial.normalBuffer = resources.one2D;
    aerial.worldToECEFMatrix.copy(params.atmosphereUniforms.worldToECEFMatrix.value);
    aerial.sunDirection.set(1, 0, 0);
    aerial.stbnTexture = resources.noise3D;
    aerial.shadowDiagnostic.value = 1;
    pass.initialize(renderer, true, FloatType);
    pass.setSize(resources.size, resources.size);
    pass.setDepthTexture(resources.depth.depthTexture!, BasicDepthPacking);
    resources.renderTerrain(2500, [0.2, 0.3, 0.4]);
    for (const strength of [1, 0.5, 0]) {
      aerial.shadowStrength.value = strength;
      resources.draw(() => pass.render(renderer, resources.depth, target, 0, false));
      const measured = await resources.readCenter(target);
      record(`aerial-surface-sun-strength-${strength}`, [measured[0]!], [1 - strength + strength * Math.exp(-1)]);
    }
  } finally { pass.dispose(); target.dispose(); }
}
