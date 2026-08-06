import { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { Earth } from './Earth';
import { Effects } from './Effects';
import { CameraRig } from './CameraRig';
import { DockingCameraPass } from './DockingCameraPiP';
import { Spacecraft } from './Spacecraft';
import { Starfield } from './Starfield';
import { SUN_DIR, SUN_LIGHT_DISTANCE_M } from './sun';

/**
 * Scene composition. Scene units = meters in the Hill frame (origin at the
 * target COM). The camera frames the chaser's approach axis with the target
 * ahead and the Earth limb (−x̂, see Earth.tsx scaled group) in shot.
 * Logarithmic depth buffer + Earth view-scaling keep meter-scale craft and
 * the planet coexisting without z-fighting.
 */
export function SceneRoot() {
  return (
    <Canvas
      dpr={[1, 1.75]}
      gl={{ logarithmicDepthBuffer: true, powerPreference: 'high-performance', antialias: true }}
      camera={{ position: [40, -320, 60], fov: 45, near: 0.5, far: 5.0e7 }}
      onCreated={({ camera }) => camera.lookAt(0, -80, 0)}
    >
      <Suspense fallback={null}>
        <Starfield />
        <Earth />
      </Suspense>
      <directionalLight
        position={[
          SUN_DIR.x * SUN_LIGHT_DISTANCE_M,
          SUN_DIR.y * SUN_LIGHT_DISTANCE_M,
          SUN_DIR.z * SUN_LIGHT_DISTANCE_M,
        ]}
        intensity={2.4}
        color="#fff6e8"
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
