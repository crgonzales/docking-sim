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
  readonly cloudMap: Texture;
  readonly transmittanceLut: Texture;
}

export interface TerrainShaderOptions {
  readonly planetCenter: readonly [number, number, number];
  readonly surfaceRadius: number;
  readonly atmosphereRadius: number;
}

export const TERRAIN_VERTEX_SHADER = /* glsl */ `
  uniform vec3 planetCenter;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec3 vRadial;
  // Vertex-side logarithmic depth (see Earth.tsx note): no fragment depth
  // writes, early-Z preserved.
  uniform float logDepthBufFC;
  void main() {
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vRadial = wp.xyz - planetCenter;
    gl_Position = projectionMatrix * viewMatrix * wp;
    gl_Position.z = (log2(max(1e-6, 1.0 + gl_Position.w)) * logDepthBufFC - 1.0) * gl_Position.w;
  }
`;

export const TERRAIN_FRAGMENT_SHADER = /* glsl */ `
  #define AERIAL_SKY_RADIANCE vec3(${AERIAL_SKY_RADIANCE.map((value) => value.toFixed(2)).join(', ')})
  uniform sampler2D dayMap;
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

  const float PI = 3.14159265359;

${CLOUD_COVERAGE_GLSL}
${SKY_LIGHTING_GLSL}

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
    vec3 radial = normalize(vRadial);
    vec3 n = normalize(vWorldNormal);
    float altitudeM = length(vRadial) - surfaceRadius;
    float latitude = abs(radial.y);
    float slope = 1.0 - clamp(dot(n, radial), 0.0, 1.0);
    vec2 uv = sphericalUv(radial);
    uv.x = fract(uv.x);

    // The 4k day map supplies regional colour and coast/detail cues; the
    // procedural palette keeps the terrain legible where the map is dark or
    // minified, without making an imagery dependency for the DEM.
    vec3 albedo = texture2D(dayMap, uv).rgb;
    vec3 regional = proceduralTerrainColor(altitudeM, slope, latitude);
    vec3 surface = regional * mix(vec3(0.72), albedo * 1.18, 0.62);

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
  return new ShaderMaterial({
    vertexShader: TERRAIN_VERTEX_SHADER,
    fragmentShader: TERRAIN_FRAGMENT_SHADER,
    uniforms: {
      dayMap: { value: textures.dayMap },
      cloudMap: { value: textures.cloudMap },
      transmittanceLut: { value: textures.transmittanceLut },
      sunDir: { value: SUN_DIR },
      planetCenter: { value: new Vector3(...options.planetCenter) },
      surfaceRadius: { value: options.surfaceRadius },
      atmosphereRadius: { value: options.atmosphereRadius },
      terrainOpacity: { value: 0 },
      cloudRotationOffset: { value: 0 },
    },
    transparent: true,
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
  uniform float logDepthBufFC;
  void main() {
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vWaterMask = waterMask;
    gl_Position = projectionMatrix * viewMatrix * wp;
    gl_Position.z = (log2(max(1e-6, 1.0 + gl_Position.w)) * logDepthBufFC - 1.0) * gl_Position.w;
  }
`;

export const WATER_FRAGMENT_SHADER = /* glsl */ `
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
    if (vWaterMask < 0.5) discard;
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
  return new ShaderMaterial({
    vertexShader: WATER_VERTEX_SHADER,
    fragmentShader: WATER_FRAGMENT_SHADER,
    uniforms: {
      planetCenter: { value: new Vector3(...options.planetCenter) },
      sunDir: { value: SUN_DIR },
      terrainOpacity: { value: 0 },
      oceanTime: { value: 0 },
    },
    transparent: true,
    blending: NormalBlending,
    depthTest: true,
    depthWrite: false,
    toneMapped: true,
  });
}
