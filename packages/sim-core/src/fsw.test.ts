// @ts-expect-error The package intentionally has no Node type dependency; Vitest supplies this test-only runtime module.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFsw, type FswConfig } from './fsw.js';
import { stepTruth } from './dynamics.js';
import { createRng } from './rng.js';
import { createSensorModel } from './sensors.js';
import { applyThrusterCommand } from './thrusters.js';
import type { TruthState } from './types.js';

const initialState: [number, number, number, number, number, number] = [0, -220, 12, 0, 0, 0];

function diagonal(values: number[]): number[][] {
  return values.map((value, row) => values.map((_, column) => row === column ? value : 0));
}

function makeConfig(controller: 'PID' | 'LQR' = 'LQR'): FswConfig {
  return {
    controller,
    massModel: { dryMass_kg: 976, initialProp_kg: 24 },
    guidanceConfig: { initialState },
    ekfConfig: {
      initialNavPrior: { state: [0, -220, 12, 0, 0, 0], covariance: diagonal([10_000, 10_000, 10_000, 10, 10, 10]) },
      q: diagonal([0, 0, 0, 0, 0, 0]),
    },
    pidGains: {
      kp_N_per_m: [0.5, 0.5, 0.5],
      ki_N_per_m_s: [0.005, 0.005, 0.005],
      kd_N_s_per_m: [4, 4, 4],
    },
    allocatorConfig: { fswHz: 10, truthHz: 100 },
  };
}

function zeroNoiseSensor(seed: number) {
  return createSensorModel({
    range_sigma_floor_m: 0,
    range_sigma_scale: 0,
    bearing_sigma_rad: 0,
    gyro_sigma_rps: 0,
    attitude_sigma_rad: 0,
  }, createRng(seed));
}

function makeTruth(): TruthState {
  return {
    t_s: 0,
    r_hill_m: [...initialState.slice(0, 3)] as [number, number, number],
    v_hill_mps: [...initialState.slice(3)] as [number, number, number],
    q_BI: [1, 0, 0, 0],
    w_body_rps: [0, 0, 0],
    prop_kg: 24,
  };
}

function advanceTruth(state: TruthState, command: Record<string, number>): TruthState {
  const application = applyThrusterCommand(command, { prop_kg: state.prop_kg, window_s: 0.1, truthHz: 100 });
  let next = state;
  for (let tick = 0; tick < 10; tick += 1) {
    next = stepTruth(next, {
      dt_s: 0.01,
      externalSpecificForce_hill_mps2: application.specificForce_hill_mps2,
      propellantRate_kg_s: application.propellantRate_kg_s,
    });
  }
  return next;
}

function sampleSequence(fsw: ReturnType<typeof createFsw>, sensorModel: ReturnType<typeof zeroNoiseSensor>, count: number): unknown[] {
  const truth = makeTruth();
  const outputs: unknown[] = [];
  for (let tick = 0; tick < count; tick += 1) {
    const sensor = sensorModel.sample({ ...truth, t_s: tick * 0.1 });
    outputs.push(fsw(sensor));
  }
  return outputs;
}

describe('FSW composition', () => {
  it('is deterministic for identical sensor sequences and seeds', () => {
    const fswA = createFsw(makeConfig());
    const fswB = createFsw(makeConfig());
    const outputsA = sampleSequence(fswA, zeroNoiseSensor(11), 20);
    const outputsB = sampleSequence(fswB, zeroNoiseSensor(11), 20);
    expect(outputsA).toEqual(outputsB);
  });

  it('emits full nav diagnostics, duty telemetry, and respects availability commands', () => {
    const fsw = createFsw(makeConfig());
    fsw.setJetAvailability('J1', false);
    const output = fsw(zeroNoiseSensor(12).sample(makeTruth()));
    expect(output.nav_diag.state).toHaveLength(6);
    expect(output.nav_diag.covariance).toHaveLength(6);
    expect(output.telemetry.prop_kg).toBe(24);
    expect(output.telemetry.thruster_duty.J1).toBe(0);
    expect(output.thrusters.J1).toBe(0);
    expect(output.telemetry.nees).toBeNull();
    expect(output.telemetry.corridor_err_m).toBeNull();
  });

  it('switches controller selection without rebuilding the FSW closure', () => {
    const fsw = createFsw(makeConfig('PID'));
    const sensor = zeroNoiseSensor(13).sample(makeTruth());
    expect(fsw(sensor).telemetry.controller).toBe('PID');
    fsw.setController('LQR');
    expect(fsw({ ...sensor, t_s: 0.1 }).telemetry.controller).toBe('LQR');
  });

  it('drives a noise-free CW approach toward the guidance hold point under LQR', () => {
    const fsw = createFsw(makeConfig('LQR'));
    const sensorModel = zeroNoiseSensor(14);
    let truth = makeTruth();
    const initialDistance_m = Math.hypot(truth.r_hill_m[0], truth.r_hill_m[1] + 30, truth.r_hill_m[2]);
    for (let tick = 0; tick < 1_000; tick += 1) {
      const output = fsw(sensorModel.sample(truth));
      truth = advanceTruth(truth, output.thrusters);
    }
    const finalDistance_m = Math.hypot(truth.r_hill_m[0], truth.r_hill_m[1] + 30, truth.r_hill_m[2]);
    expect(finalDistance_m).toBeLessThan(initialDistance_m);
  }, 30_000);

  it('keeps TruthState out of the FSW implementation', () => {
    const source = readFileSync(new URL('./fsw.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('TruthState');
  });
});
