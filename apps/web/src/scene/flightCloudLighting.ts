import {
  Matrix3,
  Matrix4,
  ShaderChunk,
  MeshStandardMaterial,
  Texture,
  Uniform,
  Vector2,
  Vector3,
  Vector4,
  type IUniform,
} from 'three';
import mediaGLSL from './clouds/shaders/cloudDensity.glsl?raw';
import transportGLSL from './clouds/shaders/cloudTransport.glsl?raw';
import lookupGLSL from './clouds/shaders/cloudLightLookup.glsl?raw';

const PHYSICAL_MEDIA_GLSL = mediaGLSL.replace(/\bbottomRadius\b/g, 'volumetricCloudPlanetRadiusM');

/**
 * This is deliberately the small local-PBR subset of the cloud backend. The
 * cloud view owns the complete lighting hook (including presentation and
 * distant-cloud code); local materials need only the canonical medium, bounded
 * transport, and valid-cache lookup.
 */
const LOCAL_CLOUD_GLSL = /* glsl */ `
precision highp sampler3D;
uniform float volumetricLocalCloudLightingEnabled;
uniform vec3 volumetricWeatherSunDirectionECEF;
uniform float volumetricCloudPlanetRadiusM;
struct MediaSample {
  float density;
  vec4 weight;
  float scattering;
  float extinction;
  vec2 phaseAnisotropy;
  float phaseMix;
};
${PHYSICAL_MEDIA_GLSL}
#define sunDirection volumetricWeatherSunDirectionECEF
${transportGLSL.replace('uniform float volumetricCloudPlanetRadiusM;', '')}
${lookupGLSL}
#undef sunDirection
`;

const VERTEX_DECLARATIONS = /* glsl */ `
uniform mat4 volumetricLocalRenderToECEF;
varying vec3 volumetricLocalPositionECEFM;
`;

const FRAGMENT_DECLARATIONS = /* glsl */ `
varying vec3 volumetricLocalPositionECEFM;
${LOCAL_CLOUD_GLSL}
`;

type FlightCloudUniform = Uniform<unknown>;

interface MaterialRegistration {
  readonly previousCompile: MeshStandardMaterial['onBeforeCompile'];
  readonly previousCacheKey: MeshStandardMaterial['customProgramCacheKey'];
  readonly compiledUniforms: Set<Record<string, IUniform>>;
  count: number;
}

function once(source: string, seam: string, replacement: string): string {
  if (source.split(seam).length !== 2) {
    throw new Error(`Pinned Three local cloud shader changed: ${seam}`);
  }
  return source.replace(seam, replacement);
}

function placeholderUniforms(): Record<string, FlightCloudUniform> {
  const uniforms: Record<string, FlightCloudUniform> = {};
  const declarations = LOCAL_CLOUD_GLSL.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '');
  const pattern = /\buniform\s+(?:(?:lowp|mediump|highp)\s+)?(sampler2DArray|sampler3D|sampler2D|float|int|vec2|vec3|vec4|mat3)\s+(\w+)(?:\[(\d+)\])?\s*;/g;
  for (const [, type, name, count] of declarations.matchAll(pattern)) {
    const value = ((): unknown => {
      if (count !== undefined) {
        const length = Number(count);
        if (type === 'vec2') return Array.from({ length }, () => new Vector2());
        if (type === 'vec3') return Array.from({ length }, () => new Vector3());
        if (type === 'vec4') return Array.from({ length }, () => new Vector4());
        return Array.from({ length }, () => 0);
      }
      if (type.startsWith('sampler')) return null as Texture | null;
      if (type === 'vec2') return new Vector2();
      if (type === 'vec3') return new Vector3();
      if (type === 'vec4') return new Vector4();
      if (type === 'mat3') return new Matrix3();
      return 0;
    })();
    uniforms[name] = new Uniform(value);
  }
  uniforms.volumetricLocalRenderToECEF = new Uniform(new Matrix4());
  return uniforms;
}

/**
 * Stable owner-side bridge for materials that live beside the flight scene.
 * Materials can compile before the asynchronous cloud assets arrive: the
 * bridge uses inert placeholders and keeps its enable uniform at zero, then
 * updates every compiled uniform map with the exact live cloud Uniform instances.
 * A Three program-cache hit skips onBeforeCompile even after needsUpdate; merely
 * replacing the bridge map would leave materials reading disposed textures.
 */
export interface FlightCloudLightingBridge {
  readonly renderToECEF: Matrix4;
  readonly uniforms: Readonly<Record<string, FlightCloudUniform>>;
  registerMaterial(material: MeshStandardMaterial): () => void;
  setBindings(bindings: Readonly<Record<string, Uniform>> | null): void;
  setEnabled(enabled: boolean): void;
  clearBindings(): void;
}

export function createFlightCloudLightingBridge(): FlightCloudLightingBridge {
  const placeholders = placeholderUniforms();
  const renderToECEF = placeholders.volumetricLocalRenderToECEF.value as Matrix4;
  const enabled = new Uniform(0);
  const materials = new Map<MeshStandardMaterial, MaterialRegistration>();
  let bindings: Readonly<Record<string, Uniform>> | null = null;
  const activeUniforms: Record<string, FlightCloudUniform> = {
    ...placeholders,
    volumetricLocalCloudLightingEnabled: enabled,
  };

  const refreshUniforms = () => {
    // Only the shader's declared subset is borrowed; do not retain unrelated
    // cloud-view resources. Every name exists even on a pre-load compilation.
    for (const name of Object.keys(placeholders)) {
      activeUniforms[name] = bindings?.[name] ?? placeholders[name]!;
    }
    activeUniforms.volumetricLocalCloudLightingEnabled = enabled;
    activeUniforms.volumetricLocalRenderToECEF = placeholders.volumetricLocalRenderToECEF!;
    for (const registration of materials.values()) {
      for (const uniforms of registration.compiledUniforms) Object.assign(uniforms, activeUniforms);
    }
  };

  const releaseRegistration = (material: MeshStandardMaterial, registration: MaterialRegistration) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (materials.get(material) !== registration || --registration.count > 0) return;
      materials.delete(material);
      // Detach every borrowed sampler before the owner can dispose it.
      for (const uniforms of registration.compiledUniforms) Object.assign(uniforms, placeholders);
      registration.compiledUniforms.clear();
      material.onBeforeCompile = registration.previousCompile;
      material.customProgramCacheKey = registration.previousCacheKey;
      // Owned material programs must forget their patched uniform bindings.
      // This releases programs only; textures, images and the material survive.
      material.dispose();
      material.needsUpdate = true;
    };
  };

  const bridge: FlightCloudLightingBridge = {
    renderToECEF,
    get uniforms() { return activeUniforms; },
    registerMaterial(material) {
      const existing = materials.get(material);
      if (existing) {
        existing.count += 1;
        return releaseRegistration(material, existing);
      }
      const previousCompile = material.onBeforeCompile;
      const previousCacheKey = material.customProgramCacheKey;
      const registration: MaterialRegistration = {
        previousCompile, previousCacheKey, compiledUniforms: new Set(), count: 1,
      };
      // Reattaching to an already rendered owned material must not reuse a
      // previous bridge's onBeforeCompile/uniform-map cache.
      material.dispose();
      material.onBeforeCompile = (shader, renderer) => {
        previousCompile.call(material, shader, renderer);
        shader.vertexShader = once(shader.vertexShader, '#include <common>',
          `#include <common>\n${VERTEX_DECLARATIONS}`);
        shader.vertexShader = once(shader.vertexShader, '#include <worldpos_vertex>', `
          #include <worldpos_vertex>
          vec4 volumetricLocalWorldPosition = vec4(transformed, 1.0);
          #ifdef USE_BATCHING
            volumetricLocalWorldPosition = batchingMatrix * volumetricLocalWorldPosition;
          #endif
          #ifdef USE_INSTANCING
            volumetricLocalWorldPosition = instanceMatrix * volumetricLocalWorldPosition;
          #endif
          volumetricLocalWorldPosition = modelMatrix * volumetricLocalWorldPosition;
          volumetricLocalPositionECEFM = (volumetricLocalRenderToECEF * volumetricLocalWorldPosition).xyz;
        `);
        shader.fragmentShader = once(shader.fragmentShader, '#include <common>',
          `#include <common>\n${FRAGMENT_DECLARATIONS}`);
        // Airfield's surface hook intentionally remains earlier in main().
        // Compute physical derivatives before the lighting branch.
        shader.fragmentShader = once(shader.fragmentShader, '\t#include <emissivemap_fragment>\n', `
          #include <emissivemap_fragment>
          float volumetricLocalCloudFootprintM = max(1.0, max(
            length(dFdx(volumetricLocalPositionECEFM)), length(dFdy(volumetricLocalPositionECEFM))));
          float volumetricLocalDirectCloudVisibility = 1.0;
          float volumetricLocalSkyCloudVisibility = 1.0;
          if (volumetricLocalCloudLightingEnabled > 0.5) {
            volumetricLocalDirectCloudVisibility = volumetricSunTransmittance(
              volumetricLocalPositionECEFM, 0.0, volumetricLocalCloudFootprintM);
            volumetricLocalSkyCloudVisibility = volumetricSkyVisibility(
              volumetricLocalPositionECEFM, volumetricLocalCloudFootprintM);
          }
        `);
        const directLighting = once(ShaderChunk.lights_fragment_begin,
          'getDirectionalLightInfo( directionalLight, directLight );',
          'getDirectionalLightInfo( directionalLight, directLight );\n directLight.color *= volumetricLocalDirectCloudVisibility;');
        shader.fragmentShader = once(shader.fragmentShader,
          '#include <lights_fragment_begin>', directLighting);
        shader.fragmentShader = once(shader.fragmentShader, '\t#include <lights_fragment_maps>\n', `
          #include <lights_fragment_maps>
          if (volumetricLocalCloudLightingEnabled > 0.5) irradiance *= volumetricLocalSkyCloudVisibility;
        `);
        Object.assign(shader.uniforms, activeUniforms);
        registration.compiledUniforms.add(shader.uniforms);
      };
      const previousKey = previousCacheKey === MeshStandardMaterial.prototype.customProgramCacheKey
        ? previousCompile.toString() : previousCacheKey.call(material);
      material.customProgramCacheKey = () => `${previousKey}|flight-local-cloud-lighting-v1`;
      materials.set(material, registration);
      material.needsUpdate = true;
      return releaseRegistration(material, registration);
    },
    setBindings(next) {
      if (bindings === next) return;
      if (next === null) enabled.value = 0;
      bindings = next;
      refreshUniforms();
    },
    setEnabled(value) {
      enabled.value = value ? 1 : 0;
    },
    clearBindings() {
      enabled.value = 0;
      bindings = null;
      refreshUniforms();
    },
  };
  return bridge;
}
