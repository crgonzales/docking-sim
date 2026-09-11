import { ShaderPass } from 'postprocessing';
import { BasicDepthPacking, GLSL3, RawShaderMaterial, Uniform, Vector2, Vector3, type WebGLRenderer } from 'three';
import { CLOUD_MEDIA_GLSL_ABI, CloudLightVolume } from './CloudLightVolume';
import { CLOUD_LIGHT_QUALITY, cloudLightUvToPosition, createCloudLightVolumeLayout } from './cloudLightVolumeLayout';
import { CloudsMaterial, createCloudShaderHooks } from './takramCloudBackend';
import type { CloudConformanceResources } from './CloudConformanceResources';
import transport from './shaders/cloudTransport.glsl?raw';
import lookup from './shaders/cloudLightLookup.glsl?raw';

/** Real array producer + real view consumer, with a homogeneous medium oracle. */
export async function verifyCloudLightVolume(
  renderer: WebGLRenderer,
  resources: CloudConformanceResources,
  params: ConstructorParameters<typeof CloudsMaterial>[0],
  atmosphere: ConstructorParameters<typeof CloudsMaterial>[1],
  record: (name: string, measured: readonly number[], expected: readonly number[]) => void,
): Promise<void> {
  const radius = params.atmosphereUniforms.bottomRadius.value;
  const volume = new CloudLightVolume({ quality: 'low', mediaGLSL: params.shaderHooks!.mediaGLSL,
    reservedCloudBytes: 0, slicesPerFrame: { direct: 8, ambient: 8 } });
  const layout = createCloudLightVolumeLayout({ quality: 'low', planetRadiusM: radius,
    cameraPositionECEFM: [radius + 3000, 0, 0], cameraUpECEF: [0, 0, 1],
    minAltitudeM: 1000, maxAltitudeM: 2000 });
  const inputs = { generation: 1, weatherGeneration: 1, visualTimeSeconds: 0,
    sunDirectionECEF: [1, 0, 0] as const, layout };
  const shaderHooks = createCloudShaderHooks({ mediaGLSL: params.shaderHooks!.mediaGLSL,
    uniforms: { ...params.shaderHooks!.uniforms, ...volume.uniforms,
      eveCloudAltitudeBoundsM: new Uniform(new Vector2(1000, 2000)) },
    lightingGLSL: `${transport}\n${lookup}
CloudLightingSample sampleCloudLighting(vec3 p, float footprint, float startM) {
  CloudLightingSample light;
  light.directTransmittance = eveSunTransmittance(p, startM, footprint);
  light.skyIrradiance = vec3(0.0); light.valid = 1.0;
  light.stockFallback = 0.0; light.generation = eveLightGeneration;
  return light;
}` });
  const material = new CloudsMaterial({ ...params, shaderHooks }, atmosphere);
  const pass = new ShaderPass(material);
  try {
    volume.request(inputs, params.shaderHooks!.uniforms);
    volume.update(renderer, inputs);
    record('light-volume-no-partial-publication', [volume.uniforms.eveLightValid.value], [0]);
    volume.update(renderer, inputs);
    if (volume.status.state === 'unsupported' || volume.status.state === 'failed') throw new Error(volume.status.error);
    record('light-volume-complete-publication', [volume.uniforms.eveLightValid.value, volume.status.generation], [1, 1]);
    material.shadowLength = false;
    material.temporalUpscale = false;
    material.depthPacking = BasicDepthPacking;
    material.uniforms.stbnTexture.value = resources.noise3D;
    material.uniforms.shadowBuffer.value = resources.shadowArray;
    material.uniforms.depthBuffer.value = resources.depth.depthTexture;
    material.setSize(resources.size, resources.size);
    material.copyCameraSettings(resources.camera);
    material.uniforms.diagnosticMode.value = 4;
    material.uniforms.maxIterationCountToSun.value = 0;
    material.uniforms.referenceStepSize.value = 10;
    const check = async (name: string, position: [number, number, number], expected: number) => {
      material.uniforms.diagnosticRayOrigin.value.fromArray(position);
      resources.draw(() => pass.render(renderer, null, resources.output));
      record(name, [(await resources.readCenter())[0]!], [expected]);
    };
    await check('light-volume-camera-slab', [radius + 1000, 0, 0], Math.exp(-1));
    await check('light-volume-below-layer-sun-path', [radius + 500, 0, 0], Math.exp(-1));
    const angle = 0.2, r = radius + 1000;
    const position: [number, number, number] = [r * Math.cos(angle), r * Math.sin(angle), 0];
    const length = Math.sqrt((radius + 2000) ** 2 - position[1] ** 2) - position[0];
    await check('light-volume-outside-cap-fallback', position, Math.exp(-0.001 * length));
  } finally { pass.dispose(); material.dispose(); volume.dispose(); }
  await verifyThresholdedCloudLightVolume(renderer, resources, record);
}

// A half-space signal has an exact box-filtered value. Thresholding that value
// loses a sparse cloud even though half the canonical rays have finite opacity.
// This models the filtering order without depending on weather assets or mips.
const thresholdedMediaGLSL = `
uniform float fixtureBoundaryZ, fixtureExtinction;
MediaSample sampleCloudMedia(const vec3 p, const float footprintM, const float lod, const float jitter) {
  float signedDistance = p.z - fixtureBoundaryZ;
  float noise = footprintM > 0.0
    ? clamp(0.5 + signedDistance / footprintM, 0.0, 1.0)
    : (signedDistance > 0.0 ? 1.0 : 0.0);
  float height = length(p) - bottomRadius;
  float density = step(0.8, noise) * step(1000.0, height) * (1.0 - step(1200.0, height));
  MediaSample media;
  media.density = density; media.weight = vec4(density, 0.0, 0.0, 0.0);
  media.extinction = fixtureExtinction * density; media.scattering = media.extinction;
  media.phaseAnisotropy = vec2(0.0); media.phaseMix = 0.0;
  return media;
}`;

/** Real producer regression for canonical subrays followed by visibility filtering.
 * Also exported for a focused GPU run, without the rest of cloud conformance.
 */
export async function verifyThresholdedCloudLightVolume(
  renderer: WebGLRenderer,
  resources: CloudConformanceResources,
  record: (name: string, measured: readonly number[], expected: readonly number[]) => void,
): Promise<void> {
  // A smaller planet avoids Earth-scale float cancellation obscuring this
  // filtering test. The 200 m shell is thin enough that even the longest ambient
  // ray cannot cross the half-space boundary from either quarter-cell origin.
  const radius = 1_000_000, base = 1000, top = 1200, extinction = 0.005;
  const quality = 'low', width = CLOUD_LIGHT_QUALITY[quality].width;
  const cell = width / 2;
  const layout = createCloudLightVolumeLayout({ quality, planetRadiusM: radius,
    cameraPositionECEFM: [radius + 3000, 0, 0], cameraUpECEF: [0, 0, 1],
    minAltitudeM: base, maxAltitudeM: top });
  const position = (dx: number, dy: number) => cloudLightUvToPosition(layout,
    [(cell + 0.5 + dx) / width, (cell + 0.5 + dy) / width], base)!;
  const center = position(0, 0), dense = position(-0.25, 0.25), clear = position(-0.25, -0.25);
  const footprint = 4 * (radius + top) * layout.capRadius / width;
  const uniforms = { fixtureBoundaryZ: new Uniform(center[2]), fixtureExtinction: new Uniform(extinction) };
  const volume = new CloudLightVolume({ quality, mediaGLSL: thresholdedMediaGLSL,
    reservedCloudBytes: 0, slicesPerFrame: { direct: 8, ambient: 8 } });
  const inputs = { generation: 1, weatherGeneration: 1, visualTimeSeconds: 0,
    sunDirectionECEF: [1, 0, 0] as const, layout };

  // Independent geometry + Beer oracle, with no density sampling or raymarch.
  // Two quarters are clear and two cloudy. Average T, not tau/extinction:
  // direct is approximately (1 + exp(-1))/2, not exp(-1/2).
  const shellDelta = (top - base) * (2 * radius + top + base);
  const pathLength = (radialProjectionM: number) =>
    shellDelta / (Math.sqrt(radialProjectionM ** 2 + shellDelta) + radialProjectionM);
  const direct = 0.5 + 0.25 * [-0.25, 0.25].reduce((sum, dx) =>
    sum + Math.exp(-extinction * pathLength(position(dx, 0.25)[0])), 0);
  // The production four-direction cosine quadrature has these radial cosines.
  // A spherical shell gives the same path length at every spatial subray for a
  // given cosine, independently of the ray's azimuth or the sampling shader.
  const ambientPaths = [1 / 8, 3 / 8, 5 / 8, 7 / 8].map(u =>
    pathLength((radius + base) * Math.sqrt(1 - u)));
  // Conservative isotropic two-flux solution: R+T=1, T=1/(1+tau/2).
  const ambient = 0.5 + ambientPaths.reduce((sum, length) => sum + 1 / (1 + 0.5 * extinction * length), 0) / 8;
  const boundaryMargin = Math.min(...[-0.25, 0.25].flatMap(dx => [-0.25, 0.25].map(dy =>
    Math.abs(position(dx, dy)[2] - center[2]))));
  if (boundaryMargin <= Math.max(...ambientPaths)) throw new Error('Threshold fixture rays cross the spatial boundary');

  const mode = new Uniform(0);
  const material = new RawShaderMaterial({ glslVersion: GLSL3, depthTest: false, depthWrite: false,
    uniforms: { ...volume.uniforms, ...uniforms,
      bottomRadius: new Uniform(radius), eveCloudAltitudeBoundsM: new Uniform(new Vector2(base, top)),
      sunDirection: new Uniform(new Vector3(1, 0, 0)), fixtureMode: mode,
      fixtureDensePosition: new Uniform(new Vector3(...dense)),
      fixtureClearPosition: new Uniform(new Vector3(...clear)), fixtureFilterFootprintM: new Uniform(footprint) },
    vertexShader: 'precision highp float; in vec3 position; void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `precision highp float;
      uniform float bottomRadius; uniform vec3 sunDirection;
      ${CLOUD_MEDIA_GLSL_ABI}
      ${thresholdedMediaGLSL}
      ${transport}
      ${lookup}
      uniform int fixtureMode;
      uniform vec3 fixtureDensePosition, fixtureClearPosition;
      uniform float fixtureFilterFootprintM;
      layout(location=0) out vec4 color; layout(location=1) out vec4 metadata;
      void main() {
        metadata = vec4(0.0);
        if (fixtureMode == 0) {
          // Read actual built texels: consumer interpolation/fallback must not
          // manufacture a passing result from neighbouring clear/cloudy cells.
          ivec2 cell = ivec2(${cell});
          color = vec4(
            texelFetch(eveLightVolumeTexture, ivec3(cell, 0), 0).r,
            texelFetch(eveLightVolumeTexture, ivec3(cell, eveLightSlices), 0).r,
            texelFetch(eveLightVolumeTexture, ivec3(cell, eveLightSlices - 1), 0).r,
            texelFetch(eveLightVolumeTexture, ivec3(cell, 2 * eveLightSlices - 1), 0).r);
        } else {
          color = vec4(
            eveDirectIntegration(fixtureDensePosition, sunDirection, 0.0, 32, 0.0),
            eveDirectIntegration(fixtureClearPosition, sunDirection, 0.0, 32, 0.0),
            eveDirectIntegration(fixtureDensePosition, sunDirection, 0.0, 32, fixtureFilterFootprintM),
            eveDirectIntegration(fixtureClearPosition, sunDirection, 0.0, 32, fixtureFilterFootprintM));
        }
      }`,
  });
  const pass = new ShaderPass(material);
  try {
    volume.request(inputs, uniforms);
    for (let frame = 0; frame < 2; ++frame) {
      volume.update(renderer, inputs);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    if (volume.status.state !== 'ready') throw new Error(`Threshold light fixture: ${volume.status.state}: ${volume.status.error}`);
    record('light-volume-thresholded-publication', [volume.uniforms.eveLightValid.value], [1]);
    resources.draw(() => pass.render(renderer, null, resources.output));
    const cached = await resources.readCenter();
    record('light-volume-thresholded-half-cell-direct-visibility', [cached[0]!], [direct]);
    record('light-volume-thresholded-half-cell-ambient-visibility', [cached[1]!], [ambient]);
    record('light-volume-thresholded-quantity-top-slices-clear', cached.slice(2), [1, 1]);
    mode.value = 1;
    resources.draw(() => pass.render(renderer, null, resources.output));
    const rays = await resources.readCenter();
    record('light-volume-thresholded-canonical-dense-and-clear-rays', rays.slice(0, 2),
      [Math.exp(-extinction * pathLength(dense[0])), 1]);
    record('light-volume-thresholded-prefiltered-noise-erases-extinction', rays.slice(2), [1, 1]);
  } finally { pass.dispose(); material.dispose(); volume.dispose(); }
}
