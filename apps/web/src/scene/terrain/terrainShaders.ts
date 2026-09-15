import { EARTH_KTX_UV_GLSL } from '../libraryEarthTextureOrientation';
import { TERRAIN_SURFACE_GLSL } from './terrainSurface';
import {
  NormalBlending,
  ShaderMaterial,
  Texture,
  Vector3,
} from 'three';

export interface TerrainShaderTextures {
  readonly dayMap: Texture;
  readonly specMap?: Texture;
}

export interface TerrainShaderOptions {
  readonly planetCenter: readonly [number, number, number];
}

export const TERRAIN_VERTEX_SHADER = /* glsl */ `
  uniform vec3 planetCenter;
  attribute float terrainWaterMask;
  varying float vTerrainWaterMask;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec3 vRadial;
  #ifdef TERRAIN_SURFACE_DETAIL
  varying vec3 vTerrainLocalM;
  #endif
  // Preserve geometric clipping; use the same fragment depth as built-in materials.
  #include <common>
  #include <logdepthbuf_pars_vertex>
  void main() {
    vTerrainWaterMask = terrainWaterMask;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vRadial = wp.xyz - planetCenter;
    #ifdef TERRAIN_SURFACE_DETAIL
    vTerrainLocalM = position;
    #endif
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }
`;

/**
 * Terrain emits the same opaque albedo + water metadata as the globe; the
 * composer's aerial lighting owns sun, sky and atmosphere. One surface owns
 * both materials and depth, including shorelines — a second water draw would
 * compete with sea-level terrain at equal depth.
 */
export const TERRAIN_FRAGMENT_SHADER = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D dayMap;
  #ifdef TERRAIN_WATER_MAP
  uniform sampler2D specMap;
  #endif
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec3 vRadial;
  varying float vTerrainWaterMask;
  #ifdef TERRAIN_SURFACE_DETAIL
  uniform float terrainSurfaceMetersPerUnit;
  varying vec3 vTerrainLocalM;
  #endif

  const float PI = 3.14159265359;

${EARTH_KTX_UV_GLSL}
#ifdef TERRAIN_SURFACE_DETAIL
${TERRAIN_SURFACE_GLSL}
#endif

  vec2 sphericalUv(vec3 direction) {
    return vec2(
      atan(direction.z, -direction.x) / (2.0 * PI),
      0.5 + asin(clamp(direction.y, -1.0, 1.0)) / PI
    );
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec3 radial = normalize(vRadial);
    vec3 n = normalize(vWorldNormal);
    vec2 uv = sphericalUv(radial);
    uv.x = fract(uv.x);
    // Color and water classification share the packaged KTX orientation and
    // the globe's linear imagery albedo across the LOD transition.
    uv = earthMapUv(uv);
    vec3 albedo = earthSurfaceAlbedo(texture2D(dayMap, uv).rgb);
    #ifdef TERRAIN_SURFACE_DETAIL
    vec3 detailAlbedo = terrainSurfaceAlbedo(albedo, vRadial * terrainSurfaceMetersPerUnit, n, vTerrainLocalM);
    #endif
    #ifdef TERRAIN_WATER_MAP
    // Match the orbital surface's geographic mask at every LOD. A binary
    // vertex mask draws triangle-shaped shorelines that change with the mesh.
    float water = earthWaterFraction(texture2D(specMap, uv).r);
    #ifdef TERRAIN_SURFACE_DETAIL
    albedo = mix(detailAlbedo, albedo, water);
    #endif
    gl_FragColor = vec4(albedo, 1.0 - 0.5 * water);
    #else
    #ifdef TERRAIN_SURFACE_DETAIL
    albedo = detailAlbedo;
    #endif
    gl_FragColor = vTerrainWaterMask >= 0.5
      ? vec4(0.015, 0.04, 0.07, 0.5)
      : vec4(albedo, 1.0);
    #endif
  }
`;

export function createTerrainPatchMaterial(
  textures: TerrainShaderTextures,
  options: TerrainShaderOptions,
): ShaderMaterial {
  return new ShaderMaterial({
    // LIBRARY_LIGHTING marks the surface for the composer's aerial lighting mask.
    defines: { LIBRARY_LIGHTING: 1, ...(textures.specMap ? { TERRAIN_WATER_MAP: 1 } : {}) },
    vertexShader: TERRAIN_VERTEX_SHADER,
    fragmentShader: TERRAIN_FRAGMENT_SHADER,
    uniforms: {
      dayMap: { value: textures.dayMap },
      specMap: { value: textures.specMap ?? null },
      planetCenter: { value: new Vector3(...options.planetCenter) },
    },
    transparent: false,
    blending: NormalBlending,
    depthTest: true,
    depthWrite: true,
    toneMapped: true,
  });
}
