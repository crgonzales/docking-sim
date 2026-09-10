import { expect, it } from 'vitest';
import { flightWorldFrame } from './flightFrame';
import { EARTH_CENTER_DISTANCE_M, EARTH_RADIUS_M } from '../scene/sky/skyConfig';

it('maps equatorial N/E/D to world +Y/-Z/-X without reflections', () => {
  const frame = flightWorldFrame([0, 0, -1500]);
  expect(frame.position).toEqual([EARTH_RADIUS_M + 1500 - EARTH_CENTER_DISTANCE_M, 0, -0]);
  frame.direction([1, 0, 0]).forEach((v, i) => expect(v).toBeCloseTo([0, 1, 0][i], 14));
  frame.direction([0, 1, 0]).forEach((v, i) => expect(v).toBeCloseTo([0, 0, -1][i], 14));
  frame.direction([0, 0, 1]).forEach((v, i) => expect(v).toBeCloseTo([-1, 0, 0][i], 14));
});
it('preserves geometric altitude, orthogonality, lengths and handedness across the chart', () => {
  for (const north of [-30000, 0, 30000]) {
    const frame = flightWorldFrame([north, 25000, -800]);
    expect(Math.hypot(frame.position[0] + EARTH_CENTER_DISTANCE_M, frame.position[1], frame.position[2]) - EARTH_RADIUS_M).toBeCloseTo(800, 8);
    const n = frame.direction([1, 0, 0]), e = frame.direction([0, 1, 0]), d = frame.direction([0, 0, 1]);
    expect(n[0] * e[0] + n[1] * e[1] + n[2] * e[2]).toBeCloseTo(0, 14);
    expect(Math.hypot(...frame.direction([3, 4, 12]))).toBeCloseTo(13, 12);
    const cross = [n[1] * e[2] - n[2] * e[1], n[2] * e[0] - n[0] * e[2], n[0] * e[1] - n[1] * e[0]];
    cross.forEach((v, i) => expect(v).toBeCloseTo(d[i], 14));
  }
});
