import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  Group,
  DoubleSide,
  FrontSide,
  NormalBlending,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector3,
} from 'three';
import {
  CLOUD_COVERAGE_GLSL,
  CLOUD_DECK_CONTRAST,
  CLOUD_DECK_DETAIL_SCALE,
  CLOUD_DECK_DETAIL_STRENGTH,
} from './sky/cloudCoverage';
import {
  CIRRUS_DRIFT_RAD_PER_SEC,
  CIRRUS_RADIUS_MULTIPLIER,
  CLOUD_CIRRUS_CONTRAST,
  CLOUD_CIRRUS_DETAIL_SCALE,
  CLOUD_CIRRUS_DETAIL_STRENGTH,
  CLOUD_CIRRUS_OPACITY,
  CLOUD_CIRRUS_UV_OFFSET,
  CLOUD_DECK_UV_OFFSET,
  CLOUD_DECK_OPACITY,
  CLOUD_DRIFT_RAD_PER_SEC,
  CLOUD_THROUGH_LAYER_FOG_END,
  CLOUD_THROUGH_LAYER_FOG_START,
  DECK_RADIUS_MULTIPLIER,
} from './sky/skyConfig';
import { SKY_LIGHTING_GLSL } from './sky/lighting';
import { SUN_DIR } from './sun';
import { WorldFrame, type WorldPositionF64 } from './worldFrame';

const CLOUD_VERTEX = /* glsl */ `
  uniform sampler2D cloudMap;
  uniform vec2 uvOffset;
  uniform float detailScale;
  uniform float detailStrength;
  uniform float contrast;
  uniform vec3 earthCenter;
  uniform float layerRadius;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec2 vUv;
  varying float vThroughLayerFog;
  // Preserve geometric clipping; use the same fragment depth as built-in materials.
  #include <common>
  #include <logdepthbuf_pars_vertex>

${CLOUD_COVERAGE_GLSL}

  vec2 sphericalUv(vec3 point) {
    return vec2(atan(point.z, -point.x) / (2.0 * PI),
      0.5 + asin(clamp(point.y, -1.0, 1.0)) / PI);
  }

  void main() {
    vUv = uv;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    // throughLayerFog depends only on camera/material uniforms, never on
    // per-vertex position, so it is identical for every vertex this frame —
    // computing it here (a few hundred invocations) instead of per-fragment
    // (millions, across two full-sphere transparent shells) is the same
    // math, just far less of it.
    vec3 cameraRadial = normalize(cameraPosition - earthCenter);
    vec2 cameraUv = sphericalUv(cameraRadial) + uvOffset;
    cameraUv.x = fract(cameraUv.x);
    float cameraCoverage = cloudCoverageAt(cloudMap, cameraUv, detailScale, detailStrength, contrast);
    float cameraLayerDistance = abs(length(cameraPosition - earthCenter) - layerRadius);
    vThroughLayerFog = cameraCoverage * (1.0 - smoothstep(
      ${CLOUD_THROUGH_LAYER_FOG_START.toFixed(1)},
      ${CLOUD_THROUGH_LAYER_FOG_END.toFixed(1)},
      cameraLayerDistance));
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }
`;

const CLOUD_FRAGMENT = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D cloudMap;
  uniform vec3 sunDir;
  uniform float opacity;
  uniform float detailScale;
  uniform float detailStrength;
  uniform vec2 uvOffset;
  uniform float contrast;
  uniform float cirrusBand;
  uniform float surfaceRadius;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec2 vUv;
  varying float vThroughLayerFog;

${CLOUD_COVERAGE_GLSL}
${SKY_LIGHTING_GLSL}

  void main() {
    #include <logdepthbuf_fragment>
    // The lookup is deliberately camera-independent. A view-driven parallax
    // offset used to live here to fake thickness at the limb; it made the
    // cloud pattern slide across the planet whenever the camera zoomed or
    // orbited. Real thickness now comes from the volumetric band — the map
    // must stay pinned to the surface.
    vec2 baseUv = vUv + uvOffset;
    float rawBase = texture2D(cloudMap, baseUv * mix(1.0, detailScale, cirrusBand)).r;
    float coverage = cloudCoverageAt(cloudMap, baseUv, detailScale, detailStrength, contrast);
    // Cirrus is a separate physical layer: select the thin, low-density band
    // from the map at its own scale instead of rendering a second deck copy.
    float thinCoverageBand = smoothstep(0.05, 0.20, rawBase)
      * (1.0 - smoothstep(0.20, 0.48, rawBase));
    coverage = mix(coverage, coverage * thinCoverageBand * 2.4, cirrusBand);
    if (coverage < 0.004) discard;

    vec3 n = normalize(vWorldNormal);
    float ndotl = dot(n, sunDir);
    float grazing = pow(1.0 - abs(ndotl), 2.0);

    vec3 dayColor = vec3(0.92, 0.94, 0.98) * skySunTint(ndotl)
      * (0.45 + 0.55 * max(ndotl, 0.0));
    vec3 color = dayColor + vec3(0.03) * grazing;
    float throughLayerFog = vThroughLayerFog;
    if (!gl_FrontFacing) {
      color *= vec3(0.62, 0.70, 0.84);
      dayColor *= vec3(0.72, 0.78, 0.90);
    }
    // The deck is an infinitely thin shell: seen edge-on at the limb its rim
    // paints dark semi-transparent arcs over the bright atmosphere band
    // (dashed ticks along the silhouette at far zoom). Real limb thickness
    // comes from the volumetric band, so fade the deck out at grazing view.
    float rimCosine = abs(dot(n, normalize(cameraPosition - vWorldPos)));
    float rimFade = smoothstep(0.06, 0.18, rimCosine);
    float litAlpha = coverage * opacity * rimFade
      * (skyLightingAmount(ndotl) + 0.06 * grazing);
    litAlpha = max(litAlpha, throughLayerFog * opacity * 0.32);
    color += vec3(0.55, 0.68, 0.92) * throughLayerFog * 0.16;
    gl_FragColor = vec4(color, litAlpha);
  }
`;

interface CloudLayerConfig {
  radiusMultiplier: number;
  /**
   * rad/s of render-time drift. Deliberately tiny: at 0.008 the deck completed a
   * full revolution in ~13 minutes, which reads as a spinning shell rather than
   * weather. These rates give hours-long revolutions — present but not
   * distracting. Render-side only; never sim time.
   */
  rotationRate: number;
  opacity: number;
  /** UV multiplier for the high-frequency modulation sample. */
  detailScale: number;
  detailStrength: number;
  /** Static UV shift so the two layers are not the same image twice. */
  uvOffset: readonly [number, number];
  contrast: number;
  cirrusBand: boolean;
  texture: Texture;
}

export interface CloudsProps {
  cloudMap: Texture;
  mainDeckRotation: { current: number };
  surfaceMaterial: ShaderMaterial;
  radius: number;
  worldFrame: WorldFrame;
  earthCenterF64: WorldPositionF64;
}

/**
 * Render-only VOLUMETRIC-style cloud shells. The rotation is deliberately kept in a
 * ref owned by the Earth render tree: it is not sim time and never enters a
 * zustand store or telemetry channel.
 */
export function Clouds({
  cloudMap,
  mainDeckRotation,
  surfaceMaterial,
  radius,
  worldFrame,
  earthCenterF64,
}: CloudsProps) {
  const deckRef = useRef<Group>(null);
  const cirrusRef = useRef<Group>(null);
  const [deckConfig, cirrusConfig] = useMemo<readonly [CloudLayerConfig, CloudLayerConfig]>(
    () => [
      {
        radiusMultiplier: DECK_RADIUS_MULTIPLIER,
        rotationRate: CLOUD_DRIFT_RAD_PER_SEC,
        opacity: CLOUD_DECK_OPACITY,
        detailScale: CLOUD_DECK_DETAIL_SCALE,
        detailStrength: CLOUD_DECK_DETAIL_STRENGTH,
        uvOffset: CLOUD_DECK_UV_OFFSET,
        contrast: CLOUD_DECK_CONTRAST,
        cirrusBand: false,
        texture: cloudMap,
      },
      {
        // Cirrus: thin, sparse, and sampled at a different scale/offset so it
        // adds parallax structure instead of a second copy of the deck.
        radiusMultiplier: CIRRUS_RADIUS_MULTIPLIER,
        rotationRate: CIRRUS_DRIFT_RAD_PER_SEC,
        opacity: CLOUD_CIRRUS_OPACITY,
        detailScale: CLOUD_CIRRUS_DETAIL_SCALE,
        detailStrength: CLOUD_CIRRUS_DETAIL_STRENGTH,
        uvOffset: CLOUD_CIRRUS_UV_OFFSET,
        contrast: CLOUD_CIRRUS_CONTRAST,
        cirrusBand: true,
        texture: cloudMap,
      },
    ],
    [cloudMap],
  );

  const deckMaterial = useMemo(
    () => new ShaderMaterial({
      vertexShader: CLOUD_VERTEX,
      fragmentShader: CLOUD_FRAGMENT,
      uniforms: {
        cloudMap: { value: deckConfig.texture },
        sunDir: { value: SUN_DIR.clone() },
        opacity: { value: deckConfig.opacity },
        detailScale: { value: deckConfig.detailScale },
        detailStrength: { value: deckConfig.detailStrength },
        uvOffset: { value: new Vector2(...deckConfig.uvOffset) },
        contrast: { value: deckConfig.contrast },
        cirrusBand: { value: deckConfig.cirrusBand ? 1 : 0 },
        earthCenter: { value: new Vector3(...worldFrame.toRender(earthCenterF64)) },
        surfaceRadius: { value: radius },
        layerRadius: { value: radius * deckConfig.radiusMultiplier },
      },
      transparent: true,
      blending: NormalBlending,
      depthTest: true,
      depthWrite: false,
      side: DoubleSide,
    }),
    [deckConfig, earthCenterF64, radius, worldFrame],
  );
  const cirrusMaterial = useMemo(
    () => new ShaderMaterial({
      vertexShader: CLOUD_VERTEX,
      fragmentShader: CLOUD_FRAGMENT,
      uniforms: {
        cloudMap: { value: cirrusConfig.texture },
        sunDir: { value: SUN_DIR.clone() },
        opacity: { value: cirrusConfig.opacity },
        detailScale: { value: cirrusConfig.detailScale },
        detailStrength: { value: cirrusConfig.detailStrength },
        uvOffset: { value: new Vector2(...cirrusConfig.uvOffset) },
        contrast: { value: cirrusConfig.contrast },
        cirrusBand: { value: cirrusConfig.cirrusBand ? 1 : 0 },
        earthCenter: { value: new Vector3(...worldFrame.toRender(earthCenterF64)) },
        surfaceRadius: { value: radius },
        layerRadius: { value: radius * cirrusConfig.radiusMultiplier },
      },
      transparent: true,
      blending: NormalBlending,
      depthTest: true,
      depthWrite: false,
      side: DoubleSide,
    }),
    [cirrusConfig, earthCenterF64, radius, worldFrame],
  );

  useFrame((state, delta) => {
    const deck = deckRef.current;
    const cirrus = cirrusRef.current;
    if (deck !== null) deck.rotation.y += delta * deckConfig.rotationRate;
    if (cirrus !== null) cirrus.rotation.y += delta * cirrusConfig.rotationRate;

    if (deck !== null) {
      mainDeckRotation.current = deck.rotation.y;
      surfaceMaterial.uniforms.cloudRotationOffset!.value = mainDeckRotation.current;
    }
    const earthCenter = worldFrame.toRender(earthCenterF64);
    deckMaterial.uniforms.earthCenter!.value.fromArray(earthCenter);
    cirrusMaterial.uniforms.earthCenter!.value.fromArray(earthCenter);

    // Backfaces only matter when the camera can be under the cirrus shell
    // (e.g. near the ground); from ordinary orbital views it is always
    // outside, so FrontSide halves cirrus's transparent overdraw there.
    const cirrusLayerRadius = cirrusMaterial.uniforms.layerRadius!.value as number;
    const cameraDistance = state.camera.position.distanceTo(
      cirrusMaterial.uniforms.earthCenter!.value,
    );
    cirrusMaterial.side = cameraDistance > cirrusLayerRadius ? FrontSide : DoubleSide;
  });

  return (
    <>
      <group ref={deckRef} renderOrder={1}>
        <mesh material={deckMaterial} renderOrder={1}>
          <sphereGeometry args={[radius * deckConfig.radiusMultiplier, 192, 192]} />
        </mesh>
      </group>
      <group ref={cirrusRef} renderOrder={2}>
        <mesh material={cirrusMaterial} renderOrder={2}>
          <sphereGeometry args={[radius * cirrusConfig.radiusMultiplier, 192, 192]} />
        </mesh>
      </group>
    </>
  );
}
