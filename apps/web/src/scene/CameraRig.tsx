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
  const lastKnownGroundHeightM = useRef<number | null>(null);
  const lastSeenFlyPoseEpoch = useRef(useViewStore.getState().flyPoseEpoch);

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
          fly.setFlyPose(cameraWorld, pose.yawRad, pose.pitchRad);
          fly = useViewStore.getState();
          lastSeenFlyPoseEpoch.current = fly.flyPoseEpoch;
        }
        // Entering FLY can land anywhere (the debug orbit camera may have
        // been panned across the globe first) — a ground height memorized
        // from wherever FLY was last active would be wrong here, so treat
        // this like a fresh cold start until the new position resolves.
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
      // While the resident tile at this position is unresolved, clamp
      // against the last known local ground height so a momentary gap
      // during normal flight doesn't move the camera. If ground has never
      // resolved at all this session (cold start, or a `?flyto=` teleport
      // outrunning the quadtree), skip the clamp rather than guessing: an
      // Earth-wide conservative floor (tried previously) only ever pushes
      // the camera UP, never back down once real (lower) ground data
      // arrives, permanently stranding any low-altitude spawn far above
      // where it was asked to be. Leaving the raw position unclamped for
      // this brief window can show a frame or two of unloaded terrain —
      // cosmetic, and no worse than the pre-existing loading state — but
      // never strands the camera once the coordinate-frame fix above keeps
      // the clamp itself correct for every frame after ground resolves.
      const groundHeightM = groundBeforeMove?.groundHeightM ?? lastKnownGroundHeightM.current;
      const target: WorldPositionF64 = groundHeightM === null
        ? moved
        : (() => {
          // clampFlyPositionToGround measures radius from the planet
          // centre, but `moved` is a world (station-origin) position —
          // convert in and back out, the same way cameraGround() already
          // does for height sampling.
          const movedRelative: WorldPositionF64 = [
            moved[0] - EARTH_CENTER_WORLD[0],
            moved[1] - EARTH_CENTER_WORLD[1],
            moved[2] - EARTH_CENTER_WORLD[2],
          ];
          const clampedRelative = clampFlyPositionToGround(
            movedRelative,
            EARTH_RADIUS_M,
            groundHeightM,
            SKY_CONFIG.flyCollisionClearanceM,
          );
          return [
            clampedRelative[0] + EARTH_CENTER_WORLD[0],
            clampedRelative[1] + EARTH_CENTER_WORLD[1],
            clampedRelative[2] + EARTH_CENTER_WORLD[2],
          ];
        })();
      if (target[0] !== fly.flyPositionM[0]
        || target[1] !== fly.flyPositionM[1]
        || target[2] !== fly.flyPositionM[2]) {
        fly.setFlyPosition(target);
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
