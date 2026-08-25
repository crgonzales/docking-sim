import { useFrame, useThree } from '@react-three/fiber';
import { useRef } from 'react';
import { Vector3 } from 'three';
import { conjugateQuaternion, rotateVector } from '@docking/sim-core';
import { useTelemetryBus } from '../telemetry/bus';
import { useViewStore } from '../viewStore';
import {
  CAMERA_NEAR,
  CAMERA_FAR,
  COCKPIT_CAMERA_NEAR,
  EARTH_CENTER_DISTANCE_M,
  EARTH_RADIUS_M,
  flySpeedMpsFromAgl,
  SKY_CONFIG,
} from './sky/skyConfig';
import { WorldFrame, type WorldPositionF64 } from './worldFrame';
import { heightAboveGround, type HeightField } from './terrain/heightField';
import type { TerrainTileSource } from './terrain/tileSource';
import {
  clampFlyPositionToGround,
  flyBasisFromPosition,
  flyForward,
  flyPoseFromDirection,
  stepFlyPosition,
} from './flyCamera';

const STATION_PORT = new Vector3(0, -8.7, 0);
const COCKPIT_OFFSET_BODY: [number, number, number] = [0, 1.5, 0];
const EARTH_CENTER_WORLD: WorldPositionF64 = [-EARTH_CENTER_DISTANCE_M, 0, 0];

function orbitOffset(azimuth_rad: number, elevation_rad: number, distance_m: number): Vector3 {
  const horizontal = Math.cos(elevation_rad) * distance_m;
  return new Vector3(
    Math.sin(azimuth_rad) * horizontal,
    -Math.cos(azimuth_rad) * horizontal,
    Math.sin(elevation_rad) * distance_m,
  );
}

/** Camera controller for attitude-independent orbit views and the cockpit. */
export interface CameraRigProps {
  worldFrame: WorldFrame;
  terrainSourceRef: { current: TerrainTileSource | null };
}

export function CameraRig({ worldFrame, terrainSourceRef }: CameraRigProps) {
  const { camera } = useThree();
  const mode = useViewStore((state) => state.mode);
  const debugSubmode = useViewStore((state) => state.debugSubmode);
  const orbit = useViewStore((state) => state.orbits[state.mode]);
  const renderState = useTelemetryBus((state) => state.renderState);
  const previousDebugSubmode = useRef(debugSubmode);

  const cameraGround = (positionWorld: WorldPositionF64): { aglM: number; groundHeightM: number } | null => {
    const source = terrainSourceRef.current;
    if (source === null) return null;
    const relative: [number, number, number] = [
      positionWorld[0] - EARTH_CENTER_WORLD[0],
      positionWorld[1] - EARTH_CENTER_WORLD[1],
      positionWorld[2] - EARTH_CENTER_WORLD[2],
    ];
    const field: HeightField = {
      tiles: source,
      level: source.manifest.maxLevel,
      detail: SKY_CONFIG.terrain.detail,
    };
    const aglM = heightAboveGround(relative, field, EARTH_RADIUS_M);
    if (aglM === null) return null;
    const altitudeM = Math.hypot(relative[0], relative[1], relative[2]) - EARTH_RADIUS_M;
    return { aglM, groundHeightM: altitudeM - aglM };
  };

  useFrame((_, dt) => {
    if (mode === 'DEBUG' && debugSubmode === 'FLY') {
      let fly = useViewStore.getState();
      if (previousDebugSubmode.current !== 'FLY') {
        const cameraWorld = worldFrame.toWorld([camera.position.x, camera.position.y, camera.position.z]);
        const direction = camera.getWorldDirection(new Vector3());
        const pose = flyPoseFromDirection(
          [direction.x, direction.y, direction.z],
          flyBasisFromPosition(cameraWorld, EARTH_CENTER_WORLD).up,
        );
        fly.setFlyPose(cameraWorld, pose.yawRad, pose.pitchRad);
        fly = useViewStore.getState();
      }

      const groundBeforeMove = cameraGround(fly.flyPositionM);
      const fallbackAgl = Math.max(
        Math.hypot(
          fly.flyPositionM[0] - EARTH_CENTER_WORLD[0],
          fly.flyPositionM[1] - EARTH_CENTER_WORLD[1],
          fly.flyPositionM[2] - EARTH_CENTER_WORLD[2],
        ) - EARTH_RADIUS_M,
        0,
      );
      const speed = flySpeedMpsFromAgl(groundBeforeMove?.aglM ?? fallbackAgl);
      const moved = stepFlyPosition(
        fly.flyPositionM,
        fly.flyMoveInput,
        fly.flyYawRad,
        fly.flyPitchRad,
        speed,
        dt,
        EARTH_CENTER_WORLD,
      );
      const groundAfterMove = cameraGround(moved);
      const clamped = groundAfterMove === null
        ? moved
        : clampFlyPositionToGround(
          moved,
          EARTH_RADIUS_M,
          groundAfterMove.groundHeightM,
          SKY_CONFIG.flyCollisionClearanceM,
        );
      if (clamped[0] !== fly.flyPositionM[0]
        || clamped[1] !== fly.flyPositionM[1]
        || clamped[2] !== fly.flyPositionM[2]) {
        fly.setFlyPosition(clamped);
      }
      fly = useViewStore.getState();

      camera.near = CAMERA_NEAR;
      camera.far = CAMERA_FAR;
      camera.updateProjectionMatrix();
      const basis = flyBasisFromPosition(fly.flyPositionM, EARTH_CENTER_WORLD);
      camera.up.set(basis.up[0], basis.up[1], basis.up[2]);
      const renderPosition = worldFrame.toRender(fly.flyPositionM);
      camera.position.set(renderPosition[0], renderPosition[1], renderPosition[2]);
      const forward = flyForward(fly.flyYawRad, fly.flyPitchRad, basis.up);
      const lookAtWorld: WorldPositionF64 = [
        fly.flyPositionM[0] + forward[0] * 100,
        fly.flyPositionM[1] + forward[1] * 100,
        fly.flyPositionM[2] + forward[2] * 100,
      ];
      const lookAtRender = worldFrame.toRender(lookAtWorld);
      camera.lookAt(new Vector3(lookAtRender[0], lookAtRender[1], lookAtRender[2]));
      previousDebugSubmode.current = debugSubmode;
      return;
    }
    previousDebugSubmode.current = debugSubmode;
    if (!renderState) return;
    const chaser = new Vector3(...renderState.r_hill_m);
    const chaserWorld: WorldPositionF64 = [chaser.x, chaser.y, chaser.z];

    if (mode === 'COCKPIT') {
      const q_HB = conjugateQuaternion(renderState.q_BH);
      const bodyForward = new Vector3(...rotateVector(q_HB, [0, 1, 0]));
      const bodyUp = new Vector3(...rotateVector(q_HB, [0, 0, 1]));
      const desiredWorld = chaser.clone().add(new Vector3(...rotateVector(q_HB, COCKPIT_OFFSET_BODY)));
      const desiredRender = worldFrame.toRender([desiredWorld.x, desiredWorld.y, desiredWorld.z]);
      camera.position.lerp(new Vector3(...desiredRender), 1 - Math.exp(-10 * dt));
      camera.near = COCKPIT_CAMERA_NEAR;
      camera.far = CAMERA_FAR;
      camera.updateProjectionMatrix();
      camera.up.copy(bodyUp);
      const lookAtWorld = desiredWorld.clone().add(bodyForward.multiplyScalar(20));
      const lookAtRender = worldFrame.toRender([lookAtWorld.x, lookAtWorld.y, lookAtWorld.z]);
      camera.lookAt(new Vector3(...lookAtRender));
      return;
    }

    camera.near = CAMERA_NEAR;
    camera.far = CAMERA_FAR;
    camera.updateProjectionMatrix();
    const desiredWorld = chaser.clone().add(orbitOffset(
      orbit.azimuth_rad,
      orbit.elevation_rad,
      orbit.distance_m,
    ));
    const desiredRender = worldFrame.toRender([desiredWorld.x, desiredWorld.y, desiredWorld.z]);
    camera.position.lerp(new Vector3(...desiredRender), 1 - Math.exp(-(mode === 'CINEMATIC' ? 2 : 3) * dt));
    camera.up.set(0, 0, 1);
    if (mode === 'CHASE' || mode === 'DEBUG') {
      // DEBUG shares the chase framing (look at the craft) but with the
      // unclamped orbit range from viewStore for inspecting Earth and clouds.
      const lookAt = worldFrame.toRender(chaserWorld);
      camera.lookAt(new Vector3(...lookAt));
    } else {
      // Keep the cinematic framing on the approach corridor rather than on
      // the vehicle alone: the target is 70% of the way from chaser to port.
      const between = chaser.clone().lerp(STATION_PORT, 0.7);
      const lookAt = worldFrame.toRender([between.x, between.y, between.z]);
      camera.lookAt(new Vector3(...lookAt));
    }
  });

  return null;
}
