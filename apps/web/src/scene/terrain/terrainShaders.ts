import { LIBRARY_RENDERER as DEFAULT_LIBRARY_RENDERER } from '../renderProbeConfig';
import { EARTH_KTX_UV_GLSL } from '../libraryEarthTextureOrientation';
import { TERRAIN_SURFACE_GLSL } from './terrainSurface';
import {
  NormalBlending,
  ShaderMaterial,
  Texture,
  Vector3,
} from 'three';
import {
  AERIAL_SKY_RADIANCE,
  CLOUD_DECK_CONTRAST,
  CLOUD_DECK_DETAIL_SCALE,
  CLOUD_DECK_DETAIL_STRENGTH,
  CLOUD_SHADOW_STRENGTH,
  OCEAN_WAVE_FADE_END,
  OCEAN_WAVE_FADE_START,
} from '../sky/skyConfig';
import { CLOUD_COVERAGE_GLSL } from '../sky/cloudCoverage';
import { SKY_LIGHTING_GLSL } from '../sky/lighting';
import { SUN_DIR } from '../sun';

export interface TerrainShaderTextures {
  readonly dayMap: Texture;
  readonly specMap?: Texture;
  readonly cloudMap: Texture;
  readonly transmittanceLut: Texture;
}

export interface TerrainShaderOptions {
  readonly planetCenter: readonly [number, number, number];
  readonly surfaceRadius: number;
  readonly atmosphereRadius: number;
  /** Explicit renderer selection; omitted preserves the query-selected path. */
  readonly libraryRenderer?: boolean;
}

export const TERRAIN_VERTEX_SHADER = /* glsl */ `
  uniform vec3 planetCenter;
  #ifdef LIBRARY_LIGHTING
  attribute float terrainWaterMask;
  varying float vTerrainWaterMask;
  #endif
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
    #ifdef LIBRARY_LIGHTING
    vTerrainWaterMask = terrainWaterMask;
    #endif
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

export const TERRAIN_FRAGMENT_SHADER = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  #define AERIAL_SKY_RADIANCE vec3(${AERIAL_SKY_RADIANCE.map((value) => value.toFixed(2)).join(', ')})
  uniform sampler2D dayMap;
  #ifdef TERRAIN_WATER_MAP
  uniform sampler2D specMap;
  #endif
  uniform sampler2D cloudMap;
  uniform sampler2D transmittanceLut;
  uniform vec3 sunDir;
  uniform vec3 planetCenter;
  uniform float surfaceRadius;
  uniform float atmosphereRadius;
  uniform float terrainOpacity;
  uniform float cloudRotationOffset;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec3 vRadial;
  #ifdef TERRAIN_SURFACE_DETAIL
  uniform float terrainSurfaceMetersPerUnit;
  varying vec3 vTerrainLocalM;
  #endif
  #ifdef LIBRARY_LIGHTING
  varying float vTerrainWaterMask;
  #endif

  const float PI = 3.14159265359;

${CLOUD_COVERAGE_GLSL}
${SKY_LIGHTING_GLSL}
${EARTH_KTX_UV_GLSL}
#ifdef TERRAIN_SURFACE_DETAIL
${TERRAIN_SURFACE_GLSL}
#endif

  vec3 rotateY(vec3 point, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return vec3(c * point.x + s * point.z, point.y, -s * point.x + c * point.z);
  }

  vec2 sphericalUv(vec3 direction) {
    return vec2(
      atan(direction.z, -direction.x) / (2.0 * PI),
      0.5 + asin(clamp(direction.y, -1.0, 1.0)) / PI
    );
  }

  vec3 proceduralTerrainColor(float altitudeM, float slope, float latitude) {
    float sand = (1.0 - smoothstep(0.0, 650.0, max(altitudeM, 0.0)))
      * (1.0 - smoothstep(0.22, 0.58, slope));
    float scrub = (1.0 - sand) * (1.0 - smoothstep(0.28, 0.72, slope));
    float rock = smoothstep(0.16, 0.55, slope);
    float snow = max(
      smoothstep(3500.0, 6500.0, altitudeM),
      smoothstep(0.78, 0.98, latitude) * smoothstep(500.0, 2500.0, altitudeM)
    );
    vec3 sandColor = vec3(0.62, 0.48, 0.30);
    vec3 scrubColor = vec3(0.22, 0.34, 0.16);
    vec3 rockColor = vec3(0.34, 0.34, 0.31);
    vec3 snowColor = vec3(0.82, 0.84, 0.82);
    vec3 color = mix(sandColor, scrubColor, clamp(scrub, 0.0, 1.0));
    color = mix(color, rockColor, clamp(rock, 0.0, 1.0));
    return mix(color, snowColor, clamp(snow, 0.0, 1.0));
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec3 radial = normalize(vRadial);
    vec3 n = normalize(vWorldNormal);
    float altitudeM = length(vRadial) - surfaceRadius;
    float latitude = abs(radial.y);
    float slope = 1.0 - clamp(dot(n, radial), 0.0, 1.0);
    vec2 uv = sphericalUv(radial);
    uv.x = fract(uv.x);
    #ifdef LIBRARY_LIGHTING
    uv = earthMapUv(uv);
    #endif

    // The 4k day map supplies regional colour and coast/detail cues; the
    // procedural palette keeps the terrain legible where the map is dark or
    // minified, without making an imagery dependency for the DEM.
    vec3 albedo = texture2D(dayMap, uv).rgb;
    #ifdef LIBRARY_LIGHTING
    albedo = earthSurfaceAlbedo(albedo);
    #endif
    vec3 regional = proceduralTerrainColor(altitudeM, slope, latitude);
    vec3 surface = regional * mix(vec3(0.72), albedo * 1.18, 0.62);

    #ifdef LIBRARY_LIGHTING
    #ifdef TERRAIN_SURFACE_DETAIL
    vec3 detailAlbedo = terrainSurfaceAlbedo(albedo, vRadial * terrainSurfaceMetersPerUnit, n, vTerrainLocalM);
    #endif
    // Share the globe's linear imagery albedo across the LOD transition. The
    // legacy elevation palette paints every low, flat region sand-colored.
    // One opaque surface owns both materials and depth, including shorelines.
    // A second water draw would compete with sea-level terrain at equal depth.
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
    return;
    #endif
    float ndotl = dot(n, sunDir);
    float cloudShadowUv = cloudCoverageAt(
      cloudMap,
      sphericalUv(rotateY(radial, -cloudRotationOffset)),
      ${CLOUD_DECK_DETAIL_SCALE.toFixed(2)},
      ${CLOUD_DECK_DETAIL_STRENGTH.toFixed(2)},
      ${CLOUD_DECK_CONTRAST.toFixed(2)}
    );
    float sunVisibility = 1.0 - cloudShadowUv * ${CLOUD_SHADOW_STRENGTH.toFixed(2)}
      * smoothstep(-0.05, 0.25, ndotl);
    vec3 lit = surface * skyLightingAmount(ndotl) * skySunTint(ndotl);
    lit *= mix(1.0, sunVisibility, max(ndotl, 0.0));

    vec3 transmittance = skyTransmittanceRatio(
      transmittanceLut,
      cameraPosition,
      vWorldPos,
      planetCenter,
      surfaceRadius,
      atmosphereRadius
    );
    // AERIAL_SKY_RADIANCE is the zenith-sky radiance this haze saturates
    // toward as the path thickens (see its doc comment in skyConfig.ts) —
    // deliberately NOT scaled by the ground/space exposure curve, which
    // exists for the atmosphere shell's own raymarch integral (a genuinely
    // tiny physically-normalized quantity needing a large display boost),
    // a different formula this one was mistakenly multiplied by, pushing an
    // already-bounded max-0.33 term to ~4x its ceiling near the ground and
    // clipping the whole surface to white.
    vec3 aerial = AERIAL_SKY_RADIANCE * (vec3(1.0) - transmittance);
    vec3 color = lit * transmittance + aerial;
    gl_FragColor = vec4(color, terrainOpacity);
  }
`;

export function createTerrainPatchMaterial(
  textures: TerrainShaderTextures,
  options: TerrainShaderOptions,
): ShaderMaterial {
  const LIBRARY_RENDERER = options.libraryRenderer ?? DEFAULT_LIBRARY_RENDERER;
  return new ShaderMaterial({
    defines: LIBRARY_RENDERER ? { LIBRARY_LIGHTING: 1, ...(textures.specMap ? { TERRAIN_WATER_MAP: 1 } : {}) } : {},
    vertexShader: TERRAIN_VERTEX_SHADER,
    fragmentShader: TERRAIN_FRAGMENT_SHADER,
    uniforms: {
      dayMap: { value: textures.dayMap },
      specMap: { value: textures.specMap ?? null },
      cloudMap: { value: textures.cloudMap },
      transmittanceLut: { value: textures.transmittanceLut },
      sunDir: { value: SUN_DIR },
      planetCenter: { value: new Vector3(...options.planetCenter) },
      surfaceRadius: { value: options.surfaceRadius },
      atmosphereRadius: { value: options.atmosphereRadius },
      terrainOpacity: { value: 0 },
      cloudRotationOffset: { value: 0 },
    },
    transparent: !LIBRARY_RENDERER,
    blending: NormalBlending,
    depthTest: true,
    depthWrite: true,
    toneMapped: true,
  });
}

export const WATER_VERTEX_SHADER = /* glsl */ `
  uniform vec3 planetCenter;
  attribute float waterMask;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying float vWaterMask;
  #include <common>
  #include <logdepthbuf_pars_vertex>
  void main() {
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vWaterMask = waterMask;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }
`;

export const WATER_FRAGMENT_SHADER = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform vec3 planetCenter;
  uniform vec3 sunDir;
  uniform float terrainOpacity;
  uniform float oceanTime;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying float vWaterMask;
  const float PI = 3.14159265359;
${SKY_LIGHTING_GLSL}

  vec2 sphericalUv(vec3 direction) {
    return vec2(atan(direction.z, -direction.x) / (2.0 * PI),
      0.5 + asin(clamp(direction.y, -1.0, 1.0)) / PI);
  }

  vec3 oceanWaveNormal(vec3 geometricNormal, vec2 uv, float time, float waveFade) {
    vec3 tangent = normalize(vec3(geometricNormal.z, 0.0, -geometricNormal.x));
    vec3 bitangent = normalize(cross(geometricNormal, tangent));
    float waveA = sin(dot(uv, vec2(92.0, 31.0)) + time * 0.72) * waveFade;
    float waveB = sin(dot(uv, vec2(-47.0, 113.0)) - time * 1.11) * waveFade;
    return normalize(geometricNormal + tangent * (waveA * 0.075 + waveB * 0.035)
      + bitangent * (waveA * 0.025 - waveB * 0.065));
  }

  void main() {
    #include <logdepthbuf_fragment>
    if (vWaterMask < 0.5) discard;
    #ifdef LIBRARY_LIGHTING
    // Only semantic waterMask survivors carry opaque water material metadata.
    gl_FragColor = vec4(0.015, 0.04, 0.07, 0.5);
    return;
    #endif
    vec3 radial = normalize(vWorldPos - planetCenter);
    vec3 n = normalize(vWorldNormal);
    vec2 uv = sphericalUv(radial);
    uv.x = fract(uv.x);
    float footprint = max(fwidth(dot(uv, vec2(92.0, 31.0))), fwidth(dot(uv, vec2(-47.0, 113.0))));
    float waveFade = clamp(1.0 - 0.6 * footprint, 0.0, 1.0);
    waveFade *= 1.0 - smoothstep(${OCEAN_WAVE_FADE_START.toFixed(1)}, ${OCEAN_WAVE_FADE_END.toFixed(1)}, distance(cameraPosition, vWorldPos));
    vec3 waterNormal = oceanWaveNormal(n, uv, oceanTime, waveFade);
    float ndotl = dot(n, sunDir);
    vec3 viewDirection = normalize(cameraPosition - vWorldPos);
    vec3 halfDirection = normalize(sunDir + viewDirection);
    float specular = pow(max(dot(waterNormal, halfDirection), 0.0), 120.0);
    vec3 base = vec3(0.015, 0.12, 0.32) * (0.35 + 0.65 * skyLightingAmount(ndotl));
    vec3 color = base + vec3(0.24, 0.55, 1.0) * specular * max(ndotl, 0.0);
    gl_FragColor = vec4(color, terrainOpacity * (0.86 + 0.14 * skyLightingAmount(ndotl)));
  }
`;

export function createWaterMaterial(options: TerrainShaderOptions): ShaderMaterial {
  const LIBRARY_RENDERER = options.libraryRenderer ?? DEFAULT_LIBRARY_RENDERER;
  return new ShaderMaterial({
    defines: LIBRARY_RENDERER ? { LIBRARY_LIGHTING: 1 } : {},
    vertexShader: WATER_VERTEX_SHADER,
    fragmentShader: WATER_FRAGMENT_SHADER,
    uniforms: {
      planetCenter: { value: new Vector3(...options.planetCenter) },
      sunDir: { value: SUN_DIR },
      terrainOpacity: { value: 0 },
      oceanTime: { value: 0 },
    },
    transparent: !LIBRARY_RENDERER,
    blending: NormalBlending,
    depthTest: true,
    depthWrite: LIBRARY_RENDERER,
    toneMapped: true,
  });
}
