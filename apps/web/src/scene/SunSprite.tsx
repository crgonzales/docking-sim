import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, Color, Mesh, ShaderMaterial } from 'three';
import { SUN_DIR } from './sun';
import {
  SUN_ANCHOR_DISTANCE_M,
  SUN_DISC_RADIUS,
  SUN_QUAD_HALF_WIDTH,
} from './sky/skyConfig';
import { WorldFrame, type WorldPositionF64 } from './worldFrame';

/**
 * The visible sun. The scene has always been LIT from `SUN_DIR`, but no sun
 * body was ever drawn — the overexposed dayside of Earth catching bloom read
 * enough like glare that the absence went unnoticed until someone went looking.
 *
 * A camera-facing quad far along `SUN_DIR`, shaded as a hard HDR disc inside a
 * soft halo. `depthTest` stays ON so the Earth (and craft) genuinely occlude
 * it — orbiting behind the planet produces a real sunrise/sunset instead of a
 * sticker that shines through terrain.
 *
 * HDR/bloom contract: the disc is a DELIBERATE highlight far above luminance
 * 1.0 — this is exactly what the half-res bloom pass exists for. The halo
 * falls below 1.0 quickly so it does not smear the frame.
 */
const SUN_VERTEX = /* glsl */ `
  varying vec2 vQuadUv;
  // Vertex-side logarithmic depth: same encoding as three's logdepth chunks
  // but computed per-vertex — no gl_FragDepth writes, so early-Z stays on
  // (fragment-depth writes across large transparent overdraw stressed the
  // Metal driver into intermittent device hangs during v0.9.0).
  uniform float logDepthBufFC;
  void main() {
    vQuadUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position.z = (log2(max(1e-6, 1.0 + gl_Position.w)) * logDepthBufFC - 1.0) * gl_Position.w;
  }
`;

const SUN_FRAGMENT = /* glsl */ `
  uniform vec3 sunTint;
  varying vec2 vQuadUv;

  void main() {
    vec2 centered = vQuadUv * 2.0 - 1.0;
    float radial = length(centered);
    // Disc: hard-edged, strongly HDR so bloom produces the glare.
    float discEdge = ${(SUN_DISC_RADIUS / SUN_QUAD_HALF_WIDTH).toFixed(8)};
    float disc = 1.0 - smoothstep(discEdge * 0.9, discEdge * 1.15, radial);
    // Halo: soft exponential glow, warm, sub-bloom by design.
    float halo = exp(-radial * 5.5) * 0.55;
    vec3 discColor = vec3(22.0, 20.5, 18.0) * sunTint * disc;
    vec3 haloColor = vec3(0.9, 0.82, 0.66) * sunTint * halo;
    float alpha = max(disc, halo * 0.85);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(discColor + haloColor, alpha);
  }
`;

export interface SunSpriteProps {
  sunTint: Color;
  worldFrame: WorldFrame;
}

export function SunSprite({ sunTint, worldFrame }: SunSpriteProps) {
  const meshRef = useRef<Mesh>(null);
  const material = useMemo(() => new ShaderMaterial({
    vertexShader: SUN_VERTEX,
    fragmentShader: SUN_FRAGMENT,
    uniforms: { sunTint: { value: sunTint } },
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
  }), [sunTint]);

  useFrame(({ camera }) => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    // The sun is at optical infinity: derive its absolute position from the
    // camera in f64, then RTC-convert it with the shared render anchor.
    const cameraWorld = worldFrame.toWorld([camera.position.x, camera.position.y, camera.position.z]);
    const sunWorld: WorldPositionF64 = [
      cameraWorld[0] + SUN_DIR.x * SUN_ANCHOR_DISTANCE_M,
      cameraWorld[1] + SUN_DIR.y * SUN_ANCHOR_DISTANCE_M,
      cameraWorld[2] + SUN_DIR.z * SUN_ANCHOR_DISTANCE_M,
    ];
    const sunRender = worldFrame.toRender(sunWorld);
    mesh.position.set(sunRender[0], sunRender[1], sunRender[2]);
    mesh.quaternion.copy(camera.quaternion);
  });

  return (
    <mesh
      ref={meshRef}
      material={material}
      position={[0, 0, 0]}
    >
      <planeGeometry args={[SUN_QUAD_HALF_WIDTH * 2, SUN_QUAD_HALF_WIDTH * 2]} />
    </mesh>
  );
}
