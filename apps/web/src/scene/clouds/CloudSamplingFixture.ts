import { ShaderPass } from 'postprocessing';
import { AtmosphereParameters } from '@takram/three-atmosphere';
import { BasicDepthPacking, Data3DTexture, FloatType, GLSL3, Matrix4, NearestFilter, RawShaderMaterial, RedFormat, Uniform, Vector2, Vector3, type WebGLRenderer } from 'three';
import { EARTH_RADIUS_M } from '../sky/skyConfig';
import samplingGLSL from './vendor/takram/src/shaders/cloudSampling.glsl?raw';
import type { CloudConformanceResources } from './CloudConformanceResources';
import type { CloudConformanceResult } from './CloudConformanceFixture';
import { CLOUD_VIEW_SAMPLING } from './cloudViewSampling';
import { CloudsMaterial, createAtmosphereUniforms, createCloudLayerUniforms, createCloudParameterUniforms, createCloudShaderHooks } from './takramCloudBackend';

/** Actual sampling helpers plus the production primary marcher; no CPU/GLSL surrogate march. */
export async function runCloudSamplingConformance(renderer: WebGLRenderer, resources: CloudConformanceResources): Promise<CloudConformanceResult[]> {
  const texels = Float32Array.from({ length: 4 * 4 * 64 }, (_, index) => index);
  const noise = new Data3DTexture(texels, 4, 4, 64);
  noise.format = RedFormat; noise.type = FloatType;
  noise.minFilter = noise.magFilter = NearestFilter; noise.needsUpdate = true;
  const mode = new Uniform(0);
  const material = new RawShaderMaterial({ glslVersion: GLSL3, depthTest: false, depthWrite: false,
    uniforms: { stbnTexture: new Uniform(noise), mode },
    vertexShader: 'precision highp float; in vec3 position; void main(){ gl_Position=vec4(position.xy,0.,1.); }',
    fragmentShader: `precision highp float; precision highp sampler3D;
      uniform sampler3D stbnTexture; uniform int mode;
      ${samplingGLSL}
      layout(location=0) out vec4 value; layout(location=1) out vec4 metadata;
      void main(){
        metadata=vec4(0.0);
        if(mode==0){
          uint lo=0u,hi=0u,oldLo=0u,oldHi=0u;
          for(int i=0;i<64;++i){
            int layer=int(samplePrimarySTBN(vec2(0.5),i*16))/16;
            int oldLayer=(i*16)%64;
            if(layer<32)lo|=1u<<uint(layer); else hi|=1u<<uint(layer-32);
            if(oldLayer<32)oldLo|=1u<<uint(oldLayer); else oldHi|=1u<<uint(oldLayer-32);
          }
          float count=0.0,oldCount=0.0;
          for(int i=0;i<32;++i){uint bit=1u<<uint(i);
            count+=float((lo&bit)!=0u)+float((hi&bit)!=0u);
            oldCount+=float((oldLo&bit)!=0u)+float((oldHi&bit)!=0u);
          }
          value=vec4(count,oldCount,samplePrimarySTBN(vec2(1.5,2.5),16),samplePrimarySTBN(vec2(4.5,6.5),1024));
        } else {
          value=vec4(cloudBudgetStep(400000.0,192.0,1.0),cloudBudgetStep(400000.0,192.0,1.04),
            cloudBudgetStep(1000.0,1.0,1.04),cloudBudgetStep(1000.0,5.0,0.9));
        }
      }`,
  });
  const pass = new ShaderPass(material);
  const cases: CloudConformanceResult[] = [];
  const record = (name: string, measured: readonly number[], expected: readonly number[], tolerance: number) => {
    const maxError = measured.every(Number.isFinite) ? Math.max(...measured.map((v, i) => Math.abs(v - expected[i]))) : Infinity;
    cases.push({ name, measured, expected, maxError, passed: maxError <= tolerance });
  };
  const draw = async (index: number) => { mode.value = index; resources.draw(() => pass.render(renderer, null, resources.output)); return resources.readCenter(); };
  try {
    const noiseResult = await draw(0);
    record('sampling-full-noise-cycle-and-spatial-address-with-legacy-control', noiseResult, [64, 4, 25, 8], 1e-4);
    const budget = await draw(2);
    record('sampling-uniform-limit-and-final-segment', [budget[0], budget[2], budget[3]], [400000 / 192, 1000, 200], 0.02);
    record('sampling-near-step-below-uniform-budget', [Number(budget[1] > 0 && budget[1] < budget[0] / 5)], [1], 0);
    cases.push(...runPrimarySamplingConformance(renderer, resources));
    return cases;
  } finally { pass.dispose(); material.dispose(); noise.dispose(); }
}

/** Analytic inputs and diagnostic readouts only: CloudsMaterial owns every march step. */
function runPrimarySamplingConformance(renderer: WebGLRenderer, resources: CloudConformanceResources): CloudConformanceResult[] {
  const phases = 64;
  const gaussian = new Uniform(new Vector2(10_000, 200)); // centre and exp(-(s/width)^2) width, metres
  const peakExtinction = 0.001;
  const atmosphere = new AtmosphereParameters({
    bottomRadius: EARTH_RADIUS_M, topRadius: EARTH_RADIUS_M + 60_000,
    solarIrradiance: new Vector3(),
  });
  // X measures physical distance without subtracting two Earth-sized floats.
  const origin = new Vector3(0, 0, EARTH_RADIUS_M + 1000);
  const worldToECEFMatrix = new Matrix4().makeTranslation(...origin.toArray());
  const layerUniforms = createCloudLayerUniforms();
  layerUniforms.minHeight.value = layerUniforms.shadowBottomHeight.value = 1000;
  layerUniforms.maxHeight.value = layerUniforms.shadowTopHeight.value = 30_000;
  const material = new CloudsMaterial({
    layerUniforms,
    parameterUniforms: createCloudParameterUniforms({
      localWeatherTexture: resources.one2D, localWeatherRepeat: new Vector2(1, 1), localWeatherOffset: new Vector2(),
      shapeTexture: resources.one3D, shapeRepeat: new Vector3(0.001, 0.001, 0.001), shapeOffset: new Vector3(),
      shapeDetailTexture: resources.one3D, shapeDetailRepeat: new Vector3(0.01, 0.01, 0.01), shapeDetailOffset: new Vector3(),
      turbulenceTexture: resources.zero2D, turbulenceRepeat: new Vector2(1, 1),
    }),
    atmosphereUniforms: createAtmosphereUniforms(atmosphere, {
      worldToECEFMatrix, ecefToWorldMatrix: worldToECEFMatrix.clone().invert(),
      altitudeCorrection: new Vector3(), sunDirection: new Vector3(0, 0, 1),
    }),
    shaderHooks: createCloudShaderHooks({
      uniforms: { fixtureGaussianM: gaussian, fixturePeakExtinction: new Uniform(peakExtinction) },
      mediaGLSL: `
uniform vec2 fixtureGaussianM;
uniform float fixturePeakExtinction;
float fixtureIntegratedLengthM;
float fixtureEndpointM;
MediaSample sampleCloudMedia(const vec3 p, const float footprintM, const float lod, const float jitter) {
  float distanceM = dot(p - diagnosticRayOrigin, diagnosticRayDirection);
  float x = (distanceM - fixtureGaussianM.x) / fixtureGaussianM.y;
  float density = exp(-x * x);
  MediaSample media;
  media.density = density;
  media.weight = vec4(1.0, 0.0, 0.0, 0.0);
  media.extinction = fixturePeakExtinction * density;
  media.scattering = media.extinction;
  media.phaseAnisotropy = vec2(0.0);
  media.phaseMix = 0.0;
  return media;
}`,
      lightingGLSL: `
CloudLightingSample sampleCloudLighting(const vec3 p, const float footprintM, const float startM) {
  CloudLightingSample light;
  light.directTransmittance = 1.0;
  light.skyIrradiance = vec3(4.0 * PI);
  light.valid = 1.0;
  light.stockFallback = 0.0;
  light.generation = 0.0;
  return light;
}`,
    }),
  }, atmosphere);
  const pass = new ShaderPass(material);
  const cases: CloudConformanceResult[] = [];
  const record = (name: string, measured: readonly number[], expected: readonly number[], tolerance: number) => {
    const finite = measured.length === expected.length && measured.every(Number.isFinite);
    const maxError = finite ? Math.max(...measured.map((v, i) => Math.abs(v - expected[i]!))) : Infinity;
    cases.push({ name: `sampling-primary-${name}`, measured, expected, maxError, passed: finite && maxError <= tolerance });
  };
  try {
    material.temporalUpscale = false;
    material.depthPacking = BasicDepthPacking;
    material.shadowLength = material.haze = material.shapeDetail = material.turbulence = false;
    material.accurateSunSkyLight = material.accuratePhaseFunction = false;
    material.multiScatteringOctaves = 1;
    material.transmittanceTexture = resources.one2D;
    material.irradianceTexture = resources.zero2D;
    material.scatteringTexture = resources.zero3D;
    material.defines.DEBUG_SHOW_SAMPLE_COUNT = '1';
    material.setSize(resources.size, resources.size);
    material.copyCameraSettings(resources.camera);
    const u = material.uniforms;
    u.depthBuffer.value = resources.depth.depthTexture;
    u.stbnTexture.value = resources.noise3D;
    u.shadowBuffer.value = resources.shadowArray;
    u.powderScale.value = u.groundBounceScale.value = 0;
    u.skyLightScale.value = 1;
    u.minExtinction.value = 1e-7;
    u.minTransmittance.value = 0.005;
    u.maxIterationCountToSun.value = u.maxIterationCountToGround.value = 0;
    u.referenceSampling.value = 0;
    u.diagnosticMode.value = 5;
    u.diagnosticRayOrigin.value.copy(origin);
    u.diagnosticRayDirection.value.set(1, 0, 0);

    // Test-local diagnostic 5 calls the installed production marchClouds, before
    // atmosphere/resolve. Two observations expose consumed length and endpoint;
    // neither changes a sample, branch, interval, budget or transport equation.
    const replacements: readonly [string, string][] = [
      ['    float sampleDistance = segmentStart + segmentLength *',
        '    fixtureIntegratedLengthM += segmentLength;\n    float sampleDistance = segmentStart + segmentLength *'],
      ['  frontDepth = transmittanceSum > 0.0 ? weightedDistanceSum / transmittanceSum : -1.0;',
        '  fixtureEndpointM = rayDistance;\n  frontDepth = transmittanceSum > 0.0 ? weightedDistanceSum / transmittanceSum : -1.0;'],
      ['void main() {', `void main() {
  if (diagnosticMode == 5) {
    int phase = int(gl_FragCoord.y) * int(resolution.x) + int(gl_FragCoord.x);
    outputColor = vec4(0.0); outputDepthVelocity = vec4(0.0);
    if (phase >= ${phases}) return;
    float jitter = (float(phase) + 0.5) / ${phases}.0;
    cloudRaySlope = 0.0; cloudEntryFootprintM = 0.0;
    correctedCameraHeight = length(diagnosticRayOrigin) - bottomRadius;
    fixtureIntegratedLengthM = 0.0; fixtureEndpointM = -1.0;
    float frontDepth, opticalDepth; ivec3 samples; vec3 lighting;
    vec4 cloud = marchClouds(diagnosticRayOrigin, diagnosticRayDirection,
      vec2(0.0, diagnosticRayLength), dot(sunDirection, diagnosticRayDirection),
      jitter, 1.0, false, frontDepth, samples, opticalDepth, lighting);
    outputColor = vec4(cloud.a, fixtureEndpointM / diagnosticRayLength,
      fixtureIntegratedLengthM / diagnosticRayLength, float(samples.x));
    return;
  }`],
    ];
    for (const [before, after] of replacements) {
      if (material.fragmentShader.split(before).length !== 2) {
        throw new Error('Production cloud sampling changed; review primary diagnostic readout seam');
      }
      material.fragmentShader = material.fragmentShader.replace(before, after);
    }
    material.needsUpdate = true;

    // Both quality probes use the production preferences. Only the negative
    // control overrides the former 800 m cap, with the current medium budget.
    const configurations = [
      { name: 'medium', settings: CLOUD_VIEW_SAMPLING.medium, meanTolerance: 0.002, rmsTolerance: 0.002 },
      { name: 'low', settings: CLOUD_VIEW_SAMPLING.low, meanTolerance: 0.005, rmsTolerance: 0.02 },
      { name: 'legacy-800', settings: { ...CLOUD_VIEW_SAMPLING.medium, maxStepSize: 800 }, meanTolerance: 0, rmsTolerance: 0 },
    ] as const;
    const rmsByName = new Map<string, number>();
    const pixels = new Float32Array(resources.size * resources.size * 4);
    if (resources.size * resources.size < phases) throw new Error('Sampling probe needs at least 64 pixels');
    const readRay = (spanM: number) => {
      u.diagnosticRayLength.value = spanM;
      pixels.fill(NaN); // Failed/partial readbacks must not masquerade as clear sky.
      resources.draw(() => pass.render(renderer, null, resources.output));
      renderer.readRenderTargetPixels(resources.output, 0, 0, resources.size, resources.size, pixels);
      const alphas: number[] = [], coverage: number[] = [], counts: number[] = [];
      for (let phase = 0; phase < phases; ++phase) {
        alphas.push(pixels[phase * 4]!);
        coverage.push(pixels[phase * 4 + 1]!, pixels[phase * 4 + 2]!);
        counts.push(pixels[phase * 4 + 3]!);
      }
      return { alphas, coverage, counts };
    };
    const opacityRms = (alphas: readonly number[], expected: number) =>
      Math.sqrt(alphas.reduce((sum, a) => sum + (a - expected) ** 2, 0) / phases);
    // The endpoints are 50 Gaussian widths from the centre: omitted tails are
    // negligible. The production 1e-7 extinction cutoff loses <1e-5 opacity.
    const expectedAlpha = -Math.expm1(-peakExtinction * gaussian.value.y * Math.sqrt(Math.PI));
    for (const { name, settings, meanTolerance, rmsTolerance } of configurations) {
      u.maxIterationCount.value = settings.maxIterationCount;
      u.minStepSize.value = settings.minStepSize;
      u.maxStepSize.value = settings.maxStepSize;
      u.perspectiveStepScale.value = settings.perspectiveStepScale;
      for (const spanM of [20_000, 400_000]) {
        const { alphas, coverage, counts } = readRay(spanM);
        record(`${name}-${spanM}m-complete-endpoint-and-integrated-length`, coverage, coverage.map(() => 1), 2e-5);
        record(`${name}-${spanM}m-finite-opacity-and-bounded-samples`, [Number(
          alphas.every(a => Number.isFinite(a) && a >= 0 && a <= 1) &&
          counts.every(n => Number.isInteger(n) && n > 0 && n <= settings.maxIterationCount)
        )], [1], 0);
        if (spanM === 400_000) {
          // The cap is a preference; covering this ray must consume the full
          // fixed budget rather than truncate its suffix at cap * iterations.
          record(`${name}-grazing-ray-exhausts-fixed-budget`, counts, counts.map(() => settings.maxIterationCount), 0);
          continue;
        }
        const mean = alphas.reduce((sum, a) => sum + a, 0) / phases;
        const rms = opacityRms(alphas, expectedAlpha);
        rmsByName.set(name, rms);
        if (name === 'legacy-800') {
          // Lower-bound assertion retains the actual RMS in the GPU report.
          cases.push({ name: 'sampling-primary-legacy-800-rms-at-least-0.1',
            measured: [rms], expected: [0.1], maxError: Number.isFinite(rms) ? Math.max(0, 0.1 - rms) : Infinity,
            passed: Number.isFinite(rms) && rms >= 0.1 });
        } else {
          record(`${name}-gaussian-opacity-mean`, [mean], [expectedAlpha], meanTolerance);
          record(`${name}-gaussian-opacity-rms`, [rms], [0], rmsTolerance);
        }
      }
      if (name === 'medium') {
        // Retain the former thin-near-feature oracle on a long grazing ray,
        // now through marchClouds including its actual empty-space branch.
        // The omitted negative Gaussian tail changes opacity by <1e-9.
        gaussian.value.set(2000, 450);
        const { alphas, coverage, counts } = readRay(400_000);
        const nearAlpha = -Math.expm1(-peakExtinction * gaussian.value.y * Math.sqrt(Math.PI));
        record('medium-thin-near-cloud-on-grazing-ray-opacity-rms', [opacityRms(alphas, nearAlpha)], [0], 0.02);
        record('medium-thin-near-cloud-complete-grazing-ray', coverage, coverage.map(() => 1), 2e-5);
        record('medium-thin-near-cloud-fixed-budget', counts, counts.map(() => settings.maxIterationCount), 0);
        gaussian.value.set(10_000, 200);
      }
    }
    const legacyRms = rmsByName.get('legacy-800')!;
    for (const [name, maxRatio] of [['medium', 0.1], ['low', 0.2]] as const) {
      record(`${name}-rms-relative-to-legacy-800`, [rmsByName.get(name)! / legacyRms], [0], maxRatio);
    }
    return cases;
  } finally { pass.dispose(); material.dispose(); }
}
