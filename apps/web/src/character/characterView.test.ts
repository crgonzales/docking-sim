import { expect, it } from 'vitest';
import { characterCameraPose } from './characterView';
import { EARTH_CENTER_DISTANCE_M, EARTH_RADIUS_M } from '../scene/sky/skyConfig';
import { WorldFrame } from '../scene/worldFrame';

it('keeps a radial 1.7 m eye clearance in the translated planet and floating render frame', () => {
  const feet: [number, number, number] = [7 * Math.PI / 180 * EARTH_RADIUS_M, 30, -120];
  const pose = characterCameraPose(feet, 0, 0);
  expect(Math.hypot(pose.eyeWorld[0] + EARTH_CENTER_DISTANCE_M, pose.eyeWorld[1], pose.eyeWorld[2])).toBeCloseTo(EARTH_RADIUS_M + 121.7, 7);
  expect(Math.hypot(...pose.forwardWorld)).toBeCloseTo(1, 12);
  expect(pose.forwardWorld.reduce((sum, x, i) => sum + x * pose.upWorld[i], 0)).toBeCloseTo(0, 12);
  const frame = new WorldFrame([0, 0, 0]); frame.rebase(pose.eyeWorld);
  expect(frame.toRender(pose.eyeWorld)).toEqual([0, 0, 0]);
});

it('looks north/east in the flight world convention and stays nonsingular at the pitch limits', () => {
  const north = characterCameraPose([0, 0, -100], 0, 0);
  north.forwardWorld.forEach((x, i) => expect(x).toBeCloseTo([0, 1, 0][i], 12));
  const east = characterCameraPose([0, 0, -100], Math.PI / 2, 0);
  east.forwardWorld.forEach((x, i) => expect(x).toBeCloseTo([0, 0, -1][i], 12));
  for (const pitch of [-100, 100]) {
    const pose = characterCameraPose([0, 0, -100], 20 * Math.PI, pitch);
    const alignment = pose.forwardWorld.reduce((sum, x, i) => sum + x * pose.upWorld[i], 0);
    expect(Math.abs(alignment)).toBeLessThan(0.999);
    expect(Math.hypot(...pose.forwardWorld)).toBeCloseTo(1, 12);
  }
});
