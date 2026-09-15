import { ShaderPass } from 'postprocessing';
import { GLSL3, RawShaderMaterial, Uniform, Vector3, DataTexture, RGBAFormat, Mesh, PlaneGeometry, Scene, Float32BufferAttribute, WebGLRenderTarget, FloatType, NearestFilter, type WebGLRenderer } from 'three';
import { createTerrainSurfaceNoise, createTerrainSurfaceUniforms, TERRAIN_SURFACE_GLSL } from './terrainSurface';
import { createTerrainPatchMaterial } from './terrainShaders';
import { terrainSurfacePhases } from './terrainSurfacePhase';
import type { CloudConformanceResources } from '../clouds/CloudConformanceResources';
import type { CloudConformanceResult } from '../clouds/CloudConformanceFixture';

/** Actual material GLSL: orbit identity and invariance across RTC patch changes. */
export async function runTerrainSurfaceConformance(
  renderer: WebGLRenderer, resources: CloudConformanceResources, tolerance: number,
): Promise<CloudConformanceResult[]> {
  const radius = 6_371_000;
  const noise = createTerrainSurfaceNoise();
  const center = new Vector3(radius + 100, 345.25, -123.75);
  const base = [0.12, 0.16, 0.10, 1];
  const uniforms = {
    ...createTerrainSurfaceUniforms(noise, radius, { cameraPositionM: [radius + 1100, 345.25, -123.75] }),
    terrainSurfaceNoisePhase: new Uniform(terrainSurfacePhases(center.toArray())),
    fixtureCenter: new Uniform(center.clone()), fixtureLocalOffset: new Uniform(new Vector3()),
    fixtureNormal: new Uniform(0), fixtureSpan: new Uniform(64),
  };
  const material = new RawShaderMaterial({ glslVersion: GLSL3, depthTest: false, depthWrite: false, uniforms,
    vertexShader: `precision highp float; in vec3 position; out vec2 fixtureUv;
      void main() { fixtureUv = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `precision highp float; precision highp sampler3D;
      in vec2 fixtureUv; uniform vec3 fixtureCenter, fixtureLocalOffset; uniform float fixtureNormal, fixtureSpan;
      ${TERRAIN_SURFACE_GLSL}
      layout(location=0) out vec4 result; layout(location=1) out vec4 metadata;
      void main() {
        vec3 local = vec3(0.0, fixtureUv * fixtureSpan) + fixtureLocalOffset;
        vec3 global = fixtureCenter + local;
        vec3 color = terrainSurfaceAlbedo(vec3(0.12, 0.16, 0.10), global, vec3(1.0, 0.0, 0.0), local);
        vec3 normal = terrainSurfaceNormal(vec3(1.0, 0.0, 0.0), global, vec3(0.12, 0.16, 0.10), local);
        result = vec4(fixtureNormal > 0.5 ? normal : color, 1.0); metadata = vec4(0.0);
      }`,
  });
  const pass = new ShaderPass(material);
  const cases: CloudConformanceResult[] = [];
  const draw = async () => {
    resources.draw(() => pass.render(renderer, null, resources.output));
    return resources.readCenter();
  };
  const record = (name: string, measured: readonly number[], expected: readonly number[]) => {
    const maxError = measured.every(Number.isFinite) && measured.length === expected.length
      ? Math.max(...measured.map((v, i) => Math.abs(v - expected[i]!))) : Infinity;
    cases.push({ name: `surface-${name}`, measured, expected, maxError, passed: maxError <= tolerance });
  };
  try {
    uniforms.terrainSurfaceEnabled.value = 0;
    record('disabled-preserves-albedo', await draw(), base);
    uniforms.fixtureNormal.value = 1;
    record('disabled-preserves-normal', await draw(), [1, 0, 0, 1]);
    uniforms.terrainSurfaceEnabled.value = 1;
    uniforms.terrainSurfaceCameraPositionM.value.x += 100_000;
    record('orbit-preserves-normal', await draw(), [1, 0, 0, 1]);
    uniforms.fixtureNormal.value = 0;
    record('orbit-preserves-albedo', await draw(), base);
    uniforms.terrainSurfaceCameraPositionM.value.x -= 100_000;
    const color = await draw();
    uniforms.fixtureNormal.value = 1;
    const normal = await draw();
    record('finite-unit-detail-normal', [Math.hypot(...normal.slice(0, 3))], [1]);
    record('bounded-detail-albedo', [Number(color.slice(0, 3).every(v => v >= 0 && v <= 1))], [1]);
    const shift = new Vector3(0, 1024.125, -2048.375);
    uniforms.fixtureCenter.value.copy(center).add(shift);
    uniforms.fixtureLocalOffset.value.copy(shift).negate();
    uniforms.terrainSurfaceNoisePhase.value = terrainSurfacePhases(uniforms.fixtureCenter.value.toArray());
    record('patch-origin-change-preserves-normal', await draw(), normal);
    uniforms.fixtureNormal.value = 0;
    record('patch-origin-change-preserves-albedo', await draw(), color);
    uniforms.fixtureNormal.value = 1;
    uniforms.fixtureSpan.value = 1;
    const groundNormal = await draw();
    for (const span of [0.1, 0.01]) {
      uniforms.fixtureSpan.value = span;
      record(`sub-centimetre-footprint-stable-normal-${span}`, await draw(), groundNormal);
    }
    // Execute the production terrain color shader: shoreline classification
    // follows the geographic texture even when vertex masks disagree.
    const shoreMap = new DataTexture(new Float32Array([0.5, 0.5, 0.5, 1]), 1, 1, RGBAFormat, FloatType);
    const coastalLand = new DataTexture(new Uint8Array([100, 100, 100, 255]), 1, 1, RGBAFormat);
    const coastalWater = new DataTexture(new Uint8Array([155, 155, 155, 255]), 1, 1, RGBAFormat);
    const darkLand = new DataTexture(new Float32Array([0.02, 0.04, 0.01, 1]), 1, 1, RGBAFormat, FloatType);
    for (const map of [shoreMap, coastalLand, coastalWater, darkLand]) map.needsUpdate = true;
    const terrainMaterial = createTerrainPatchMaterial({ dayMap: resources.one2D, specMap: resources.one2D },
      { planetCenter: [-radius - 1000, 0, 0] });
    const geometry = new PlaneGeometry(20000, 20000);
    const vertexMask = new Float32BufferAttribute(new Float32Array(4), 1);
    geometry.setAttribute('terrainWaterMask', vertexMask);
    const mesh = new Mesh(geometry, terrainMaterial); mesh.rotation.y = Math.PI / 2; mesh.position.x = -1000;
    const scene = new Scene(); scene.add(mesh);
    // The scene color shader has one output, unlike the two-output cloud
    // shader. Give it the same single-color/depth attachment contract as flight.
    const surfaceTarget = new WebGLRenderTarget(resources.size, resources.size,
      { type: FloatType, minFilter: NearestFilter, magFilter: NearestFilter });
    try {
      for (const [name, map, vertexWater, expectedWater] of [
        ['water-despite-dry-vertices', resources.one2D, 0, 1],
        ['land-despite-wet-vertices', resources.zero2D, 1, 0],
        ['fractional-shore', shoreMap, 0, 0.5],
        // Actual packaged specular values on opposite sides of the KSC coast.
        ['gray-coastal-land-keeps-land-lighting', coastalLand, 1, 0],
        ['gray-coastal-water-keeps-ocean-lighting', coastalWater, 0, 1],
      ] as const) {
        vertexMask.array.fill(vertexWater); vertexMask.needsUpdate = true;
        terrainMaterial.uniforms.specMap!.value = map;
        resources.draw(() => { renderer.setRenderTarget(surfaceTarget); renderer.render(scene, resources.camera); });
        record(`geographic-${name}`, await resources.readCenter(surfaceTarget), [0.9, 0.9, 0.9, 1 - 0.5 * expectedWater]);
      }
      terrainMaterial.uniforms.specMap!.value = resources.zero2D;
      terrainMaterial.uniforms.dayMap!.value = darkLand;
      resources.draw(() => { renderer.setRenderTarget(surfaceTarget); renderer.render(scene, resources.camera); });
      const calibrated = await resources.readCenter(surfaceTarget);
      record('dark-land-calibration-preserves-hue', [calibrated[0]! / calibrated[1]!, calibrated[2]! / calibrated[1]!], [0.5, 0.25]);
      record('dark-land-calibration-is-bounded-reflectance',
        [Number(calibrated[1]! > 0.08 && calibrated[1]! < 0.3)], [1]);
      terrainMaterial.uniforms.dayMap!.value = resources.zero2D;
      resources.draw(() => { renderer.setRenderTarget(surfaceTarget); renderer.render(scene, resources.camera); });
      record('black-reflectance-stays-black-and-finite', await resources.readCenter(surfaceTarget), [0, 0, 0, 1]);
    } finally {
      surfaceTarget.dispose(); geometry.dispose(); terrainMaterial.dispose();
      for (const map of [shoreMap, coastalLand, coastalWater, darkLand]) map.dispose();
    }
  } finally { pass.dispose(); material.dispose(); noise.dispose(); }
  return cases;
}
