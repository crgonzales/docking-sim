import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@docking/sim-core';
import { flightWorldFrame } from '../flight/flightFrame';
import {
  AIRFIELD_ANCHOR_N_M, AIRFIELD_BASIS, AIRFIELD_BOUNDS,
  AIRFIELD_BUILDING_FOOTPRINTS, AIRFIELD_DATUM_WORLD,
  airfieldGroundHeight, airfieldLocalPoint, airfieldPositionFromLocal,
} from './airfieldSite';

describe('shared airfield surface', () => {
  it.each<Vec3>([[0, 0, 0], [20, 0, -799], [-20, 0, 799], [-340, 0, 300], [-90, 0, -450]])(
    'supports the rendered tangent plane at local (%s, %s, %s)', (east, up, south) => {
      const chart = airfieldPositionFromLocal([east, up, south]);
      const sampled = airfieldGroundHeight([chart[0], chart[1], -1000]);
      expect(sampled).not.toBeNull();
      const world = flightWorldFrame([chart[0], chart[1], -sampled!]).position;
      const displacement = world.map((v, i) => v - AIRFIELD_DATUM_WORLD[i]);
      expect(displacement.reduce((sum, v, i) => sum + v * AIRFIELD_BASIS.up[i], 0)).toBeCloseTo(0, 5);
      expect(displacement.reduce((sum, v, i) => sum + v * AIRFIELD_BASIS.east[i], 0)).toBeCloseTo(east, 5);
      expect(displacement.reduce((sum, v, i) => sum + v * AIRFIELD_BASIS.south[i], 0)).toBeCloseTo(south, 5);
    },
  );

  it('preserves actual eye/model height when transforming between chart and site coordinates', () => {
    for (const point of [[8, 1.7, 0], [-80, 3, 750], [-340, 30, 300]] as Vec3[]) {
      const roundTrip = airfieldLocalPoint(airfieldPositionFromLocal(point));
      point.forEach((v, i) => expect(roundTrip[i]).toBeCloseTo(v, 5));
    }
    expect(airfieldLocalPoint(AIRFIELD_ANCHOR_N_M).every((v) => Math.abs(v) < 1e-6)).toBe(true);
  });

  it('rejects unsupported edges, remote positions and invalid input', () => {
    for (const point of [
      [AIRFIELD_BOUNDS.eastMaxM + 1, 0, 0], [AIRFIELD_BOUNDS.eastMinM - 1, 0, 0],
      [0, 0, AIRFIELD_BOUNDS.northMaxM + 1], [0, 0, AIRFIELD_BOUNDS.northMinM - 1],
    ] as Vec3[]) expect(airfieldGroundHeight(airfieldPositionFromLocal(point))).toBeNull();
    expect(airfieldGroundHeight([0, 0, -1500])).toBeNull();
    expect(airfieldGroundHeight([NaN, 0, 0])).toBeNull();
  });

  it('keeps character support out of every solid building including its wall clearance', () => {
    for (const building of AIRFIELD_BUILDING_FOOTPRINTS) {
      expect(airfieldGroundHeight(airfieldPositionFromLocal([building.centerEastM, 0, building.centerSouthM]))).toBeNull();
      expect(airfieldGroundHeight(airfieldPositionFromLocal([building.eastMaxM + 0.1, 0, building.centerSouthM]))).toBeNull();
      expect(airfieldGroundHeight(airfieldPositionFromLocal([building.eastMaxM + 1, 0, building.centerSouthM]))).not.toBeNull();
    }
  });
});
