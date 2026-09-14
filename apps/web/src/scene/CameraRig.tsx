import { useFrame, useThree } from '@react-three/fiber';
import { useLayoutEffect, useRef } from 'react';
import { Vector3 } from 'three';
import { conjugateQuaternion, rotateVector } from '@docking/sim-core';
import { useTelemetryBus } from '../telemetry/bus';
import { useViewStore } from '../viewStore';
import { useAppModeStore } from '../appModeStore';
import { useScenarioStore } from '../telemetry/scenarioStore';
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
import { renderTimings } from './renderTimings';
import { heightAboveGround, type HeightField } from './terrain/heightField';
import type { TerrainTileSource } from './terrain/tileSource';
import {
  flyBasisFromPosition,
  flyForward,
  flyPoseFromDirection,
  stepFlyPosition,
} from './flyCamera';
import {
  beginFlySpawnCorrection,
  groundClampedFlyPosition,
  trackFlySpawnCorrection,
} from './flySpawnGroundCorrection';

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
  const lastKnownGroundHeightM = useRef<number | null>(null);
  const lastSeenFlyPoseEpoch = useRef(useViewStore.getState().flyPoseEpoch);
  const lastObservedFlyState = useRef(useViewStore.getState());
  const spawnGroundCorrection = useRef(beginFlySpawnCorrection(lastObservedFlyState.current));
  const cameraOwnedFlyWrite = useRef(false);

  useLayoutEffect(() => {
    const observe = (next: ReturnType<typeof useViewStore.getState>): void => {
      spawnGroundCorrection.current = trackFlySpawnCorrection(
        spawnGroundCorrection.current, lastObservedFlyState.current, next, cameraOwnedFlyWrite.current,
      );
      lastObservedFlyState.current = next;
    };
    const unsubscribe = useViewStore.subscribe(observe);
    // Cover a deep-link pose published between mounting and subscribing.
    observe(useViewStore.getState());
    return unsubscribe;
  }, []);

  const cameraGround = (positionWorld: WorldPositionF64): { aglM: number; groundHeightM: number } | null => {
    const startedAt = renderTimings.start('cameraRig.groundCpuWall');
    try {
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
    } finally {
      renderTimings.end('cameraRig.groundCpuWall', startedAt);
    }
  };

  useFrame((_, dt) => {
    const startedAt = renderTimings.start('cameraRig.frameCpuWall');
    try {
      if (mode === 'DEBUG' && debugSubmode === 'FLY') {
        let fly = useViewStore.getState();
        if (previousDebugSubmode.current !== 'FLY') {
          if (lastSeenFlyPoseEpoch.current !== fly.flyPoseEpoch) {
            // The pose was seeded externally (e.g. a `?flyto=` deep link)
            // since we last synced — trust it instead of overwriting it with
            // one derived from wherever the render camera currently sits,
            // which on a fresh spawn is still the default station transform.
            lastSeenFlyPoseEpoch.current = fly.flyPoseEpoch;
          } else {
            const cameraWorld = worldFrame.toWorld([camera.position.x, camera.position.y, camera.position.z]);
            const direction = camera.getWorldDirection(new Vector3());
            const pose = flyPoseFromDirection(
              [direction.x, direction.y, direction.z],
              flyBasisFromPosition(cameraWorld, EARTH_CENTER_WORLD).up,
            );
            // Entering normal flight is not a teleport to be lowered later.
            spawnGroundCorrection.current = null;
            cameraOwnedFlyWrite.current = true;
            try {
              fly.setFlyPose(cameraWorld, pose.yawRad, pose.pitchRad);
            } finally {
              cameraOwnedFlyWrite.current = false;
            }
            fly = useViewStore.getState();
            lastSeenFlyPoseEpoch.current = fly.flyPoseEpoch;
          }
          // Entering FLY can land anywhere (the debug orbit camera may have
          // been panned across the globe first) — a ground height memorized
          // from wherever FLY was last active would be wrong here, so treat
          // this like a fresh cold start until the new position resolves.
          lastKnownGroundHeightM.current = null;
        }

        // Teleports within FLY also change geography. A remembered mountain
        // height must not lift the next ocean/lowland pose while tiles load.
        if (lastSeenFlyPoseEpoch.current !== fly.flyPoseEpoch) {
          lastSeenFlyPoseEpoch.current = fly.flyPoseEpoch;
          lastKnownGroundHeightM.current = null;
        }

        // Sampled once, before the move, and reused for both the speed curve
        // and the post-move clamp below: a single WASD step covers at most
        // speed*dt, and flySpeedMpsFromAgl is slow near the ground (where
        // terrain height can vary meaningfully over a short hop) and fast
        // only far from it (where it can't) — so re-sampling after moving
        // would cost a second full terrain-height pipeline call per frame
        // (Newton inversion + multi-octave noise) for a negligible gain.
        const groundBeforeMove = cameraGround(fly.flyPositionM);
        if (groundBeforeMove !== null) lastKnownGroundHeightM.current = groundBeforeMove.groundHeightM;
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
        // Preserve the last local floor during brief residency gaps, and skip
        // unknown ground on a fresh teleport. An untouched teleport may undo
        // only its own coarse-ground lift when finer ground arrives. Ordinary
        // movement and external position commands retain the upward-only clamp.
        const groundHeightM = groundBeforeMove?.groundHeightM ?? lastKnownGroundHeightM.current;
        const target = groundClampedFlyPosition(
          moved, groundHeightM, EARTH_CENTER_WORLD, EARTH_RADIUS_M,
          SKY_CONFIG.flyCollisionClearanceM, spawnGroundCorrection.current,
        );
        if (target[0] !== fly.flyPositionM[0]
          || target[1] !== fly.flyPositionM[1]
          || target[2] !== fly.flyPositionM[2]) {
          cameraOwnedFlyWrite.current = true;
          try {
            fly.setFlyPosition(target);
          } finally {
            cameraOwnedFlyWrite.current = false;
          }
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
        const teaching = useAppModeStore.getState().mode === 'MISSION' && useScenarioStore.getState().selectedMission === 'FIRST_DOCKING';
        const between = chaser.clone().lerp(STATION_PORT, teaching ? 0.2 : 0.7);
        const lookAt = worldFrame.toRender([between.x, between.y, between.z]);
        camera.lookAt(new Vector3(...lookAt));
      }
    } finally {
      renderTimings.end('cameraRig.frameCpuWall', startedAt);
    }
  });

  return null;
}
