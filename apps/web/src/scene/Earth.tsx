import { useCallback, useMemo } from 'react';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import {
  AdditiveBlending,
  BackSide,
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  FileLoader,
  FloatType,
  HalfFloatType,
  LinearFilter,
  NoColorSpace,
  RGBAFormat,
  ShaderMaterial,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  Loader,
  type TextureDataType,
  type WebGLRenderer,
} from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { Clouds } from './Clouds';
import {
  CLOUD_COVERAGE_GLSL,
  CLOUD_DECK_CONTRAST,
  CLOUD_DECK_DETAIL_SCALE,
  CLOUD_DECK_DETAIL_STRENGTH,
} from './sky/cloudCoverage';
import {
  ATMOSPHERE_RADIUS_MULTIPLIER,
  ATMOSPHERE_MULTIPLE_SCATTERING_LUT_PATH,
  ATMOSPHERE_TRANSMITTANCE_LUT_PATH,
  CLOUD_COVERAGE_MASK_PATH,
  CLOUD_SHADOW_STRENGTH,
  EARTH_CENTER_DISTANCE,
  EARTH_RADIUS_M,
  EARTH_VIEW_SCALE,
  NIGHT_EMISSIVE_GAIN,
  OCEAN_TINT_STRENGTH,
  OCEAN_WAVE_FADE_END,
  OCEAN_WAVE_FADE_START,
  SKY_CONFIG,
  SHADOW_ANGULAR_OFFSET_RAD,
  SHADOW_FULL_LIGHT_COSINE,
  SPEC_GAIN,
  AERIAL_SKY_RADIANCE,
  ATMOSPHERE_INTENSITY,
} from './sky/skyConfig';
import { SKY_LIGHTING_GLSL } from './sky/lighting';
import { VolumetricClouds } from './VolumetricClouds';
export {
  computeCloudShadowUv,
  deriveRayleighCoefficients,
  henyeyGreensteinPhase,
  rayleighPhase,
} from './EarthMath';
import { SUN_DIR } from './sun';

/**
 * Earth with day/night, main-deck cloud shadows, and analytic atmosphere.
 *
 * Scale handling: the render scene is the Hill frame in meters, but Earth at
 * its true distance (~6.771e6 m) destroys float/depth precision. The whole
 * Earth group is therefore divided by EARTH_VIEW_SCALE — distance and radius
 * equally — which preserves angular size exactly. Combined with the canvas's
 * logarithmic depth buffer this keeps both the meter-scale craft and the
 * planet stable in one scene.
 */
/** LEO orbit radius for the target (≈400 km altitude). */
export const ORBIT_RADIUS_M = EARTH_CENTER_DISTANCE * EARTH_VIEW_SCALE;

/**
 * R3F memoizes loaders by constructor for the lifetime of the page. Keeping
 * KTX2Loader behind useLoader therefore gives the transcoder one shared,
 * page-lifetime instance. It is intentionally never disposed here: ANALYSIS
 * unmounts Canvas and SANDBOX can mount it again later.
 */
const KTX2_TRANSCODER_PATH = '/';
const TRANSMITTANCE_LUT_WIDTH = 256;
const TRANSMITTANCE_LUT_HEIGHT = 64;
const MULTIPLE_SCATTERING_LUT_WIDTH = 32;
const MULTIPLE_SCATTERING_LUT_HEIGHT = 32;

class AtmosphereLutLoader extends Loader<DataTexture> {
  private textureType: TextureDataType = FloatType;

  setTextureType(textureType: TextureDataType): void {
    this.textureType = textureType;
  }

  load(
    url: string,
    onLoad: (texture: DataTexture) => void,
    onProgress?: (event: ProgressEvent<EventTarget>) => void,
    onError?: (event: unknown) => void,
  ): void {
    const isTransmittance = url.endsWith('transmittance.bin');
    const width = isTransmittance ? TRANSMITTANCE_LUT_WIDTH : MULTIPLE_SCATTERING_LUT_WIDTH;
    const height = isTransmittance ? TRANSMITTANCE_LUT_HEIGHT : MULTIPLE_SCATTERING_LUT_HEIGHT;
    const fileLoader = new FileLoader(this.manager).setResponseType('arraybuffer');
    fileLoader.load(url, (buffer) => {
      const floatData = new Float32Array(buffer as ArrayBuffer);
      // The bake stores tightly-packed RGB, but RGB float formats are not
      // filterable in WebGL2 — with LinearFilter the texture goes incomplete
      // and every sample silently reads vec4(0). Pad to RGBA (alpha 1) so the
      // GPU sees RGBA32F/RGBA16F, the filterable float formats.
      const texelCount = width * height;
      const rgbaData = new Float32Array(texelCount * 4);
      for (let index = 0; index < texelCount; index += 1) {
        rgbaData[index * 4] = floatData[index * 3]!;
        rgbaData[index * 4 + 1] = floatData[index * 3 + 1]!;
        rgbaData[index * 4 + 2] = floatData[index * 3 + 2]!;
        rgbaData[index * 4 + 3] = 1;
      }
      // DataUtils handles subnormals; a naive log2-based converter turned the
      // LUT's 1e-6 transmittance floor into sign-set garbage.
      const data = this.textureType === HalfFloatType
        ? Uint16Array.from(rgbaData, (value) => DataUtils.toHalfFloat(Math.min(value, 65504)))
        : rgbaData;
      const texture = new DataTexture(data, width, height, RGBAFormat, this.textureType);
      texture.colorSpace = NoColorSpace;
      texture.minFilter = LinearFilter;
      texture.magFilter = LinearFilter;
      texture.wrapS = ClampToEdgeWrapping;
      texture.wrapT = ClampToEdgeWrapping;
      texture.unpackAlignment = 1;
      texture.needsUpdate = true;
      onLoad(texture);
    }, onProgress, onError);
  }
}

const earthVertex = /* glsl */ `
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const earthFragment = /* glsl */ `
  #define AERIAL_SKY_RADIANCE vec3(${AERIAL_SKY_RADIANCE.map((c) => c.toFixed(2)).join(', ')})
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform sampler2D specMap;
  uniform sampler2D normalMap;
  uniform sampler2D cloudMap;
  uniform sampler2D atmosphereTransmittanceLut;
  uniform sampler2D atmosphereMultipleScatteringLut;
  uniform vec3 sunDir;
  uniform vec3 planetCenter;
  uniform float nightGain;
  uniform float specGain;
  uniform float cloudRotationOffset;
  uniform float shadowAngularOffset;
  uniform float surfaceRadius;
  uniform float atmosphereRadius;
  uniform float oceanTime;
  // How far the ocean is pushed toward scattered blue (0 = raw albedo).
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec2 vUv;

  const float PI = 3.14159265359;

  vec3 rotateY(vec3 point, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return vec3(c * point.x + s * point.z, point.y, -s * point.x + c * point.z);
  }

${CLOUD_COVERAGE_GLSL}
${SKY_LIGHTING_GLSL}

  vec2 atmosphereLutUv(vec3 point, vec3 direction) {
    vec3 radial = point - planetCenter;
    float altitude = clamp(length(radial) - surfaceRadius, 0.0, atmosphereRadius - surfaceRadius);
    float altitudeUv = altitude / max(atmosphereRadius - surfaceRadius, 0.0001);
    float mu = dot(normalize(radial), normalize(direction));
    return vec2(mu * 0.5 + 0.5, altitudeUv);
  }

  // Match SphereGeometry's equirectangular UV convention (+x maps to u=0.5;
  // the old +0.5 offset put shadows and volumetrics 180 deg from the deck).
  // Callers fract() the result to wrap the seam.
  vec2 sphericalUv(vec3 point) {
    return vec2(atan(point.z, -point.x) / (2.0 * PI),
      0.5 + asin(clamp(point.y, -1.0, 1.0)) / PI);
  }

  vec3 tangentSpaceNormal(vec3 geometricNormal, vec3 encodedNormal) {
    vec3 tangent = normalize(vec3(geometricNormal.z, 0.0, -geometricNormal.x));
    vec3 bitangent = normalize(cross(geometricNormal, tangent));
    return normalize(tangent * encodedNormal.x + bitangent * encodedNormal.y
      + geometricNormal * encodedNormal.z);
  }

  // waveFade is the pixel-footprint attenuation computed in main(): once a
  // wave cycle spans only a few fragments the sines are temporal noise, not
  // detail — they must dissolve before they can shimmer at far zoom.
  vec3 oceanWaveNormal(vec3 geometricNormal, vec2 uv, float time, float waveFade) {
    vec3 tangent = normalize(vec3(geometricNormal.z, 0.0, -geometricNormal.x));
    vec3 bitangent = normalize(cross(geometricNormal, tangent));
    float waveA = sin(dot(uv, vec2(92.0, 31.0)) + time * 0.72) * waveFade;
    float waveB = sin(dot(uv, vec2(-47.0, 113.0)) - time * 1.11) * waveFade;
    return normalize(geometricNormal + tangent * (waveA * 0.075 + waveB * 0.035)
      + bitangent * (waveA * 0.025 - waveB * 0.065));
  }

  void main() {
    vec3 n = normalize(vWorldNormal);
    float ndotl = dot(n, sunDir);
    float dayness = skyTerminatorRamp(ndotl);
    float waterMask = texture2D(specMap, vUv).r;
    vec3 encodedRelief = texture2D(normalMap, vUv).xyz * 2.0 - 1.0;
    vec3 terrainNormal = tangentSpaceNormal(n, encodedRelief);
    float wavePhaseFootprint = max(
      fwidth(dot(vUv, vec2(92.0, 31.0))),
      fwidth(dot(vUv, vec2(-47.0, 113.0))));
    float waveFade = clamp(1.0 - 0.6 * wavePhaseFootprint, 0.0, 1.0);
    // The wave pattern stays resolvable from any distance (its wavelength is
    // continental), so the footprint fade alone never retires it — the range
    // fade does, per the rationale on OCEAN_WAVE_FADE_* in skyConfig.
    waveFade *= 1.0 - smoothstep(
      ${OCEAN_WAVE_FADE_START.toFixed(1)},
      ${OCEAN_WAVE_FADE_END.toFixed(1)},
      distance(cameraPosition, vWorldPos));
    vec3 waterNormal = oceanWaveNormal(n, vUv, oceanTime, waveFade);
    vec3 lightingNormal = mix(waterNormal, terrainNormal, 1.0 - waterMask);

    // Relief only enters direct day lighting and glint. The shared terminator
    // remains pinned to the geometric sphere normal above.
    float reliefNdotl = max(dot(lightingNormal, sunDir), 0.0);
    vec3 day = texture2D(dayMap, vUv).rgb * reliefNdotl * skySunTint(ndotl);  // mutated by ocean tint below
    // City lights are pointlike and high-contrast: even correctly-filtered
    // they flicker between mip texels under sub-pixel drift when minified.
    // Bias the lookup by half the minification level — no-op at native
    // resolution, progressively softer as the disc shrinks.
    float nightFootprintTexels = length(fwidth(vUv)) * 2048.0;
    float nightMipBias = clamp(0.5 * log2(max(nightFootprintTexels, 1.0)), 0.0, 2.0);
    vec3 night = texture2D(nightMap, vUv, nightMipBias).rgb * nightGain * (1.0 - dayness);

    // The cloud sample is only used to attenuate direct solar terms. A point
    // is shadowed by the cloud point along +sunDir (sunDir points surface->sun);
    // the offset grows toward the terminator as incidence falls. The inverse
    // deck rotation converts the world-space blocker point to cloud UV space.
    float sunVisibility = 1.0;
    if (ndotl > 0.0) {
      vec3 sunTangent = normalize(sunDir - n * ndotl);
      float angularOffset = shadowAngularOffset /
        max(max(ndotl, 0.08), 0.0001);
      vec3 cloudPoint = normalize(n + sunTangent * angularOffset);
      vec2 cloudUv = sphericalUv(rotateY(cloudPoint, -cloudRotationOffset));
      cloudUv.x = fract(cloudUv.x);
      cloudUv.y = clamp(cloudUv.y, 0.001, 0.999);
      // IDENTICAL function and parameters to the visible deck (cloudCoverage.ts).
      // Previously this sampled the raw map through its own smoothstep, so the
      // shadow was a different shape from the cloud casting it.
      float cloudAlpha = cloudCoverageAt(
        cloudMap, cloudUv,
        ${CLOUD_DECK_DETAIL_SCALE.toFixed(3)},
        ${CLOUD_DECK_DETAIL_STRENGTH.toFixed(3)},
        ${CLOUD_DECK_CONTRAST.toFixed(3)}
      );
      float shadowStrength = clamp(ndotl / ${SHADOW_FULL_LIGHT_COSINE.toFixed(2)}, 0.0, 1.0);
      sunVisibility = 1.0 - ${CLOUD_SHADOW_STRENGTH.toFixed(2)} * cloudAlpha * shadowStrength;
    }

    // Sun glint uses the linear data mask; it is not a colour texture.
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    vec3 halfDir = normalize(sunDir + viewDir);
    float glint = pow(max(dot(lightingNormal, halfDir), 0.0), 80.0) * waterMask * specGain * dayness;

    // Ocean tint. Blue Marble's raw ocean is a dark desaturated slate — the
    // vivid blue of real orbital imagery comes from Rayleigh scattering through
    // the air column above the water, which a surface albedo texture cannot
    // contain. Reintroduce it on water only, using the same mask that drives
    // glint, so land keeps its true albedo.
    vec3 oceanTint = vec3(0.06, 0.26, 0.62);
    float oceanLum = dot(day, vec3(0.299, 0.587, 0.114));
    // The 0.35 floor is gated by ndotl: ungated it kept near-terminator ocean
    // glowing faint blue while adjacent land went dark — an unnatural bright
    // band on the dusk side. Scattering needs sunlight to scatter.
    vec3 water = mix(day, oceanTint * (0.35 * clamp(ndotl, 0.0, 1.0) + 1.5 * oceanLum), ${OCEAN_TINT_STRENGTH.toFixed(2)});
    day = mix(day, water, waterMask);
    float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
    vec3 oceanRim = vec3(0.05, 0.22, 0.72) * fresnel * waterMask * dayness;
    // The twinkle pulse rides on the wave footprint fade: from far away the
    // whole glint field would otherwise throb in sync — visible as shimmer.
    float oceanGlint = pow(max(dot(waterNormal, halfDir), 0.0), 180.0)
      * waterMask * specGain * dayness
      * mix(1.0, 0.75 + 0.25 * sin(oceanTime * 1.7), waveFade);

    // Physical camera-to-ground transmission and in-scatter. This deliberately
    // does not use the shared artistic terminator ramp: near-nadir stays clear,
    // while a long limb path naturally blue-shifts toward the atmosphere.
    vec3 groundViewDirection = normalize(cameraPosition - vWorldPos);
    vec3 groundTransmittance = texture2D(
      atmosphereTransmittanceLut,
      atmosphereLutUv(vWorldPos, groundViewDirection)
    ).rgb;
    vec3 groundMultipleScatter = texture2D(
      atmosphereMultipleScatteringLut,
      vec2(dot(n, sunDir) * 0.5 + 0.5, 0.0)
    ).rgb;
    // (1 - T) is the OPACITY of the air column; the light it contributes is
    // that opacity times the sky's own radiance — a dim blue. Multiplying by
    // anything that saturates to white was the dayside washout (twice).
    //
    // thickPath closes the seam against the atmosphere shell: pixels just
    // inside the silhouette look through a near-tangent air column and must
    // approach the shell's tone-mapped peak (~0.93), or the limb shows a
    // 1-px luminance jump that aliases into a sawtooth. pow5 confines the
    // boost to grazing paths — at nadir (1-T ~ 0.15) it contributes ~1e-4.
    // Blue is the most-scattered channel, making (1 - T.b) the cleanest
    // path-length proxy; a mean over RGB is dragged down by red's easy
    // transmission and leaves the red channel stepping at the silhouette.
    float groundOpacity = 1.0 - groundTransmittance.b;
    vec3 thickPath = vec3(0.90) * pow(clamp(groundOpacity, 0.0, 1.0), 4.0);
    // thickPath keeps a doubled low-angle response: the adjacent shell
    // integrates a partially-lit tangent path, so a linear ndotl gate makes
    // the interior die faster than the band beside it and re-opens the seam
    // near the terminator.
    vec3 aerialInScatter = (
      AERIAL_SKY_RADIANCE * (vec3(1.0) - groundTransmittance)
      + groundMultipleScatter * 0.15
    ) * max(ndotl, 0.0)
      + thickPath * clamp(ndotl * 2.0, 0.0, 1.0);
    day = day * groundTransmittance;

    vec3 color = day * dayness * sunVisibility
      + aerialInScatter * sunVisibility
      + night + oceanRim + vec3((glint + oceanGlint) * sunVisibility);
    gl_FragColor = vec4(color, 1.0);
  }
`;

const atmoVertex = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const atmoFragment = /* glsl */ `
  #define ATMOSPHERE_INTENSITY ${ATMOSPHERE_INTENSITY.toFixed(1)}
  uniform vec3 sunDir;
  uniform vec3 planetCenter;
  uniform sampler2D transmittanceLut;
  uniform sampler2D multipleScatteringLut;
  uniform vec3 rayleighScattering;
  uniform float mieScattering;
  uniform float mieAnisotropy;
  uniform float rayleighScaleHeight;
  uniform float mieScaleHeight;
  uniform vec3 ozoneAbsorption;
  uniform float ozoneCenter;
  uniform float ozoneHalfWidth;
  uniform float surfaceRadius;
  uniform float atmosphereRadius;
  varying vec3 vWorldPos;

  const float PI = 3.14159265359;

  float rayleighDensity(float altitude) {
    return exp(-max(altitude, 0.0) / rayleighScaleHeight);
  }

  float mieDensity(float altitude) {
    return exp(-max(altitude, 0.0) / mieScaleHeight);
  }

  float ozoneDensity(float altitude) {
    return clamp(1.0 - abs(altitude - ozoneCenter) / ozoneHalfWidth, 0.0, 1.0);
  }

  vec2 atmosphereLutUv(vec3 point, vec3 direction) {
    vec3 radial = point - planetCenter;
    float altitude = clamp(length(radial) - surfaceRadius, 0.0, atmosphereRadius - surfaceRadius);
    float altitudeUv = altitude / max(atmosphereRadius - surfaceRadius, 0.0001);
    float mu = dot(normalize(radial), normalize(direction));
    return vec2(mu * 0.5 + 0.5, altitudeUv);
  }

  vec3 sampleTransmittance(vec3 point, vec3 direction) {
    // The LUT stores T = exp(-tau); this path only samples and multiplies T.
    return texture2D(transmittanceLut, atmosphereLutUv(point, direction)).rgb;
  }

  vec3 sampleMultipleScattering(vec3 point, vec3 direction) {
    return texture2D(multipleScatteringLut, atmosphereLutUv(point, direction)).rgb;
  }

  float rayleighPhase(float cosTheta) {
    return 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta);
  }

  float miePhase(float cosTheta) {
    float g = mieAnisotropy;
    float denominator = max(1.0 + g * g - 2.0 * g * cosTheta, 0.001);
    return (1.0 - g * g) / (4.0 * PI * pow(denominator, 1.5));
  }

  void main() {
    vec3 cameraToCenter = planetCenter - cameraPosition;
    vec3 ray = normalize(vWorldPos - cameraPosition);
    float closestDistance = dot(cameraToCenter, ray);
    vec3 closestPoint = cameraPosition + ray * closestDistance;
    float impact = length(closestPoint - planetCenter);
    // Rays that strike the planet only ever reach the framebuffer at MSAA
    // silhouette samples — everywhere else the surface depth-rejects them.
    // Integrating their (occluded) far-side segment gave those samples
    // near-zero in-scatter and cut dark ticks into the limb band, so clamp
    // planet-hitting rays to the tangent path: edge samples then match the
    // band immediately beside them.
    float chordImpact = max(impact, surfaceRadius);
    float outerHalfChord = sqrt(max(atmosphereRadius * atmosphereRadius - chordImpact * chordImpact, 0.0));
    float startDistance = closestDistance - outerHalfChord;
    float endDistance = closestDistance + outerHalfChord;
    float segmentLength = max(endDistance - startDistance, 0.0);
    float stepLength = segmentLength / 12.0;
    vec3 scattered = vec3(0.0);
    vec3 viewDirection = normalize(cameraPosition - vWorldPos);
    float lightTravelCos = dot(-sunDir, viewDirection);

    for (int index = 0; index < 12; index += 1) {
      float sampleDistance = startDistance + (float(index) + 0.5) * stepLength;
      vec3 samplePoint = cameraPosition + ray * sampleDistance;
      vec3 sampleRadial = samplePoint - planetCenter;
      float altitude = max(length(sampleRadial) - surfaceRadius, 0.0);
      float rayleighTerm = rayleighDensity(altitude);
      float mieTerm = mieDensity(altitude);
      vec3 sunTransmittance = sampleTransmittance(samplePoint, sunDir);
      vec3 viewTransmittance = sampleTransmittance(samplePoint, -ray);
      vec3 multipleScatter = sampleMultipleScattering(samplePoint, sunDir);
      vec3 directScatter = rayleighScattering * rayleighTerm * rayleighPhase(lightTravelCos)
        + vec3(mieScattering * mieTerm * miePhase(lightTravelCos));
      vec3 source = directScatter * sunTransmittance * viewTransmittance;
      // The LUT carries the integrated ozone column; this local tent keeps the
      // shell's emission profile tied to the same 25 +/- 15 km absorber.
      vec3 ozoneLocalTransmittance = exp(-ozoneAbsorption
        * ozoneDensity(altitude) * stepLength * 1000.0);
      source *= ozoneLocalTransmittance;
      // Psi_ms is baked seeded with the sun transmittance at the sample, so it
      // must NOT be re-multiplied by sunTransmittance here (that squares the
      // twilight falloff and hard-clips the limb at the terminator). It is a
      // bounded ambient radiance factor: convert to a source term with the
      // local scattering coefficient and an isotropic phase.
      vec3 ambientCoefficient = (rayleighScattering * rayleighTerm
        + vec3(mieScattering * mieTerm)) / (4.0 * PI);
      source += ambientCoefficient * multipleScatter * viewTransmittance;
      // Coefficients are metres^-1 while the render shell is in kilometres.
      scattered += source * stepLength * 1000.0;
    }

    // Physically-normalized radiance needs a display exposure: without it the
    // limb integrates to ~0.005-0.05 and the atmosphere is invisible.
    scattered *= ATMOSPHERE_INTENSITY;

    // Exponential rolloff instead of a hard clamp: min() plateaued every
    // bright channel at the same value, flattening the dense near-surface
    // band into a clipped white line. 1 - exp(-x) compresses peaks smoothly,
    // keeps the gradient monotonic, and lets the LUT's reddened sun
    // transmittance produce the warm low-band tones — no hardcoded tint.
    vec3 color = vec3(1.0) - exp(-scattered);
    // AdditiveBlending multiplies by srcAlpha. The earlier alpha sampled
    // transmittance AT the fragment — the top of the atmosphere, where T = 1 by
    // construction — so alpha was permanently 0 and the whole shell rendered
    // invisible. scattered already carries every attenuation term; the
    // additive contribution needs alpha 1.
    gl_FragColor = vec4(color, 1.0);
  }
`;

function supportsCompressedEarthTier(renderer: WebGLRenderer) {
  const { capabilities, extensions } = renderer;
  return capabilities.isWebGL2
    && capabilities.maxTextureSize >= 8192
    && (
      extensions.has('EXT_texture_compression_bptc')
      || extensions.has('WEBGL_compressed_texture_s3tc')
      || extensions.has('WEBGL_compressed_texture_astc')
      || extensions.has('WEBGL_compressed_texture_etc')
    );
}

function getEarthDayMapUrl(renderer: WebGLRenderer) {
  return supportsCompressedEarthTier(renderer)
    ? '/assets/textures/earth_day_4k.ktx2'
    : '/assets/textures/earth_day_2k.ktx2';
}

function supportsFloatLinear(renderer: WebGLRenderer): boolean {
  return renderer.extensions.has('OES_texture_float_linear');
}

export function Earth() {
  const { gl: renderer } = useThree();
  const dayMapUrl = useMemo(() => getEarthDayMapUrl(renderer), [renderer]);
  const configureKtx2Loader = useCallback((loader: KTX2Loader) => {
    // useLoader memoizes KTX2Loader by constructor, making this one
    // page-lifetime loader. detectSupport runs before the first request.
    loader.setTranscoderPath(KTX2_TRANSCODER_PATH);
    loader.detectSupport(renderer);
  }, [renderer]);
  const [dayMap, nightMap, specMap, cloudMap, normalMap] = useLoader(
    KTX2Loader,
    [
      dayMapUrl,
      '/assets/textures/earth_night_2k.ktx2',
      '/assets/textures/earth_spec_2k.ktx2',
      '/assets/textures/earth_clouds_4k.ktx2',
      '/assets/textures/earth_normal_4k.ktx2',
    ],
    configureKtx2Loader,
  );
  const configureAtmosphereLutLoader = useCallback((loader: AtmosphereLutLoader) => {
    loader.setTextureType(supportsFloatLinear(renderer) ? FloatType : HalfFloatType);
  }, [renderer]);
  const [transmittanceLut, multipleScatteringLut] = useLoader(
    AtmosphereLutLoader,
    [ATMOSPHERE_TRANSMITTANCE_LUT_PATH, ATMOSPHERE_MULTIPLE_SCATTERING_LUT_PATH],
    configureAtmosphereLutLoader,
  );
  const cloudCoverageMask = useLoader(TextureLoader, CLOUD_COVERAGE_MASK_PATH);

  const anisotropy = renderer.capabilities.getMaxAnisotropy();
  dayMap.colorSpace = SRGBColorSpace;
  nightMap.colorSpace = SRGBColorSpace;
  cloudMap.colorSpace = SRGBColorSpace;
  specMap.colorSpace = NoColorSpace;
  normalMap.colorSpace = NoColorSpace;
  cloudCoverageMask.colorSpace = NoColorSpace;
  dayMap.anisotropy = anisotropy;
  nightMap.anisotropy = anisotropy;
  specMap.anisotropy = anisotropy;
  cloudMap.anisotropy = anisotropy;
  normalMap.anisotropy = anisotropy;

  const radius = EARTH_RADIUS_M / EARTH_VIEW_SCALE;
  const position = useMemo(
    () => new Vector3(-ORBIT_RADIUS_M / EARTH_VIEW_SCALE, 0, 0),
    [],
  );
  const mainDeckRotation = useMemo(() => ({ current: 0 }), []);

  const earthMaterial = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: earthVertex,
        fragmentShader: earthFragment,
        uniforms: {
          dayMap: { value: dayMap },
          nightMap: { value: nightMap },
          specMap: { value: specMap },
          normalMap: { value: normalMap },
          cloudMap: { value: cloudMap },
          atmosphereTransmittanceLut: { value: transmittanceLut },
          atmosphereMultipleScatteringLut: { value: multipleScatteringLut },
          sunDir: { value: SUN_DIR },
          planetCenter: { value: position },
          nightGain: { value: NIGHT_EMISSIVE_GAIN },
          specGain: { value: SPEC_GAIN },
          cloudRotationOffset: { value: mainDeckRotation.current },
          shadowAngularOffset: { value: SHADOW_ANGULAR_OFFSET_RAD },
          surfaceRadius: { value: radius },
          atmosphereRadius: { value: radius * ATMOSPHERE_RADIUS_MULTIPLIER },
          oceanTime: { value: 0 },
        },
      }),
    [cloudMap, dayMap, mainDeckRotation, multipleScatteringLut, nightMap, normalMap, position, radius, specMap, transmittanceLut],
  );

  useFrame((_, delta) => {
    earthMaterial.uniforms.oceanTime!.value += delta;
  });

  const atmoMaterial = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: atmoVertex,
        fragmentShader: atmoFragment,
        uniforms: {
          sunDir: { value: SUN_DIR },
          planetCenter: { value: position },
          transmittanceLut: { value: transmittanceLut },
          multipleScatteringLut: { value: multipleScatteringLut },
          rayleighScattering: { value: new Vector3(...SKY_CONFIG.atmosphere.rayleighScatteringM) },
          mieScattering: { value: SKY_CONFIG.atmosphere.mieScatteringM },
          mieAnisotropy: { value: SKY_CONFIG.atmosphere.mieAnisotropy },
          rayleighScaleHeight: { value: SKY_CONFIG.atmosphere.rayleighScaleHeightKm },
          mieScaleHeight: { value: SKY_CONFIG.atmosphere.mieScaleHeightKm },
          ozoneAbsorption: { value: new Vector3(...SKY_CONFIG.atmosphere.ozoneAbsorptionM) },
          ozoneCenter: { value: SKY_CONFIG.atmosphere.ozoneCenterKm },
          ozoneHalfWidth: { value: SKY_CONFIG.atmosphere.ozoneHalfWidthKm },
          surfaceRadius: { value: radius },
          atmosphereRadius: { value: radius * ATMOSPHERE_RADIUS_MULTIPLIER },
        },
        blending: AdditiveBlending,
        side: BackSide,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    [multipleScatteringLut, position, radius, transmittanceLut],
  );

  return (
    <group position={position}>
      <mesh material={earthMaterial} renderOrder={0}>
        <sphereGeometry args={[radius, 192, 192]} />
      </mesh>
      <Clouds
        cloudMap={cloudMap}
        mainDeckRotation={mainDeckRotation}
        surfaceMaterial={earthMaterial}
        radius={radius}
      />
      <VolumetricClouds
        cloudMap={cloudMap}
        cloudCoverageMask={cloudCoverageMask}
        mainDeckRotation={mainDeckRotation}
        earthCenter={position}
        radius={radius}
      />
      <mesh
        material={atmoMaterial}
        scale={ATMOSPHERE_RADIUS_MULTIPLIER}
        renderOrder={3}
      >
        <sphereGeometry args={[radius, 192, 192]} />
      </mesh>
    </group>
  );
}
