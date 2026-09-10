import { ShaderPass } from 'postprocessing';
import { GLSL3, RawShaderMaterial, Uniform, Vector3, type WebGLRenderer } from 'three';
import type { CloudConformanceResult } from './CloudConformanceFixture';
import type { CloudConformanceResources } from './CloudConformanceResources';
import { createCloudPresentationUniforms } from './cloudPresentation';
import presentationGLSL from './shaders/cloudPresentation.glsl?raw';

/** Actual presentation shader: endpoints, smooth transition, and premultiplication. */
export async function runCloudPresentationConformance(
  renderer: WebGLRenderer, resources: CloudConformanceResources, tolerance: number,
): Promise<CloudConformanceResult[]> {
  const radius = 6_371_000;
  const uniforms = {
    ...createCloudPresentationUniforms(),
    eveCloudPlanetRadiusM: new Uniform(radius),
    fixtureCamera: new Uniform(new Vector3()),
    fixtureRay: new Uniform(new Vector3()),
    fixtureDistance: new Uniform(0),
  };
  const material = new RawShaderMaterial({
    glslVersion: GLSL3, depthTest: false, depthWrite: false, uniforms,
    vertexShader: 'precision highp float; in vec3 position; void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `precision highp float;
      uniform float eveCloudPlanetRadiusM;
      uniform vec3 fixtureCamera, fixtureRay;
      uniform float fixtureDistance;
      ${presentationGLSL}
      layout(location = 0) out vec4 fixtureOutput;
      layout(location = 1) out vec4 fixtureMetadata;
      void main() {
        float visibility = eveCloudHorizonVisibility(fixtureCamera, fixtureRay, fixtureDistance);
        fixtureOutput = vec4(visibility, 2.0 * visibility, 0.8 * visibility, 7.0);
        fixtureMetadata = vec4(0.0);
      }`,
  });
  const pass = new ShaderPass(material);
  const cases: CloudConformanceResult[] = [];
  const inputs = [
    ['low-distant-horizon', 1000, 120_000, 0, 0.55, 0.45],
    ['nearby-clouds', 1000, 10_000, 0, 0.55, 1],
    ['distance-midpoint', 1000, 62_500, 0, 0.55, 0.725],
    ['altitude-midpoint', 4750, 120_000, 0, 0.55, 0.725],
    ['twenty-kilometres', 20_000, 120_000, 0, 0.55, 1],
    ['orbit', 400_000, 120_000, 0, 0.55, 1],
    ['above-horizon', 1000, 120_000, Math.PI / 6, 0.55, 1],
    ['disabled', 1000, 120_000, 0, 0, 1],
  ] as const;
  try {
    for (const [name, altitude, distance, elevation, strength, visibility] of inputs) {
      uniforms.fixtureCamera.value.set(radius + altitude, 0, 0);
      uniforms.fixtureRay.value.set(Math.sin(elevation), Math.cos(elevation), 0);
      uniforms.fixtureDistance.value = distance;
      uniforms.eveHorizonThinning.value = strength;
      resources.draw(() => pass.render(renderer, null, resources.output));
      const measured = await resources.readCenter();
      const expected = [visibility, 2 * visibility, 0.8 * visibility, 7];
      const maxError = measured.every(Number.isFinite)
        ? Math.max(...measured.map((value, i) => Math.abs(value - expected[i]!))) : Infinity;
      cases.push({ name: `presentation-${name}`, measured, expected, maxError, passed: maxError <= tolerance });
    }
  } finally { pass.dispose(); }
  return cases;
}
