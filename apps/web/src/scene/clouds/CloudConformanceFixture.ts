import { EffectPass, ShaderPass } from 'postprocessing';
import { BasicDepthPacking, FloatType, GLSL3, Matrix4, RawShaderMaterial, Uniform, Vector2, Vector3, WebGLRenderTarget, type WebGLRenderer } from 'three';
import { AtmosphereParameters } from '@takram/three-atmosphere';
import { Ellipsoid } from '@takram/three-geospatial';
import { StableAerialPerspectiveEffect } from '../libraryDepth';
import { EARTH_RADIUS_M } from '../sky/skyConfig';
import { CloudConformanceResources, homogeneousCloudExpected } from './CloudConformanceResources';
import { verifyCloudLightVolume } from './CloudLightVolumeFixture';
import { runCloudTemporalConformance } from './CloudTemporalFixture';
import { runCloudWeatherConformance } from './CloudWeatherFixture';
import { runCloudMotionConformance } from './CloudMotionFixture';
import { runCloudPresentationConformance } from './CloudPresentationFixture';
import { runCloudColumnConformance } from './CloudColumnFixture';
import { runCloudDistantConformance } from './CloudDistantFixture';
import { runTerrainSurfaceConformance } from '../terrain/TerrainSurfaceFixture';
import { verifyCloudAerialTransport } from './CloudAerialFixture';
import { verifyOceanShadowReceiver } from './CloudOceanReceiverFixture';
import { verifyWaterReflectionContinuity } from './WaterReflectionFixture';
import { runCloudSamplingConformance } from './CloudSamplingFixture';
import {
  CloudsMaterial, ShadowMaterial, createAtmosphereUniforms, createCloudLayerUniforms,
  createCloudParameterUniforms, createCloudShaderHooks,
} from './takramCloudBackend';

export interface CloudConformanceResult {
  readonly name: string;
  readonly measured: readonly number[];
  readonly expected: readonly number[];
  readonly maxError: number;
  readonly passed: boolean;
}
export interface CloudConformanceReport {
  readonly status: 'passed' | 'failed' | 'unsupported';
  readonly error?: string;
  readonly tolerance: number;
  readonly cases: readonly CloudConformanceResult[];
}

// Only the medium and lighting inputs are synthetic. All integration, sphere
// intersection, depth decoding and aerial treatment use the production shaders.
const mediaGLSL = `
uniform vec2 fixtureExtinction;
uniform vec2 fixtureScattering;
uniform vec2 fixtureDensityScale;
MediaSample sampleCloudMedia(const vec3 positionECEFM, const float footprintM, const float weatherLod, const float jitter) {
  float height = length(positionECEFM) - bottomRadius;
  float inside = step(1000.0, height) * (1.0 - step(2000.0, height));
  float denseBand = step(1700.0, height) * (1.0 - step(1800.0, height));
  inside *= mix(fixtureDensityScale.x, fixtureDensityScale.y, denseBand);
  MediaSample media;
  media.density = inside;
  media.weight = vec4(inside, 0.0, 0.0, 0.0);
  media.extinction = inside * (fixtureExtinction.x + fixtureExtinction.y);
  media.scattering = inside * (fixtureScattering.x + fixtureScattering.y);
  media.phaseAnisotropy = vec2(0.0);
  media.phaseMix = 0.0;
  return media;
}`;
const lightingGLSL = `
uniform float fixtureRemainderTransmittance;
uniform float fixtureLightingValid;
CloudLightingSample sampleCloudLighting(vec3 positionECEFM, float footprintM, float sunStartM) {
  CloudLightingSample light;
  light.directTransmittance = fixtureRemainderTransmittance;
  light.skyIrradiance = vec3(4.0 * PI);
  light.valid = fixtureLightingValid;
  light.stockFallback = 0.0;
  light.generation = 0.0;
  return light;
}`;

/** Runs only from the explicit development probe; no readbacks in normal flight. */
export async function runCloudConformance(renderer: WebGLRenderer): Promise<CloudConformanceReport> {
  const tolerance = 1e-3;
  const cases: CloudConformanceResult[] = [];
  if (!renderer.extensions.has('EXT_color_buffer_float') || !renderer.capabilities.logarithmicDepthBuffer) {
    return { status: 'unsupported', error: 'Requires renderable RGBA32F and the production logarithmic-depth renderer.', tolerance, cases };
  }
  const resources = new CloudConformanceResources(renderer);
  const extinction = new Uniform(new Vector2());
  const scattering = new Uniform(new Vector2());
  const densityScale = new Uniform(new Vector2(1, 1));
  const remainder = new Uniform(1);
  const lightValid = new Uniform(1);
  const shaderHooks = createCloudShaderHooks({ mediaGLSL, lightingGLSL, uniforms: {
    fixtureExtinction: extinction, fixtureScattering: scattering, fixtureDensityScale: densityScale,
    fixtureRemainderTransmittance: remainder, fixtureLightingValid: lightValid,
  } });
  const atmosphere = new AtmosphereParameters({
    bottomRadius: EARTH_RADIUS_M, topRadius: EARTH_RADIUS_M + 60_000,
    solarIrradiance: new Vector3(),
  });
  const worldToECEFMatrix = new Matrix4().makeTranslation(EARTH_RADIUS_M + 3000, 0, 0);
  const parameterUniforms = createCloudParameterUniforms({
    localWeatherTexture: resources.one2D, localWeatherRepeat: new Vector2(1, 1), localWeatherOffset: new Vector2(),
    shapeTexture: resources.one3D, shapeRepeat: new Vector3(0.001, 0.001, 0.001), shapeOffset: new Vector3(),
    shapeDetailTexture: resources.one3D, shapeDetailRepeat: new Vector3(0.01, 0.01, 0.01), shapeDetailOffset: new Vector3(),
    turbulenceTexture: resources.zero2D, turbulenceRepeat: new Vector2(1, 1),
  });
  const layerUniforms = createCloudLayerUniforms();
  layerUniforms.minHeight.value = layerUniforms.shadowBottomHeight.value = 1000;
  layerUniforms.maxHeight.value = layerUniforms.shadowTopHeight.value = 2000;
  const atmosphereUniforms = createAtmosphereUniforms(atmosphere, {
    worldToECEFMatrix, ecefToWorldMatrix: worldToECEFMatrix.clone().invert(),
    altitudeCorrection: new Vector3(), sunDirection: new Vector3(1, 0, 0),
  });
  const params = { parameterUniforms, layerUniforms, atmosphereUniforms, shaderHooks };
  const cameraMaterial = new CloudsMaterial(params, atmosphere);
  const shadowMaterial = new ShadowMaterial(params);
  const cameraPass = new ShaderPass(cameraMaterial);
  const shadowPass = new ShaderPass(shadowMaterial);
  // The atmosphere EffectPass writes one color attachment, like the main
  // composer. Cloud MRT depth/velocity attachments belong to the cloud pass.
  const compositeTarget = new WebGLRenderTarget(resources.size, resources.size, {
    type: FloatType, depthBuffer: false,
  });
  // Three r170 cannot select MRT attachment 1 in its async readback API.
  // Copy the actual production outputDepthVelocity without filtering.
  const depthMaterial = new RawShaderMaterial({
    glslVersion: GLSL3, depthTest: false, depthWrite: false,
    uniforms: { depthVelocityBuffer: new Uniform(resources.output.textures[1]) },
    vertexShader: `precision highp float;
      in vec3 position;
      void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `precision highp float;
      precision highp sampler2D;
      uniform sampler2D depthVelocityBuffer;
      out vec4 depthVelocity;
      void main() {
        depthVelocity = texelFetch(depthVelocityBuffer, ivec2(gl_FragCoord.xy), 0);
      }`,
  });
  const depthPass = new ShaderPass(depthMaterial);
  const aerial = new StableAerialPerspectiveEffect(resources.camera, {
    ellipsoid: new Ellipsoid(EARTH_RADIUS_M, EARTH_RADIUS_M, EARTH_RADIUS_M),
    correctAltitude: false, correctGeometricError: false,
    sunLight: false, skyLight: false, transmittance: true, inscatter: true,
    sky: false, sun: false, moon: false,
    transmittanceTexture: resources.one2D, irradianceTexture: resources.zero2D,
    scatteringTexture: resources.zero3D,
  }, atmosphere);
  const aerialPass = new EffectPass(resources.camera, aerial);
  const record = (name: string, measured: readonly number[], expected: readonly number[]) => {
    const finite = measured.length === expected.length && measured.every(Number.isFinite);
    const maxError = finite ? Math.max(...measured.map((value, i) => Math.abs(value - expected[i]!))) : Infinity;
    cases.push({ name, measured, expected, maxError, passed: finite && maxError <= tolerance });
  };
  try {
    cameraMaterial.temporalUpscale = false;
    cameraMaterial.depthPacking = BasicDepthPacking;
    cameraMaterial.shadowLength = cameraMaterial.haze = cameraMaterial.shapeDetail = cameraMaterial.turbulence = false;
    cameraMaterial.accurateSunSkyLight = cameraMaterial.accuratePhaseFunction = false;
    cameraMaterial.multiScatteringOctaves = 1;
    cameraMaterial.transmittanceTexture = resources.one2D;
    cameraMaterial.irradianceTexture = resources.zero2D;
    cameraMaterial.scatteringTexture = resources.zero3D;
    cameraMaterial.setSize(resources.size, resources.size);
    const u = cameraMaterial.uniforms;
    u.depthBuffer.value = resources.depth.depthTexture;
    u.stbnTexture.value = resources.noise3D;
    u.shadowBuffer.value = resources.shadowArray;
    u.powderScale.value = u.groundBounceScale.value = 0;
    u.skyLightScale.value = 1;
    u.minDensity.value = u.minExtinction.value = 1e-8;
    u.minTransmittance.value = 1e-8;
    u.maxIterationCount.value = 512;
    u.maxIterationCountToSun.value = 0;
    u.maxIterationCountToGround.value = 0;
    u.referenceSampling.value = 1;
    u.referenceStepSize.value = 10;
    cameraMaterial.copyCameraSettings(resources.camera);
    const inputs = [
      { name: 'empty', e: [0, 0], s: [0, 0], terrain: null, length: 1000 },
      { name: 'slab', e: [0.001, 0], s: [0.0005, 0], terrain: null, length: 1000 },
      { name: 'overlap', e: [0.001, 0.002], s: [0.0005, 0.0005], terrain: null, length: 1000 },
      { name: 'overlap-reversed', e: [0.002, 0.001], s: [0.0005, 0.0005], terrain: null, length: 1000 },
      { name: 'terrain-before', e: [0.001, 0], s: [0.0005, 0], terrain: 500, length: 0 },
      { name: 'terrain-inside', e: [0.001, 0], s: [0.0005, 0], terrain: 1500, length: 500 },
      { name: 'terrain-partial-step', e: [0.001, 0], s: [0.0005, 0], terrain: 1437.5, length: 437.5 },
      { name: 'terrain-behind', e: [0.001, 0], s: [0.0005, 0], terrain: 2500, length: 1000 },
    ];
    for (const input of inputs) {
      extinction.value.fromArray(input.e);
      scattering.value.fromArray(input.s);
      resources.renderTerrain(input.terrain);
      resources.draw(() => cameraPass.render(renderer, null, resources.output));
      record(input.name, await resources.readCenter(), homogeneousCloudExpected(
        input.e[0]! + input.e[1]!, input.s[0]! + input.s[1]!, input.length,
      ).toArray());
    }
    // Exercise the real adaptive/jittered path too: the reference marcher
    // alone cannot catch gaps or overshoot introduced by step acceleration.
    u.referenceSampling.value = 0;
    u.minStepSize.value = 37;
    u.maxStepSize.value = 113;
    u.perspectiveStepScale.value = 1.1;
    extinction.value.set(0.001, 0);
    scattering.value.set(0.0005, 0);
    resources.renderTerrain(1437.5);
    resources.draw(() => cameraPass.render(renderer, null, resources.output));
    record('adaptive-terrain-partial-segment', await resources.readCenter(),
      homogeneousCloudExpected(0.001, 0.0005, 437.5).toArray());
    for (const blend of [0, 0.5, 1]) {
      u.farRepresentationMix.value = blend;
      u.farIterationCount.value = 32;
      resources.draw(() => cameraPass.render(renderer, null, resources.output));
      record(`near-far-partial-terrain-blend-${blend}`, await resources.readCenter(),
        homogeneousCloudExpected(0.001, 0.0005, 437.5).toArray());
    }
    // A 100 m dense band is resolved by 25 m steps and missed by a single
    // far sample. Both still integrate the full 1000 m interval on the GPU.
    // The endpoint readbacks are the oracle for mixing these representations;
    // no CPU marcher or diagnostic override supplies their opacity/depth.
    u.minStepSize.value = u.maxStepSize.value = 25;
    u.perspectiveStepScale.value = 1;
    resources.renderTerrain(null);
    const readRepresentation = async (blend: number) => {
      u.farRepresentationMix.value = blend;
      resources.draw(() => {
        cameraPass.render(renderer, null, resources.output);
        depthPass.render(renderer, null, compositeTarget);
      });
      return {
        color: await resources.readCenter(),
        depthVelocity: await resources.readCenter(compositeTarget),
      };
    };
    for (const profile of [
      { name: 'unequal-opacity', background: 0.05, band: 8, coarseNear: false },
      { name: 'clear-far', background: 0, band: 8, coarseNear: false },
      { name: 'clear-near', background: 0, band: 8, coarseNear: true },
      { name: 'clear-both', background: 0, band: 0, coarseNear: false },
    ]) {
      densityScale.value.set(profile.background, profile.band);
      u.maxIterationCount.value = profile.coarseNear ? 1 : 512;
      u.farIterationCount.value = profile.coarseNear ? 40 : 1;
      const near = await readRepresentation(0);
      const far = await readRepresentation(1);
      const resolvedAlpha = 1 - Math.exp(-0.001 * (900 * profile.background + 100 * profile.band));
      const coarseAlpha = 1 - Math.exp(-profile.background);
      record(`near-far-${profile.name}-endpoint-opacity`, [near.color[3]!, far.color[3]!],
        profile.coarseNear ? [coarseAlpha, resolvedAlpha] : [resolvedAlpha, coarseAlpha]);
      if (profile.name === 'unequal-opacity') {
        record('near-far-distinct-opacity-and-depth', [
          Number(Math.abs(near.color[3]! - far.color[3]!) > 0.25),
          Number(Math.abs(near.depthVelocity[0]! - far.depthVelocity[0]!) > 0.01),
        ], [1, 1]);
      }
      for (const blend of [0, 0.25, 0.5, 0.75, 1]) {
        const measured = await readRepresentation(blend);
        const nearWeight = (1 - blend) * near.color[3]!;
        const farWeight = blend * far.color[3]!;
        const opacity = nearWeight + farWeight;
        // Clear rays retain the production scene/far-plane depth. In particular,
        // an empty endpoint's fallback depth must never enter a cloud mixture.
        const depth = opacity === 0 ? resources.camera.far * 1e-4
          : farWeight === 0 ? near.depthVelocity[0]!
          : nearWeight === 0 ? far.depthVelocity[0]!
          : (nearWeight * near.depthVelocity[0]! + farWeight * far.depthVelocity[0]!) / opacity;
        record(`near-far-${profile.name}-depth-blend-${blend}`,
          [measured.depthVelocity[0]!, measured.color[3]!, Number(measured.depthVelocity.every(Number.isFinite))],
          [depth, opacity, 1]);
        if (blend === 0 || blend === 1) {
          const endpoint = blend === 0 ? near : far;
          record(`near-far-${profile.name}-exact-endpoint-${blend}`, [
            Number(measured.depthVelocity[0] === endpoint.depthVelocity[0]),
            Number(measured.color.every((value, i) => value === endpoint.color[i])),
          ], [1, 1]);
        } else if (profile.name === 'unequal-opacity') {
          const unweightedDepth = (1 - blend) * near.depthVelocity[0]! + blend * far.depthVelocity[0]!;
          // Ensure the old representation-only formula fails this regression
          // by more than the fixture tolerance, despite depth's 1e-4 encoding.
          record(`near-far-opacity-depth-distinguishes-unweighted-${blend}`,
            [Number(Math.abs(depth - unweightedDepth) > 2 * tolerance)], [1]);
        }
      }
    }
    densityScale.value.set(1, 1);
    u.maxIterationCount.value = 512;
    u.farIterationCount.value = 32;
    u.minStepSize.value = 37;
    u.maxStepSize.value = 113;
    u.perspectiveStepScale.value = 1.1;
    u.farRepresentationMix.value = 0;
    u.referenceSampling.value = 1;
    shadowMaterial.cascadeCount = 1;
    shadowMaterial.temporalPass = shadowMaterial.temporalJitter = shadowMaterial.shapeDetail = shadowMaterial.turbulence = false;
    shadowMaterial.setSize(resources.size, resources.size);
    const shadow = shadowMaterial.uniforms;
    shadow.stbnTexture.value = resources.noise3D;
    shadow.maxIterationCount.value = 512;
    shadow.minDensity.value = shadow.minExtinction.value = shadow.minTransmittance.value = 1e-8;
    shadow.referenceSampling.value = 1;
    shadow.referenceStepSize.value = 10;
    // Shadow centre clip maps to the same ECEF origin as the view camera.
    shadow.inverseShadowMatrices.value[0]!.makeTranslation(0, 0, 1);
    extinction.value.set(0.001, 0);
    resources.draw(() => shadowPass.render(renderer, null, resources.output));
    const shadowPixel = await resources.readCenter();
    record('shadow-total-optical-depth', [shadowPixel[2]! * 1000], [1]);

    u.diagnosticRayOrigin.value.set(EARTH_RADIUS_M + 1000, 0, 0);
    u.diagnosticRayDirection.value.set(1, 0, 0);
    u.diagnosticRayLength.value = 1000;
    u.diagnosticMode.value = 3;
    resources.draw(() => cameraPass.render(renderer, null, resources.output));
    record('secondary-total-optical-depth', [(await resources.readCenter())[0]!], [1]);
    u.diagnosticMode.value = 4;
    u.minSecondaryStepSize.value = 250;
    u.maxIterationCountToSun.value = 25;
    remainder.value = Math.exp(-0.75);
    resources.draw(() => cameraPass.render(renderer, null, resources.output));
    record('near-plus-cache-disjoint', [(await resources.readCenter())[0]!], [Math.exp(-1)]);
    lightValid.value = 0;
    resources.draw(() => cameraPass.render(renderer, null, resources.output));
    record('invalid-cache-direct-fallback', [(await resources.readCenter())[0]!], [Math.exp(-1)]);
    u.maxIterationCountToSun.value = 0;
    resources.draw(() => cameraPass.render(renderer, null, resources.output));
    record('zero-near-budget-direct-fallback', [(await resources.readCenter())[0]!], [Math.exp(-1)]);
    lightValid.value = 1;
    remainder.value = Math.exp(-1);
    resources.draw(() => cameraPass.render(renderer, null, resources.output));
    record('zero-near-budget-full-cache', [(await resources.readCenter())[0]!], [Math.exp(-1)]);
    u.diagnosticMode.value = 0;
    remainder.value = 1;
    const background = [0.2, 0.3, 0.4] as const;
    resources.renderTerrain(2500, background);
    resources.draw(() => cameraPass.render(renderer, null, resources.output));
    aerial.worldToECEFMatrix.copy(worldToECEFMatrix);
    aerial.sunDirection.set(1, 0, 0);
    aerial.stbnTexture = resources.noise3D;
    aerial.overlay = { map: resources.output.texture };
    aerialPass.initialize(renderer, true, FloatType);
    aerialPass.setSize(resources.size, resources.size);
    aerialPass.setDepthTexture(resources.depth.depthTexture!, BasicDepthPacking);
    resources.draw(() => aerialPass.render(renderer, resources.depth, compositeTarget, 0, false));
    const slab = homogeneousCloudExpected(0.001, 0.0005, 1000);
    record('single-atmosphere-overlay-composition', (await resources.readCenter(compositeTarget)).slice(0, 3),
      background.map(channel => slab.x + Math.exp(-1) * channel));
    await verifyCloudLightVolume(renderer, resources, params, atmosphere, record);
    await verifyCloudAerialTransport(renderer, resources, params, atmosphere, record);
    await verifyOceanShadowReceiver(renderer, resources, params, atmosphere, record);
    await verifyWaterReflectionContinuity(renderer, resources, record);
    cases.push(...await runCloudSamplingConformance(renderer, resources));
    cases.push(...await runCloudTemporalConformance(renderer, resources, tolerance));
    cases.push(...await runCloudWeatherConformance(renderer, resources, tolerance));
    cases.push(...await runCloudMotionConformance(renderer, resources, tolerance));
    cases.push(...await runCloudPresentationConformance(renderer, resources, tolerance));
    cases.push(...await runCloudColumnConformance(renderer, resources, tolerance));
    cases.push(...await runCloudDistantConformance(renderer, resources, tolerance));
    cases.push(...await runTerrainSurfaceConformance(renderer, resources, tolerance));
    return { status: cases.every(result => result.passed) ? 'passed' : 'failed', tolerance, cases };
  } catch (error) {
    return { status: 'failed', error: String(error), tolerance, cases };
  } finally {
    depthPass.dispose();
    depthMaterial.dispose();
    cameraPass.dispose();
    shadowPass.dispose();
    cameraMaterial.dispose();
    shadowMaterial.dispose();
    aerialPass.dispose();
    aerial.dispose();
    compositeTarget.dispose();
    resources.dispose();
  }
}
