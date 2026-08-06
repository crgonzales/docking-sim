import { describe, expect, it } from 'vitest';
import { errorQuaternion, smallAngleLog } from './attitude.js';
import { stepTruth } from './dynamics.js';
import { inverseMatrix } from './linalg.js';
import { createMekf } from './mekf.js';
import { createRng } from './rng.js';
import { createSensorModel } from './sensors.js';
import type { SensorFrame, TruthState, Vec3 } from './types.js';

function diagonal(values: number[]): number[][] {
  return values.map((value, row) => values.map((_, column) => row === column ? value : 0));
}

function truthAtStart(): TruthState {
  return {
    t_s: 0,
    r_hill_m: [10, -100, 4],
    v_hill_mps: [0, 0, 0],
    q_BI: [1, 0, 0, 0],
    w_body_rps: [0.03, -0.02, 0.04],
    prop_kg: 24,
  };
}

function sensorConfig() {
  return {
    range_sigma_floor_m: 0,
    range_sigma_scale: 0,
    bearing_sigma_rad: 0,
    gyro_sigma_rps: 0,
    gyro_bias_random_walk_rps_sqrt_s: 0,
    attitude_sigma_rad: 0,
    degrade: { biasRamp: { gyro_rps: [0.0012, -0.0007, 0.0009] as Vec3 } },
  };
}

function mekfConfig() {
  return {
    p0: diagonal([0.2 ** 2, 0.2 ** 2, 0.2 ** 2, 0.01 ** 2, 0.01 ** 2, 0.01 ** 2]),
    q: diagonal([0, 0, 0, 0, 0, 0]),
    r: diagonal([1e-12, 1e-12, 1e-12]),
    gyro_sigma_rps: 0,
    gyro_bias_random_walk_rps_sqrt_s: 0,
    star_tracker_sigma_rad: 0,
  };
}

function advanceFilter(
  count: number,
  filter: ReturnType<typeof createMekf>,
  sensors: ReturnType<typeof createSensorModel>,
  truth: TruthState,
  dt_s: number,
  starTracker = true,
): { truth: TruthState; truthAtLastSensor: TruthState; lastSensor: SensorFrame } {
  let currentTruth = truth;
  let truthAtLastSensor = truth;
  let lastSensor: SensorFrame = sensors.sample(currentTruth);
  for (let step = 0; step < count; step += 1) {
    truthAtLastSensor = currentTruth;
    lastSensor = sensors.sample(currentTruth);
    if (!starTracker) {
      lastSensor = { ...lastSensor, star_tracker_q_BI: null, attitude_q_BI: null };
    }
    filter.step(lastSensor, dt_s);
    currentTruth = stepTruth(currentTruth, { dt_s, torque_body_Nm: [0, 0, 0] });
  }
  return { truth: currentTruth, truthAtLastSensor, lastSensor };
}

describe('attitude MEKF', () => {
  it('converges on seeded tumbling truth and estimates the sensor bias', () => {
    const sensors = createSensorModel(sensorConfig(), createRng(1));
    const filter = createMekf(mekfConfig());
    const result = advanceFilter(2_000, filter, sensors, truthAtStart(), 0.01);
    const diag = filter.getAttDiag();
    const attitudeError = smallAngleLog(errorQuaternion(diag.q_ref_BI, result.truthAtLastSensor.q_BI));
    expect(Math.hypot(...attitudeError)).toBeLessThan(1e-5);
    const trueBias = sensors.getTrueGyroBias();
    diag.bias_rps.forEach((value, axis) => expect(value).toBeCloseTo(trueBias[axis]!, 5));
  }, 30_000);

  it('grows covariance during star-tracker dropout while gyro propagation continues', () => {
    const sensors = createSensorModel(sensorConfig(), createRng(2));
    const filter = createMekf(mekfConfig());
    const result = advanceFilter(20, filter, sensors, truthAtStart(), 0.01);
    const before = filter.getAttDiag().covariance;
    advanceFilter(200, filter, sensors, result.truth, 0.01, false);
    const after = filter.getAttDiag().covariance;
    expect(after[0]![0]!).toBeGreaterThan(before[0]![0]!);
    expect(after[1]![1]!).toBeGreaterThan(before[1]![1]!);
  });

  it('handles double-covered star-tracker quaternions without a sign jump', () => {
    const filter = createMekf(mekfConfig());
    const identitySensor: SensorFrame = {
      t_s: 0,
      range_m: 1,
      bearing_body_rad: [0, 0],
      gyro_rps: [0, 0, 0],
      star_tracker_q_BI: [1, 0, 0, 0],
      attitude_q_BI: [1, 0, 0, 0],
    };
    filter.step(identitySensor, 0.01);
    for (let index = 1; index <= 20; index += 1) {
      filter.step({ ...identitySensor, t_s: index * 0.01, star_tracker_q_BI: [-1, 0, 0, 0], attitude_q_BI: [-1, 0, 0, 0] }, 0.01);
    }
    const diag = filter.getAttDiag();
    expect(diag.q_ref_BI[0]).toBeCloseTo(1, 12);
    expect(Math.hypot(diag.q_ref_BI[1], diag.q_ref_BI[2], diag.q_ref_BI[3])).toBeLessThan(1e-10);
  });

  it('passes the 50-run six-dimensional attitude ANEES gate', () => {
    const runs = 50;
    const dt_s = 0.02;
    const warmupEpochs = 50;
    const windowEpochs = 150;
    const sensorNoise = {
      range_sigma_floor_m: 0,
      range_sigma_scale: 0,
      bearing_sigma_rad: 0,
      gyro_sigma_rps: 2e-4,
      gyro_bias_random_walk_rps_sqrt_s: 2e-5,
      attitude_sigma_rad: 2e-4,
    };
    const filterConfig = {
      p0: diagonal([0.25 ** 2, 0.25 ** 2, 0.25 ** 2, 0.01 ** 2, 0.01 ** 2, 0.01 ** 2]),
      gyro_sigma_rps: 2e-4,
      gyro_bias_random_walk_rps_sqrt_s: 2e-5,
      star_tracker_sigma_rad: 2e-4,
    };
    const aneesByEpoch: number[][] = Array.from({ length: windowEpochs }, () => []);
    for (let run = 0; run < runs; run += 1) {
      const sensors = createSensorModel(sensorNoise, createRng(20_000 + run));
      const filter = createMekf(filterConfig);
      let truth = truthAtStart();
      for (let epoch = 0; epoch < warmupEpochs + windowEpochs; epoch += 1) {
        const sensor = sensors.sample(truth);
        filter.step(sensor, dt_s);
        if (epoch >= warmupEpochs) {
          const diag = filter.getAttDiag();
          const attitudeError = smallAngleLog(errorQuaternion(diag.q_ref_BI, truth.q_BI));
          const trueBias = sensors.getTrueGyroBias();
          const error = [
            ...attitudeError,
            trueBias[0] - diag.bias_rps[0],
            trueBias[1] - diag.bias_rps[1],
            trueBias[2] - diag.bias_rps[2],
          ];
          const covarianceInverse = inverseMatrix(diag.covariance, { strict: true });
          const nees = error.reduce((sum, value, row) => sum + value * covarianceInverse[row]!.reduce(
            (inner, coefficient, column) => inner + coefficient * error[column]!,
            0,
          ), 0);
          aneesByEpoch[epoch - warmupEpochs]!.push(nees);
        }
        truth = stepTruth(truth, { dt_s, torque_body_Nm: [0, 0, 0] });
      }
    }
    const meanByEpoch = aneesByEpoch.map((values) => values.reduce((sum, value) => sum + value, 0) / runs);
    const degreesOfFreedom = 6 * runs;
    const whMean = 1 - 2 / (9 * degreesOfFreedom);
    const whSigma = Math.sqrt(2 / (9 * degreesOfFreedom));
    const chiSquareQuantile = (z: number): number => degreesOfFreedom * (whMean + z * whSigma) ** 3;
    const lower = chiSquareQuantile(-1.96) / runs;
    const upper = chiSquareQuantile(1.96) / runs;
    const insideCount = meanByEpoch.filter((value) => value >= lower && value <= upper).length;
    const windowMean = meanByEpoch.reduce((sum, value) => sum + value, 0) / meanByEpoch.length;
    expect(insideCount / windowEpochs).toBeGreaterThanOrEqual(0.9);
    expect(windowMean).toBeGreaterThanOrEqual(lower);
    expect(windowMean).toBeLessThanOrEqual(upper);
  }, 30_000);
});
