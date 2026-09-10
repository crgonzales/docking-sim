import { describe, expect, it } from 'vitest';
import { stepFlyPosition, type FlyVector3 } from './flyCamera';
import { directionFromGeodetic, parseFlytoParam } from './flytoParam';
import {
  beginFlySpawnCorrection,
  groundClampedFlyPosition,
  trackFlySpawnCorrection,
  type FlyGroundPose,
  type FlySpawnGroundCorrection,
} from './flySpawnGroundCorrection';
import { EARTH_CENTER_DISTANCE_M, EARTH_RADIUS_M, SKY_CONFIG } from './sky/skyConfig';
import {
  DEFAULT_TERRAIN_RGB_CODEC,
  residentTileMap,
  sampleResidentTerrain,
  type TerrainTile,
} from './terrain/heightField';
import { addressFromDirection, nodeAddressKey } from './terrain/quadtree';

const CENTER: FlyVector3 = [-EARTH_CENTER_DISTANCE_M, 0, 0];
const LAT_DEG = 46.472;
const LON_DEG = -73.6077;

function teleport(altitudeM = 459, epoch = 1, latDeg = LAT_DEG): FlyGroundPose {
  const spawn = parseFlytoParam(`?flyto=${latDeg},${LON_DEG},${altitudeM}`)!;
  return {
    mode: 'DEBUG', debugSubmode: 'FLY', flyPositionM: spawn.positionM,
    flyPoseEpoch: epoch, flyYawRad: spawn.yawRad, flyPitchRad: spawn.pitchRad,
    flyMoveInput: [0, 0, 0],
  };
}

function altitude(position: FlyVector3): number {
  return Math.hypot(position[0] - CENTER[0], position[1], position[2]) - EARTH_RADIUS_M;
}

function clamp(position: FlyVector3, ground: number | null, correction: FlySpawnGroundCorrection | null): FlyVector3 {
  return groundClampedFlyPosition(
    position, ground, CENTER, EARTH_RADIUS_M, SKY_CONFIG.flyCollisionClearanceM, correction,
  );
}

describe('teleport ground refinement', () => {
  it('removes the Canadian spawn lift when a fine tile replaces the resident ancestor', () => {
    const pose = teleport();
    const correction = beginFlySpawnCorrection(pose);
    const direction = directionFromGeodetic(LAT_DEG, LON_DEG);
    const tiles = new Map<string, TerrainTile>();
    const insert = (level: number, ground: number): void => {
      const address = addressFromDirection(direction, level);
      tiles.set(nodeAddressKey(address), {
        address, width: 1, height: 1, codec: DEFAULT_TERRAIN_RGB_CODEC,
        data: new Float32Array([ground]),
      });
    };
    const residentGround = (): number | null => sampleResidentTerrain(
      LAT_DEG * Math.PI / 180, LON_DEG * Math.PI / 180, residentTileMap(tiles), 12,
    );

    expect(clamp(pose.flyPositionM, residentGround(), correction)).toBe(pose.flyPositionM);
    insert(0, 510);
    insert(12, Number.NaN); // An unresolved child still selects its coarse ancestor.
    const lifted = clamp(pose.flyPositionM, residentGround(), correction);
    expect(altitude(lifted)).toBeCloseTo(512, 6);
    insert(12, 457);
    const refined = clamp(lifted, residentGround(), correction);
    expect(altitude(refined)).toBeCloseTo(459, 6);
    for (let axis = 0; axis < 3; axis += 1) {
      expect(refined[axis]).toBeCloseTo(pose.flyPositionM[axis], 6);
      // The lift changes only radius about Earth's offset centre.
      expect((lifted[axis] - CENTER[axis]) / (EARTH_RADIUS_M + 512))
        .toBeCloseTo(direction[axis], 12);
    }
  });

  it.each([
    { requested: 50, expected: 459 },
    { requested: 480, expected: 480 },
    { requested: 600, expected: 600 },
  ])('preserves a requested altitude of $requested m and converges with a warm spawn', ({ requested, expected }) => {
    const pose = teleport(requested);
    const correction = beginFlySpawnCorrection(pose);
    const lifted = clamp(pose.flyPositionM, 510, correction);
    const refined = clamp(lifted, 457, correction);
    const warm = clamp(pose.flyPositionM, 457, beginFlySpawnCorrection(pose));
    expect(altitude(lifted)).toBeCloseTo(Math.max(requested, 512), 6);
    expect(altitude(refined)).toBeCloseTo(expected, 6);
    expect(refined).toEqual(warm);
  });

  it('does not invent a floor or undo a safe lift while ground is unresolved', () => {
    const pose = teleport(50);
    const correction = beginFlySpawnCorrection(pose);
    expect(clamp(pose.flyPositionM, null, correction)).toBe(pose.flyPositionM);
    const lifted = clamp(pose.flyPositionM, 510, correction);
    expect(clamp(lifted, null, correction)).toBe(lifted);
    expect(altitude(clamp(lifted, 457, correction))).toBeCloseTo(459, 6);
  });

  it('retains the existing sea-level floor for negative bathymetry', () => {
    const pose = teleport(0);
    const correction = beginFlySpawnCorrection(pose);
    const lifted = clamp(pose.flyPositionM, 510, correction);
    expect(altitude(clamp(lifted, -500, correction))).toBeCloseTo(SKY_CONFIG.flyCollisionClearanceM, 6);
  });
});

describe('ownership of a spawn ground lift', () => {
  it('survives its own position writes, idle input ticks, and unrelated state updates', () => {
    const pose = teleport();
    const correction = beginFlySpawnCorrection(pose);
    const afterClamp = { ...pose, flyPositionM: clamp(pose.flyPositionM, 510, correction) };
    let tracked = trackFlySpawnCorrection(correction, pose, afterClamp, true);
    expect(tracked).toBe(correction);
    const idleTick: FlyGroundPose = { ...afterClamp, flyMoveInput: [0, 0, 0] };
    tracked = trackFlySpawnCorrection(tracked, afterClamp, idleTick);
    const unrelatedUpdate = { ...idleTick, keybindsOpen: true };
    tracked = trackFlySpawnCorrection(tracked, idleTick, unrelatedUpdate);
    expect(tracked).toBe(correction);
    expect(altitude(clamp(afterClamp.flyPositionM, 457, tracked))).toBeCloseTo(459, 6);
  });

  it('cancels on a movement press even if the key is released before the next frame', () => {
    const pose = teleport();
    const correction = beginFlySpawnCorrection(pose);
    const lifted = { ...pose, flyPositionM: clamp(pose.flyPositionM, 510, correction) };
    const pressed: FlyGroundPose = { ...lifted, flyMoveInput: [0, 1, 0] };
    let tracked = trackFlySpawnCorrection(correction, lifted, pressed);
    expect(tracked).toBeNull();
    const moved = stepFlyPosition(
      pressed.flyPositionM, pressed.flyMoveInput, pressed.flyYawRad, pressed.flyPitchRad, 10, 0.25, CENTER,
    );
    const released: FlyGroundPose = { ...pressed, flyMoveInput: [0, 0, 0] };
    tracked = trackFlySpawnCorrection(tracked, pressed, released);
    expect(tracked).toBeNull();
    expect(clamp(moved, 457, tracked)).toBe(moved);
    expect(moved).not.toEqual(lifted.flyPositionM);
  });

  it.each(['flyYawRad', 'flyPitchRad'] as const)('cancels on %s steering', key => {
    const pose = teleport();
    const correction = beginFlySpawnCorrection(pose);
    const lifted = { ...pose, flyPositionM: clamp(pose.flyPositionM, 510, correction) };
    const steered = { ...lifted, [key]: lifted[key] + 0.1 };
    const tracked = trackFlySpawnCorrection(correction, lifted, steered);
    expect(tracked).toBeNull();
    expect(clamp(steered.flyPositionM, 457, tracked)).toBe(steered.flyPositionM);
  });

  it.each(['same position', 'higher altitude', 'different location'] as const)(
    'cancels a continuous external update with no pose epoch: %s', command => {
      const pose = teleport();
      const correction = beginFlySpawnCorrection(pose);
      const lifted = { ...pose, flyPositionM: clamp(pose.flyPositionM, 510, correction) };
      const commanded: FlyVector3 = command === 'same position' ? [...lifted.flyPositionM]
        : teleport(600, 1, command === 'different location' ? 47 : LAT_DEG).flyPositionM;
      const external = { ...lifted, flyPositionM: commanded };
      const tracked = trackFlySpawnCorrection(correction, lifted, external);
      expect(tracked).toBeNull();
      expect(clamp(commanded, 457, tracked)).toBe(commanded);
      // Normal collision protection still lifts, but it cannot later lower flight.
      const higherGround = clamp(commanded, 700, tracked);
      expect(altitude(higherGround)).toBeCloseTo(702, 6);
      expect(clamp(higherGround, 457, tracked)).toBe(higherGround);
    },
  );

  it.each([{ mode: 'CHASE' }, { debugSubmode: 'ORBIT' }])('cancels a mode change: %o', change => {
    const pose = teleport();
    const exited = { ...pose, ...change };
    const cancelled = trackFlySpawnCorrection(beginFlySpawnCorrection(pose), pose, exited);
    expect(cancelled).toBeNull();
    expect(trackFlySpawnCorrection(cancelled, exited, pose)).toBeNull();
  });

  it('replaces the old lift baseline on a new teleport, even after movement cancelled it', () => {
    const oldPose = teleport(50);
    const oldCorrection = beginFlySpawnCorrection(oldPose);
    const lifted = { ...oldPose, flyPositionM: clamp(oldPose.flyPositionM, 510, oldCorrection) };
    const nextPose = teleport(120, 2, 47);
    for (const prior of [oldCorrection, null]) {
      const correction = trackFlySpawnCorrection(prior, lifted, nextPose);
      expect(correction?.requestedPositionM).toBe(nextPose.flyPositionM);
      expect(clamp(nextPose.flyPositionM, null, correction)).toBe(nextPose.flyPositionM);
      const nextLift = clamp(nextPose.flyPositionM, 300, correction);
      expect(altitude(nextLift)).toBeCloseTo(302, 6);
      const refined = clamp(nextLift, 100, correction);
      expect(refined).toBe(nextPose.flyPositionM);
      expect(altitude(refined)).toBeCloseTo(120, 6);
    }
  });

  it('does not arm ordinary flight entry or a teleport with active movement', () => {
    const pose = teleport();
    expect(beginFlySpawnCorrection({ ...pose, flyPoseEpoch: 0 })).toBeNull();
    expect(beginFlySpawnCorrection({ ...pose, mode: 'CHASE' })).toBeNull();
    expect(beginFlySpawnCorrection({ ...pose, debugSubmode: 'ORBIT' })).toBeNull();
    expect(beginFlySpawnCorrection({ ...pose, flyMoveInput: [1, 0, 0] })).toBeNull();
    const previous = { ...pose, flyPoseEpoch: 0 };
    // CameraRig derives an ordinary FLY pose from the render camera internally.
    expect(trackFlySpawnCorrection(null, previous, pose, true)).toBeNull();
  });
});
