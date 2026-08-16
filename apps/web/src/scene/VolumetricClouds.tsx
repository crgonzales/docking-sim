import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  InstancedBufferAttribute,
  InstancedMesh,
  NormalBlending,
  Object3D,
  PlaneGeometry,
  ShaderMaterial,
  Texture,
  Vector3,
} from 'three';
import {
  CLOUD_COVERAGE_GLSL,
  CLOUD_DECK_CONTRAST,
  CLOUD_DECK_DETAIL_SCALE,
  CLOUD_DECK_DETAIL_STRENGTH,
} from './sky/cloudCoverage';
import { SKY_LIGHTING_GLSL } from './sky/lighting';
import {
  CLOUD_BAND_INNER_MULTIPLIER,
  CLOUD_BAND_OUTER_MULTIPLIER,
  PUFF_DETAIL_MAX_SIZE,
  PUFF_DETAIL_MIN_SIZE,
  PUFF_LARGE_MAX_SIZE,
  PUFF_LARGE_MIN_SIZE,
  PUFF_NOISE_OCTAVES,
  PUFF_NOISE_SCALE,
  PUFF_SILVER_LINING_G,
  VOLUMETRIC_CAP_COSINE,
  VOLUMETRIC_FADE_IN_END,
  VOLUMETRIC_FADE_IN_START,
  VOLUMETRIC_FADE_OUT_END,
  VOLUMETRIC_FADE_OUT_START,
  VOLUMETRIC_INSTANCE_COUNT,
} from './sky/skyConfig';
import {
  sampleCloudPlacements,
  type CoverageMask,
} from './sky/cloudPlacement';
import { SUN_DIR } from './sun';

/**
 * Cloud-field density. At 3000 the ~44° cap gives ~155 km between puffs — with
 * 8–22 km puffs that reads as isolated popcorn, not weather. 12000 brings
 * spacing to ~78 km so clusters form over the deck's formations. The owner has
 * explicitly deprioritized frame cost in favour of looks; the FPS counter in
 * the mode bar shows what this costs on real hardware, and this constant is
 * still the first thing to lower if that number gets ugly. 0 disables the
 * layer entirely (the flat deck is independent and stays correct).
 */
/**
 * Cap half-angle as a cosine. The cap is WORLD-ANCHORED around +x̂ (the fixed
 * direction from Earth's centre to the Hill-frame origin) — it must never
 * follow the camera: an earlier version re-aimed the cap at the sub-camera
 * point every frame, which dragged the entire cloud field across the planet
 * whenever the camera zoomed or orbited, while the group-local density lookup
 * let puffs keep their cloudiness as they slid over clear ocean.
 *
 * Being static, it must cover the whole camera envelope at once: horizon at
 * the farthest CINEMATIC orbit (8771 from centre) is ~43.4°, and the
 * sub-camera point can deviate from +x̂ by up to ~17.2° (2000-unit orbit
 * against the 6771 baseline) — ~61° total, cos ≈ 0.48.
 */
/**
 * Vertical extent of the volumetric layer, as radius multipliers (R = 6371 km).
 * 1.5 km base to 9 km tops — a real convective cloud band.
 *
 * This is what makes the limb work. Placing every instance on ONE shell radius
 * means that at the horizon you look tangentially along an infinitely thin
 * surface and the whole field collapses to a line, which is exactly why the
 * clouds still read flat there no matter how many instances there are. Real
 * cloud layers are visible at the limb *because* they have thickness, so the
 * instances must occupy a band, not a shell.
 */

/**
 * Billboard size range in scene units (1 unit = 1 km at Earth scale).
 *
 * The first implementation used 0.22-0.74 — viewed from the ~391-unit distance
 * between the craft and the cloud deck, that is 2-3 PIXELS per puff. Three
 * thousand sub-3-pixel dots is an invisible feature: every "still looks flat"
 * report was made by someone who had never actually seen the volumetric layer.
 * 8-22 km reads as cumulus cluster scale from LEO (~28-75 px on screen).
 */
const VOLUMETRIC_VERTEX = /* glsl */ `
  attribute vec3 instancePosition;
  attribute float instanceSeed;

  uniform sampler2D cloudMap;
  uniform float cloudRotationOffset;
  uniform vec3 sunDir;
  uniform vec3 earthCenter;
  uniform float viewportHeight;

  varying vec2 vQuadUv;
  varying float vDensity;
  varying float vDistanceFade;
  varying float vSunAmount;
  varying float vSeed;
  varying vec3 vWorldCenter;
  varying float vQuadPixels;

  const float PI = 3.14159265359;

  vec3 rotateY(vec3 point, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return vec3(c * point.x + s * point.z, point.y, -s * point.x + c * point.z);
  }

${CLOUD_COVERAGE_GLSL}

  // SphereGeometry convention: +x maps to u=0.5 (no +0.5 offset — that put
  // the density lookup 180 deg from the visible deck). Caller fracts to wrap.
  vec2 sphericalUv(vec3 point) {
    return vec2(atan(point.z, -point.x) / (2.0 * PI),
      0.5 + asin(clamp(point.y, -1.0, 1.0)) / PI);
  }

  void main() {
    vec3 spherePoint = normalize(instancePosition);
    // Match the flat deck and the surface shadow lookup exactly: the map is
    // authored in the deck's local frame, so undo its current rotation.
    vec2 cloudUv = sphericalUv(rotateY(spherePoint, -cloudRotationOffset));
    cloudUv.x = fract(cloudUv.x);
    cloudUv.y = clamp(cloudUv.y, 0.001, 0.999);
    // IDENTICAL coverage function to the flat deck and the surface shadows
    // (cloudCoverage.ts). This was a third divergent transfer function until
    // the review pass — puffs would not have matched the shadows below them.
    float density = cloudCoverageAt(
      cloudMap, cloudUv,
      ${CLOUD_DECK_DETAIL_SCALE.toFixed(3)},
      ${CLOUD_DECK_DETAIL_STRENGTH.toFixed(3)},
      ${CLOUD_DECK_CONTRAST.toFixed(3)}
    );

    float cameraDistance = distance(cameraPosition, earthCenter);
    float fadeIn = 1.0 - smoothstep(${VOLUMETRIC_FADE_IN_START.toFixed(1)}, ${VOLUMETRIC_FADE_IN_END.toFixed(1)}, cameraDistance);
    float fadeOut = 1.0 - smoothstep(${VOLUMETRIC_FADE_OUT_START.toFixed(1)}, ${VOLUMETRIC_FADE_OUT_END.toFixed(1)}, cameraDistance);
    float distanceFade = fadeIn * fadeOut;
    float largeSize = mix(${PUFF_LARGE_MIN_SIZE.toFixed(1)}, ${PUFF_LARGE_MAX_SIZE.toFixed(1)}, fract(instanceSeed * 17.371));
    float detailSize = mix(${PUFF_DETAIL_MIN_SIZE.toFixed(1)}, ${PUFF_DETAIL_MAX_SIZE.toFixed(1)}, fract(instanceSeed * 43.117));
    // Seed-select the octave: max() made the 14-22 km large octave always win
    // (detail topped out at 7.2 km), so the promised small-puff octave never
    // rendered. ~40% of instances now take the detail size.
    float useDetail = step(0.6, fract(instanceSeed * 7.13));
    float sizeVariation = mix(largeSize, detailSize, useDetail);
    float billboardSize = sizeVariation * density * distanceFade;

    // InstancedMesh carries the sphere-point translation in instanceMatrix.
    // Add the quad in view space so every patch faces the camera.
    vec4 centerView = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float angle = fract(instanceSeed * 31.17) * 2.0 * PI;
    float c = cos(angle);
    float s = sin(angle);
    vec2 rotatedQuad = vec2(c * position.x - s * position.y, s * position.x + c * position.y);
    centerView.xy += rotatedQuad * billboardSize;
    gl_Position = projectionMatrix * centerView;

    // On-screen quad size in pixels, computed once per quad: the fragment
    // shader previously derived this from fwidth(vQuadUv), which is noisy for
    // small quads and made borderline puffs pop in and out as whole squares.
    vQuadPixels = billboardSize * projectionMatrix[1][1] * 0.5 * viewportHeight
      / max(-centerView.z, 1.0);
    vQuadUv = uv;
    vDensity = density;
    vDistanceFade = distanceFade;
    vSeed = instanceSeed;
    vWorldCenter = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vec3 worldNormal = normalize(mat3(modelMatrix) * spherePoint);
    vSunAmount = dot(worldNormal, sunDir);
  }
`;

const VOLUMETRIC_FRAGMENT = /* glsl */ `
  varying vec2 vQuadUv;
  varying float vDensity;
  varying float vDistanceFade;
  varying float vSunAmount;
  varying float vSeed;
  varying vec3 vWorldCenter;
  varying float vQuadPixels;

${SKY_LIGHTING_GLSL}

  const float PI = 3.14159265359;

  float hash12(vec2 point) {
    vec3 value = fract(vec3(point.xyx) * 0.1031 + vSeed * vec3(0.17, 0.31, 0.47));
    value += dot(value, value.yzx + 33.33);
    return fract((value.x + value.y) * value.z);
  }

  float valueNoise(vec2 point) {
    vec2 cell = floor(point);
    vec2 fraction = fract(point);
    fraction = fraction * fraction * (3.0 - 2.0 * fraction);
    float a = hash12(cell);
    float b = hash12(cell + vec2(1.0, 0.0));
    float c = hash12(cell + vec2(0.0, 1.0));
    float d = hash12(cell + vec2(1.0, 1.0));
    return mix(mix(a, b, fraction.x), mix(c, d, fraction.x), fraction.y);
  }

  // detailAmount in [0,1] progressively silences the higher octaves: each
  // octave doubles spatial frequency, so on a small on-screen quad the upper
  // octaves are sub-pixel and read as frame-to-frame sparkle, not shape.
  float puffFbm(vec2 point, float detailAmount) {
    float value = 0.0;
    float amplitude = 0.58;
    float frequency = 1.0;
    float octaveFade = 1.0;
    for (int octave = 0; octave < ${PUFF_NOISE_OCTAVES}; octave += 1) {
      value += valueNoise(point * frequency) * amplitude * octaveFade;
      frequency *= 2.03;
      amplitude *= 0.5;
      octaveFade *= detailAmount;
    }
    return value / 0.98;
  }

  float henyeyGreenstein(float cosine, float g) {
    float denominator = max(1.0 + g * g - 2.0 * g * cosine, 0.001);
    return (1.0 - g * g) / (4.0 * PI * pow(denominator, 1.5));
  }

  void main() {
    vec2 centered = vQuadUv * 2.0 - 1.0;
    float radial = length(centered);
    // Pixel footprint of the quad: below a few fragments the FBM edge is
    // temporal noise (sparkling puffs at far zoom), so fade the puff out and
    // flatten its noise before it can flicker.
    float quadPixels = vQuadPixels;
    float subpixelFade = smoothstep(4.0, 12.0, quadPixels);
    // Octave detail needs far more pixels than mere visibility: a 15 px puff
    // can hold its base shape but not its 8x-frequency octaves.
    float noiseDetail = smoothstep(10.0, 90.0, quadPixels);
    float noise = puffFbm(
      centered * ${PUFF_NOISE_SCALE.toFixed(2)} + vec2(vSeed * 13.7, vSeed * 7.9),
      noiseDetail);
    noise = mix(0.5, noise, subpixelFade);
    float lumpyRadius = radial * (0.78 + 0.42 * noise);
    float puffyEdge = 1.0 - smoothstep(0.34, 1.0, lumpyRadius);
    if (puffyEdge < 0.01 || vDensity < 0.01 || vDistanceFade < 0.01) discard;

    float grazing = pow(1.0 - abs(vSunAmount), 2.0);
    vec3 viewDirection = normalize(cameraPosition - vWorldCenter);
    float silverLining = henyeyGreenstein(dot(-sunDir, viewDirection), ${PUFF_SILVER_LINING_G.toFixed(2)});
    float backlitEdge = smoothstep(-0.18, 0.30, -vSunAmount) * smoothstep(0.25, 0.82, radial);
    vec3 dayColor = vec3(0.86, 0.9, 0.98) * skySunTint(vSunAmount)
      * (0.42 + 0.58 * max(vSunAmount, 0.0));
    vec3 color = dayColor + vec3(0.025) * grazing
      + vec3(1.0, 0.62, 0.30) * silverLining * backlitEdge * 0.18;
    float alpha = puffyEdge * vDensity * vDistanceFade * subpixelFade
      * (0.68 * skyLightingAmount(vSunAmount) + 0.08 * grazing + 0.04 * silverLining * backlitEdge);
    gl_FragColor = vec4(color, alpha);
  }
`;

export interface VolumetricCloudsProps {
  cloudMap: Texture;
  cloudCoverageMask: Texture;
  mainDeckRotation: { current: number };
  earthCenter: Vector3;
  radius: number;
}

function readCoverageMask(texture: Texture): CoverageMask {
  const image = texture.image as CanvasImageSource & { width: number; height: number };
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Unable to create a canvas for the cloud coverage mask');
  context.drawImage(image, 0, 0);
  const rgba = context.getImageData(0, 0, image.width, image.height).data;
  const data = new Uint8Array(image.width * image.height);
  for (let index = 0; index < data.length; index += 1) data[index] = rgba[index * 4];
  return { width: image.width, height: image.height, data };
}

/**
 * A fixed-cost near-field cloud volume. All mesh data is constructed once;
 * useFrame only updates the deck-rotation uniform; nothing tracks the camera.
 */
export function VolumetricClouds({
  cloudMap,
  cloudCoverageMask,
  mainDeckRotation,
  earthCenter,
  radius,
}: VolumetricCloudsProps) {

  const instancedMesh = useMemo(() => {
    const geometry = new PlaneGeometry(1, 1, 1, 1);
    const mask = readCoverageMask(cloudCoverageMask);
    const placements = sampleCloudPlacements(VOLUMETRIC_INSTANCE_COUNT, VOLUMETRIC_CAP_COSINE, mask);
    const positions = placements.positions;
    const seeds = placements.seeds;
    const dummy = new Object3D();
    const bandInnerRadius = radius * CLOUD_BAND_INNER_MULTIPLIER;
    const bandOuterRadius = radius * CLOUD_BAND_OUTER_MULTIPLIER;
    const mesh = new InstancedMesh(
      geometry,
      new ShaderMaterial({
        vertexShader: VOLUMETRIC_VERTEX,
        fragmentShader: VOLUMETRIC_FRAGMENT,
        uniforms: {
          viewportHeight: { value: 900 },
          cloudMap: { value: cloudMap },
          cloudRotationOffset: { value: mainDeckRotation.current },
          sunDir: { value: SUN_DIR },
          earthCenter: { value: earthCenter },
        },
        transparent: true,
        blending: NormalBlending,
        depthTest: true,
        depthWrite: false,
      }),
      VOLUMETRIC_INSTANCE_COUNT,
    );
    const positionAttribute = new InstancedBufferAttribute(positions, 3);
    const seedAttribute = new InstancedBufferAttribute(seeds, 1);
    geometry.setAttribute('instancePosition', positionAttribute);
    geometry.setAttribute('instanceSeed', seedAttribute);

    for (let index = 0; index < VOLUMETRIC_INSTANCE_COUNT; index += 1) {
      const x = placements.positions[index * 3];
      const y = placements.positions[index * 3 + 1];
      const z = placements.positions[index * 3 + 2];

      // Spread through the vertical band rather than pinning to one shell, so
      // the layer has genuine thickness when viewed edge-on at the limb. Biased
      // toward the lower half, matching real cloud mass distribution.
      const bandFraction = placements.bandFractions[index];
      const instanceRadius = bandInnerRadius
        + (bandOuterRadius - bandInnerRadius) * bandFraction;
      dummy.position.set(x * instanceRadius, y * instanceRadius, z * instanceRadius);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    }
    positionAttribute.needsUpdate = true;
    seedAttribute.needsUpdate = true;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.renderOrder = 2.5;
    // The geometry is a unit plane whose bounding sphere is a ~0.7-unit dot
    // at the group origin — instance positions are NOT in it, so three.js
    // culled the ENTIRE 12k-puff field whenever that point left the frustum:
    // the whole cloud layer blinked with camera motion.
    mesh.frustumCulled = false;
    return mesh;
  }, [cloudCoverageMask, cloudMap, earthCenter, mainDeckRotation, radius]);

  // R3F does not dispose resources owned by a <primitive>; without this the
  // geometry, material, and instance buffers leak on every Canvas remount
  // (ANALYSIS tab unmounts the canvas; SANDBOX remounts it).
  useEffect(() => () => {
    instancedMesh.geometry.dispose();
    (instancedMesh.material as ShaderMaterial).dispose();
    instancedMesh.dispose();
  }, [instancedMesh]);

  useFrame(({ size }) => {
    // The field itself is static; only the slow deck drift moves the weather.
    const material = instancedMesh.material as ShaderMaterial;
    material.uniforms.cloudRotationOffset!.value = mainDeckRotation.current;
    material.uniforms.viewportHeight!.value = size.height;
  });

  return <primitive object={instancedMesh} />;
}
