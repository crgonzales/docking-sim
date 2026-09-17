// @ts-ignore The package intentionally has no Node type dependency; Vitest supplies this test-only runtime module.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hillToBody, smallAngleExp } from './attitude.js';
import { createFsw, type FswConfig } from './fsw.js';
import { stepTruth } from './dynamics.js';
import { createRng } from './rng.js';
import { createSensorModel } from './sensors.js';
import { applyThrusterCommand } from './thrusters.js';
import type { FswTraceRecord } from './trace.js';
import type { TruthState } from './types.js';

const initialState: [number, number, number, number, number, number] = [0, -220, 12, 0, 0, 0];

function diagonal(values: number[]): number[][] {
  return values.map((value, row) => values.map((_, column) => row === column ? value : 0));
}

function makeConfig(controller: FswConfig['controller'] = 'LQR'): FswConfig {
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
    expect(output.telemetry.corridor_err_m).toBe(0);
    expect(output.telemetry.abort).toBe('ARMED');
    expect(output.telemetry.outcome).toBe('NONE');
  });

  it('switches controller selection without rebuilding the FSW closure', () => {
    const fsw = createFsw(makeConfig('PID'));
    const sensor = zeroNoiseSensor(13).sample(makeTruth());
    expect(fsw(sensor).telemetry.controller).toBe('PID');
    fsw.setController('LQR');
    expect(fsw({ ...sensor, t_s: 0.1 }).telemetry.controller).toBe('LQR');
  });

  it('publishes and switches the active manual authority through the command surface', () => {
    const fsw = createFsw(makeConfig());
    const sensors = zeroNoiseSensor(25);
    const truth = makeTruth();
    expect(fsw.getManualAuthority()).toBe('LOW');
    expect(fsw(sensors.sample({ ...truth, t_s: 0 })).telemetry.manual_authority).toBe('LOW');
    fsw.setManualAuthority('HIGH');
    expect(fsw.getManualAuthority()).toBe('HIGH');
    expect(fsw(sensors.sample({ ...truth, t_s: 0.1 })).telemetry.manual_authority).toBe('HIGH');
  });

  it('runs AUTO and MANUAL mode branches through a deterministic command surface', () => {
    const first = createFsw(makeConfig());
    const second = createFsw(makeConfig());
    const sensorModelA = zeroNoiseSensor(15);
    const sensorModelB = zeroNoiseSensor(15);
    const truth = makeTruth();
    const commands = [
      { mode: 'MANUAL' as const, subMode: 'PULSE' as const, command: { translation: [1, 0, 0] as [number, number, number], rotation: [0, 0.5, 0] as [number, number, number] } },
      { mode: 'MANUAL' as const, subMode: 'RATE' as const, command: { translation: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] } },
      { mode: 'AUTO' as const, subMode: 'RATE' as const, command: { translation: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] } },
    ];
    commands.forEach((entry, index) => {
      first.setControlMode(entry.mode);
      second.setControlMode(entry.mode);
      first.setManualSubMode(entry.subMode);
      second.setManualSubMode(entry.subMode);
      first.setManualCommand(entry.command);
      second.setManualCommand(entry.command);
      const t_s = index * 0.1;
      const outputA = first({ ...sensorModelA.sample({ ...truth, t_s }), t_s });
      const outputB = second({ ...sensorModelB.sample({ ...truth, t_s }), t_s });
      expect(outputA).toEqual(outputB);
      expect(outputA.telemetry.control_mode).toBe(entry.mode);
      expect(outputA.telemetry.manual_sub_mode).toBe(entry.mode === 'MANUAL' ? entry.subMode : null);
      expect(outputA.att_diag.initialized).toBe(true);
    });
  });

  it('freezes the guidance reference until a manual takeover clears the fault', () => {
    const testConfig = { ...makeConfig(), attitudeControllerConfig: { meanMotionRadS: 0 } };
    const frozen = createFsw(testConfig);
    const nominal = createFsw(testConfig);
    const constantReference = createFsw({
      ...testConfig,
      guidanceConfig: { initialState: [...initialState], closingGain_s_inv: 0 },
    });
    const sensors = zeroNoiseSensor(23);
    const truth = makeTruth();

    const initialSensor = sensors.sample(truth);
    frozen(initialSensor);
    nominal(initialSensor);
    constantReference(initialSensor);
    frozen.injectGuidanceFault();

    const laterSensor = sensors.sample({ ...truth, t_s: 10 });
    const frozenOutput = frozen(laterSensor);
    const nominalOutput = nominal(laterSensor);
    const constantOutput = constantReference(laterSensor);
    expect(frozenOutput.telemetry.guidance_frozen).toBe(true);
    expect(frozenOutput.thrusters).not.toEqual(nominalOutput.thrusters);
    expect(frozenOutput.thrusters).toEqual(constantOutput.thrusters);
    const heldSensor = sensors.sample({ ...truth, t_s: 20 });
    const heldOutput = frozen(heldSensor);
    const constantHeldOutput = constantReference(heldSensor);
    expect(heldOutput.thrusters).toEqual(constantHeldOutput.thrusters);

    frozen.setControlMode('MANUAL');
    const manualOutput = frozen(sensors.sample({ ...truth, t_s: 20.1 }));
    expect(manualOutput.telemetry.control_mode).toBe('MANUAL');
    expect(manualOutput.telemetry.guidance_frozen).toBe(false);
  });

  it('uses the estimated non-identity attitude for the bearing measurement model', () => {
    const fsw = createFsw({
      ...makeConfig(),
      ekfConfig: {
        initialNavPrior: { state: [0, -220, 12, 0, 0, 0], covariance: diagonal([10_000, 10_000, 10_000, 10, 10, 10]) },
        q: diagonal([0, 0, 0, 0, 0, 0]),
      },
    });
    const sensorModel = zeroNoiseSensor(16);
    let truth: TruthState = { ...makeTruth(), q_BI: smallAngleExp([0.35, -0.2, 0.15]) };
    let output = fsw(sensorModel.sample(truth));
    for (let tick = 1; tick <= 20; tick += 1) {
      truth = stepTruth(truth, { dt_s: 0.1 });
      output = fsw(sensorModel.sample(truth));
    }
    const q_BH = hillToBody(truth.q_BI, truth.t_s);
    output.att_diag.q_ref_BI.forEach((value, axis) => expect(value).toBeCloseTo(truth.q_BI[axis]!, 5));
    output.telemetry.q_BH_est.forEach((value, axis) => expect(value).toBeCloseTo(q_BH[axis]!, 5));
    expect(Math.hypot(
      output.nav_diag.state[0] - truth.r_hill_m[0],
      output.nav_diag.state[1] - truth.r_hill_m[1],
      output.nav_diag.state[2] - truth.r_hill_m[2],
    )).toBeLessThan(0.1);
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

  it('emits a trace record per tick with the FSW ordinal and sample tick, without changing the output', () => {
    const records: FswTraceRecord[] = [];
    const traced = createFsw({ ...makeConfig(), onTrace: (record) => records.push(record) });
    const untraced = createFsw(makeConfig());
    const sensorsA = zeroNoiseSensor(26);
    const sensorsB = zeroNoiseSensor(26);
    const truth = makeTruth();
    // The SimLoop's first FSW tick runs at t = 0.1 s (plant tick 10), then every 0.1 s.
    const outputs = [1, 2, 3].map((window) => {
      const t_s = window * 0.1;
      const sensorA = { ...sensorsA.sample({ ...truth, t_s }), t_s };
      const sensorB = { ...sensorsB.sample({ ...truth, t_s }), t_s };
      return [traced(sensorA), untraced(sensorB)] as const;
    });
    for (const [tracedOutput, untracedOutput] of outputs) expect(tracedOutput).toEqual(untracedOutput);

    expect(records).toHaveLength(3);
    const first = records[0]!;
    expect(first.fswSequence).toBe(1);
    expect(first.samplePlantTick).toBe(10);
    expect(first.sampleTime_s).toBeCloseTo(0.1, 12);
    expect(first.commandInterval_tick).toEqual([10, 20]);
    expect(records[1]!.fswSequence).toBe(2);
    expect(records[1]!.samplePlantTick).toBe(20);
    expect(records[2]!.commandInterval_tick).toEqual([30, 40]);
    expect(first.mode.branch).toBe('AUTO');
    expect(first.mode.controller).toBe('LQR');
    expect(first.allocation.onTimes).toEqual(outputs[0]![0].thrusters);
    expect(first.nav.state).toEqual(outputs[0]![0].nav_diag.state);
    expect(first.mekf.q_ref_BI).toEqual(outputs[0]![0].att_diag.q_ref_BI);
    expect(first.sensor.t_s).toBe(first.sampleTime_s);
    expect(first.manual.rateReference).toBeNull();
    expect(first.mpc.result).toBeNull();
    expect(Object.keys(first)).not.toContain('truth');
  });

  it.each(['LQR', 'MPC'] as const)('isolates live outputs and future ticks from a mutating %s trace observer', (controller) => {
    const records: FswTraceRecord[] = [];
    function corruptNumbers(value: unknown): void {
      if (value === null || typeof value !== 'object') return;
      const fields = value as Record<string, unknown>;
      for (const [key, entry] of Object.entries(fields)) {
        if (typeof entry === 'number') fields[key] = entry + 1_000_000;
        else corruptNumbers(entry);
      }
    }
    const config = { ...makeConfig(controller), mpcConfig: { horizonSteps: 4, maxIterations: 150 } };
    const traced = createFsw({ ...config, onTrace: (record) => {
      records.push(record);
      corruptNumbers(record);
    } });
    const untraced = createFsw(config);
    const sensorsA = zeroNoiseSensor(28);
    const sensorsB = zeroNoiseSensor(28);
    const truth = makeTruth();
    // Include both cached MPC commands and a subsequent one-second re-solve.
    for (let window = 0; window <= 11; window += 1) {
      const state = { ...truth, t_s: window / 10 };
      const sensorA = sensorsA.sample(state);
      const sensorB = sensorsB.sample(state);
      const output = traced(sensorA);
      const expected = untraced(sensorB);
      expect(sensorA).toEqual(sensorB);
      expect(output).toEqual(expected);
      if (controller === 'MPC') expect(output.telemetry.mpc_fallback).toBe(false);
      // A retained record must not share data with returned or cached output.
      corruptNumbers(records[window]);
      expect(output).toEqual(expected);
    }
    expect(records).toHaveLength(12);
  });

  it('reports the manual branches and the manual force clamp in the trace', () => {
    const records: FswTraceRecord[] = [];
    const fsw = createFsw({ ...makeConfig(), onTrace: (record) => records.push(record) });
    const sensors = zeroNoiseSensor(27);
    const truth = makeTruth();
    fsw.setControlMode('MANUAL');
    fsw.setManualSubMode('RATE');
    fsw.setManualCommand({ translation: [1, 0, 0], rotation: [0, 0, 0] });
    fsw({ ...sensors.sample({ ...truth, t_s: 0.1 }), t_s: 0.1 });
    fsw.setManualSubMode('PULSE');
    fsw({ ...sensors.sample({ ...truth, t_s: 0.2 }), t_s: 0.2 });

    expect(records[0]!.mode.branch).toBe('MANUAL_RATE');
    expect(records[0]!.mode.manualSub).toBe('RATE');
    expect(records[0]!.manual.rateReference).not.toBeNull();
    expect(records[1]!.mode.branch).toBe('MANUAL_PULSE');
    expect(records[1]!.manual.rateReference).toBeNull();
    expect(records[1]!.manual.forceLimit_N).toBeGreaterThan(0);
    expect(records.every((record) => typeof record.manual.forceClamped === 'boolean')).toBe(true);
  });

  it('selects MPC and reports a non-fallback solve in AUTO', () => {
    const fsw = createFsw({
      ...makeConfig('MPC'),
      mpcConfig: { horizonSteps: 4, maxIterations: 150 },
    });
    const output = fsw(zeroNoiseSensor(17).sample(makeTruth()));

    expect(output.telemetry.controller).toBe('MPC');
    expect(output.telemetry.mpc_fallback).toBe(false);
  });

  it('holds the MPC command between one-second solve ticks', () => {
    const fsw = createFsw({
      ...makeConfig('MPC'),
      mpcConfig: { horizonSteps: 4, maxIterations: 150 },
    });
    const sensors = zeroNoiseSensor(18);
    const truth = makeTruth();
    const first = fsw(sensors.sample({ ...truth, t_s: 0 }));
    const between = fsw(sensors.sample({ ...truth, t_s: 0.1 }));

    expect(first.telemetry.mpc_fallback).toBe(false);
    expect(between.telemetry.mpc_fallback).toBe(false);
    expect(between.telemetry.controller).toBe('MPC');
  });

  it('falls back to LQR when the MPC iteration cap is hit', () => {
    const fsw = createFsw({
      ...makeConfig('MPC'),
      mpcConfig: { horizonSteps: 4, maxIterations: 1 },
    });
    const output = fsw(zeroNoiseSensor(19).sample(makeTruth()));

    expect(output.telemetry.controller).toBe('MPC');
    expect(output.telemetry.mpc_fallback).toBe(true);
  });

  it('re-probes MPC authority after jet availability changes', () => {
    const fsw = createFsw({
      ...makeConfig('MPC'),
      mpcConfig: { horizonSteps: 4, maxIterations: 150 },
    });
    const sensors = zeroNoiseSensor(20);
    const truth = makeTruth();
    fsw(sensors.sample({ ...truth, t_s: 0 }));
    fsw.setJetAvailability('J1', false);
    const output = fsw(sensors.sample({ ...truth, t_s: 0.1 }));

    expect(output.telemetry.controller).toBe('MPC');
    expect(output.telemetry.mpc_fallback).toBe(false);
    expect(output.thrusters.J1).toBe(0);
  });

  it('enters the abort latch idempotently from the command surface', () => {
    const fsw = createFsw(makeConfig());
    const sensors = zeroNoiseSensor(21);
    const truth = makeTruth();
    fsw.commandAbort();
    fsw.commandAbort();
    const first = fsw(sensors.sample({ ...truth, t_s: 0 }));
    const second = fsw(sensors.sample({ ...truth, t_s: 0.1 }));

    expect(first.abort).toBe(true);
    expect(first.abort_state).toBe('BURNING');
    expect(second.abort).toBe(true);
    expect(['BURNING', 'COASTING']).toContain(second.abort_state);
  });

  it('keeps ABORT COASTING damping identical across manual authority levels', () => {
    const coastOutput = (authority: 'LOW' | 'HIGH') => {
      const fsw = createFsw({
        ...makeConfig(),
        attitudeControllerConfig: { initialManualAuthority: authority },
      });
      const sensors = zeroNoiseSensor(24);
      const truth = { ...makeTruth(), w_body_rps: [0.02, -0.015, 0.01] as [number, number, number] };
      fsw.commandAbort();
      for (let tick = 0; tick < 320; tick += 1) {
        const output = fsw(sensors.sample({ ...truth, t_s: tick * 0.1 }));
        if (output.abort_state === 'COASTING') return output;
      }
      throw new Error('ABORT did not reach COASTING');
    };

    const low = coastOutput('LOW');
    const high = coastOutput('HIGH');
    expect(high.thrusters).toEqual(low.thrusters);
  });

  it('shows corridor caution but never auto-aborts in MANUAL mode', () => {
    const violating: [number, number, number, number, number, number] = [20, -20, 0, 0, 0, 0];
    const fsw = createFsw({
      ...makeConfig(),
      guidanceConfig: { initialState: violating },
      ekfConfig: {
        initialNavPrior: { state: violating, covariance: diagonal([10_000, 10_000, 10_000, 10, 10, 10]) },
        q: diagonal([0, 0, 0, 0, 0, 0]),
      },
    });
    fsw.setControlMode('MANUAL');
    const output = fsw(zeroNoiseSensor(22).sample({ ...makeTruth(), r_hill_m: [20, -20, 0] }));

    expect(output.telemetry.corridor_err_m).toBeGreaterThan(0);
    expect(output.abort).toBe(false);
    expect(output.abort_state).toBe('ARMED');
  });
});
