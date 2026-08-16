import { useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three';
import { conjugateQuaternion, rotateVector } from '@docking/sim-core';
import { useTelemetryBus } from '../telemetry/bus';
import { useViewStore } from '../viewStore';

const STATION_PORT = new Vector3(0, -8.7, 0);
const COCKPIT_OFFSET_BODY: [number, number, number] = [0, 1.5, 0];

function orbitOffset(azimuth_rad: number, elevation_rad: number, distance_m: number): Vector3 {
  const horizontal = Math.cos(elevation_rad) * distance_m;
  return new Vector3(
    Math.sin(azimuth_rad) * horizontal,
    -Math.cos(azimuth_rad) * horizontal,
    Math.sin(elevation_rad) * distance_m,
  );
}

/** Camera controller for attitude-independent orbit views and the cockpit. */
export function CameraRig() {
  const { camera } = useThree();
  const mode = useViewStore((state) => state.mode);
  const orbit = useViewStore((state) => state.orbits[state.mode]);
  const renderState = useTelemetryBus((state) => state.renderState);

  useFrame((_, dt) => {
    if (!renderState) return;
    const chaser = new Vector3(...renderState.r_hill_m);

    if (mode === 'COCKPIT') {
      const q_HB = conjugateQuaternion(renderState.q_BH);
      const bodyForward = new Vector3(...rotateVector(q_HB, [0, 1, 0]));
      const bodyUp = new Vector3(...rotateVector(q_HB, [0, 0, 1]));
      const desiredPosition = chaser.clone().add(new Vector3(...rotateVector(q_HB, COCKPIT_OFFSET_BODY)));
      camera.position.lerp(desiredPosition, 1 - Math.exp(-10 * dt));
      camera.near = 0.05;
      camera.updateProjectionMatrix();
      camera.up.copy(bodyUp);
      camera.lookAt(camera.position.clone().add(bodyForward.multiplyScalar(20)));
      return;
    }

    camera.near = 0.5;
    camera.updateProjectionMatrix();
    const desiredPosition = chaser.clone().add(orbitOffset(
      orbit.azimuth_rad,
      orbit.elevation_rad,
      orbit.distance_m,
    ));
    camera.position.lerp(desiredPosition, 1 - Math.exp(-(mode === 'CINEMATIC' ? 2 : 3) * dt));
    camera.up.set(0, 0, 1);
    if (mode === 'CHASE' || mode === 'DEBUG') {
      // DEBUG shares the chase framing (look at the craft) but with the
      // unclamped orbit range from viewStore for inspecting Earth and clouds.
      camera.lookAt(chaser);
    } else {
      // Keep the cinematic framing on the approach corridor rather than on
      // the vehicle alone: the target is 70% of the way from chaser to port.
      const between = chaser.clone().lerp(STATION_PORT, 0.7);
      camera.lookAt(between);
    }
  });

  return null;
}
