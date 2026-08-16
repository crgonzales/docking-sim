import { Suspense, useEffect, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Color } from 'three';
import { Earth } from './Earth';
import { Effects } from './Effects';
import { CameraRig } from './CameraRig';
import { DockingCameraPass } from './DockingCameraPiP';
import { Spacecraft } from './Spacecraft';
import { Starfield } from './Starfield';
import { SunSprite } from './SunSprite';
import { SUN_DIR, SUN_LIGHT_DISTANCE_M } from './sun';
import {
  ATMOSPHERE_TRANSMITTANCE_LUT_PATH,
  SKY_CONFIG,
} from './sky/skyConfig';
import {
  sampleTransmittanceLut,
  TRANSMITTANCE_LUT_SIZE,
} from './sky/atmosphereMath';

function useSunExtinctionTint(): Color {
  const [sunTint, setSunTint] = useState(() => new Color(1, 1, 1));

  useEffect(() => {
    let mounted = true;
    fetch(ATMOSPHERE_TRANSMITTANCE_LUT_PATH)
      .then((response) => {
        if (!response.ok) throw new Error(`Unable to load ${ATMOSPHERE_TRANSMITTANCE_LUT_PATH}`);
        return response.arrayBuffer();
      })
      .then((buffer) => {
        const data = new Float32Array(buffer);
        // The fixed SUN_DIR is evaluated at the representative subsolar point
        // and the operating cloud-deck altitude. Normalize red to preserve
        // light intensity while retaining the LUT's atmospheric warmth.
        const transmittance = sampleTransmittanceLut(
          data,
          TRANSMITTANCE_LUT_SIZE,
          SKY_CONFIG.deckAltitudeKm,
          SUN_DIR.dot(SUN_DIR),
          SKY_CONFIG.atmosphere,
        );
        const scale = Math.max(transmittance[0], Number.EPSILON);
        if (mounted) setSunTint(new Color(
          transmittance[0] / scale,
          transmittance[1] / scale,
          transmittance[2] / scale,
        ));
      })
      .catch(() => {
        // White is the neutral fallback until the committed table is available.
      });
    return () => {
      mounted = false;
    };
  }, []);

  return sunTint;
}

/**
 * Scene composition. Scene units = meters in the Hill frame (origin at the
 * target COM). The camera frames the chaser's approach axis with the target
 * ahead and the Earth limb (−x̂, see Earth.tsx scaled group) in shot.
 * Logarithmic depth buffer + Earth view-scaling keep meter-scale craft and
 * the planet coexisting without z-fighting.
 */
export function SceneRoot() {
  const sunTint = useSunExtinctionTint();

  return (
    <Canvas
      dpr={[1, 1.75]}
      gl={{ logarithmicDepthBuffer: true, powerPreference: 'high-performance', antialias: true }}
      camera={{ position: [40, -320, 60], fov: 45, near: 0.5, far: 5.0e7 }}
      onCreated={({ camera }) => camera.lookAt(0, -80, 0)}
    >
      <Suspense fallback={null}>
        <Starfield />
        <SunSprite sunTint={sunTint} />
        <Earth />
      </Suspense>
      <directionalLight
        position={[
          SUN_DIR.x * SUN_LIGHT_DISTANCE_M,
          SUN_DIR.y * SUN_LIGHT_DISTANCE_M,
          SUN_DIR.z * SUN_LIGHT_DISTANCE_M,
        ]}
        intensity={2.4}
        color={sunTint}
      />
      {/* faint earthshine so the night side of the craft isn't pure black */}
      <ambientLight intensity={0.06} color="#7d9bff" />
      <Spacecraft />
      <CameraRig />
      <DockingCameraPass />
      <Effects />
    </Canvas>
  );
}
