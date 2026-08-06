import { FSW_HZ, TRUTH_HZ } from './constants.js';
import { createFsw, type FswConfig } from './fsw.js';
import { inverseMatrix } from './linalg.js';
import { createRng } from './rng.js';
import { createSensorModel, type SensorDegradeConfig, type SensorModel, type SensorModelConfig } from './sensors.js';
import { applyThrusterCommand, DRACO_THRUSTER_SPECS } from './thrusters.js';
import type { Quat, TelemetryFrame, ThrusterCommand, TruthState, Vec3 } from './types.js';
import type { ThrusterSpec, ThrusterState, ThrusterStateMap } from './thrusters.js';
import { stepTruth } from './dynamics.js';

export interface SimInitialConditions {
  r_hill_m: Vec3;
  v_hill_mps: Vec3;
  prop_kg: number;
  q_BI?: Quat;
  t_s?: number;
}

export interface SimThrusterConfig {
  specs?: readonly ThrusterSpec[];
  states?: ThrusterStateMap;
}

export interface SimConfig {
  initial: SimInitialConditions;
  fsw: FswConfig;
  sensors?: SensorModelConfig;
  thrusters?: SimThrusterConfig;
}

export interface SimLoop {
  stepTo(t_s: number): TelemetryFrame[];
  setController(controller: 'PID' | 'LQR'): void;
  isolateThruster(id: string): void;
  injectThrusterStuck(id: string, state: 'OPEN' | 'CLOSED'): void;
  setSensorDegrade(degrade: SensorDegradeConfig): void;
  clearSensorDegrade(): void;
  getTruthState(): TruthState;
}

const IDENTITY_QUATERNION: Quat = [1, 0, 0, 0];
const TRUTH_TICK_S = 1 / TRUTH_HZ;
const FSW_TICKS_PER_WINDOW = TRUTH_HZ / FSW_HZ;

function cloneVec3(value: Vec3): Vec3 {
  return [...value];
}

function cloneTruthState(state: TruthState): TruthState {
  return {
    ...state,
    r_hill_m: cloneVec3(state.r_hill_m),
    v_hill_mps: cloneVec3(state.v_hill_mps),
    q_BI: [...state.q_BI],
    w_body_rps: cloneVec3(state.w_body_rps),
  };
}

function validateInitial(initial: SimInitialConditions): void {
  if ([...initial.r_hill_m, ...initial.v_hill_mps, initial.prop_kg].some((value) => !Number.isFinite(value))) {
    throw new RangeError('initial truth conditions must be finite');
  }
  if (initial.prop_kg < 0) throw new RangeError('initial propellant must be non-negative');
  if (initial.t_s !== undefined && (!Number.isFinite(initial.t_s) || initial.t_s < 0)) {
    throw new RangeError('initial time must be finite and non-negative');
  }
}


function computeNees(truth: TruthState, state: number[], covariance: number[][]): number {
  const error = [
    truth.r_hill_m[0] - state[0]!, truth.r_hill_m[1] - state[1]!, truth.r_hill_m[2] - state[2]!,
    truth.v_hill_mps[0] - state[3]!, truth.v_hill_mps[1] - state[4]!, truth.v_hill_mps[2] - state[5]!,
  ];
  const covarianceInverse = inverseMatrix(covariance, { strict: true });
  return error.reduce((sum, value, row) => sum + value * covarianceInverse[row]!.reduce(
    (inner, coefficient, column) => inner + coefficient * error[column]!,
    0,
  ), 0);
}

function simFswConfig(config: SimConfig, specs: readonly ThrusterSpec[]): FswConfig {
  return {
    ...config.fsw,
    allocatorConfig: {
      ...(config.fsw.allocatorConfig ?? {}),
      specs: config.fsw.allocatorConfig?.specs ?? specs,
    },
  };
}

/** Create the truth-privileged deterministic simulation loop. */
export function createSimLoop(config: SimConfig, seed: number): SimLoop {
  validateInitial(config.initial);
  const specs = config.thrusters?.specs ?? config.fsw.allocatorConfig?.specs ?? DRACO_THRUSTER_SPECS;
  const states: ThrusterStateMap = { ...(config.thrusters?.states ?? {}) };
  const fsw = createFsw(simFswConfig(config, specs));
  const sensorModel: SensorModel = createSensorModel(config.sensors, createRng(seed));
  let truth: TruthState = {
    t_s: config.initial.t_s ?? 0,
    r_hill_m: cloneVec3(config.initial.r_hill_m),
    v_hill_mps: cloneVec3(config.initial.v_hill_mps),
    q_BI: [...(config.initial.q_BI ?? IDENTITY_QUATERNION)],
    w_body_rps: [0, 0, 0],
    prop_kg: config.initial.prop_kg,
  };
  let truthTickIndex = 0;
  let remainingOnTimes: ThrusterCommand = {};

  const applyOneTruthTick = (): void => {
    const commandForTick: ThrusterCommand = {};
    for (const spec of specs) {
      const state = states[spec.id] ?? 'nominal';
      if (state !== 'nominal') remainingOnTimes[spec.id] = 0;
      commandForTick[spec.id] = state === 'nominal' ? Math.min(TRUTH_TICK_S, remainingOnTimes[spec.id] ?? 0) : 0;
    }
    const application = applyThrusterCommand(commandForTick, {
      specs,
      states,
      prop_kg: truth.prop_kg,
      dryMass_kg: config.fsw.massModel.dryMass_kg,
      truthHz: TRUTH_HZ,
      window_s: TRUTH_TICK_S,
      // FSW already applied the min-impulse deadband and quantization to the
      // whole pulse; each truth-tick slice must be applied as-is, or every
      // sub-20 ms slice of a legitimate pulse would be zeroed and nominal
      // jets would never fire in truth.
      minOnTime_s: 0,
    });
    truth = stepTruth(truth, {
      dt_s: TRUTH_TICK_S,
      externalSpecificForce_hill_mps2: application.specificForce_hill_mps2,
      propellantRate_kg_s: application.propellantRate_kg_s,
    });
    for (const spec of specs) {
      if ((states[spec.id] ?? 'nominal') === 'nominal') {
        remainingOnTimes[spec.id] = Math.max(0, (remainingOnTimes[spec.id] ?? 0) - TRUTH_TICK_S);
      }
    }
    truthTickIndex += 1;
  };

  const runFswTick = (): TelemetryFrame => {
    const output = fsw({ ...sensorModel.sample(truth), t_s: truth.t_s });
    remainingOnTimes = { ...output.thrusters };
    output.telemetry.nees = computeNees(truth, output.nav_diag.state, output.nav_diag.covariance);
    // Prop is a measured quantity on a real vehicle: publish the truth tank
    // level, not FSW's commanded-consumption estimate — otherwise stuck jets
    // silently diverge the gauge from reality.
    output.telemetry.prop_kg = truth.prop_kg;
    return output.telemetry;
  };

  return {
    stepTo(target_t_s) {
      if (!Number.isFinite(target_t_s) || target_t_s + 1e-9 < truth.t_s) throw new RangeError('target sim time must be finite and non-decreasing');
      const origin_t_s = config.initial.t_s ?? 0;
      const targetTickIndex = Math.floor((target_t_s - origin_t_s) * TRUTH_HZ + 1e-9);
      const frames: TelemetryFrame[] = [];
      while (truthTickIndex < targetTickIndex) {
        applyOneTruthTick();
        if (truthTickIndex % FSW_TICKS_PER_WINDOW === 0) frames.push(runFswTick());
      }
      return frames;
    },
    setController(controller) {
      fsw.setController(controller);
    },
    isolateThruster(id) {
      if (!specs.some((spec) => spec.id === id)) throw new RangeError(`unknown thruster ${id}`);
      states[id] = 'isolated';
      remainingOnTimes[id] = 0;
      fsw.setJetAvailability(id, false);
    },
    injectThrusterStuck(id, state) {
      if (!specs.some((spec) => spec.id === id)) throw new RangeError(`unknown thruster ${id}`);
      states[id] = state === 'OPEN' ? 'stuck_open' : 'stuck_closed';
    },
    setSensorDegrade(degrade) {
      sensorModel.setDegrade(degrade);
    },
    clearSensorDegrade() {
      sensorModel.clearDegrade();
    },
    getTruthState() {
      return cloneTruthState(truth);
    },
  };
}
