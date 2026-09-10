import { MeshNormalMaterial, type ShaderMaterial } from 'three';
import { EARTH_KTX_UV_GLSL } from '../libraryEarthTextureOrientation';
import { TERRAIN_SURFACE_GLSL } from './terrainSurface';

type NormalShader = Parameters<MeshNormalMaterial['onBeforeCompile']>[0];

function replaceOnce(source: string, seam: string, replacement: string): string {
  if (source.split(seam).length !== 2) throw new Error('Terrain detail normal shader seam changed');
  return source.replace(seam, replacement);
}

/** Same material field as the color pass, retaining Three's normal/depth ABI. */
export function applyTerrainSurfaceNormalShader(shader: NormalShader, hasWaterMap = false): void {
  const vertex = replaceOnce(shader.vertexShader, '#include <common>', `#include <common>
    attribute float terrainWaterMask;
    uniform vec3 planetCenter;
    uniform float terrainSurfaceMetersPerUnit;
    varying vec3 vTerrainPositionM;
    varying vec3 vTerrainLocalM;
    varying float vTerrainWaterMask;`);
  const vertexShader = replaceOnce(vertex, '#include <project_vertex>', `#include <project_vertex>
    vTerrainPositionM = ((modelMatrix * vec4(transformed, 1.0)).xyz - planetCenter) * terrainSurfaceMetersPerUnit;
    vTerrainLocalM = transformed;
    vTerrainWaterMask = terrainWaterMask;`);
  const fragment = replaceOnce(shader.fragmentShader, '#include <packing>', `#include <packing>
    uniform sampler2D dayMap;
    ${hasWaterMap ? 'uniform sampler2D specMap;' : ''}
    varying vec3 vTerrainPositionM;
    varying vec3 vTerrainLocalM;
    varying float vTerrainWaterMask;
    ${EARTH_KTX_UV_GLSL}
    ${TERRAIN_SURFACE_GLSL}`);
  const fragmentShader = replaceOnce(fragment, '#include <normal_fragment_maps>', `#include <normal_fragment_maps>
    vec3 radial = normalize(vTerrainPositionM);
    vec2 groundUv = earthMapUv(vec2(fract(atan(radial.z, -radial.x) / 6.28318530718),
      0.5 + asin(clamp(radial.y, -1.0, 1.0)) / 3.14159265359));
    vec3 groundAlbedo = earthSurfaceAlbedo(texture2D(dayMap, groundUv).rgb);
    // Evaluate derivatives before the shoreline selection. Neighboring lanes
    // must agree on derivative execution even when one lane is water.
    vec3 worldNormal = normalize(normal * mat3(viewMatrix));
    vec3 detailNormal = terrainSurfaceNormal(worldNormal, vTerrainPositionM, groundAlbedo, vTerrainLocalM);
    ${hasWaterMap ? `float water = earthWaterFraction(texture2D(specMap, groundUv).r);
    normal = normalize(mat3(viewMatrix) * normalize(mix(detailNormal, radial, water)));` :
    'if (vTerrainWaterMask < 0.5) normal = normalize(mat3(viewMatrix) * detailNormal);'}`);
  shader.vertexShader = vertexShader;
  shader.fragmentShader = fragmentShader;
}

/** The source terrain owner retains the texture; this material owns no assets. */
export function createTerrainSurfaceNormalMaterial(source: ShaderMaterial): MeshNormalMaterial {
  const material = new MeshNormalMaterial();
  material.onBeforeCompile = shader => {
    applyTerrainSurfaceNormalShader(shader, source.defines.TERRAIN_WATER_MAP === 1);
    Object.assign(shader.uniforms, source.uniforms);
  };
  material.customProgramCacheKey = () => `terrain-surface-normal-v4-water-${source.defines.TERRAIN_WATER_MAP === 1}`;
  return material;
}
