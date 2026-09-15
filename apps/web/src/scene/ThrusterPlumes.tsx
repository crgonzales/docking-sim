import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending, BackSide, CylinderGeometry, Matrix4, Mesh, Quaternion, ShaderMaterial, Vector2, Vector3,
} from 'three';
import { useTelemetryBus } from '../telemetry/bus';
import { updateRcsListener } from '../hud/rcsAudio';
import { RCS_INSPECTION, useRcsInspection } from './rcsInspection';
import { SPACECRAFT_EXHAUST_LAYER } from './SpacecraftExhaustPass';
import {
  boundedThrusterDuty, NOZZLE_EXIT_RADIUS_M, PLUME_END_RADIUS_M, PLUME_LENGTH_M,
  THRUSTER_NOZZLES,
} from './thrusterPresentation';

const UP = new Vector3(0, 1, 0);
const vertexShader = /* glsl */ `
  varying vec3 vPosition;
  varying vec3 vCamera;
  varying vec3 vViewPosition;
  #include <common>
  #include <logdepthbuf_pars_vertex>
  void main() {
    vPosition = position;
    vCamera = (inverse(modelViewMatrix) * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vViewPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
    #include <logdepthbuf_vertex>
  }
`;
const fragmentShader = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  #include <packing>
  uniform float duty, time, phase, nozzleRadius;
  uniform sampler2D opaqueDepth;
  uniform vec2 viewportSize;
  uniform float clipOpaque;
  varying vec3 vPosition;
  varying vec3 vCamera;
  varying vec3 vViewPosition;
  const float LENGTH = ${PLUME_LENGTH_M.toFixed(3)};
  const float RADIUS = ${PLUME_END_RADIUS_M.toFixed(3)};
  void main() {
    #include <logdepthbuf_fragment>
    vec3 ray = normalize(vPosition - vCamera);
    // Integrate only the tiny plume volume. The mesh provides tight raster
    // bounds; no particles, screen-sized pass or per-jet light is required.
    float a = dot(ray.xz, ray.xz);
    float b = dot(vCamera.xz, ray.xz);
    float c = dot(vCamera.xz, vCamera.xz) - RADIUS * RADIUS;
    float nearT = 0.0, farT = 1e5;
    if (a > 1e-7) {
      float d = b * b - a * c;
      if (d < 0.0) discard;
      nearT = max(nearT, (-b - sqrt(d)) / a);
      farT = min(farT, (-b + sqrt(d)) / a);
    } else if (c > 0.0) discard;
    if (abs(ray.y) > 1e-7) {
      vec2 ends = (vec2(0.0, LENGTH) - vCamera.y) / ray.y;
      nearT = max(nearT, min(ends.x, ends.y));
      farT = min(farT, max(ends.x, ends.y));
    } else if (vCamera.y < 0.0 || vCamera.y > LENGTH) discard;
    #ifdef USE_LOGDEPTHBUF
    if (clipOpaque > 0.5) {
      float depth = texture2D(opaqueDepth, gl_FragCoord.xy / viewportSize).r;
      if (depth < 1.0) {
        float viewDepth = exp2(depth * 2.0 / logDepthBufFC) - 1.0;
        farT = min(farT, viewDepth / max(1e-5, -normalize(vViewPosition).z));
      }
    }
    #endif
    if (farT <= nearT) discard;
    float segment = (farT - nearT) / 10.0;
    float opticalDepth = 0.0;
    vec3 light = vec3(0.0);
    for (int i = 0; i < 10; i++) {
      vec3 p = vCamera + (nearT + (float(i) + 0.5) * segment) * ray;
      float along = clamp(p.y / LENGTH, 0.0, 1.0);
      float width = mix(nozzleRadius, RADIUS, along);
      float radial = length(p.xz) / width;
      float edge = 1.0 - smoothstep(0.65, 1.0, radial);
      float flow = 0.94 + 0.06 * sin(p.y * 15.0 - time * 23.0 + phase);
      float density = exp(-radial * radial * 3.5) * edge * exp(-along * 3.0)
        * (1.0 - smoothstep(0.65, 1.0, along)) * flow;
      float heat = exp(-along * 7.0) * exp(-radial * radial * 2.0);
      vec3 color = mix(vec3(0.65, 0.78, 1.0), vec3(5.0, 4.1, 3.1), heat);
      float weight = density * segment;
      opticalDepth += weight;
      light += color * weight;
    }
    float alpha = (1.0 - exp(-opticalDepth * 4.5)) * duty;
    if (alpha < 0.001) discard;
    gl_FragColor = vec4(light / max(opticalDepth, 1e-5), alpha);
  }
`;

/** Nozzles and exhaust share one body-frame transform. The simulator's force
 * points INTO the vehicle; gas leaves along its negative, without Euler hacks.
 * Intensity is the actual truth-side fired fraction, including stuck-open jets.
 */
export function ThrusterPlumes() {
  const selected = useRcsInspection(s => s.jet);
  const vectors = useRcsInspection(s => s.vectors);
  const selectedNozzle = THRUSTER_NOZZLES.find(nozzle => nozzle.id === selected)!;
  const vectorOrigin = useMemo(() => new Vector3(...selectedNozzle.exit), [selectedNozzle]);
  const exhaustVector = useMemo(() => new Vector3(...selectedNozzle.exhaust), [selectedNozzle]);
  const forceVector = useMemo(() => exhaustVector.clone().negate(), [exhaustVector]);
  const meshRefs = useRef<Array<Mesh | null>>([]);
  const resources = useMemo(() => {
    const plume = new CylinderGeometry(PLUME_END_RADIUS_M, NOZZLE_EXIT_RADIUS_M, PLUME_LENGTH_M, 16, 1);
    plume.translate(0, PLUME_LENGTH_M / 2, 0);
    const matrices = THRUSTER_NOZZLES.map(nozzle => new Matrix4().compose(
      new Vector3(...nozzle.exit), new Quaternion().setFromUnitVectors(UP, new Vector3(...nozzle.exhaust)), new Vector3(1, 1, 1),
    ));
    const materials = THRUSTER_NOZZLES.map((nozzle, index) => new ShaderMaterial({
      uniforms: { duty: { value: 0 }, time: { value: 0 }, phase: { value: index * 1.618 }, nozzleRadius: { value: nozzle.radiusM },
        opaqueDepth: { value: null }, viewportSize: { value: new Vector2(1, 1) }, clipOpaque: { value: 0 } },
      vertexShader, fragmentShader, transparent: true, blending: AdditiveBlending,
      // The exhaust pass composites plumes against the composer's opaque depth itself.
      side: BackSide, depthWrite: false, depthTest: false, toneMapped: false,
    }));
    return { plume, matrices, materials };
  }, []);
  const audioPosition = useMemo(() => new Vector3(), []);
  const viewRight = useMemo(() => new Vector3(), []);
  useEffect(() => () => {
    resources.plume.dispose();
    resources.materials.forEach(material => material.dispose());
  }, [resources]);

  useFrame(({ camera }) => {
    const current = useTelemetryBus.getState().renderState;
    viewRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    for (let index = 0; index < THRUSTER_NOZZLES.length; index++) {
      const mesh = meshRefs.current[index];
      if (!mesh) continue;
      const nozzle = THRUSTER_NOZZLES[index]!;
      const duty = boundedThrusterDuty(current?.thruster_duty[nozzle.id]);
      mesh.visible = duty > 0;
      const material = resources.materials[index]!;
      material.uniforms.duty!.value = duty;
      material.uniforms.time!.value = current?.t_s ?? 0;
      mesh.getWorldPosition(audioPosition).sub(camera.position);
      const distance = audioPosition.length();
      updateRcsListener(nozzle.id, distance > 0.01 ? audioPosition.dot(viewRight) / distance : 0, distance);
    }
  });
  return <group dispose={null}>
    {RCS_INSPECTION && vectors && <group>
      <arrowHelper args={[exhaustVector, vectorOrigin, 2.8, 0xffb35b, 0.18, 0.1]} />
      <arrowHelper args={[forceVector, vectorOrigin, 2.2, 0x53ecff, 0.18, 0.1]} />
    </group>}
    {THRUSTER_NOZZLES.map((nozzle, index) => <mesh key={nozzle.id}
      name={`rcs-plume-${nozzle.id}`}
      layers-mask={1 << SPACECRAFT_EXHAUST_LAYER}
      ref={mesh => { meshRefs.current[index] = mesh; }}
      geometry={resources.plume} material={resources.materials[index]}
      matrix={resources.matrices[index]} matrixAutoUpdate={false} visible={false}
    />)}
  </group>;
}
