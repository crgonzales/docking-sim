import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  Group,
  NormalBlending,
  ShaderMaterial,
  Texture,
  Vector2,
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
  DECK_RADIUS_MULTIPLIER,
} from './sky/skyConfig';
import { SKY_LIGHTING_GLSL } from './sky/lighting';
import { SUN_DIR } from './sun';

const CLOUD_VERTEX = /* glsl */ `
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

const CLOUD_FRAGMENT = /* glsl */ `
  uniform sampler2D cloudMap;
  uniform vec3 sunDir;
  uniform float opacity;
  uniform float detailScale;
  uniform float detailStrength;
  uniform vec2 uvOffset;
  uniform float contrast;
  uniform float cirrusBand;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec2 vUv;

${CLOUD_COVERAGE_GLSL}
${SKY_LIGHTING_GLSL}

  void main() {
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
    // The deck is an infinitely thin shell: seen edge-on at the limb its rim
    // paints dark semi-transparent arcs over the bright atmosphere band
    // (dashed ticks along the silhouette at far zoom). Real limb thickness
    // comes from the volumetric band, so fade the deck out at grazing view.
    float rimCosine = abs(dot(n, normalize(cameraPosition - vWorldPos)));
    float rimFade = smoothstep(0.06, 0.18, rimCosine);
    float litAlpha = coverage * opacity * rimFade
      * (skyLightingAmount(ndotl) + 0.06 * grazing);
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
}

/**
 * Render-only EVE-style cloud shells. The rotation is deliberately kept in a
 * ref owned by the Earth render tree: it is not sim time and never enters a
 * zustand store or telemetry channel.
 */
export function Clouds({ cloudMap, mainDeckRotation, surfaceMaterial, radius }: CloudsProps) {
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
        sunDir: { value: SUN_DIR },
        opacity: { value: deckConfig.opacity },
        detailScale: { value: deckConfig.detailScale },
        detailStrength: { value: deckConfig.detailStrength },
        uvOffset: { value: new Vector2(...deckConfig.uvOffset) },
        contrast: { value: deckConfig.contrast },
        cirrusBand: { value: deckConfig.cirrusBand ? 1 : 0 },
      },
      transparent: true,
      blending: NormalBlending,
      depthTest: true,
      depthWrite: false,
    }),
    [deckConfig],
  );
  const cirrusMaterial = useMemo(
    () => new ShaderMaterial({
      vertexShader: CLOUD_VERTEX,
      fragmentShader: CLOUD_FRAGMENT,
      uniforms: {
        cloudMap: { value: cirrusConfig.texture },
        sunDir: { value: SUN_DIR },
        opacity: { value: cirrusConfig.opacity },
        detailScale: { value: cirrusConfig.detailScale },
        detailStrength: { value: cirrusConfig.detailStrength },
        uvOffset: { value: new Vector2(...cirrusConfig.uvOffset) },
        contrast: { value: cirrusConfig.contrast },
        cirrusBand: { value: cirrusConfig.cirrusBand ? 1 : 0 },
      },
      transparent: true,
      blending: NormalBlending,
      depthTest: true,
      depthWrite: false,
    }),
    [cirrusConfig],
  );

  useFrame((_, delta) => {
    const deck = deckRef.current;
    const cirrus = cirrusRef.current;
    if (deck !== null) deck.rotation.y += delta * deckConfig.rotationRate;
    if (cirrus !== null) cirrus.rotation.y += delta * cirrusConfig.rotationRate;

    if (deck !== null) {
      mainDeckRotation.current = deck.rotation.y;
      surfaceMaterial.uniforms.cloudRotationOffset!.value = mainDeckRotation.current;
    }
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
