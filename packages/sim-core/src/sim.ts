import { FSW_HZ, TRUTH_HZ } from './constants.js';
import {
  conjugateQuaternion,
  DEFAULT_MEAN_MOTION_RAD_S,
  errorQuaternion,
  hillFromInertial,
  hillToBody,
  multiplyQuaternion,
  rotateVector,
  smallAngleLog,
} from './attitude.js';
import { insideCaptureEnvelope } from './corridor.js';
import { createFsw, type FswConfig } from './fsw.js';
import { inverseMatrix } from './linalg.js';
import { createRng } from './rng.js';
import { createSensorModel, type SensorDegradeConfig, type SensorModel, type SensorModelConfig } from './sensors.js';
import { applyThrusterCommand, DRACO_THRUSTER_SPECS } from './thrusters.js';
import type {
  ControlMode,
  ManualCommand,
  ManualSubMode,
  Quat,
  RenderState,
  TelemetryFrame,
  ThrusterCommand,
  TruthState,
  Vec3,
} from './types.js';
import type { ThrusterSpec, ThrusterState, ThrusterStateMap } from './thrusters.js';
import { stepTruth, type InertiaTensor } from './dynamics.js';

export interface SimInitialConditions {
  r_hill_m: Vec3;
  v_hill_mps: Vec3;
  prop_kg: number;
  q_BI?: Quat;
  w_body_rps?: Vec3;
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
  /** Diagonal body-frame inertia `[Ixx, Iyy, Izz]` in kg·m². */
  inertia_kg_m2?: InertiaTensor;
}

export interface SimLoop {
  stepTo(t_s: number): TelemetryFrame[];
  setController(controller: 'PID' | 'LQR' | 'MPC'): void;
  commandAbort(): void;
  setControlMode(mode: ControlMode): void;
  setManualSubMode(mode: ManualSubMode): void;
  setManualCommand(command: ManualCommand): void;
  isolateThruster(id: string): void;
  injectThrusterStuck(id: string, state: 'OPEN' | 'CLOSED'): void;
  setSensorDegrade(degrade: SensorDegradeConfig): void;
  clearSensorDegrade(): void;
  getTruthState(): TruthState;
  getRenderState(): RenderState;
}

export type SimOutcome = 'NONE' | 'DOCKED' | 'COLLISION' | 'ABORT';

const IDENTITY_QUATERNION: Quat = [1, 0, 0, 0];
const TRUTH_TICK_S = 1 / TRUTH_HZ;
const FSW_TICKS_PER_WINDOW = TRUTH_HZ / FSW_HZ;
const STATION_PORT_HILL: Vec3 = [0, -8.7, 0];
const CHASER_PORT_BODY: Vec3 = [0, 1.7, 0];
/**
 * Docked attitude: identity q_BH — the chaser's +ŷ docking axis points INTO
 * the station port (which faces −ŷ), per the Phase 1 geometry and the FSW
 * docking-telemetry convention (misalign measured from identity q_BH).
 * The chaser approaches from −ŷ, so its COM docks at y = −8.7 − 1.7 = −10.4.
 */
const DOCKING_Q_BH: Quat = [1, 0, 0, 0];
const DEG_PER_RAD = 180 / Math.PI;

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
  if ([...initial.r_hill_m, ...initial.v_hill_mps, ...(initial.w_body_rps ?? [0, 0, 0]), initial.prop_kg]
    .some((value) => !Number.isFinite(value))) {
    throw new RangeError('initial truth conditions must be finite');
  }
  if (initial.prop_kg < 0) throw new RangeError('initial propellant must be non-negative');
  if (initial.t_s !== undefined && (!Number.isFinite(initial.t_s) || initial.t_s < 0)) {
    throw new RangeError('initial time must be finite and non-negative');
  }
}

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function dockingQBi(t_s: number, meanMotionRadS: number): Quat {
  return multiplyQuaternion(DOCKING_Q_BH, conjugateQuaternion(hillFromInertial(t_s, meanMotionRadS)));
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

function computeAttitudeNees(
  truth: TruthState,
  attDiag: { q_ref_BI: Quat; bias_rps: Vec3; covariance: number[][]; initialized: boolean },
  trueGyroBias_rps: Vec3,
): number | null {
  if (!attDiag.initialized) return null;
  const attitudeError = smallAngleLog(errorQuaternion(attDiag.q_ref_BI, truth.q_BI));
  const error = [
    attitudeError[0], attitudeError[1], attitudeError[2],
    trueGyroBias_rps[0] - attDiag.bias_rps[0],
    trueGyroBias_rps[1] - attDiag.bias_rps[1],
    trueGyroBias_rps[2] - attDiag.bias_rps[2],
  ];
  const covarianceInverse = inverseMatrix(attDiag.covariance, { strict: true });
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
    w_body_rps: cloneVec3(config.initial.w_body_rps ?? [0, 0, 0]),
    prop_kg: config.initial.prop_kg,
  };
  let truthTickIndex = 0;
  let remainingOnTimes: ThrusterCommand = {};
  let outcome: SimOutcome = 'NONE';
  let docked = false;
  const meanMotionRadS = config.fsw.attitudeControllerConfig?.meanMotionRadS ?? DEFAULT_MEAN_MOTION_RAD_S;

  const evaluateContact = (): void => {
    if (outcome !== 'NONE') return;
    const meanMotion = meanMotionRadS;
    const q_BH = hillToBody(truth.q_BI, truth.t_s, meanMotion);
    const q_HB = conjugateQuaternion(q_BH);
    const chaserPort_hill_m = truth.r_hill_m.map((value, index) => value + rotateVector(q_HB, CHASER_PORT_BODY)[index]!) as Vec3;
    const portDelta_hill_m = subtract(chaserPort_hill_m, STATION_PORT_HILL);
    if (Math.hypot(...portDelta_hill_m) > 0.05) return;
    const dockingAxis_hill = rotateVector(q_HB, [0, 1, 0]);
    // Closing = motion along the docking axis toward the station: the axis
    // points +ŷ (into the port), so a positive projection is closing.
    const closing_mps = dot(truth.v_hill_mps, dockingAxis_hill);
    const lateral_m = Math.hypot(portDelta_hill_m[0], portDelta_hill_m[2]);
    // Misalign = FULL attitude error from the aligned (identity-q_BH) docked
    // orientation — matching FSW telemetry. An axis-only angle would let a
    // craft rolled 180° about its docking axis pass as perfectly aligned;
    // real docking mechanisms have roll capture limits too.
    const misalign_deg = Math.hypot(...smallAngleLog(q_BH)) * DEG_PER_RAD;
    const omega_lvh_body_rps = rotateVector(q_BH, [0, 0, meanMotion]);
    const rate_dps = Math.hypot(
      truth.w_body_rps[0] - omega_lvh_body_rps[0],
      truth.w_body_rps[1] - omega_lvh_body_rps[1],
      truth.w_body_rps[2] - omega_lvh_body_rps[2],
    ) * DEG_PER_RAD;
    const capture = insideCaptureEnvelope(closing_mps, lateral_m, misalign_deg, rate_dps);
    outcome = capture.inside ? 'DOCKED' : 'COLLISION';
    if (outcome === 'DOCKED') {
      docked = true;
      const q_BI = dockingQBi(truth.t_s, meanMotion);
      const q_HB_docked = conjugateQuaternion(DOCKING_Q_BH);
      const portOffset_hill = rotateVector(q_HB_docked, CHASER_PORT_BODY);
      truth = {
        ...truth,
        r_hill_m: subtract(STATION_PORT_HILL, portOffset_hill),
        v_hill_mps: [0, 0, 0],
        q_BI,
        w_body_rps: rotateVector(DOCKING_Q_BH, [0, 0, meanMotion]),
      };
    }
  };

  const applyOneTruthTick = (): void => {
    if (docked) {
      // Docked = rigidly attached to the station: the inertial attitude must
      // keep rotating with the LVLH frame (recomputed each tick), or q_BH
      // would drift at orbital rate and contradict the pinned w_body_rps.
      const t_next = truth.t_s + TRUTH_TICK_S;
      truth = { ...truth, t_s: t_next, q_BI: dockingQBi(t_next, meanMotionRadS) };
      truthTickIndex += 1;
      return;
    }
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
      externalSpecificForce_body_mps2: application.specificForce_body_mps2,
      torque_body_Nm: application.torque_Nm,
      inertia_kg_m2: config.inertia_kg_m2,
      propellantRate_kg_s: application.propellantRate_kg_s,
    });
    evaluateContact();
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
    output.telemetry.att_nees = computeAttitudeNees(truth, output.att_diag, sensorModel.getTrueGyroBias());
    // Prop is a measured quantity on a real vehicle: publish the truth tank
    // level, not FSW's commanded-consumption estimate — otherwise stuck jets
    // silently diverge the gauge from reality.
    output.telemetry.prop_kg = truth.prop_kg;
    if (outcome === 'NONE' && output.abort) outcome = 'ABORT';
    output.telemetry.outcome = outcome;
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
    commandAbort() {
      fsw.commandAbort();
    },
    setControlMode(mode) {
      fsw.setControlMode(mode);
    },
    setManualSubMode(mode) {
      fsw.setManualSubMode(mode);
    },
    setManualCommand(command) {
      fsw.setManualCommand(command);
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
    getRenderState() {
      return {
        t_s: truth.t_s,
        r_hill_m: cloneVec3(truth.r_hill_m),
        v_hill_mps: cloneVec3(truth.v_hill_mps),
        q_BH: hillToBody(truth.q_BI, truth.t_s),
      };
    },
  };
}
