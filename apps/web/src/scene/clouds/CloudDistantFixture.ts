import { ShaderPass } from 'postprocessing';
import { raySphereIntersection } from '@takram/three-geospatial/shaders';
import { DataTexture, FloatType, GLSL3, RawShaderMaterial, RGBAFormat, Uniform, Vector2, Vector3, Vector4, type WebGLRenderer } from 'three';
import type { CloudConformanceResources } from './CloudConformanceResources';
import type { CloudConformanceResult } from './CloudConformanceFixture';
import distantGLSL from './shaders/distantCloud.glsl?raw';
import columnGLSL from './shaders/cloudColumn.glsl?raw';

/** Production distant geometry/radial integration with analytic medium/lighting oracles. */
export async function runCloudDistantConformance(
  renderer: WebGLRenderer, resources: CloudConformanceResources, tolerance: number,
): Promise<CloudConformanceResult[]> {
  const radius = 6_371_000;
  const texels = new Float32Array([0.5, 0.75, 0.5, 0.25, 0.5, 0.75, 0.5, 0.25]);
  // Distinct geographic columns on opposite sides of an X-directed limb ray.
  const texture = new DataTexture(texels, 2, 1, RGBAFormat, FloatType);
  texture.needsUpdate = true;
  const uniforms = {
    volumetricColumnTexture: new Uniform(texture), volumetricColumnDimensions: new Uniform(new Vector2(2048, 1024)),
    volumetricColumnReady: new Uniform(1), volumetricColumnGeneration: new Uniform(1),
    fixtureOrigin: new Uniform(new Vector3(radius + 3000, 0, 0)),
    fixtureDirection: new Uniform(new Vector3(-1, 0, 0)),
    fixtureStart: new Uniform(0), fixtureEnd: new Uniform(3000), altitudeCorrection: new Uniform(new Vector3()),
    minHeight: new Uniform(1000), maxHeight: new Uniform(2000), cloudEntryFootprintM: new Uniform(50000),
    volumetricCloudBaseAltitudeM: new Uniform(new Vector4(1000, 1000, 1000, 1000)),
    volumetricCloudTopAltitudeM: new Uniform(new Vector4(2000, 2000, 2000, 2000)),
    fixtureCoverage: new Uniform(new Vector2(1, 1)), fixtureExtinction: new Uniform(new Vector2()),
    fixtureAlbedo: new Uniform(new Vector2(0.25, 0.75)),
    fixtureLightingOnly: new Uniform(false),
    fixtureScatteringOrders: new Uniform(new Vector2()),
  };
  const material = new RawShaderMaterial({ glslVersion: GLSL3, depthTest: false, depthWrite: false, uniforms,
    vertexShader: 'precision highp float; in vec3 position; void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `precision highp float;
      const float PI = 3.141592653589793;
      const float RECIPROCAL_PI4 = 0.07957747154594767;
      const float METER_TO_LENGTH_UNIT = 0.001;
      const float volumetricWeatherPlanetRadiusM = 6371000.0;
      uniform float minHeight, maxHeight, cloudEntryFootprintM;
      const float cloudRaySlope = 0.0, skyLightScale = 1.0;
      const int VOLUMETRIC_CLOUD_PROFILE_COUNT = 4;
      const vec4 volumetricCloudPhaseAnisotropyX = vec4(0.0), volumetricCloudPhaseAnisotropyY = vec4(0.0), volumetricCloudPhaseMix = vec4(0.0);
      const vec3 sunDirection = vec3(1.0, 0.0, 0.0);
      uniform vec3 fixtureOrigin, fixtureDirection, altitudeCorrection;
      uniform float fixtureStart, fixtureEnd;
      uniform vec4 volumetricCloudBaseAltitudeM, volumetricCloudTopAltitudeM;
      uniform vec2 fixtureCoverage, fixtureExtinction, fixtureAlbedo;
      uniform bool fixtureLightingOnly;
      uniform vec2 fixtureScatteringOrders;
      struct CloudLightingSample { float valid; vec3 skyIrradiance; };
      struct MediaSample { float extinction; float scattering; };
      ${raySphereIntersection}
      // Analytic fixture is static: its atlas and physical coordinates coincide.
      vec3 volumetricWeatherCanonicalPositionECEFM(const vec3 p) { return p; }
      vec2 volumetricWeatherUv(const vec3 p) { return vec2(p.x < 0.0 ? 0.75 : 0.25, 0.5); }
      float volumetricWeatherMapLod(const vec3 p, const float f, const float l, const vec2 d, const vec2 a) { return 0.0; }
      vec2 volumetricSampleWeather(const vec3 p, const float f, const float l) {
        return vec2(p.x < 0.0 ? fixtureCoverage.y : fixtureCoverage.x, 0.0);
      }
      MediaSample sampleCloudMedia(const vec3 p, const float f, const float l, const float j) {
        MediaSample media;
        media.extinction = p.x < 0.0 ? fixtureExtinction.y : fixtureExtinction.x;
        media.scattering = media.extinction * (p.x < 0.0 ? fixtureAlbedo.y : fixtureAlbedo.x);
        return media;
      }
      ${columnGLSL}
      vec3 GetSunAndSkyScalarIrradiance(const vec3 p, const vec3 s, out vec3 sky) { sky = vec3(4.0 * PI); return vec3(0.0); }
      float approximateMultipleScattering(const float t, const float c, const vec2 a, const float m) { return fixtureScatteringOrders.x; }
      float phaseFunction(const float c, const float t, const vec2 a, const float m) { return fixtureScatteringOrders.y; }
      float volumetricSkyVisibility(const vec3 p, const float f) { return 1.0; }
      ${distantGLSL}
      float cloudSunOpticalDepth(const vec3 p, const float f, const float l, const float j, out CloudLightingSample light) {
        light.valid = 1.0; light.skyIrradiance = vec3(4.0 * PI); return 0.0;
      }
      layout(location=0) out vec4 outputValue; layout(location=1) out vec4 metadata;
      void main() {
        if (fixtureLightingOnly) {
          // Isolate the production top-light response from the column geometry.
          // Inputs are known single/total scattering, not a second copy of the
          // response formula; the checks below protect its lighting boundaries.
          float response = volumetricCloudTopScattering(0.0, 0.0, vec2(0.0), 0.0,
            fixtureOrigin, fixtureDirection);
          outputValue = vec4(response, 0.25, 0.5, 1.0); metadata = vec4(0.0);
          return;
        }
        float depth, opticalDepth; ivec3 samples; vec3 light;
        vec4 value = renderDistantClouds(fixtureOrigin, fixtureDirection, vec2(fixtureStart, fixtureEnd), 0.0, 0.5,
          depth, samples, opticalDepth, light);
        outputValue = vec4(value.r, value.a, depth * 0.001, float(samples.x)); metadata = vec4(0.0);
      }`,
  });
  const pass = new ShaderPass(material);
  const cases: CloudConformanceResult[] = [];
  const sample = async (name: string, expected: readonly number[]) => {
    resources.draw(() => pass.render(renderer, null, resources.output));
    const measured = await resources.readCenter();
    const maxError = measured.length === expected.length && measured.every(Number.isFinite)
      ? Math.max(...measured.map((v, i) => Math.abs(v - expected[i]!))) : Infinity;
    cases.push({ name: `distant-${name}`, measured, expected, maxError, passed: maxError <= tolerance });
  };
  const empty = [0, 0, -0.001, 0] as const;
  const setColumns = (nearOpacity: number, farOpacity: number, heightM: number, thicknessM: number) => {
    texels.set([nearOpacity, nearOpacity * heightM / 1000, nearOpacity * thicknessM / 1000, nearOpacity * 0.25,
      farOpacity, farOpacity * heightM / 1000, farOpacity * thicknessM / 1000, farOpacity * 0.75]);
    texture.needsUpdate = true;
    uniforms.volumetricColumnTexture.value = texture;
  };
  const setProfile = (baseM: number, topM: number) => {
    uniforms.volumetricCloudBaseAltitudeM.value.setScalar(baseM);
    uniforms.volumetricCloudTopAltitudeM.value.setScalar(topM);
  };
  const closestM = 400_000;
  const setLimbRay = (altitudeM: number) => {
    uniforms.fixtureOrigin.value.set(closestM, radius + altitudeM, 0);
    uniforms.fixtureDirection.value.set(-1, 0, 0);
    uniforms.fixtureStart.value = 0;
    uniforms.fixtureEnd.value = 2 * closestM;
  };
  // Independent analytic chord/Beer and two-layer alpha-over oracles. Double
  // precision here keeps the expected geometry independent of GLSL roundoff.
  const chord = (heightM: number, tangentAltitudeM: number) =>
    Math.sqrt((radius + heightM) ** 2 - (radius + tangentAltitudeM) ** 2);
  const slantOpacity = (vertical: number, lengthM: number, thicknessM: number) =>
    -Math.expm1(Math.log1p(-vertical) * lengthM / thicknessM);
  const over = (near: number, far: number, nearDepthM: number, farDepthM: number) => {
    const farWeight = (1 - near) * far;
    const opacity = near + farWeight;
    return [0.25 * near + 0.75 * farWeight, opacity,
      (near * nearDepthM + farWeight * farDepthM) / opacity / 1000, Number(near > 0) + Number(farWeight > 0)];
  };
  try {
    await sample('radial-opacity-premultiplication-and-depth', [0.25, 0.5, 1.5, 1]);
    uniforms.fixtureEnd.value = 1400;
    // The shell now resolves the visible 400 m before this cut, even though its
    // full-column representative depth is behind terrain. Depth stays in front.
    const partialOpacity = 1 - 0.5 ** 0.4;
    await sample('terrain-clips-column-support', [0.5 * partialOpacity, partialOpacity, 1.2, 1]);
    uniforms.fixtureEnd.value = 900;
    await sample('terrain-before-layer', empty);
    uniforms.fixtureEnd.value = 3000;
    uniforms.fixtureDirection.value.set(1, 0, 0);
    await sample('look-away-from-planet', [0, 0, -0.001, 0]);
    uniforms.fixtureOrigin.value.set(0, 0, radius + 3000);
    uniforms.fixtureDirection.value.set(0, 0, -1);
    await sample('north-pole', [0.25, 0.5, 1.5, 1]);
    uniforms.altitudeCorrection.value.set(1000, 2000, 3000);
    uniforms.fixtureOrigin.value.add(uniforms.altitudeCorrection.value);
    await sample('physical-and-atmosphere-frame-registration', [0.25, 0.5, 1.5, 1]);
    uniforms.volumetricColumnReady.value = 0;
    await sample('unpublished-is-empty', [0, 0, -0.001, 0]);
    uniforms.volumetricColumnReady.value = 1;
    uniforms.volumetricColumnTexture.value = resources.zero2D;
    await sample('clear-column-is-empty', [0, 0, -0.001, 0]);

    uniforms.altitudeCorrection.value.set(0, 0, 0);
    uniforms.maxHeight.value = 14000;
    setProfile(11000, 14000);
    const cirrusOpacity = 1 / 128;
    setColumns(cirrusOpacity, 0, 12500, 3000);
    setLimbRay(12000); // Above global support midpoint (7500 m), below cirrus moment.
    const cirrusChord = chord(14000, 12000);
    const cirrusAlpha = slantOpacity(cirrusOpacity, cirrusChord, 3000);
    await sample('high-cirrus-grazes-above-global-mean',
      over(cirrusAlpha, 0, closestM - chord(12500, 12000), 0));

    setLimbRay(13500); // Also misses the actual first-event sphere, but not its support.
    const upperChord = chord(14000, 13500);
    const upperAlpha = slantOpacity(cirrusOpacity, upperChord, 3000);
    await sample('high-cirrus-grazes-above-column-moment',
      over(upperAlpha, 0, closestM - upperChord / 2, 0));
    setColumns(cirrusOpacity, cirrusOpacity, 12500, 3000);
    await sample('grazing-halves-do-not-double-count-the-chord',
      over(upperAlpha, upperAlpha, closestM - upperChord / 2, closestM + upperChord / 2));

    // Force the actual production radial helper to recover high clouds from an
    // empty atlas, so the geometry fixture also exercises the detail branch.
    setColumns(0, 0, 12500, 3000);
    uniforms.cloudEntryFootprintM.value = 0;
    uniforms.fixtureCoverage.value.set(1, 0);
    uniforms.fixtureExtinction.value.setScalar(-Math.log1p(-cirrusOpacity) / 3000);
    await sample('canonical-radial-detail-high-cirrus-grazing',
      over(upperAlpha, 0, closestM - upperChord / 2, 0));
    uniforms.cloudEntryFootprintM.value = 50000;
    uniforms.fixtureCoverage.value.set(1, 1);
    setColumns(cirrusOpacity, cirrusOpacity, 12500, 3000);
    setLimbRay(14000);
    await sample('outer-support-tangent-has-zero-length', empty);
    setLimbRay(14001);
    await sample('above-all-support-is-empty', empty);
    setProfile(1000, 2000);
    setColumns(0.5, 0.5, 1500, 1000);
    setLimbRay(12000);
    await sample('global-shell-hit-with-local-support-miss-is-empty', empty);

    uniforms.maxHeight.value = 2000;
    const nearVertical = 1 / 256;
    const farVertical = 1 / 128;
    setColumns(0, farVertical, 1500, 1000);
    setLimbRay(500); // Above the solid limb; both low-cloud crossings are visible.
    const lowLength = chord(2000, 500) - chord(1000, 500);
    const nearAlpha = slantOpacity(nearVertical, lowLength, 1000);
    const farAlpha = slantOpacity(farVertical, lowLength, 1000);
    const nearDepth = closestM - chord(1500, 500);
    const farDepth = closestM + chord(1500, 500);
    await sample('near-clear-far-cloudy-above-solid-limb', over(0, farAlpha, 0, farDepth));
    uniforms.fixtureEnd.value = closestM;
    await sample('terrain-stops-far-cloud-behind-clear-near-column', empty);
    setLimbRay(-500);
    await sample('opaque-planet-stops-far-cloud-without-scene-depth', empty);

    setColumns(nearVertical, farVertical, 1500, 1000);
    setLimbRay(500);
    await sample('both-crossings-premultiplied-alpha-over-and-weighted-depth',
      over(nearAlpha, farAlpha, nearDepth, farDepth));
    uniforms.fixtureEnd.value = closestM;
    await sample('terrain-stops-far-crossing-and-preserves-near', over(nearAlpha, 0, nearDepth, 0));
    setLimbRay(-500);
    const planetNearAlpha = slantOpacity(nearVertical, chord(2000, -500) - chord(1000, -500), 1000);
    await sample('opaque-planet-preserves-visible-near-crossing',
      over(planetNearAlpha, 0, closestM - chord(1500, -500), 0));

    // Match the host ABI: origin is at the outer-shell entry; near/far are still
    // camera-relative, but the returned depth must be relative to that origin.
    setLimbRay(500);
    const entryDistance = closestM - chord(2000, 500);
    uniforms.fixtureOrigin.value.x -= entryDistance;
    uniforms.fixtureStart.value = entryDistance;
    await sample('host-entry-origin-and-nonzero-near-depth',
      over(nearAlpha, farAlpha, nearDepth - entryDistance, farDepth - entryDistance));

    uniforms.fixtureLightingOnly.value = true;
    uniforms.fixtureScatteringOrders.value.set(0.08, 0.03);
    uniforms.fixtureOrigin.value.set(radius + 3000, 0, 0);
    uniforms.fixtureDirection.value.set(-1, 0, 0);
    await sample('sunlit-top-restores-higher-order-light-only', [0.13, 0.25, 0.5, 1]);
    uniforms.fixtureDirection.value.set(1, 0, 0);
    await sample('underside-retains-original-lighting', [0.08, 0.25, 0.5, 1]);
    uniforms.fixtureDirection.value.set(0, 1, 0);
    await sample('grazing-view-retains-original-lighting', [0.08, 0.25, 0.5, 1]);
    uniforms.fixtureOrigin.value.set(-radius - 3000, 0, 0);
    uniforms.fixtureDirection.value.set(1, 0, 0);
    await sample('night-side-retains-original-lighting', [0.08, 0.25, 0.5, 1]);
    uniforms.fixtureOrigin.value.set(0, radius + 3000, 0);
    uniforms.fixtureDirection.value.set(0, -1, 0);
    await sample('terminator-retains-original-lighting', [0.08, 0.25, 0.5, 1]);
    uniforms.fixtureOrigin.value.set(radius + 3000, 0, 0);
    uniforms.fixtureDirection.value.set(-0.175, Math.sqrt(1 - 0.175 ** 2), 0);
    await sample('top-response-fades-continuously-toward-limb', [0.105, 0.25, 0.5, 1]);
    uniforms.fixtureDirection.value.set(-1, 0, 0);
    uniforms.fixtureScatteringOrders.value.set(0.03, 0.03);
    await sample('single-scattering-lobe-is-unchanged', [0.03, 0.25, 0.5, 1]);
    uniforms.fixtureScatteringOrders.value.set(0, 0);
    await sample('unlit-clouds-do-not-create-light', [0, 0.25, 0.5, 1]);
  } finally { texture.dispose(); pass.dispose(); material.dispose(); }
  return cases;
}
