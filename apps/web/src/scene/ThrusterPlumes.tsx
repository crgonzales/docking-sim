import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending,
  ConeGeometry,
  Mesh,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import { DRACO_THRUSTER_GEOMETRY } from '@docking/sim-core';
import type { RenderState } from '@docking/sim-core';
import { useTelemetryBus } from '../telemetry/bus';

const PLUME_LENGTH_M = 1.2;
const PLUME_RADIUS_M = 0.22;
const PLUME_MAX_OPACITY = 0.24;
const BODY_UP = new Vector3(0, 1, 0);
const PLUME_VERTEX_SHADER = /* glsl */ `
  varying vec3 vPlumePosition;

  void main() {
    vPlumePosition = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const PLUME_FRAGMENT_SHADER = /* glsl */ `
  uniform float duty;
  uniform float time;
  uniform float phase;

  varying vec3 vPlumePosition;

  void main() {
    float along = clamp(vPlumePosition.y / ${PLUME_LENGTH_M.toFixed(3)}, 0.0, 1.0);
    float radial = clamp(length(vPlumePosition.xz) / ${PLUME_RADIUS_M.toFixed(3)}, 0.0, 1.0);
    float radialFalloff = 1.0 - smoothstep(0.18, 1.0, radial);
    float longitudinalFalloff = 1.0 - smoothstep(0.0, 1.0, along);
    float coreRadial = 1.0 - smoothstep(0.0, 0.46, radial);
    float coreLongitudinal = 1.0 - smoothstep(0.0, 0.52, along);
    float hotCore = coreRadial * coreLongitudinal;
    float flicker = 0.97 + 0.03 * (0.5 + 0.5 * sin(time * 17.0 + phase));
    float alpha = duty * ${PLUME_MAX_OPACITY.toFixed(3)} * radialFalloff * longitudinalFalloff * flicker;

    vec3 orange = vec3(1.0, 0.22, 0.055) * 0.72;
    vec3 hot = vec3(2.8, 2.55, 2.2);
    vec3 color = mix(orange, hot, hotCore);
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * Truth-driven exhaust jets. Geometry is translated so the cone base sits at
 * the jet position and its local +y axis points down the exhaust stream.
 * Materials are separate per jet so opacity can track duty independently while
 * the geometry remains shared.
 */
export function ThrusterPlumes() {
  // Re-render only when the render channel appears/disappears. Individual
  // render-state publishes update this ref without rebuilding the mesh tree.
  const hasRenderState = useTelemetryBus((state) => state.renderState !== null);
  const renderStateRef = useRef<RenderState | null>(useTelemetryBus.getState().renderState);
  useEffect(() => useTelemetryBus.subscribe((state) => {
    renderStateRef.current = state.renderState;
  }), []);
  const meshRefs = useRef<Array<Mesh | null>>([]);
  const geometry = useMemo(() => {
    const value = new ConeGeometry(PLUME_RADIUS_M, PLUME_LENGTH_M, 24, 1, true);
    // ConeGeometry's base is at -y and apex at +y. Move the base to the
    // origin, so the mesh position is the physical jet location.
    value.translate(0, PLUME_LENGTH_M / 2, 0);
    return value;
  }, []);
  const materials = useMemo(
    () => DRACO_THRUSTER_GEOMETRY.map((_, index) => new ShaderMaterial({
      uniforms: {
        duty: { value: 0 },
        time: { value: 0 },
        phase: { value: index * 1.618 },
      },
      vertexShader: PLUME_VERTEX_SHADER,
      fragmentShader: PLUME_FRAGMENT_SHADER,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    })),
    [],
  );
  const orientations = useMemo(
    () => DRACO_THRUSTER_GEOMETRY.map((jet) => {
      const exhaustDirection = new Vector3(
        -jet.direction_body[0],
        -jet.direction_body[1],
        -jet.direction_body[2],
      ).normalize();
      return new Quaternion().setFromUnitVectors(BODY_UP, exhaustDirection);
    }),
    [],
  );

  useFrame((state) => {
    const current = renderStateRef.current;
    if (current === null) return;
    for (let index = 0; index < DRACO_THRUSTER_GEOMETRY.length; index += 1) {
      const mesh = meshRefs.current[index];
      const material = materials[index];
      if (mesh === null || material === undefined) continue;
      const requestedDuty = current.thruster_duty[DRACO_THRUSTER_GEOMETRY[index]!.id] ?? 0;
      const duty = Math.max(0, Math.min(1, requestedDuty));
      mesh.visible = duty > 0;
      mesh.scale.set(0.75 + 0.25 * duty, 0.35 + 0.65 * duty, 0.75 + 0.25 * duty);
      material.uniforms.duty!.value = duty;
      material.uniforms.time!.value = state.clock.elapsedTime;
    }
  });

  if (!hasRenderState) return null;

  return (
    <group>
      {DRACO_THRUSTER_GEOMETRY.map((jet, index) => (
        <mesh
          key={jet.id}
          ref={(mesh) => { meshRefs.current[index] = mesh; }}
          geometry={geometry}
          material={materials[index]}
          position={jet.position_body_m}
          quaternion={orientations[index]}
          scale={[0, 0, 0]}
        />
      ))}
    </group>
  );
}
