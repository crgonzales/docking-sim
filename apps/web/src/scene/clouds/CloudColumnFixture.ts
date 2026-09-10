import { ShaderPass } from 'postprocessing';
import { GLSL3, RawShaderMaterial, Uniform, Vector4, type WebGLRenderer } from 'three';
import { CloudColumnAtlas } from './CloudColumnAtlas';
import type { CloudConformanceResources } from './CloudConformanceResources';
import type { CloudConformanceResult } from './CloudConformanceFixture';

// Homogeneous shell: analytic Beer opacity and first-event height are an
// independent oracle for the actual production atlas builder and GPU mip chain.
const mediaGLSL = `
uniform float eveWeatherPlanetRadiusM;
uniform vec4 eveCloudBaseAltitudeM, eveCloudTopAltitudeM;
uniform float fixtureExtinction, fixtureSparse;
const int EVE_CLOUD_PROFILE_COUNT = 4;
vec2 eveSampleWeather(const vec3 p, const float footprintM, const float lod) {
  return vec2(fixtureSparse > 0.5 && p.z < 0.0 ? 0.0 : 1.0, 0.0);
}
MediaSample sampleCloudMedia(const vec3 p, const float footprintM, const float lod, const float jitter) {
  MediaSample m;
  m.density = 1.0; m.weight = vec4(1.0, 0.0, 0.0, 0.0);
  m.extinction = fixtureExtinction; m.scattering = fixtureExtinction * 0.5;
  m.phaseAnisotropy = vec2(0.0); m.phaseMix = 0.0;
  return m;
}`;

export async function runCloudColumnConformance(
  renderer: WebGLRenderer, resources: CloudConformanceResources, tolerance: number,
): Promise<CloudConformanceResult[]> {
  const atlas = new CloudColumnAtlas({ quality: 'low', rowsPerFrame: 128, mediaGLSL });
  const uniforms = {
    eveWeatherPlanetRadiusM: new Uniform(6_371_000),
    eveCloudBaseAltitudeM: new Uniform(new Vector4(1000, 1000, 1000, 1000)),
    eveCloudTopAltitudeM: new Uniform(new Vector4(2000, 2000, 2000, 2000)),
    fixtureExtinction: new Uniform(0.001), fixtureSparse: new Uniform(0),
  };
  const lod = new Uniform(0);
  const material = new RawShaderMaterial({ glslVersion: GLSL3, depthTest: false, depthWrite: false,
    uniforms: { ...atlas.uniforms, fixtureLod: lod },
    vertexShader: 'precision highp float; in vec3 position; void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `precision highp float;
      uniform sampler2D eveColumnTexture; uniform float fixtureLod;
      layout(location=0) out vec4 color; layout(location=1) out vec4 metadata;
      void main() { color = textureLod(eveColumnTexture, vec2(0.5, 0.75), fixtureLod); metadata = vec4(0.0); }`,
  });
  const pass = new ShaderPass(material);
  const cases: CloudConformanceResult[] = [];
  const record = (name: string, measured: readonly number[], expected: readonly number[]) => {
    const maxError = measured.every(Number.isFinite) && measured.length === expected.length
      ? Math.max(...measured.map((v, i) => Math.abs(v - expected[i]!))) : Infinity;
    cases.push({ name: `column-${name}`, measured, expected, maxError, passed: maxError <= tolerance });
  };
  const build = async (generation: number) => {
    atlas.request(generation, uniforms);
    for (let i = 0; i < 4; ++i) {
      atlas.update(renderer);
      if (i < 3) record(`generation-${generation}-unpublished-${i}`, [atlas.uniforms.eveColumnReady.value], [0]);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    if (atlas.status.state !== 'ready') throw new Error(`Column fixture: ${atlas.status.state}: ${atlas.status.error}`);
  };
  const sample = async (name: string, level: number, expected: readonly number[]) => {
    lod.value = level;
    resources.draw(() => pass.render(renderer, null, resources.output));
    record(name, await resources.readCenter(), expected);
  };
  try {
    await build(1);
    const opacity = 1 - Math.exp(-1);
    const meanDistanceM = 1000 - 1000 / Math.expm1(1);
    const expected = [opacity, opacity * (2000 - meanDistanceM) / 1000, opacity, opacity * 0.5];
    await sample('homogeneous-opacity-and-moments', 0, expected);
    atlas.request(1, uniforms);
    record('unchanged-generation-stays-ready', [atlas.uniforms.eveColumnReady.value, atlas.status.completedRows], [1, 512]);
    uniforms.fixtureSparse.value = 1;
    await build(2);
    await sample('sparse-base-column', 0, expected);
    await sample('mips-average-opacity-not-optical-depth', 10, expected.map(v => v * 0.5));
    atlas.handleContextLoss();
    record('context-loss-unpublishes', [atlas.uniforms.eveColumnReady.value, atlas.uniforms.eveColumnGeneration.value], [0, -1]);
    // Rebuild the same weather generation: context loss must invalidate the
    // generation guard as well as release the now-empty GPU render target.
    await build(2);
    await sample('context-restoration-rebuilds-same-generation', 10, expected.map(v => v * 0.5));
    uniforms.fixtureExtinction.value = 0;
    await build(3);
    await sample('empty-exact-zero', 0, [0, 0, 0, 0]);
    atlas.invalidate();
    record('invalidation-unpublishes', [atlas.uniforms.eveColumnReady.value, atlas.uniforms.eveColumnGeneration.value], [0, -1]);
  } finally { atlas.dispose(); pass.dispose(); material.dispose(); }
  return cases;
}
