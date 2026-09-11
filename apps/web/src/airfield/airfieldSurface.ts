import type { MeshStandardMaterial } from 'three';
import type { AirfieldMaterialName } from './airfieldGeometry';
import { AIRFIELD_SITE } from './airfieldSite';

// Read the surveyed surface definitions, not the merged rendering cells: one
// pavement instance can span asphalt and concrete. No extra meshes or textures.
const CONCRETE_MASK = AIRFIELD_SITE.surfaces
  .filter((surface) => surface.kind === 'APRON' || surface.kind === 'PAD')
  .map((surface) => `airfieldConcreteMask(p, vec2(${surface.centerEastM.toFixed(1)}, ${surface.centerSouthM.toFixed(1)}),
    vec2(${(surface.widthM / 2).toFixed(1)}, ${(surface.lengthM / 2).toFixed(1)}), footprint)`)
  .join(' + ');

const SURFACE_FUNCTIONS = /* glsl */`
varying vec3 vAirfieldSurface;

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
vec2 p = vAirfieldSurface.xy;
vec2 pixelWidth = fwidth(p);
float footprint = max(length(dFdx(p)), length(dFdy(p)));
#ifdef AIRFIELD_INFIELD
  float coarse = airfieldNoise(p / 28.0 + vec2(13.1, 47.7), footprint / 28.0);
  float medium = airfieldNoise(p / 2.0 + vec2(37.2, 11.9), footprint / 2.0);
  float grain = airfieldNoise(p / 0.22 + vec2(5.3, 71.4), footprint / 0.22);
  diffuseColor.rgb *= (1.0 + 0.14 * coarse + 0.06 * medium + 0.025 * grain)
    * vec3(1.0 + 0.03 * coarse, 1.0, 1.0 - 0.04 * coarse);
#else
  float coarse = airfieldNoise(p / 32.0 + vec2(13.1, 47.7), footprint / 32.0);
  float medium = airfieldNoise(p / 3.0 + vec2(37.2, 11.9), footprint / 3.0);
  float grain = airfieldNoise(p / 0.16 + vec2(5.3, 71.4), footprint / 0.16);
  diffuseColor.rgb *= 1.0 + 0.075 * coarse + 0.035 * medium + 0.018 * grain;
#endif
float concreteJoint = 0.0;
#ifdef AIRFIELD_CONCRETE
  // Summed coverage keeps the shared apron edge fully concrete.
  float concrete = clamp(${CONCRETE_MASK}, 0.0, 1.0) * vAirfieldSurface.z;
  concreteJoint = concrete * airfieldJoints(p, pixelWidth);
  diffuseColor.rgb *= mix(vec3(1.0), vec3(1.30, 1.27, 1.18), concrete)
    * (1.0 - 0.24 * concreteJoint);
#endif
`;

function replaceOnce(source: string, seam: string, replacement: string): string {
  if (source.split(seam).length !== 2) throw new Error(`Pinned Three airfield shader changed: ${seam}`);
  return source.replace(seam, replacement);
}

/** Configure an owned material once; daylight/rebasing never replaces it. */
export function applyAirfieldSurface(material: MeshStandardMaterial, name: AirfieldMaterialName): void {
  if (name !== 'infield' && name !== 'pavement' && name !== 'shoulder') return;
  const define = name === 'infield' ? '#define AIRFIELD_INFIELD\n'
    : name === 'pavement' ? '#define AIRFIELD_CONCRETE\n' : '';
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = replaceOnce(shader.vertexShader, '#include <common>',
      '#include <common>\nvarying vec3 vAirfieldSurface;');
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
    `);
    shader.fragmentShader = define + replaceOnce(shader.fragmentShader, '#include <common>',
      `#include <common>\n${SURFACE_FUNCTIONS}`);
    shader.fragmentShader = replaceOnce(shader.fragmentShader, '#include <color_fragment>',
      `#include <color_fragment>\n${SURFACE_COLOR}`);
    shader.fragmentShader = replaceOnce(shader.fragmentShader, '#include <roughnessmap_fragment>', /* glsl */`
      #include <roughnessmap_fragment>
      roughnessFactor = clamp(roughnessFactor + 0.025 * medium + 0.012 * grain
        + 0.02 * concreteJoint, 0.86, 0.99);
    `);
  };
  material.customProgramCacheKey = () => `airfield-surface-v1-${name}`;
}
