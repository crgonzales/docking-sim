import { useMemo } from 'react';
import { useLoader } from '@react-three/fiber';
import {
  AdditiveBlending,
  BackSide,
  Color,
  ShaderMaterial,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
} from 'three';
import { R_EARTH_M } from '@docking/sim-core';
import { SUN_DIR } from './sun';

/**
 * Earth with day/night terminator shader and additive atmosphere rim.
 *
 * Scale handling: the render scene is the Hill frame in meters, but Earth at
 * its true distance (~6.771e6 m) destroys float/depth precision. The whole
 * Earth group is therefore divided by EARTH_VIEW_SCALE — distance and radius
 * equally — which preserves angular size exactly. Combined with the canvas's
 * logarithmic depth buffer this keeps both the meter-scale craft and the
 * planet stable in one scene.
 *
 * HDR contract (bloom threshold = 1.0): day albedo stays < 1.0; night city
 * lights and the sun glint are emitted with gain > 1.0 so only they bloom.
 */
export const EARTH_VIEW_SCALE = 1000;
/** LEO orbit radius for the target (≈400 km altitude). */
export const ORBIT_RADIUS_M = R_EARTH_M + 4.0e5;
const NIGHT_EMISSIVE_GAIN = 2.5;
const SPEC_GAIN = 1.6;

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
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform sampler2D specMap;
  uniform vec3 sunDir;
  uniform float nightGain;
  uniform float specGain;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec2 vUv;

  void main() {
    vec3 n = normalize(vWorldNormal);
    float ndotl = dot(n, sunDir);
    // Soft terminator band.
    float dayness = smoothstep(-0.12, 0.18, ndotl);

    vec3 day = texture2D(dayMap, vUv).rgb * max(ndotl, 0.0);
    vec3 night = texture2D(nightMap, vUv).rgb * nightGain * (1.0 - dayness);

    // Sun glint on water (spec map is bright on oceans).
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    vec3 halfDir = normalize(sunDir + viewDir);
    float waterMask = texture2D(specMap, vUv).r;
    float glint = pow(max(dot(n, halfDir), 0.0), 80.0) * waterMask * specGain * dayness;

    vec3 color = day * dayness + night + vec3(glint);
    gl_FragColor = vec4(color, 1.0);
  }
`;

const atmoVertex = /* glsl */ `
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  void main() {
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const atmoFragment = /* glsl */ `
  uniform vec3 sunDir;
  uniform vec3 rimColor;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  void main() {
    vec3 n = normalize(vWorldNormal);
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    // BackSide sphere: rim is where the surface grazes the view direction.
    float rim = pow(1.0 - abs(dot(n, viewDir)), 3.0);
    // Fade the rim on the night side so the atmosphere follows the sun.
    float lit = clamp(dot(n, sunDir) * 1.5 + 0.5, 0.05, 1.0);
    gl_FragColor = vec4(rimColor * rim * lit, rim * lit);
  }
`;

export function Earth() {
  const [dayMap, nightMap, specMap] = useLoader(TextureLoader, [
    '/assets/textures/earth_day.jpg',
    '/assets/textures/earth_night.png',
    '/assets/textures/earth_spec.jpg',
  ]);
  dayMap.colorSpace = SRGBColorSpace;
  nightMap.colorSpace = SRGBColorSpace;

  const earthMaterial = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: earthVertex,
        fragmentShader: earthFragment,
        uniforms: {
          dayMap: { value: dayMap },
          nightMap: { value: nightMap },
          specMap: { value: specMap },
          sunDir: { value: SUN_DIR.clone() },
          nightGain: { value: NIGHT_EMISSIVE_GAIN },
          specGain: { value: SPEC_GAIN },
        },
      }),
    [dayMap, nightMap, specMap],
  );

  const atmoMaterial = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: atmoVertex,
        fragmentShader: atmoFragment,
        uniforms: {
          sunDir: { value: SUN_DIR.clone() },
          rimColor: { value: new Color('#4d7dff') },
        },
        blending: AdditiveBlending,
        side: BackSide,
        transparent: true,
        depthWrite: false,
      }),
    [],
  );

  const radius = R_EARTH_M / EARTH_VIEW_SCALE;
  const position = useMemo(
    () => new Vector3(-ORBIT_RADIUS_M / EARTH_VIEW_SCALE, 0, 0),
    [],
  );

  return (
    <group position={position}>
      <mesh material={earthMaterial}>
        <sphereGeometry args={[radius, 96, 96]} />
      </mesh>
      <mesh material={atmoMaterial} scale={1.03}>
        <sphereGeometry args={[radius, 96, 96]} />
      </mesh>
    </group>
  );
}
