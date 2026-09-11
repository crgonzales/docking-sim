import { ShaderPass } from 'postprocessing';
import { GLSL3, RawShaderMaterial, type WebGLRenderer } from 'three';
import { WATER_RADIANCE_GLSL } from '../libraryWaterLighting';
import type { CloudConformanceResources } from './CloudConformanceResources';

/** Adjacent packed normals straddle zero by 1/255. Smooth spherical water
 * must not inherit that screen-space discontinuity in its reflection. */
export async function verifyWaterReflectionContinuity(
  renderer: WebGLRenderer, resources: CloudConformanceResources,
  record: (name: string, measured: readonly number[], expected: readonly number[]) => void,
): Promise<void> {
  for (const original of [false, true]) {
    const material = new RawShaderMaterial({
      glslVersion: GLSL3, depthTest: false, depthWrite: false,
      vertexShader: 'precision highp float; in vec3 position; void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `precision highp float;
        const vec3 sunDirection = vec3(0.5, 0.8, 0.33166248);
        const float albedoScale = 1.0;
        ${original ? WATER_RADIANCE_GLSL.replace('vec3 n = normalize(positionECEF);', 'vec3 n = normalize(normal);') : WATER_RADIANCE_GLSL}
        layout(location = 0) out vec4 fixtureOutput;
        layout(location = 1) out vec4 fixtureMetadata;
        void main() {
          vec3 p = vec3(6371.0, 0.0, 0.0);
          vec3 view = normalize(vec3(0.5, -0.7, -0.33166248));
          vec3 left = waterSurfaceRadiance(p, vec3(1.0, -1.0 / 255.0, 0.0), view, vec3(1.0), vec3(0.0));
          vec3 right = waterSurfaceRadiance(p, vec3(1.0, 1.0 / 255.0, 0.0), view, vec3(1.0), vec3(0.0));
          vec3 leftNormal = waterIlluminationNormal(p, normalize(vec3(1.0, -1.0 / 255.0, 0.0)), 1.0);
          vec3 rightNormal = waterIlluminationNormal(p, normalize(vec3(1.0, 1.0 / 255.0, 0.0)), 1.0);
          float incidentStep = abs(dot(leftNormal, sunDirection) - dot(rightNormal, sunDirection));
          fixtureOutput = vec4(abs(left - right).rg, incidentStep, left.r);
          fixtureMetadata = vec4(0.0);
        }`,
    });
    const pass = new ShaderPass(material);
    try {
      resources.draw(() => pass.render(renderer, null, resources.output));
      const measured = await resources.readCenter();
      if (original) {
        record('water-packed-normal-negative-control-has-seam',
          [Number(measured[0]! > 0.001)], [1]);
      } else {
        record('water-reflection-continuous-across-packed-normal-step', measured.slice(0, 3), [0, 0, 0]);
        record('water-reflection-still-has-sun-glint', [Number(measured[3]! > 0.01 && Number.isFinite(measured[3]))], [1]);
      }
    } finally { pass.dispose(); }
  }
}
