import { describe, expect, it } from 'vitest';
import { createRng } from './rng.js';
import {
  bearingToLosUnit,
  createSensorModel,
  relativePositionToBearing,
} from './sensors.js';
import type { TruthState } from './types.js';

const truth: TruthState = {
  t_s: 0,
  r_hill_m: [12, -250, 7],
  v_hill_mps: [0.02, 0.85, -0.05],
  q_BI: [1, 0, 0, 0],
  w_body_rps: [0, 0, 0.001],
  prop_kg: 24,
};

const zeroNoise = {
  range_sigma_floor_m: 0,
  range_sigma_scale: 0,
  bearing_sigma_rad: 0,
  gyro_sigma_rps: 0,
  gyro_bias_random_walk_rps_sqrt_s: 0,
  attitude_sigma_rad: 0,
};

describe('sensor model', () => {
  it('is deterministic for identical seeds and truth samples', () => {
    const first = createSensorModel({}, createRng(77));
    const second = createSensorModel({}, createRng(77));
    expect(first.sample(truth)).toEqual(second.sample(truth));
  });

  it('round-trips the chaser-to-target bearing convention', () => {
    const model = createSensorModel(zeroNoise, createRng(1));
    const sample = model.sample(truth);
    const range_m = Math.hypot(...truth.r_hill_m);
    const bearing = relativePositionToBearing(truth.r_hill_m);
    expect(sample.range_m).toBeCloseTo(range_m, 14);
    expect(sample.bearing_body_rad![0]).toBeCloseTo(bearing[0], 14);
    expect(sample.bearing_body_rad![1]).toBeCloseTo(bearing[1], 14);
    const expectedLos: [number, number, number] = truth.r_hill_m.map((component) => -component / range_m) as [number, number, number];
    bearingToLosUnit(sample.bearing_body_rad!).forEach((component, index) => {
      expect(component).toBeCloseTo(expectedLos[index]!, 14);
    });
  });

  it('drops nullable fields only while the sim-time degradation is active', () => {
    const model = createSensorModel(zeroNoise, createRng(2));
    model.setDegrade({ start_t_s: 5, duration_s: 2, dropout: true });
    expect(model.sample({ ...truth, t_s: 4 }).range_m).not.toBeNull();
    const dropped = model.sample({ ...truth, t_s: 5 });
    expect(dropped.range_m).toBeNull();
    expect(dropped.bearing_body_rad).toBeNull();
    expect(dropped.attitude_q_BI).toBeNull();
    expect(dropped.gyro_rps).toEqual(truth.w_body_rps);
    expect(model.sample({ ...truth, t_s: 7 }).range_m).not.toBeNull();
  });

  it('ramps configured biases according to simulation time', () => {
    const model = createSensorModel(zeroNoise, createRng(3));
    model.setDegrade({
      start_t_s: 10,
      rampDuration_s: 20,
      biasRamp: { range_m: 4, gyro_rps: [0.02, 0, 0] },
    });
    const before = model.sample({ ...truth, t_s: 10 });
    const halfway = model.sample({ ...truth, t_s: 20 });
    const after = model.sample({ ...truth, t_s: 30 });
    const range_m = Math.hypot(...truth.r_hill_m);
    expect(before.range_m).toBeCloseTo(range_m, 14);
    expect(halfway.range_m).toBeCloseTo(range_m + 2, 14);
    expect(after.range_m).toBeCloseTo(range_m + 4, 14);
    expect(halfway.gyro_rps[0]).toBeCloseTo(0.01, 14);
  });

  it('advances a seeded gyro bias random walk and exposes only its diagnostic getter', () => {
    const config = { ...zeroNoise, gyro_bias_random_walk_rps_sqrt_s: [1e-3, 2e-3, 3e-3] as [number, number, number] };
    const first = createSensorModel(config, createRng(101));
    const second = createSensorModel(config, createRng(101));
    expect(first.getTrueGyroBias()).toEqual([0, 0, 0]);
    first.sample({ ...truth, t_s: 0 });
    second.sample({ ...truth, t_s: 0 });
    const firstSample = first.sample({ ...truth, t_s: 1 });
    const secondSample = second.sample({ ...truth, t_s: 1 });
    expect(firstSample).toEqual(secondSample);
    expect(first.getTrueGyroBias()).not.toEqual([0, 0, 0]);
    firstSample.gyro_rps.forEach((value, axis) => {
      expect(value - truth.w_body_rps[axis]!).toBeCloseTo(first.getTrueGyroBias()[axis]!, 14);
    });
  });
});
