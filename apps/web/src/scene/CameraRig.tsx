import { useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three';
import { conjugateQuaternion, rotateVector } from '@docking/sim-core';
import { useTelemetryBus } from '../telemetry/bus';
import { useViewStore } from '../viewStore';

const CINEMATIC_POSITION = new Vector3(40, -320, 60);
const CINEMATIC_TARGET = new Vector3(0, -80, 0);
const CHASE_OFFSET_BODY: [number, number, number] = [10, -32, 14];
const COCKPIT_OFFSET_BODY: [number, number, number] = [0, 1.5, 0];

/** Camera controller for cinematic, attitude-aware chase, and cockpit views. */
export function CameraRig() {
  const { camera } = useThree();
  const mode = useViewStore((state) => state.mode);
  const renderState = useTelemetryBus((state) => state.renderState);

  useFrame((_, dt) => {
    if (mode === 'CINEMATIC') {
      camera.near = 0.5;
      camera.updateProjectionMatrix();
      camera.position.lerp(CINEMATIC_POSITION, 1 - Math.exp(-3 * dt));
      camera.up.set(0, 0, 1);
      camera.lookAt(CINEMATIC_TARGET);
      return;
    }
    if (!renderState) return;
    const q_HB = conjugateQuaternion(renderState.q_BH);
    const chaser = new Vector3(...renderState.r_hill_m);
    const bodyForward = new Vector3(...rotateVector(q_HB, [0, 1, 0]));
    const bodyUp = new Vector3(...rotateVector(q_HB, [0, 0, 1]));
    const bodyOffset = mode === 'CHASE' ? CHASE_OFFSET_BODY : COCKPIT_OFFSET_BODY;
    const desiredPosition = chaser.clone().add(new Vector3(...rotateVector(q_HB, bodyOffset)));
    camera.position.lerp(desiredPosition, 1 - Math.exp(-(mode === 'CHASE' ? 3 : 10) * dt));
    camera.near = mode === 'COCKPIT' ? 0.05 : 0.5;
    camera.updateProjectionMatrix();
    camera.up.copy(bodyUp);
    const target = mode === 'CHASE'
      ? chaser
      : camera.position.clone().add(bodyForward.multiplyScalar(20));
    camera.lookAt(target);
  });

  return null;
}
