import { MeshStandardMaterial } from 'three';
import type { AirfieldMaterialName } from './airfieldGeometry';
import { AIRFIELD_SITE } from './airfieldSite';
import type { AirfieldSurfaceTextures } from './airfieldSurfaceTextures';

// Read the surveyed surface definitions, not the merged rendering cells: one
// pavement instance can span asphalt and concrete. Keep the existing batches.
const CONCRETE_MASK = AIRFIELD_SITE.surfaces
  .filter((surface) => surface.kind === 'APRON' || surface.kind === 'PAD')
  .map((surface) => `airfieldConcreteMask(airfieldP, vec2(${surface.centerEastM.toFixed(1)}, ${surface.centerSouthM.toFixed(1)}),
    vec2(${(surface.widthM / 2).toFixed(1)}, ${(surface.lengthM / 2).toFixed(1)}), airfieldFootprint)`)
  .join(' + ');

const SURFACE_FUNCTIONS = /* glsl */`
varying vec3 vAirfieldSurface;
varying vec3 vAirfieldEastView;
uniform sampler2D airfieldColorMap;
uniform sampler2D airfieldNormalRoughnessMap;
uniform float airfieldTileSizeM;
#ifdef AIRFIELD_CONCRETE
uniform sampler2D airfieldConcreteColorMap;
uniform sampler2D airfieldConcreteNormalRoughnessMap;
uniform float airfieldConcreteTileSizeM;
#endif

float airfieldHash(vec2 p) {
  vec3 h = fract(vec3(p.xyx) * 0.1031);
  h += dot(h, h.yzx + 33.33);
  return fract((h.x + h.y) * h.z);
}

// Zero-mean value noise. Fade each band before its lattice becomes subpixel;
// derivatives come from continuous meter coordinates, never fract/floor noise.
float airfieldNoise(vec2 p, float footprint) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n = mix(mix(airfieldHash(cell), airfieldHash(cell + vec2(1.0, 0.0)), f.x),
    mix(airfieldHash(cell + vec2(0.0, 1.0)), airfieldHash(cell + vec2(1.0)), f.x), f.y);
  return (2.0 * n - 1.0) * (1.0 - smoothstep(0.2, 0.65, footprint));
}

#ifdef AIRFIELD_CONCRETE
float airfieldConcreteMask(vec2 p, vec2 center, vec2 halfSize, float footprint) {
  vec2 edge = abs(p - center) - halfSize;
  float filterWidth = max(0.5 * footprint, 0.001);
  return 1.0 - smoothstep(-filterWidth, filterWidth, max(edge.x, edge.y));
}

// Integral of an 18 mm joint every 5 m. Differencing across the pixel footprint
// preserves area coverage instead of widening distant joints into dark grids.
vec2 airfieldJointIntegral(vec2 p) {
  vec2 cell = floor(p / 5.0);
  return cell * 0.018 + min(p - cell * 5.0, vec2(0.018));
}

float airfieldJoints(vec2 p, vec2 pixelWidth) {
  vec2 width = max(pixelWidth, vec2(0.001));
  vec2 q = p + 0.009;
  vec2 coverage = clamp((airfieldJointIntegral(q + 0.5 * width)
    - airfieldJointIntegral(q - 0.5 * width)) / width, 0.0, 1.0);
  return 1.0 - (1.0 - coverage.x) * (1.0 - coverage.y);
}
#endif
`;

const SURFACE_COLOR = /* glsl */`
// Derivatives and texture samples precede face guards. Unwrapped site meters
// preserve footprints across tile boundaries and floating-origin rebases.
vec2 airfieldP = vAirfieldSurface.xy;
vec2 airfieldPixelWidth = fwidth(airfieldP);
float airfieldFootprint = max(length(dFdx(airfieldP)), length(dFdy(airfieldP)));
vec2 airfieldUv = airfieldP / airfieldTileSizeM;
vec3 airfieldAlbedo = texture2D(airfieldColorMap, airfieldUv).rgb;
vec4 airfieldDetail = texture2D(airfieldNormalRoughnessMap, airfieldUv);
float airfieldConcrete = 0.0;
float airfieldConcreteJoint = 0.0;
#ifdef AIRFIELD_CONCRETE
  // Summed coverage keeps the shared apron edge fully concrete. Blend all
  // material channels with the same surveyed mask, including roughness/normal.
  airfieldConcrete = clamp(${CONCRETE_MASK}, 0.0, 1.0) * vAirfieldSurface.z;
  vec2 airfieldConcreteUv = airfieldP / airfieldConcreteTileSizeM;
  vec3 airfieldConcreteAlbedo = texture2D(airfieldConcreteColorMap, airfieldConcreteUv).rgb;
  vec4 airfieldConcreteDetail = texture2D(airfieldConcreteNormalRoughnessMap, airfieldConcreteUv);
  airfieldAlbedo = mix(airfieldAlbedo, airfieldConcreteAlbedo, airfieldConcrete);
  airfieldDetail = mix(airfieldDetail, airfieldConcreteDetail, airfieldConcrete);
  airfieldConcreteJoint = airfieldConcrete * airfieldJoints(airfieldP, airfieldPixelWidth);
#endif
#ifdef AIRFIELD_INFIELD
  float airfieldCoarse = airfieldNoise(airfieldP / 28.0 + vec2(13.1, 47.7), airfieldFootprint / 28.0);
  float airfieldMedium = airfieldNoise(airfieldP / 2.0 + vec2(37.2, 11.9), airfieldFootprint / 2.0);
  airfieldAlbedo *= (1.0 + 0.14 * airfieldCoarse + 0.06 * airfieldMedium)
    * vec3(1.0 + 0.03 * airfieldCoarse, 1.0, 1.0 - 0.04 * airfieldCoarse);
#else
  float airfieldCoarse = airfieldNoise(airfieldP / 32.0 + vec2(13.1, 47.7), airfieldFootprint / 32.0);
  float airfieldMedium = airfieldNoise(airfieldP / 3.0 + vec2(37.2, 11.9), airfieldFootprint / 3.0);
  airfieldAlbedo *= 1.0 + 0.075 * airfieldCoarse + 0.035 * airfieldMedium;
#endif
#ifdef AIRFIELD_SHOULDER
  airfieldAlbedo *= vec3(1.20, 1.18, 1.12);
  airfieldDetail.a += 0.025;
#endif
airfieldAlbedo *= 1.0 - 0.24 * airfieldConcreteJoint;
diffuseColor.rgb = mix(diffuseColor.rgb, airfieldAlbedo, vAirfieldSurface.z);
`;

const SURFACE_NORMAL = /* glsl */`
// An explicit site-east tangent avoids derivative-built tangent frames from
// the rank-one xz UVs on vertical box sides. Guard before normalizing a basis.
vec3 airfieldTangent = vAirfieldEastView - normal * dot(vAirfieldEastView, normal);
float airfieldTangentLengthSq = dot(airfieldTangent, airfieldTangent);
if (vAirfieldSurface.z > 0.5 && airfieldTangentLengthSq > 0.000001) {
  airfieldTangent *= inversesqrt(airfieldTangentLengthSq);
  // UV +v is site south: east cross up = south (the xz chart is left-handed).
  vec3 airfieldBitangent = cross(airfieldTangent, normal);
  vec3 airfieldMapNormal = airfieldDetail.xyz * 2.0 - 1.0;
  airfieldMapNormal.xy *= 1.0 - smoothstep(0.04, 0.30, airfieldFootprint);
  normal = normalize(airfieldTangent * airfieldMapNormal.x
    + airfieldBitangent * airfieldMapNormal.y + normal * airfieldMapNormal.z);
}
`;

function replaceOnce(source: string, seam: string, replacement: string): string {
  if (source.split(seam).length !== 2) throw new Error(`Pinned Three airfield shader changed: ${seam}`);
  return source.replace(seam, replacement);
}

/** Configure an owned material once; daylight/rebasing never replaces it. */
export function applyAirfieldSurface(
  material: MeshStandardMaterial,
  name: AirfieldMaterialName,
  textures: AirfieldSurfaceTextures,
): void {
  if (name !== 'infield' && name !== 'pavement' && name !== 'shoulder') return;
  const define = name === 'infield' ? '#define AIRFIELD_INFIELD\n'
    : name === 'pavement' ? '#define AIRFIELD_CONCRETE\n' : '#define AIRFIELD_SHOULDER\n';
  const maps = name === 'infield' ? textures.infield : textures.asphalt;
  const uniforms = {
    airfieldColorMap: { value: maps.color },
    airfieldNormalRoughnessMap: { value: maps.normalRoughness },
    airfieldTileSizeM: { value: maps.tileSizeM },
    ...(name === 'pavement' ? {
      airfieldConcreteColorMap: { value: textures.concrete.color },
      airfieldConcreteNormalRoughnessMap: { value: textures.concrete.normalRoughness },
      airfieldConcreteTileSizeM: { value: textures.concrete.tileSizeM },
    } : {}),
  };
  const previousCompile = material.onBeforeCompile;
  const previousCacheKey = material.customProgramCacheKey;
  // Three's default key reads this.onBeforeCompile. Capture that default before
  // wrapping it; custom keys keep their live behavior for other material hooks.
  const defaultCacheKey = previousCacheKey === MeshStandardMaterial.prototype.customProgramCacheKey
    ? previousCompile.toString() : undefined;
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = replaceOnce(shader.vertexShader, '#include <common>',
      '#include <common>\nvarying vec3 vAirfieldSurface;\nvarying vec3 vAirfieldEastView;');
    shader.vertexShader = replaceOnce(shader.vertexShader, '#include <begin_vertex>', /* glsl */`
      #include <begin_vertex>
      vec4 airfieldSitePosition = vec4(transformed, 1.0);
      vec3 airfieldSiteNormal = normal;
      #ifdef USE_INSTANCING
        // Full translation, rotation AND scale of each box, before the parent's
        // Earth orientation, render-unit scale or floating-origin translation.
        airfieldSitePosition = instanceMatrix * airfieldSitePosition;
        // Box face normals are axis aligned, so normalization removes scale.
        airfieldSiteNormal = mat3(instanceMatrix) * airfieldSiteNormal;
      #endif
      vAirfieldSurface = vec3(airfieldSitePosition.xz, step(0.5, normalize(airfieldSiteNormal).y));
      // Site axes, not per-box UVs. Normalize away the parent's render scale.
      vAirfieldEastView = normalize(mat3(modelViewMatrix) * vec3(1.0, 0.0, 0.0));
    `);
    shader.fragmentShader = define + replaceOnce(shader.fragmentShader, '#include <common>',
      `#include <common>\n${SURFACE_FUNCTIONS}`);
    shader.fragmentShader = replaceOnce(shader.fragmentShader, '#include <color_fragment>',
      `#include <color_fragment>\n${SURFACE_COLOR}`);
    shader.fragmentShader = replaceOnce(shader.fragmentShader, '#include <roughnessmap_fragment>', /* glsl */`
      #include <roughnessmap_fragment>
      float airfieldRoughness = clamp(airfieldDetail.a + 0.012 * airfieldMedium
        + 0.02 * airfieldConcreteJoint, 0.78, 0.995);
      roughnessFactor = mix(roughnessFactor, airfieldRoughness, vAirfieldSurface.z);
    `);
    shader.fragmentShader = replaceOnce(shader.fragmentShader, '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>\n${SURFACE_NORMAL}`);
  };
  material.customProgramCacheKey = () => `${defaultCacheKey ?? previousCacheKey.call(material)}|airfield-surface-v2-${name}`;
}
