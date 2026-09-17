import { describe, expect, it } from 'vitest';
import { conjugateQuaternion, errorQuaternion, rotateVector, smallAngleExp, smallAngleLog } from './attitude.js';
import { createImuBodyAdapter } from './imuFrames.js';
import { createMountTables } from './mounts.js';
import { createSensorModel, type SensorModelConfig } from './sensors.js';
import { createRng } from './rng.js';
import { createMekf } from './mekf.js';
import { inverseMatrix } from './linalg.js';
import { createFsw } from './fsw.js';
import { createTracedSimLoop, type SimConfig } from './sim.js';
import type { FswTraceRecord, PlantTickRecord } from './trace.js';
import type { Quat, TruthState, Vec3 } from './types.js';

const identity: Quat = [1, 0, 0, 0];
const quarter: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
function mounts(q_SB: Quat = quarter, r_body_m: Vec3 = [0, 0, 0]) {
  return createMountTables({ sensors: [{ id: 'imu', kind: 'IMU', q_SB, r_body_m,
    boresight_sensor: [0, 1, 0], halfAngleFov_rad: Math.PI, minRange_m: 0, maxRange_m: 100,
    cadence_s: .1, provenance: { kind: 'SIM_ASSUMPTION', reference: 'Synthetic IMU test installation only.' } }], datums: [], blockers: [] });
}
const quiet: SensorModelConfig = { gyro_sigma_rps: 0, gyro_bias_random_walk_rps_sqrt_s: 0, attitude_sigma_rad: 0 };
const truth = (w_body_rps: Vec3 = [.2, -.3, .4]): TruthState => ({ t_s: 0,
  r_hill_m: [0, -250, 12], v_hill_mps: [0, 0, 0], q_BI: [...identity], w_body_rps, prop_kg: 24 });
const close = (a: readonly number[], b: readonly number[], digits = 12) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, digits));
function simConfig(): SimConfig {
  const state: [number, number, number, number, number, number] = [0, -250, 12, 0, 0, 0];
  return { initial: truth(), sensors: quiet, fsw: { controller: 'LQR',
    massModel: { dryMass_kg: 976, initialProp_kg: 24 }, guidanceConfig: { initialState: state },
    ekfConfig: { initialNavPrior: { state, covariance: [10000, 10000, 10000, 10, 10, 10]
      .map((v, i, all) => all.map((_, j) => i === j ? v : 0)) } },
    allocatorConfig: { fswHz: 10, truthHz: 100 } } };
}

describe('IMU calibration boundary', () => {
  it('uses sensor→body on distinct endpoint and mean channels against a quarter-turn oracle', () => {
    const adapt = createImuBodyAdapter(mounts().calibration, 'imu');
    const result = adapt({ mount_id: 'imu', gyro_sensor_rps: [2, 3, 4], gyro_mean_sensor_rps: [5, 6, 7] });
    close(result.gyro_rps, [3, -2, 4]); close(result.gyro_mean_rps!, [6, -5, 7]);
    expect(adapt({ mount_id: 'imu', gyro_sensor_rps: [2, 3, 4] })).not.toHaveProperty('gyro_mean_rps');
  });

  it('composes exact actual and assumed rotations for a general installation', () => {
    const tables = mounts(smallAngleExp([.4, -.2, .7]));
    const model = createSensorModel({ ...quiet, mounts: tables.actual }, createRng(12), tables.calibration);
    const sample = model.sample(truth());
    close(sample.gyro_rps, truth().w_body_rps);
    expect(sample.imu_raw).toBeDefined();
    expect(sample.star_tracker_q_BI).toEqual(identity);
  });

  it('rejects actual tables, bad calibration and mismatched or nonfinite samples', () => {
    const tables = mounts();
    // @ts-expect-error Actual geometry must not be accepted as calibration.
    expect(() => createImuBodyAdapter(tables.actual, 'imu')).toThrow('CALIBRATION');
    expect(() => createImuBodyAdapter(tables.calibration, 'absent')).toThrow('calibration');
    const adapt = createImuBodyAdapter(tables.calibration, 'imu');
    expect(() => adapt({ mount_id: 'other', gyro_sensor_rps: [1, 2, 3] })).toThrow('mismatch');
    expect(() => adapt({ mount_id: 'imu', gyro_sensor_rps: [NaN, 2, 3] })).toThrow('finite');
    tables.calibration.sensors[0]!.q_SB[0] = 2;
    expect(() => createImuBodyAdapter(tables.calibration, 'imu')).toThrow('unit');
    close(adapt({ mount_id: 'imu', gyro_sensor_rps: [2, 3, 4] }).gyro_rps, [3, -2, 4]);
  });

  it('requires explicit assumed calibration and unambiguous physical selection', () => {
    const tables = mounts();
    expect(() => createSensorModel({ mounts: tables.actual })).toThrow('CALIBRATION');
    expect(() => createSensorModel({ imuMountId: 'imu' })).toThrow('requires actual');
    const second = { ...tables.actual.sensors[0]!, id: 'imu2' };
    const actual = { ...tables.actual, sensors: [...tables.actual.sensors, second] };
    expect(() => createSensorModel({ mounts: actual }, createRng(1), tables.calibration)).toThrow('exactly one');
    expect(() => createSensorModel({ mounts: actual, imuMountId: 'imu' }, createRng(1), tables.calibration)).not.toThrow();
    const cfg = simConfig();
    expect(() => createTracedSimLoop({ ...cfg, mounts: tables.actual, sensors: { mounts: tables.actual } }, 1)).toThrow('not both');
  });
});

describe('mounted measurements and truth-only diagnostics', () => {
  it('draws anisotropic noise/random-walk/bias in sensor axes and diagnoses bias with actual rotation', () => {
    const tables = mounts();
    const calibration = mounts(identity).calibration; // Deliberately wrong: diagnostics must not use this.
    const config: SensorModelConfig = { gyro_sigma_rps: [.01, .02, .03],
      gyro_bias_random_walk_rps_sqrt_s: [.001, .002, .003],
      degrade: { start_t_s: 0, biasRamp: { gyro_rps: [.1, .2, .3] } } };
    const mounted = createSensorModel({ ...config, mounts: tables.actual }, createRng(73), calibration);
    const reference = createSensorModel(config, createRng(73));
    for (const t_s of [0, .1, .4, 1]) {
      const input = { ...truth([0, 0, 0]), t_s };
      const a = mounted.sample(input), b = reference.sample(input);
      expect(a.imu_raw!.gyro_sensor_rps).toEqual(b.gyro_rps);
      expect(a.gyro_rps).toEqual(b.gyro_rps); // Assumed identity, not actual inverse.
      expect(mounted.getTrueGyroBias()).toEqual(reference.getTrueGyroBias());
      const [x, y, z] = reference.getTrueGyroBias();
      close(mounted.getTrueGyroBiasBody(), [y, -x, z]);
      expect(a.star_tracker_q_BI).toEqual(b.star_tracker_q_BI);
      expect(a.attitude_q_BI).toEqual(b.attitude_q_BI);
      expect(Object.keys(a.imu_raw!).sort()).toEqual(['gyro_sensor_rps', 'mount_id']);
    }
  });

  it('does not change gyro or star tracker with an IMU lever arm or mutable caller geometry', () => {
    const a = mounts(), b = mounts(quarter, [20, -30, 40]);
    const first = createSensorModel({ mounts: a.actual }, createRng(14), a.calibration);
    const second = createSensorModel({ mounts: b.actual }, createRng(14), b.calibration);
    a.actual.sensors[0]!.q_SB[0] = 99;
    for (const t_s of [.1, .2]) {
      const x = first.sample({ ...truth(), t_s });
      const y = second.sample({ ...truth(), t_s, r_hill_m: [10, -200, 30], v_hill_mps: [2, 3, 4] });
      expect(y.imu_raw).toEqual(x.imu_raw);
      expect(y.gyro_rps).toEqual(x.gyro_rps);
      expect(y.star_tracker_q_BI).toEqual(x.star_tracker_q_BI);
    }
  });

  it('cannot distinguish different physical mounts/truths that produce identical measurements at real FSW', () => {
    const a = mounts(identity), b = mounts([0, 1, 0, 0]), calibration = a.calibration;
    const first = createSensorModel({ ...quiet, mounts: a.actual }, createRng(15), calibration);
    const second = createSensorModel({ ...quiet, mounts: b.actual }, createRng(15), calibration);
    const cfg = simConfig().fsw;
    const fswA = createFsw({ ...cfg, mountCalibration: calibration });
    const fswB = createFsw({ ...cfg, mountCalibration: calibration });
    for (const t_s of [.1, .2, .3]) {
      const x = first.sample({ ...truth([.2, -.3, .4]), t_s });
      const y = second.sample({ ...truth([.2, .3, -.4]), t_s });
      expect(y).toEqual(x);
      expect(fswB(y)).toEqual(fswA(x));
    }
  });

  it('bounds gyro-only MEKF miscalibration drift by 2 |omega| sin(delta/2) T', () => {
    const delta = Math.PI / 180, dt = .1, duration = 5, w: Vec3 = [.2, 0, 0];
    const tables = mounts(identity), wrong = mounts(smallAngleExp([0, 0, delta])).calibration;
    const exactModel = createSensorModel({ ...quiet, mounts: tables.actual }, createRng(1), tables.calibration);
    const wrongModel = createSensorModel({ ...quiet, mounts: tables.actual }, createRng(1), wrong);
    const exactFilter = createMekf({ initial_q_ref_BI: identity }), wrongFilter = createMekf({ initial_q_ref_BI: identity });
    for (let i = 1; i <= duration / dt; i++) {
      const input = { ...truth(w), t_s: i * dt };
      const exactSample = exactModel.sample(input), wrongSample = wrongModel.sample(input);
      // Explicit star-tracker outage isolates calibration error in the real propagation path.
      for (const s of [exactSample, wrongSample]) { s.star_tracker_q_BI = null; s.attitude_q_BI = null; }
      exactFilter.step(exactSample, dt); wrongFilter.step(wrongSample, dt);
    }
    const expected = smallAngleExp([-w[0] * duration, 0, 0]);
    const angle = (q: Quat) => Math.hypot(...smallAngleLog(errorQuaternion(q, expected)));
    expect(angle(exactFilter.getAttDiag().q_ref_BI)).toBeLessThan(1e-12);
    const error = angle(wrongFilter.getAttDiag().q_ref_BI);
    expect(error).toBeGreaterThan(.01);
    expect(error).toBeLessThanOrEqual(2 * Math.hypot(...w) * Math.sin(delta / 2) * duration + 1e-12);
  });
});

describe('real mounted simulation window', () => {
  it('computes attitude NEES against actual body bias, not assumed-calibrated bias', () => {
    const tables = mounts(), cfg = simConfig(), bias: Vec3 = [.03, -.04, .05];
    const { sim, trace } = createTracedSimLoop({ ...cfg, mounts: tables.actual,
      sensors: { ...quiet, degrade: { start_t_s: 0, biasRamp: { gyro_rps: bias } } },
      fsw: { ...cfg.fsw, mountCalibration: mounts(identity).calibration } }, 18);
    const frames = sim.stepTo(.2), att = trace.latestFsw()!.mekf;
    const angle = smallAngleLog(errorQuaternion(att.q_ref_BI, sim.getTruthState().q_BI));
    const inverse = inverseMatrix(att.covariance, { strict: true });
    const nees = (bodyBias: Vec3) => {
      const error = [...angle, ...bodyBias.map((v, i) => v - att.bias_rps[i]!)];
      return error.reduce((sum, v, i) => sum + v * inverse[i]!.reduce((inner, c, j) => inner + c * error[j]!, 0), 0);
    };
    const expected = nees([bias[1], -bias[0], bias[2]]);
    expect(frames[1]!.att_nees).toBeCloseTo(expected, 8);
    expect(frames[1]!.att_nees).not.toBeCloseTo(nees(bias), 8);
  });

  it('retains sensor-axis bias/noise in the full integral, then supplies body mean and endpoint to FSW', () => {
    const tables = mounts(smallAngleExp([.2, -.4, .7]));
    const assumed = mounts(smallAngleExp([-.3, .2, .1])).calibration;
    const cfg = simConfig();
    const enabled = { ...cfg, mounts: tables.actual, sensors: { ...quiet, gyro_sigma_rps: [.001, .002, .003] as Vec3,
      degrade: { start_t_s: 0, biasRamp: { gyro_rps: [.003, -.004, .005] as Vec3 } } },
      fsw: { ...cfg.fsw, mountCalibration: assumed } };
    const { sim, trace } = createTracedSimLoop(enabled, 16);
    const ticks: PlantTickRecord[] = [], records: FswTraceRecord[] = [], replayed: FswTraceRecord[] = [];
    trace.subscribePlantTick(t => ticks.push(t)); trace.subscribeFsw(r => records.push(r));
    const replay = createFsw({ ...cfg.fsw, onTrace: r => replayed.push(r) });
    sim.stepTo(.3);
    expect(records).toHaveLength(3); expect(ticks).toHaveLength(30);
    for (let k = 0; k < records.length; k++) {
      const sensor = records[k]!.sensor, raw = sensor.imu_raw!;
      const integral: Vec3 = [0, 0, 0]; let elapsed = 0;
      for (let j = 10 * k; j < 10 * (k + 1); j++) {
        const previous = j === 0 ? truth().w_body_rps : ticks[j - 1]!.truth.w_body_rps;
        const current = ticks[j]!.truth.w_body_rps;
        for (let axis = 0; axis < 3; axis++) integral[axis]! += .005 * (previous[axis]! + current[axis]!);
        elapsed += .01;
      }
      const actualQ = tables.actual.sensors[0]!.q_SB, inverseAssumed = conjugateQuaternion(assumed.sensors[0]!.q_SB);
      const mean = rotateVector(actualQ, integral).map(v => v / elapsed);
      const endpoint = rotateVector(actualQ, ticks[10 * k + 9]!.truth.w_body_rps);
      close(raw.gyro_mean_sensor_rps!, mean.map((v, axis) => v + raw.gyro_sensor_rps[axis]! - endpoint[axis]!));
      close(sensor.gyro_rps, rotateVector(inverseAssumed, raw.gyro_sensor_rps));
      close(sensor.gyro_mean_rps!, rotateVector(inverseAssumed, raw.gyro_mean_sensor_rps!));
      // A real FSW replay needs only the body-frame measurements; geometry/raw/diagnostics are unnecessary.
      const { imu_raw: _raw, ...bodyFrame } = sensor;
      replay(bodyFrame);
      const expectedRecord = { ...records[k]!, sensor: bodyFrame };
      expect(replayed[k]).toEqual(expectedRecord);
    }
  });

  it('leaves explicit absent mounts/calibration identical to the legacy simulation', () => {
    const cfg = simConfig();
    const legacy = createTracedSimLoop(cfg, 17);
    const absent = createTracedSimLoop({ ...cfg, mounts: undefined,
      sensors: { ...cfg.sensors, mounts: undefined }, fsw: { ...cfg.fsw, mountCalibration: undefined } }, 17);
    expect(absent.sim.stepTo(.3)).toEqual(legacy.sim.stepTo(.3));
    expect(absent.trace.latestFsw()).toEqual(legacy.trace.latestFsw());
    expect(absent.trace.latestFsw()!.sensor).not.toHaveProperty('imu_raw');
    expect(absent.sim.getTruthState()).toEqual(legacy.sim.getTruthState());
  });
});
