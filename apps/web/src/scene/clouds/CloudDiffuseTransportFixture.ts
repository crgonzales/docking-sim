import {
  Camera, Color, FloatType, GLSL3, Mesh, NearestFilter, NoBlending, PlaneGeometry,
  RawShaderMaterial, RGBAFormat, Scene, Uniform, Vector3, Vector4, WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import type { CloudConformanceResult } from './CloudConformanceFixture';
import type { CloudConformanceResources } from './CloudConformanceResources';
import { CLOUD_MEDIA_GLSL_ABI } from './CloudLightVolume';
import transportGLSL from './shaders/cloudTransport.glsl?raw';

type OpticalDepths = readonly [scattering: number, absorption: number, asymmetryWeightedScattering: number];

/** Independent boundary-value oracle: integrate the two coupled intensities,
 * not the production hyperbolic/exponential transfer formula. With depth x
 * increasing downward, D'=-aD+bU and U'=aU-bD. Shoot backward from D(1)=1,
 * U(1)=0, then normalize to unit incident D(0). The bottom is black.
 */
function twoStreamBoundaryValue([scattering, absorption, weighted]: OpticalDepths, steps = 1024): readonly number[] {
  const exchange = (scattering - weighted) / 2;
  const removal = absorption + exchange;
  const slope = (down: number, up: number) =>
    [removal * down - exchange * up, exchange * down - removal * up] as const;
  const h = 1 / steps;
  let down = 1, up = 0;
  for (let i = 0; i < steps; i++) {
    const k1 = slope(down, up);
    const k2 = slope(down + h * k1[0] / 2, up + h * k1[1] / 2);
    const k3 = slope(down + h * k2[0] / 2, up + h * k2[1] / 2);
    const k4 = slope(down + h * k3[0], up + h * k3[1]);
    down += h * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]) / 6;
    up += h * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]) / 6;
  }
  return [1 / down, up / down]; // Transmitted and reflected fractions.
}

/** One float pixel calls the complete, unmodified production transport include.
 * No camera raymarch/cache is under test here. All GPU work and cleanup remain
 * synchronous; the caller owns capability checks and the existing renderer.
 */
export function runCloudDiffuseTransportConformance(
  renderer: WebGLRenderer, resources: CloudConformanceResources, tolerance = 1e-3,
): CloudConformanceResult[] {
  const cases: CloudConformanceResult[] = [];
  const record = (name: string, measured: readonly number[], expected: readonly number[], limit = Math.min(tolerance, 5e-5)) => {
    const finite = measured.length === expected.length && measured.every(Number.isFinite) && expected.every(Number.isFinite);
    const maxError = finite ? Math.max(...measured.map((value, i) => Math.abs(value - expected[i]!))) : Infinity;
    cases.push({ name: `cloud-diffuse-transport-${name}`, measured, expected, maxError, passed: finite && maxError <= limit });
  };
  // Eq.11 gives conservative albedo; T=1-albedo with no layer absorption:
  // https://amt.copernicus.org/articles/13/3909/2020/#section3
  // Optical depths already follow the oblique ray: never add another secant.
  const inputs: { name: string; tau: OpticalDepths; expected: number }[] = [
    { name: 'vacuum', tau: [0, 0, 0], expected: 1 },
    { name: 'forward-conservative', tau: [64, 0, 64], expected: 1 },
    { name: 'forward-with-absorption', tau: [64, 0.5, 64], expected: Math.exp(-0.5) },
    ...[0.0001, 1, 16, 1000].map(tau => ({
      name: `pure-absorption-${tau}`, tau: [0, tau, 0] as OpticalDepths, expected: Math.exp(-tau),
    })),
    ...[1, 20, 1000].map(tau => ({
      name: `conservative-isotropic-${tau}`, tau: [tau, 0, 0] as OpticalDepths, expected: 1 / (1 + tau / 2),
    })),
    { name: 'conservative-forward-biased', tau: [20, 0, 16], expected: 1 / 3 },
    { name: 'conservative-backward', tau: [20, 0, -20], expected: 1 / 21 },
    { name: 'opaque-absorbing-scattering', tau: [1000, 1000, 850], expected: 0 },
  ];
  record('oracle-analytical-endpoints', [
    ...twoStreamBoundaryValue([0, 0, 0]), ...twoStreamBoundaryValue([20, 0, 0]),
    ...twoStreamBoundaryValue([0, 1, 0]),
  ], [1, 0, 1 / 11, 10 / 11, Math.exp(-1), 0], 1e-8);
  for (const [name, tau] of [
    ['isotropic', [2, 0.5, 0]], ['forward-biased', [20, 0.2, 15]],
    ['backward-biased', [8, 2, -4]], ['thin', [0.01, 0.001, 0.008]],
  ] as const) {
    const fine = twoStreamBoundaryValue(tau);
    const coarse = twoStreamBoundaryValue(tau, 512);
    record(`oracle-${name}-converges`, [coarse[0]! / fine[0]!, coarse[1]! - fine[1]!], [1, 0], 1e-8);
    inputs.push({ name: `mixed-${name}`, tau, expected: fine[0]! });
  }

  const gl = renderer.getContext();
  const recordErrors = (name: string) => {
    const errors: number[] = [];
    for (let i = 0; i < 16; i++) {
      const error = gl.getError();
      if (error === gl.NO_ERROR) break;
      errors.push(error);
    }
    record(`${name}-gl-errors`, [errors.length, ...errors], new Array(errors.length + 1).fill(0), 0);
  };
  const saved = {
    target: renderer.getRenderTarget(), face: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel(),
    viewport: renderer.getViewport(new Vector4()), scissor: renderer.getScissor(new Vector4()),
    scissorTest: renderer.getScissorTest(), currentViewport: renderer.getCurrentViewport(new Vector4()),
    gpuViewport: new Vector4().fromArray(gl.getParameter(gl.VIEWPORT) as Int32Array),
    gpuScissor: new Vector4().fromArray(gl.getParameter(gl.SCISSOR_BOX) as Int32Array),
    gpuScissorTest: gl.isEnabled(gl.SCISSOR_TEST), clear: renderer.getClearColor(new Color()),
    alpha: renderer.getClearAlpha(), autoClear: renderer.autoClear, toneMapping: renderer.toneMapping,
    xr: renderer.xr.enabled, shadows: renderer.shadowMap.enabled,
  };
  const depths = new Uniform(new Vector3());
  const material = new RawShaderMaterial({
    glslVersion: GLSL3, depthTest: false, depthWrite: false, blending: NoBlending, toneMapped: false,
    uniforms: { fixtureOpticalDepths: depths },
    vertexShader: 'in vec3 position; void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `precision highp float;
      ${CLOUD_MEDIA_GLSL_ABI}
      const vec3 sunDirection = vec3(1.0, 0.0, 0.0);
      // Unused media provider links the full include; main calls only the real
      // optical-depth function, whose inputs come directly from a GPU uniform.
      MediaSample sampleCloudMedia(vec3 p, float footprint, float lod, float jitter) {
        MediaSample m; m.density = 0.0; m.weight = vec4(0.0); m.scattering = 0.0;
        m.extinction = 0.0; m.phaseAnisotropy = vec2(0.0); m.phaseMix = 0.0; return m;
      }
      ${transportGLSL}
      uniform vec3 fixtureOpticalDepths;
      out vec4 outputColor;
      void main() {
        float transmitted = eveDiffuseTransmittance(fixtureOpticalDepths.x,
          fixtureOpticalDepths.y, fixtureOpticalDepths.z);
        outputColor = vec4(transmitted, 0.25, 0.5, 1.0);
      }`,
  });
  const geometry = new PlaneGeometry(2, 2);
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new Scene();
  scene.add(mesh);
  const camera = new Camera();
  const output = new WebGLRenderTarget(1, 1, {
    type: FloatType, format: RGBAFormat, depthBuffer: false,
    minFilter: NearestFilter, magFilter: NearestFilter,
  });
  try {
    resources.draw(() => {
      try {
        recordErrors('entry');
        renderer.xr.enabled = false;
        renderer.shadowMap.enabled = false;
        const measured: number[] = [];
        for (const input of inputs) {
          depths.value.fromArray(input.tau);
          renderer.setRenderTarget(output);
          renderer.render(scene, camera);
          const pixel = new Float32Array(4).fill(NaN);
          renderer.readRenderTargetPixels(output, 0, 0, 1, 1, pixel);
          measured.push(pixel[0]!);
          // Relative accuracy for small transmission; opaque cases still have
          // a 5e-11 absolute ceiling. GBA are independent draw/readback markers.
          const scale = Math.max(input.expected, 1e-6);
          record(input.name, [pixel[0]! / scale, ...pixel.slice(1)], [input.expected / scale, 0.25, 0.5, 1]);
        }
        record('passive-no-amplification-or-negative-flux', measured.map((value, i) =>
          Number(Number.isFinite(value) && value >= 0 && value <= Math.exp(-inputs[i]!.tau[1]) + 2e-6)),
        inputs.map(() => 1), 0);
        recordErrors('render-and-readback');
      } finally {
        renderer.setRenderTarget(null);
        output.dispose(); material.dispose(); geometry.dispose(); scene.clear();
        renderer.xr.enabled = saved.xr;
        renderer.shadowMap.enabled = saved.shadows;
      }
    });
  } finally {
    // draw() restores logical state; the bound target can have a distinct
    // physical viewport/scissor, which must also be restored before returning.
    if (!renderer.getCurrentViewport(new Vector4()).equals(saved.currentViewport)) {
      renderer.setRenderTarget(saved.target, saved.face, saved.mip);
    }
    renderer.state.viewport(saved.gpuViewport);
    renderer.state.scissor(saved.gpuScissor);
    renderer.state.setScissorTest(saved.gpuScissorTest);
    recordErrors('cleanup');
  }
  record('renderer-state-restored', [
    Number(renderer.getRenderTarget() === saved.target), Number(renderer.getActiveCubeFace() === saved.face),
    Number(renderer.getActiveMipmapLevel() === saved.mip), Number(renderer.getViewport(new Vector4()).equals(saved.viewport)),
    Number(renderer.getScissor(new Vector4()).equals(saved.scissor)), Number(renderer.getScissorTest() === saved.scissorTest),
    Number(renderer.getCurrentViewport(new Vector4()).equals(saved.currentViewport)),
    Number(new Vector4().fromArray(gl.getParameter(gl.VIEWPORT) as Int32Array).equals(saved.gpuViewport)),
    Number(new Vector4().fromArray(gl.getParameter(gl.SCISSOR_BOX) as Int32Array).equals(saved.gpuScissor)),
    Number(gl.isEnabled(gl.SCISSOR_TEST) === saved.gpuScissorTest), Number(renderer.getClearColor(new Color()).equals(saved.clear)),
    Number(renderer.getClearAlpha() === saved.alpha), Number(renderer.autoClear === saved.autoClear),
    Number(renderer.toneMapping === saved.toneMapping), Number(renderer.xr.enabled === saved.xr),
    Number(renderer.shadowMap.enabled === saved.shadows),
  ], new Array(16).fill(1), 0);
  return cases;
}
