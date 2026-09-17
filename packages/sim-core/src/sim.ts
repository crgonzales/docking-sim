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
import { CORRIDOR, insideCaptureEnvelope } from './corridor.js';
import { createFsw, type FswConfig } from './fsw.js';
import type { ManualAuthority } from './control.js';
import { inverseMatrix } from './linalg.js';
import { createRng } from './rng.js';
import { createWorldAnchor, type WorldAnchorConfig } from './worldAnchor.js';
import { createSensorModel, resolveActualImu, type SensorDegradeConfig, type SensorModel, type SensorModelConfig } from './sensors.js';
import { createImuBodyAdapter } from './imuFrames.js';
import type { MountSet } from './mounts.js';
import { applyThrusterCommand, DRACO_THRUSTER_SPECS } from './thrusters.js';
import type {
  ControlMode,
  ManualCommand,
  ManualSubMode,
  NavSource,
  Quat,
  RenderState,
  TelemetryFrame,
  ThrusterCommand,
  TruthState,
  Vec3,
} from './types.js';
import type { ThrusterSpec, ThrusterState, ThrusterStateMap } from './thrusters.js';
import { stepTruth, type InertiaTensor } from './dynamics.js';
import type {
  FswTraceRecord,
  PendingWindow,
  PlantSlice,
  PlantTickRecord,
  PlantWindowRecord,
  TraceSource,
} from './trace.js';

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
  /**
   * Opt-in physical orbit placement. Legacy attitudes remain in I0.
   * Omitted rates inherit the anchor's n; explicit overrides must agree within
   * relative 1e-12. Without an anchor, all legacy defaults/overrides are retained.
   */
  anchor?: WorldAnchorConfig;
  /** Truth-only installation; assumed geometry lives in fsw.mountCalibration. */
  mounts?: MountSet;
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
  setNavSource(source: NavSource): void;
  injectGuidanceFault(): void;
  clearGuidanceFault(): void;
  setManualSubMode(mode: ManualSubMode): void;
  setManualCommand(command: ManualCommand): void;
  holdManualPosition(): void;
  setManualAuthority(level: ManualAuthority): void;
  isolateThruster(id: string): void;
  injectThrusterStuck(id: string, state: 'OPEN' | 'CLOSED'): void;
  injectVelocityBias(dv_mps: Vec3): void;
  setSensorDegrade(degrade: SensorDegradeConfig): void;
  clearSensorDegrade(): void;
  getTruthState(): TruthState;
  getRenderState(): RenderState;
}

export type SimOutcome = 'NONE' | 'DOCKED' | 'COLLISION' | 'ABORT';

const IDENTITY_QUATERNION: Quat = [1, 0, 0, 0];
const TRUTH_TICK_S = 1 / TRUTH_HZ;
const FSW_TICKS_PER_WINDOW = TRUTH_HZ / FSW_HZ;
const FSW_WINDOW_S = FSW_TICKS_PER_WINDOW * TRUTH_TICK_S;
export const STATION_PORT_HILL: Vec3 = CORRIDOR.apex_hill_m;
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

function simFswConfig(
  config: SimConfig,
  specs: readonly ThrusterSpec[],
  onTrace?: (record: FswTraceRecord) => void,
): FswConfig {
  return {
    ...config.fsw,
    allocatorConfig: {
      ...(config.fsw.allocatorConfig ?? {}),
      specs: config.fsw.allocatorConfig?.specs ?? specs,
    },
    // Only the traced loop adds the sink; the untraced config stays as it was.
    ...(onTrace === undefined ? {} : { onTrace }),
  };
}

function zeroJetRecord(specs: readonly ThrusterSpec[]): Record<string, number> {
  return Object.fromEntries(specs.map((spec) => [spec.id, 0]));
}

/** Resolve once, only for an enabled anchor; never mutate the caller's config. */
function anchoredConfig(config: SimConfig, meanMotionRadS: number): SimConfig {
  const { fsw, sensors } = config;
  const sites = [
    ['fsw.attitudeControllerConfig.meanMotionRadS', fsw.attitudeControllerConfig?.meanMotionRadS],
    ['fsw.ekfConfig.meanMotionRadS', fsw.ekfConfig?.meanMotionRadS],
    ['fsw.lqrConfig.meanMotionRadS', fsw.lqrConfig?.meanMotionRadS],
    ['fsw.mpcConfig.meanMotionRadS', fsw.mpcConfig?.meanMotionRadS],
    ['sensors.meanMotionRadS', sensors?.meanMotionRadS],
  ] as const;
  // Relative 1e-12 tolerance admits rounding, then all consumers use exactly n.
  for (const [site, value] of sites) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0
      || Math.abs(value - meanMotionRadS) > meanMotionRadS * 1e-12)) {
      throw new RangeError(`SimConfig.${site} must match anchor.meanMotionRadS (${meanMotionRadS})`);
    }
  }
  return { ...config, sensors: { ...sensors, meanMotionRadS }, fsw: {
    ...fsw,
    attitudeControllerConfig: { ...fsw.attitudeControllerConfig, meanMotionRadS },
    ekfConfig: { ...fsw.ekfConfig, meanMotionRadS },
    lqrConfig: { ...fsw.lqrConfig, meanMotionRadS },
    mpcConfig: { ...fsw.mpcConfig, meanMotionRadS },
  } };
}

/** Create the truth-privileged deterministic simulation loop. */
export function createSimLoop(config: SimConfig, seed: number): SimLoop {
  return buildSimLoop(config, seed, false).sim;
}

/**
 * Create the same deterministic loop with a read-only trace channel. `sim` is
 * an ordinary `SimLoop`; `trace` hands out FSW records (sensor-derived) and
 * plant records (truth-privileged) and is therefore excluded from the scenario
 * package by the honesty grep, exactly like `getTruthState`.
 */
export function createTracedSimLoop(config: SimConfig, seed: number): { sim: SimLoop; trace: TraceSource } {
  const built = buildSimLoop(config, seed, true);
  return { sim: built.sim, trace: built.trace! };
}

function buildSimLoop(config: SimConfig, seed: number, tracing: boolean): { sim: SimLoop; trace: TraceSource | null } {
  validateInitial(config.initial);
  const anchorMeanMotion = config.anchor === undefined ? undefined : createWorldAnchor(config.anchor).meanMotionRadS;
  if (anchorMeanMotion !== undefined) config = anchoredConfig(config, anchorMeanMotion);
  if (config.mounts !== undefined && config.sensors?.mounts !== undefined) throw new RangeError('Specify actual mounts at SimConfig.mounts or sensors.mounts, not both');
  const sensorConfig = config.mounts === undefined ? config.sensors : { ...config.sensors, mounts: config.mounts };
  const actualImu = resolveActualImu(sensorConfig ?? {});
  const adaptImu = actualImu === undefined ? undefined : createImuBodyAdapter(config.fsw.mountCalibration!, actualImu.id);
  const specs = config.thrusters?.specs ?? config.fsw.allocatorConfig?.specs ?? DRACO_THRUSTER_SPECS;
  const states: ThrusterStateMap = { ...(config.thrusters?.states ?? {}) };

  // Trace state. Every access sits behind `tracing`, so the untraced loop does
  // exactly the work it did before this channel existed.
  const fswSubscribers = new Set<(record: FswTraceRecord) => void>();
  const plantTickSubscribers = new Set<(record: PlantTickRecord) => void>();
  const plantWindowSubscribers = new Set<(record: PlantWindowRecord) => void>();
  // Private snapshots. Nothing outside this closure ever holds a reference to
  // them: subscribers and getters receive independent structuredClone copies
  // (the same detachment fsw.ts applies before calling onTrace), so a mutating
  // observer cannot rewrite history, corrupt another observer, or alter the
  // provenance of a later window.
  let latestFswRecord: FswTraceRecord | null = null;
  let latestPlantTickRecord: PlantTickRecord | null = null;
  let latestPlantWindowRecord: PlantWindowRecord | null = null;
  // Window provenance is captured as scalars at FSW time, never read back
  // through a record object.
  let heldFswSequence: number | null = null;
  let heldSamplePlantTick: number | null = null;
  const publish = <T>(subscribers: Set<(record: T) => void>, record: T): void => {
    for (const subscriber of subscribers) subscriber(structuredClone(record));
  };
  let windowIndex = 1;
  let windowStartTick = 0;
  let windowStart_t_s = config.initial.t_s ?? 0;
  let windowSlices = 0;
  let windowDockedSlices = 0;
  let windowActiveTime_s: Record<string, number> = zeroJetRecord(specs);
  let windowImpulseBody_Ns: Vec3 = [0, 0, 0];
  let windowImpulseHill_Ns: Vec3 = [0, 0, 0];
  let windowAngularImpulseBody_Nms: Vec3 = [0, 0, 0];
  let windowPropellantUsed_kg = 0;

  const fsw = createFsw(simFswConfig(config, specs, tracing
    ? (record) => {
      // fsw.ts already handed us a detached clone; it becomes the private snapshot.
      latestFswRecord = record;
      heldFswSequence = record.fswSequence;
      heldSamplePlantTick = record.samplePlantTick;
      publish(fswSubscribers, record);
    }
    : undefined));
  const sensorModel: SensorModel = createSensorModel(sensorConfig, createRng(seed), config.fsw.mountCalibration);
  let truth: TruthState = {
    t_s: config.initial.t_s ?? 0,
    r_hill_m: cloneVec3(config.initial.r_hill_m),
    v_hill_mps: cloneVec3(config.initial.v_hill_mps),
    q_BI: [...(config.initial.q_BI ?? IDENTITY_QUATERNION)],
    w_body_rps: cloneVec3(config.initial.w_body_rps ?? [0, 0, 0]),
    prop_kg: config.initial.prop_kg,
  };
  let truthTickIndex = 0;
  let gyroWindow_s = 0;
  let gyroIntegral: Vec3 = [0, 0, 0];
  let remainingOnTimes: ThrusterCommand = {};
  let accumulatedActiveOnTime_s: Record<string, number> = Object.fromEntries(specs.map((spec) => [spec.id, 0]));
  let latchedThrusterDuty: Record<string, number> = Object.fromEntries(specs.map((spec) => [spec.id, 0]));
  let outcome: SimOutcome = 'NONE';
  let docked = false;
  let pendingVelocityBias_mps: Vec3 | null = null;
  const meanMotionRadS = config.fsw.attitudeControllerConfig?.meanMotionRadS ?? DEFAULT_MEAN_MOTION_RAD_S;

  const evaluateContact = (): void => {
    if (outcome !== 'NONE') return;
    const meanMotion = meanMotionRadS;
    const q_BH = hillToBody(truth.q_BI, truth.t_s, meanMotion);
    const q_HB = conjugateQuaternion(q_BH);
    const chaserPort_hill_m = truth.r_hill_m.map((value, index) => value + rotateVector(q_HB, CHASER_PORT_BODY)[index]!) as Vec3;
    const portDelta_hill_m = subtract(chaserPort_hill_m, STATION_PORT_HILL);
    // Contact is crossing the docking face, not entering a 5 cm sphere about
    // its center. That sphere silently made the advertised 10 cm lateral
    // capture envelope impossible to use between 5 and 10 cm of offset.
    const lateral_m = Math.hypot(portDelta_hill_m[0], portDelta_hill_m[2]);
    if (Math.abs(portDelta_hill_m[1]) > 0.05 || lateral_m > 0.85) return;
    const dockingAxis_hill = rotateVector(q_HB, [0, 1, 0]);
    // Closing = motion along the docking axis toward the station: the axis
    // points +ŷ (into the port), so a positive projection is closing.
    const closing_mps = dot(truth.v_hill_mps, dockingAxis_hill);
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

  const windowSnapshot = (): PendingWindow => ({
    windowIndex,
    bounds_tick: [windowStartTick, truthTickIndex],
    bounds_s: [windowStart_t_s, truth.t_s],
    sourceFswSequence: heldFswSequence,
    sourceSamplePlantTick: heldSamplePlantTick,
    docked: windowSlices > 0 && windowDockedSlices === windowSlices,
    activeTime_s: { ...windowActiveTime_s },
    impulse_body_Ns: cloneVec3(windowImpulseBody_Ns),
    impulse_hill_Ns: cloneVec3(windowImpulseHill_Ns),
    angularImpulse_body_Nms: cloneVec3(windowAngularImpulseBody_Nms),
    propellantUsed_kg: windowPropellantUsed_kg,
    slicesIntegrated: windowSlices,
  });

  /** Fold one 10 ms slice into the window accumulators and publish its tick record. */
  const tracePlantTick = (slice: PlantSlice, dockedTick: boolean, q_HB_slice: Quat | null, biasApplied_mps: Vec3 | null): void => {
    for (const spec of specs) {
      windowActiveTime_s[spec.id] = (windowActiveTime_s[spec.id] ?? 0) + (slice.activeOnTime_s[spec.id] ?? 0);
    }
    const impulseBody_Ns: Vec3 = [
      slice.force_body_N[0] * TRUTH_TICK_S,
      slice.force_body_N[1] * TRUTH_TICK_S,
      slice.force_body_N[2] * TRUTH_TICK_S,
    ];
    // Body sums are per-slice; the Hill sum rotates each slice by the attitude
    // it was applied at, so it stays exact under within-window rotation.
    const impulseHill_Ns = q_HB_slice === null ? impulseBody_Ns : rotateVector(q_HB_slice, impulseBody_Ns);
    for (let axis = 0; axis < 3; axis++) {
      windowImpulseBody_Ns[axis]! += impulseBody_Ns[axis]!;
      windowImpulseHill_Ns[axis]! += impulseHill_Ns[axis]!;
      windowAngularImpulseBody_Nms[axis]! += slice.torque_body_Nm[axis]! * TRUTH_TICK_S;
    }
    windowPropellantUsed_kg += slice.propellantUsed_kg;
    windowSlices += 1;
    if (dockedTick) windowDockedSlices += 1;
    const record: PlantTickRecord = {
      plantTick: truthTickIndex,
      t_s: truth.t_s,
      truth: cloneTruthState(truth),
      docked: dockedTick,
      slice,
      jetStates: Object.fromEntries(specs.map((spec) => [spec.id, states[spec.id] ?? 'nominal'])),
      outcome,
      velocityBiasApplied_mps: biasApplied_mps,
    };
    latestPlantTickRecord = record;
    publish(plantTickSubscribers, record);
  };

  /** Publish the integrated window and reset the accumulators — only after the flush. */
  const flushWindow = (): void => {
    const record: PlantWindowRecord = windowSnapshot();
    latestPlantWindowRecord = record;
    publish(plantWindowSubscribers, record);
    windowIndex += 1;
    windowStartTick = truthTickIndex;
    windowStart_t_s = truth.t_s;
    windowSlices = 0;
    windowDockedSlices = 0;
    windowActiveTime_s = zeroJetRecord(specs);
    windowImpulseBody_Ns = [0, 0, 0];
    windowImpulseHill_Ns = [0, 0, 0];
    windowAngularImpulseBody_Nms = [0, 0, 0];
    windowPropellantUsed_kg = 0;
  };

  const applyOneTruthTick = (): void => {
    const biasApplied_mps = tracing && pendingVelocityBias_mps !== null ? cloneVec3(pendingVelocityBias_mps) : null;
    if (pendingVelocityBias_mps !== null) {
      truth = {
        ...truth,
        v_hill_mps: truth.v_hill_mps.map((value, index) => value + pendingVelocityBias_mps![index]!) as Vec3,
      };
      pendingVelocityBias_mps = null;
    }
    if (docked) {
      // Docked = rigidly attached to the station: the inertial attitude must
      // keep rotating with the LVLH frame (recomputed each tick), or q_BH
      // would drift at orbital rate and contradict the pinned w_body_rps.
      const t_next = truth.t_s + TRUTH_TICK_S;
      truth = { ...truth, t_s: t_next, q_BI: dockingQBi(t_next, meanMotionRadS) };
      for (let axis = 0; axis < 3; axis++) gyroIntegral[axis]! += truth.w_body_rps[axis]! * TRUTH_TICK_S;
      gyroWindow_s += TRUTH_TICK_S;
      truthTickIndex += 1;
      if (tracing) {
        // No thruster application happens on a docked tick, so the slice is an
        // explicit zero record rather than a fabricated applyThrusterCommand result.
        tracePlantTick({
          onTimes_s: zeroJetRecord(specs),
          activeOnTime_s: zeroJetRecord(specs),
          force_body_N: [0, 0, 0],
          torque_body_Nm: [0, 0, 0],
          specificForce_body_mps2: [0, 0, 0],
          propellantUsed_kg: 0,
        }, true, null, biasApplied_mps);
      }
      return;
    }
    const q_HB_slice: Quat | null = tracing
      ? conjugateQuaternion(hillToBody(truth.q_BI, truth.t_s, meanMotionRadS))
      : null;
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
    for (const spec of specs) {
      accumulatedActiveOnTime_s[spec.id] = (accumulatedActiveOnTime_s[spec.id] ?? 0)
        + (application.activeOnTime_s[spec.id] ?? 0);
    }
    const previousRate = truth.w_body_rps;
    truth = stepTruth(truth, {
      dt_s: TRUTH_TICK_S,
      meanMotionRadS: anchorMeanMotion,
      externalSpecificForce_body_mps2: application.specificForce_body_mps2,
      torque_body_Nm: application.torque_Nm,
      inertia_kg_m2: config.inertia_kg_m2,
      propellantRate_kg_s: application.propellantRate_kg_s,
    });
    for (let axis = 0; axis < 3; axis++) {
      gyroIntegral[axis]! += 0.5 * (previousRate[axis]! + truth.w_body_rps[axis]!) * TRUTH_TICK_S;
    }
    gyroWindow_s += TRUTH_TICK_S;
    evaluateContact();
    for (const spec of specs) {
      if ((states[spec.id] ?? 'nominal') === 'nominal') {
        remainingOnTimes[spec.id] = Math.max(0, (remainingOnTimes[spec.id] ?? 0) - TRUTH_TICK_S);
      }
    }
    truthTickIndex += 1;
    if (tracing) {
      tracePlantTick({
        onTimes_s: { ...commandForTick },
        activeOnTime_s: { ...application.activeOnTime_s },
        force_body_N: cloneVec3(application.force_N),
        torque_body_Nm: cloneVec3(application.torque_Nm),
        specificForce_body_mps2: cloneVec3(application.specificForce_body_mps2),
        propellantUsed_kg: application.propellantUsed_kg,
      }, false, q_HB_slice, biasApplied_mps);
    }
  };

  const latchThrusterDuty = (): void => {
    latchedThrusterDuty = Object.fromEntries(specs.map((spec) => [
      spec.id,
      Math.max(0, Math.min(1, (accumulatedActiveOnTime_s[spec.id] ?? 0) / FSW_WINDOW_S)),
    ]));
    accumulatedActiveOnTime_s = Object.fromEntries(specs.map((spec) => [spec.id, 0]));
  };

  const runFswTick = (): TelemetryFrame => {
    const sensor = sensorModel.sample(truth);
    // Model the IMU's accumulated rotation between FSW updates. Sampling only
    // the rate at the END of a PWM window aliases short torque pulses into a
    // persistent attitude/bias error. Preserve sensor bias/noise in this mean;
    // no truth attitude or position is exposed to navigation.
    if (actualImu !== undefined && sensor.imu_raw !== undefined) {
      const integralSensor = rotateVector(actualImu.q_SB, gyroIntegral);
      const endpointSensor = rotateVector(actualImu.q_SB, truth.w_body_rps);
      if (gyroWindow_s > 0) sensor.imu_raw.gyro_mean_sensor_rps = integralSensor.map((angle, axis) =>
        angle / gyroWindow_s + sensor.imu_raw!.gyro_sensor_rps[axis]! - endpointSensor[axis]!) as Vec3;
      Object.assign(sensor, adaptImu!(sensor.imu_raw));
    } else if (gyroWindow_s > 0) sensor.gyro_mean_rps = gyroIntegral.map((angle, axis) =>
      angle / gyroWindow_s + sensor.gyro_rps[axis]! - truth.w_body_rps[axis]!) as Vec3;
    gyroIntegral = [0, 0, 0]; gyroWindow_s = 0;
    const output = fsw(sensor);
    remainingOnTimes = { ...output.thrusters };
    output.telemetry.nees = computeNees(truth, output.nav_diag.state, output.nav_diag.covariance);
    output.telemetry.att_nees = computeAttitudeNees(truth, output.att_diag, sensorModel.getTrueGyroBiasBody());
    // Prop is a measured quantity on a real vehicle: publish the truth tank
    // level, not FSW's commanded-consumption estimate — otherwise stuck jets
    // silently diverge the gauge from reality.
    output.telemetry.prop_kg = truth.prop_kg;
    if (outcome === 'NONE' && output.abort) outcome = 'ABORT';
    output.telemetry.outcome = outcome;
    return output.telemetry;
  };

  const sim: SimLoop = {
    stepTo(target_t_s) {
      if (!Number.isFinite(target_t_s) || target_t_s + 1e-9 < truth.t_s) throw new RangeError('target sim time must be finite and non-decreasing');
      const origin_t_s = config.initial.t_s ?? 0;
      const targetTickIndex = Math.floor((target_t_s - origin_t_s) * TRUTH_HZ + 1e-9);
      const frames: TelemetryFrame[] = [];
      while (truthTickIndex < targetTickIndex) {
        applyOneTruthTick();
        if (truthTickIndex % FSW_TICKS_PER_WINDOW === 0) {
          latchThrusterDuty();
          // The window closes at the same point the render duty latches:
          // after the tenth slice, before the next command exists.
          if (tracing) flushWindow();
          frames.push(runFswTick());
        }
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
    setNavSource(source) {
      fsw.setNavSource(source);
    },
    injectGuidanceFault() {
      fsw.injectGuidanceFault();
    },
    clearGuidanceFault() {
      fsw.clearGuidanceFault();
    },
    setManualSubMode(mode) {
      fsw.setManualSubMode(mode);
    },
    setManualCommand(command) {
      fsw.setManualCommand(command);
    },
    holdManualPosition() {
      fsw.holdManualPosition();
    },
    setManualAuthority(level) {
      fsw.setManualAuthority(level);
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
    injectVelocityBias(dv_mps) {
      if (dv_mps.some((value) => !Number.isFinite(value))) throw new RangeError('velocity bias must be finite');
      pendingVelocityBias_mps = [...dv_mps];
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
        q_BH: hillToBody(truth.q_BI, truth.t_s, anchorMeanMotion),
        thruster_duty: { ...latchedThrusterDuty },
      };
    },
  };

  if (!tracing) return { sim, trace: null };

  const subscribe = <T>(set: Set<(record: T) => void>, fn: (record: T) => void): (() => void) => {
    set.add(fn);
    return () => { set.delete(fn); };
  };
  const trace: TraceSource = {
    subscribeFsw: (fn) => subscribe(fswSubscribers, fn),
    subscribePlantTick: (fn) => subscribe(plantTickSubscribers, fn),
    subscribePlantWindow: (fn) => subscribe(plantWindowSubscribers, fn),
    latestFsw: () => (latestFswRecord === null ? null : structuredClone(latestFswRecord)),
    latestPlantTick: () => (latestPlantTickRecord === null ? null : structuredClone(latestPlantTickRecord)),
    latestPlantWindow: () => (latestPlantWindowRecord === null ? null : structuredClone(latestPlantWindowRecord)),
    // windowSnapshot already builds a fresh object from the accumulators on every call.
    pendingWindow: windowSnapshot,
  };
  return { sim, trace };
}
