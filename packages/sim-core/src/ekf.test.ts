import { describe, expect, it } from 'vitest';
import { hillToBody } from './attitude.js';
import { stepTruth } from './dynamics.js';
import { propagateCW } from './cw.js';
import { createEkf, cwDiscreteMatrices, ekfMeasurementModel, type Matrix6, type State6 } from './ekf.js';
import { createRng } from './rng.js';
import { bearingToLosUnit, createSensorModel } from './sensors.js';
import type { SensorFrame, TruthState } from './types.js';

const initialTruth: TruthState = {
  t_s: 0,
  r_hill_m: [12, -250, 7],
  v_hill_mps: [0.02, 0.85, -0.05],
  q_BI: [1, 0, 0, 0],
  w_body_rps: [0, 0, 0.001],
  prop_kg: 24,
};

// ANEES gate trajectory: slow drift keeps range ~190-250 m across the whole
// 60-300 s window so the measurement geometry stays representative of the
// approach corridor for the entire evaluation.
const aneesTruth: TruthState = {
  ...initialTruth,
  v_hill_mps: [0.02, 0.2, -0.05],
};

const diagonal = (values: number[]): Matrix6 => values.map((value, row) => values.map((_, column) => row === column ? value : 0));
const trace = (matrix: number[][]): number => matrix.reduce((sum, row, index) => sum + (row[index] ?? 0), 0);

function inverse(matrix: number[][]): number[][] {
  const size = matrix.length;
  const augmented = matrix.map((row, rowIndex) => [...row, ...Array.from({ length: size }, (_, column) => rowIndex === column ? 1 : 0)]);
  for (let pivot = 0; pivot < size; pivot += 1) {
    let pivotRow = pivot;
    for (let row = pivot + 1; row < size; row += 1) if (Math.abs(augmented[row]![pivot]!) > Math.abs(augmented[pivotRow]![pivot]!)) pivotRow = row;
    [augmented[pivot], augmented[pivotRow]] = [augmented[pivotRow]!, augmented[pivot]!];
    const divisor = augmented[pivot]![pivot]!;
    for (let column = pivot; column < 2 * size; column += 1) augmented[pivot]![column]! /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row]![pivot]!;
      for (let column = pivot; column < 2 * size; column += 1) augmented[row]![column]! -= factor * augmented[pivot]![column]!;
    }
  }
  return augmented.map((row) => row.slice(size));
}

function nees(error: State6, covariance: Matrix6): number {
  const inv = inverse(covariance);
  return error.reduce((sum, value, row) => sum + value * inv[row]!.reduce((inner, coefficient, column) => inner + coefficient * error[column]!, 0), 0);
}

function zeroNoiseSensor() {
  return createSensorModel({
    range_sigma_floor_m: 0,
    range_sigma_scale: 0,
    bearing_sigma_rad: 0,
    gyro_sigma_rps: 0,
    attitude_sigma_rad: 0,
  }, createRng(1));
}

describe('translational EKF', () => {
  it('uses the exact CW discrete transition', () => {
    const dt_s = 0.1;
    const state: State6 = [12, -250, 7, 0.02, 0.85, -0.05];
    const matrices = cwDiscreteMatrices(0.001, dt_s);
    const propagated = propagateCW([state[0], state[1], state[2]], [state[3], state[4], state[5]], 0.001, dt_s);
    const predicted = matrices.phi.map((row) => row.reduce((sum, value, index) => sum + value * state[index]!, 0));
    [...propagated.r, ...propagated.v].forEach((value, index) => expect(predicted[index]).toBeCloseTo(value, 10));
  });

  it('initializes from range+bearing using the shared sensor convention', () => {
    const sensor = zeroNoiseSensor().sample(initialTruth);
    const ekf = createEkf({ initialNavPrior: { state: [99, 99, 99, 0, 0, 0], covariance: diagonal([1, 1, 1, 1, 1, 1]) } });
    ekf.step(sensor, 0.1, initialTruth.v_hill_mps);
    const diag = ekf.getNavDiag();
    const los = bearingToLosUnit(sensor.bearing_body_rad!);
    expect(diag.initialized).toBe(true);
    expect(diag.state[0]).toBeCloseTo(-sensor.range_m! * los[0], 12);
    expect(ekfMeasurementModel(diag.state)[1]).toBeCloseTo(sensor.bearing_body_rad![0], 10);
  });

  it('grows covariance during measurement dropout', () => {
    const sensorModel = zeroNoiseSensor();
    const ekf = createEkf();
    ekf.step(sensorModel.sample(initialTruth), 0.1, initialTruth.v_hill_mps);
    const before = trace(ekf.getNavDiag().covariance);
    const dropout: SensorFrame = { ...sensorModel.sample({ ...initialTruth, t_s: 0.1 }), range_m: null, bearing_body_rad: null };
    for (let i = 0; i < 20; i += 1) ekf.step({ ...dropout, t_s: (i + 1) * 0.1 }, 0.1, initialTruth.v_hill_mps);
    expect(trace(ekf.getNavDiag().covariance)).toBeGreaterThan(before);
  });

  it('converges on seeded free-drift truth and passes the 50-run ANEES gate', () => {
    const runCount = 50;
    const epochCount = 300;
    const aneesByEpoch: number[] = [];
    const allRuns: Array<{ truth: TruthState; ekf: ReturnType<typeof createEkf>; sensor: ReturnType<typeof createSensorModel> }> = [];
    for (let run = 0; run < runCount; run += 1) {
      const sensor = createSensorModel({ range_sigma_floor_m: 0.2, range_sigma_scale: 0, bearing_sigma_rad: 0.001 }, createRng(1000 + run));
      const ekf = createEkf({
        initialNavPrior: { state: [0, 0, 0, 0, 0, 0], covariance: diagonal([10_000, 10_000, 10_000, 10, 10, 10]) },
        p0: diagonal([1, 1, 1, 0.1, 0.1, 0.1]),
        // The gate's truth is EXACT CW (zero process noise), so the filter
        // must model Q = 0 here: any phantom Q floors P while the true error
        // keeps shrinking, which drives ANEES below the band by construction.
        // (Runtime FSW configs use Q > 0 because real truth has thrust
        // quantization residue — that mismatch is a tuning concern, not a
        // consistency-gate concern.)
        q: diagonal([0, 0, 0, 0, 0, 0]),
        // R must match the sensor model's actual noise: a knowingly optimistic
        // filter is exactly what the ANEES gate exists to reject.
        r: [[0.2 ** 2, 0, 0], [0, 0.001 ** 2, 0], [0, 0, 0.001 ** 2]],
      });
      allRuns.push({ truth: { ...aneesTruth, r_hill_m: [...aneesTruth.r_hill_m], v_hill_mps: [...aneesTruth.v_hill_mps] }, ekf, sensor });
      ekf.step(zeroNoiseSensor().sample(aneesTruth), 0.1, aneesTruth.v_hill_mps);
    }
    for (let epoch = 1; epoch <= epochCount; epoch += 1) {
      const errors: State6[] = [];
      const covariances: Matrix6[] = [];
      for (let run = 0; run < runCount; run += 1) {
        const entry = allRuns[run]!;
        for (let tick = 0; tick < 10; tick += 1) {
          for (let truthTick = 0; truthTick < 10; truthTick += 1) entry.truth = stepTruth(entry.truth);
          entry.ekf.step(
            entry.sensor.sample(entry.truth),
            0.1,
            aneesTruth.v_hill_mps,
            undefined,
            { q_BH: hillToBody(entry.truth.q_BI, entry.truth.t_s) },
          );
        }
        if (epoch >= 60) {
          const state = entry.ekf.getNavDiag().state;
          errors.push([
            entry.truth.r_hill_m[0] - state[0], entry.truth.r_hill_m[1] - state[1], entry.truth.r_hill_m[2] - state[2],
            entry.truth.v_hill_mps[0] - state[3], entry.truth.v_hill_mps[1] - state[4], entry.truth.v_hill_mps[2] - state[5],
          ]);
          covariances.push(entry.ekf.getNavDiag().covariance);
        }
      }
      if (epoch >= 60) aneesByEpoch.push(errors.reduce((sum, error, run) => sum + nees(error, covariances[run]!), 0) / runCount);
    }
    const df = 6 * runCount;
    // 95% pointwise band per the plan: chi-square(6N) quantiles via
    // Wilson-Hilferty with z = +/-1.96, scaled by N.
    const z = 1.959964;
    const chi = (sign: number) => df * (1 - 2 / (9 * df) + sign * z * Math.sqrt(2 / (9 * df))) ** 3 / runCount;
    const lower = chi(-1);
    const upper = chi(1);
    const inside = aneesByEpoch.filter((value) => value >= lower && value <= upper).length / aneesByEpoch.length;
    const mean = aneesByEpoch.reduce((sum, value) => sum + value, 0) / aneesByEpoch.length;
    expect(inside).toBeGreaterThanOrEqual(0.9);
    expect(mean).toBeGreaterThanOrEqual(lower);
    expect(mean).toBeLessThanOrEqual(upper);
    expect(Math.hypot(...allRuns[0]!.truth.r_hill_m)).toBeGreaterThan(0);
  }, 30_000);
});
