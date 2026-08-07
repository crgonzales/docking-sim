import { FSW_HZ, TRUTH_HZ } from './constants.js';
import {
  conjugateQuaternion,
  hillToBody,
  rotateVector,
  smallAngleLog,
} from './attitude.js';
import { createAllocator, type AllocatorConfig } from './allocator.js';
import { MEAN_MOTION_RAD_S } from './dynamics.js';
import { createEkf, type EkfConfig, type State6 } from './ekf.js';
import { createGuidance, type GuidanceConfig } from './guidance.js';
import {
  createAttitudeController,
  createLqrController,
  createPidController,
  type AttitudeControllerConfig,
  type LqrConfig,
  type PidGains,
  type StateController,
} from './control.js';
import { createMekf, type MekfConfig } from './mekf.js';
import { applyThrusterCommand } from './thrusters.js';
import { DRACO_THRUSTER_SPECS } from './thrusters.js';
import { probeAccelerationAuthority } from './authority.js';
import { createMpc, type MpcConfig, type MpcController } from './mpc.js';
import { computeSafingBurn, createCorridorMonitor, type AbortState } from './monitors.js';
import type {
  ControlMode,
  FswTick,
  ManualCommand,
  ManualSubMode,
  SensorFrame,
  TelemetryFrame,
  ThrusterCommand,
  Vec3,
} from './types.js';

export interface FswMassModel {
  dryMass_kg: number;
  initialProp_kg: number;
}

export interface FswConfig {
  controller: 'PID' | 'LQR' | 'MPC';
  pidGains?: PidGains;
  allocatorConfig?: AllocatorConfig;
  ekfConfig?: EkfConfig;
  guidanceConfig?: GuidanceConfig;
  lqrConfig?: LqrConfig;
  mekfConfig?: MekfConfig;
  attitudeControllerConfig?: AttitudeControllerConfig;
  mpcConfig?: MpcConfig;
  /** Required torque reserve used while probing MPC acceleration authority. */
  torqueReserve_Nm?: number;
  massModel: FswMassModel;
  /**
   * Ceiling on MANUAL-mode commanded translation force (N). Manual velocity
   * steps otherwise drive the translational controller into demands that
   * saturate every jet, leaving the allocator no torque authority — the
   * v0.4.0 tumble. 60 N leaves the canted 16-jet set comfortable headroom.
   */
  manualForceLimit_N?: number;
}

const DEFAULT_GUIDANCE_STATE: [number, number, number, number, number, number] = [0, -250, 12, 0, 0, 0];
const DEFAULT_PID_GAINS: PidGains = {
  kp_N_per_m: [0.2, 0.2, 0.2],
  ki_N_per_m_s: [0.002, 0.002, 0.002],
  kd_N_s_per_m: [2, 2, 2],
};
const ZERO_COMMAND: ThrusterCommand = {};
const ZERO_VECTOR: Vec3 = [0, 0, 0];
const DEG_PER_RAD = 180 / Math.PI;

function validateConfig(config: FswConfig): void {
  if (config.controller !== 'PID' && config.controller !== 'LQR' && config.controller !== 'MPC') throw new RangeError('controller must be PID, LQR, or MPC');
  if (!Number.isFinite(config.massModel.dryMass_kg) || config.massModel.dryMass_kg <= 0) throw new RangeError('dryMass_kg must be positive');
  if (!Number.isFinite(config.massModel.initialProp_kg) || config.massModel.initialProp_kg < 0) throw new RangeError('initialProp_kg must be non-negative');
}

function stateGuidanceConfig(config: FswConfig): GuidanceConfig {
  if (config.guidanceConfig !== undefined) return config.guidanceConfig;
  const initialState = config.ekfConfig?.initialNavPrior?.state ?? DEFAULT_GUIDANCE_STATE;
  return { initialState: [...initialState] as GuidanceConfig['initialState'] };
}

function mergedAvailability(
  specs: readonly { id: string }[],
  allocatorConfig: AllocatorConfig | undefined,
  operatorAvailability: Record<string, boolean>,
): Partial<Record<string, boolean>> {
  const configured = { ...(allocatorConfig?.availableMask ?? {}), ...(allocatorConfig?.availabilityMask ?? {}) };
  return Object.fromEntries(specs.map((spec) => [
    spec.id,
    configured[spec.id] !== false && operatorAvailability[spec.id] !== false,
  ]));
}

function finiteDt(sensor: SensorFrame, previousTime_s: number | null, defaultDt_s: number): number {
  if (previousTime_s === null) return defaultDt_s;
  const dt_s = sensor.t_s - previousTime_s;
  if (!(dt_s > 0) || !Number.isFinite(dt_s)) throw new RangeError('sensor timestamps must increase');
  return dt_s;
}

function validateManualCommand(command: ManualCommand): void {
  if ([...command.translation, ...command.rotation]
    .some((value) => !Number.isFinite(value) || value < -1 || value > 1)) {
    throw new RangeError('manual command axes must be finite and in [-1, 1]');
  }
}

function cloneManualCommand(command: ManualCommand): ManualCommand {
  return { translation: [...command.translation], rotation: [...command.rotation] };
}

function attitudeSigmaDeg(covariance: number[][]): number {
  return Math.sqrt(Math.max(0, (covariance[0]?.[0] ?? 0) + (covariance[1]?.[1] ?? 0) + (covariance[2]?.[2] ?? 0))) * DEG_PER_RAD;
}

function dockingTelemetry(
  sensor: SensorFrame,
  state: State6,
  q_BH: [number, number, number, number],
  omega_body_rps: Vec3,
  meanMotionRadS: number,
): TelemetryFrame['docking'] {
  // Gate on the NAV range, not the raw sensor: a range-sensor dropout must
  // not blank the docking display while the navigation solution stays valid.
  const range_m = Math.hypot(state[0], state[1], state[2]);
  if (!(range_m > 0) || range_m >= 50) return null;
  const closing_mps = -(state[0] * state[3] + state[1] * state[4] + state[2] * state[5]) / range_m;
  const lateral_m = Math.hypot(state[0], state[2]);
  const misalign_deg = Math.hypot(...smallAngleLog(q_BH)) * DEG_PER_RAD;
  const omega_hill_base_body_rps = rotateVector(q_BH, [0, 0, meanMotionRadS]);
  const rate_dps = Math.hypot(
    omega_body_rps[0] - omega_hill_base_body_rps[0],
    omega_body_rps[1] - omega_hill_base_body_rps[1],
    omega_body_rps[2] - omega_hill_base_body_rps[2],
  ) * DEG_PER_RAD;
  return { closing_mps, lateral_m, misalign_deg, rate_dps };
}

/** Create the pure FSW closure, including its operator command surface. */
export function createFsw(config: FswConfig): FswTick {
  validateConfig(config);
  const allocatorConfig = config.allocatorConfig ?? {};
  const specs = allocatorConfig.specs ?? DRACO_THRUSTER_SPECS;
  const commandWindow_s = 1 / (allocatorConfig.fswHz ?? FSW_HZ);
  const truthHz = allocatorConfig.truthHz ?? TRUTH_HZ;
  const guidance = createGuidance(stateGuidanceConfig(config));
  const ekf = createEkf(config.ekfConfig);
  const mekf = createMekf(config.mekfConfig);
  const meanMotionRadS = config.attitudeControllerConfig?.meanMotionRadS ?? MEAN_MOTION_RAD_S;
  const attitudeController = createAttitudeController({
    ...(config.attitudeControllerConfig ?? {}),
    meanMotionRadS,
  });
  const pid = createPidController({ gains: config.pidGains ?? DEFAULT_PID_GAINS });
  const lqr = createLqrController({
    ...(config.lqrConfig ?? {}),
    mass_kg: config.lqrConfig?.mass_kg ?? config.massModel.dryMass_kg + config.massModel.initialProp_kg,
  });
  const allocator = createAllocator(allocatorConfig);
  const operatorAvailability: Record<string, boolean> = {};
  specs.forEach((spec) => { operatorAvailability[spec.id] = true; });

  const manualForceLimit_N = config.manualForceLimit_N ?? 60;
  if (!(manualForceLimit_N > 0) || !Number.isFinite(manualForceLimit_N)) {
    throw new RangeError('manualForceLimit_N must be finite and positive');
  }
  let selectedController: 'PID' | 'LQR' | 'MPC' = config.controller;
  let propEstimate_kg = config.massModel.initialProp_kg;
  let lastSensorTime_s: number | null = null;
  let previousOnTimes: ThrusterCommand = { ...ZERO_COMMAND };
  let previousQ_HB: [number, number, number, number] = [1, 0, 0, 0];
  let controlMode: ControlMode = 'AUTO';
  let manualSubMode: ManualSubMode = 'RATE';
  let manualCommand: ManualCommand = { translation: [0, 0, 0], rotation: [0, 0, 0] };
  let lastAppliedMode: ControlMode = 'AUTO';
  let lastAppliedSubMode: ManualSubMode = 'RATE';
  let mpc: MpcController | null = null;
  let mpcFallback = false;
  const corridorMonitor = createCorridorMonitor({ dt_s: commandWindow_s });
  let abortState: AbortState = 'ARMED';
  let abortRequested = false;
  let abortElapsed_s = 0;
  let abortTargetVelocity_hill_mps: Vec3 = [0, 0, 0];
  const ABORT_COMPLETION_TOLERANCE_MPS = 0.01;
  const ABORT_TIMEOUT_S = 30;
  const ABORT_MAX_FORCE_N = 60;

  const createConfiguredMpc = (): MpcController | null => {
    const availability = mergedAvailability(specs, allocatorConfig, operatorAvailability);
    const authority = probeAccelerationAuthority(
      { ...allocatorConfig, availableMask: availability },
      config.massModel.dryMass_kg + propEstimate_kg,
      config.torqueReserve_Nm ?? 0.1,
    );
    // Loss of a controllable axis (heavy isolation) makes the octahedron
    // degenerate; MPC cannot be built. Degrade to LQR fallback instead of
    // letting createMpc throw inside the flight tick.
    if (authority.symmetric_mps2.some((radius) => !(radius > 0))) return null;
    return createMpc({
      ...(config.mpcConfig ?? {}),
      meanMotionRadS,
      authority,
    });
  };
  let mpcUnavailable = false;

  const tick = ((sensor: SensorFrame) => {
    const dt_s = finiteDt(sensor, lastSensorTime_s, commandWindow_s);
    lastSensorTime_s = sensor.t_s;
    mekf.step(sensor, dt_s);
    const att_diag = mekf.getAttDiag();
    const q_BH = hillToBody(
      att_diag.q_ref_BI,
      sensor.t_s,
      meanMotionRadS,
    );
    const omega_est_body_rps: Vec3 = [
      sensor.gyro_rps[0] - att_diag.bias_rps[0],
      sensor.gyro_rps[1] - att_diag.bias_rps[1],
      sensor.gyro_rps[2] - att_diag.bias_rps[2],
    ];
    const reference = guidance.reference(sensor.t_s);
    const previousApplication = applyThrusterCommand(previousOnTimes, {
      specs,
      prop_kg: propEstimate_kg,
      dryMass_kg: config.massModel.dryMass_kg,
      truthHz,
      window_s: commandWindow_s,
    });
    propEstimate_kg = Math.max(0, propEstimate_kg - previousApplication.propellantUsed_kg);

    const previousSpecificForceImpulse_mps: Vec3 = rotateVector(
      previousQ_HB,
      previousApplication.specificForce_body_mps2.map((value) => value * commandWindow_s) as Vec3,
    );
    const previousSpecificForce_mps2: Vec3 = previousSpecificForceImpulse_mps.map(
      (value) => value / dt_s,
    ) as Vec3;
    ekf.step(sensor, dt_s, reference.v_hill_mps, previousSpecificForce_mps2, {
      q_BH,
      attitudeCovariance: att_diag.covariance.slice(0, 3).map((row) => row.slice(0, 3)),
    });
    const nav_diag = ekf.getNavDiag();
    const corridor = corridorMonitor.corridorMonitor(nav_diag.state, dt_s);
    if (abortRequested && abortState === 'ARMED') {
      abortTargetVelocity_hill_mps = computeSafingBurn(nav_diag.state, meanMotionRadS).targetVelocity_hill_mps;
      abortState = 'BURNING';
      abortElapsed_s = 0;
    }
    if (abortState === 'ARMED' && controlMode === 'AUTO' && corridor.abortTrigger) {
      abortTargetVelocity_hill_mps = computeSafingBurn(nav_diag.state, meanMotionRadS).targetVelocity_hill_mps;
      abortState = 'BURNING';
      abortRequested = true;
      abortElapsed_s = 0;
    }
    const translationController: StateController = selectedController === 'PID' ? pid : lqr;
    let commandedForce_hill_N: Vec3;
    let commandedTorque_body_Nm: Vec3 = [...ZERO_VECTOR];
    if (abortState === 'BURNING') {
      const velocityError = abortTargetVelocity_hill_mps.map((value, index) => value - nav_diag.state[index + 3]!) as Vec3;
      const errorNorm_mps = Math.hypot(...velocityError);
      if (errorNorm_mps <= ABORT_COMPLETION_TOLERANCE_MPS || abortElapsed_s >= ABORT_TIMEOUT_S) {
        abortState = 'COASTING';
        commandedForce_hill_N = [...ZERO_VECTOR];
      } else {
        const massEstimate_kg = config.massModel.dryMass_kg + propEstimate_kg;
        const scale = Math.min(1, ABORT_MAX_FORCE_N / Math.max(1e-9, massEstimate_kg * errorNorm_mps));
        commandedForce_hill_N = velocityError.map((value) => value * massEstimate_kg * scale) as Vec3;
        abortElapsed_s += dt_s;
      }
      // The docking attitude IS the LVLH hold (identity q_BH: nose +ŷ into
      // the −ŷ-facing station port) — no MPC-specific attitude target exists.
      commandedTorque_body_Nm = attitudeController.stepAuto(att_diag.q_ref_BI, sensor.t_s, omega_est_body_rps);
    } else if (abortState === 'COASTING') {
      commandedForce_hill_N = [...ZERO_VECTOR];
      const rateDamping_Nm = attitudeController.step(
        q_BH,
        omega_est_body_rps,
        q_BH,
        rotateVector(q_BH, [0, 0, meanMotionRadS]),
      );
      commandedTorque_body_Nm = rateDamping_Nm;
    } else if (controlMode === 'AUTO') {
      if (selectedController === 'MPC') {
        if (mpc === null && !mpcUnavailable) {
          mpc = createConfiguredMpc();
          mpcUnavailable = mpc === null;
        }
        const mpcResult = mpc?.step(nav_diag.state, sensor.t_s) ?? null;
        if (mpcResult !== null && mpcResult.status === 'optimal') {
          const massEstimate_kg = config.massModel.dryMass_kg + propEstimate_kg;
          commandedForce_hill_N = mpcResult.accel_hill_mps2.map((value) => value * massEstimate_kg) as Vec3;
          mpcFallback = false;
        } else {
          commandedForce_hill_N = lqr.step(nav_diag.state, reference, dt_s);
          mpcFallback = true;
        }
      } else {
        commandedForce_hill_N = translationController.step(nav_diag.state, reference, dt_s);
        mpcFallback = false;
      }
      commandedTorque_body_Nm = attitudeController.stepAuto(att_diag.q_ref_BI, sensor.t_s, omega_est_body_rps);
    } else if (manualSubMode === 'RATE') {
      if (lastAppliedMode !== 'MANUAL' || lastAppliedSubMode !== 'RATE') {
        attitudeController.captureReference(
          [q_BH[0], q_BH[1], q_BH[2], q_BH[3]],
          [nav_diag.state[0], nav_diag.state[1], nav_diag.state[2]],
        );
        // Plan §7: every transition into RATE also resets the translation
        // controllers' integrator state — stale integral windup must never
        // command a snap maneuver against the freshly captured reference.
        pid.reset?.();
        lqr.reset?.();
      }
      const rateOutput = attitudeController.stepRate(
        q_BH,
        omega_est_body_rps,
        [nav_diag.state[0], nav_diag.state[1], nav_diag.state[2]],
        manualCommand,
        dt_s,
      );
      const manualReference: State6 = [
        rateOutput.reference.r_target_hill_m[0],
        rateOutput.reference.r_target_hill_m[1],
        rateOutput.reference.r_target_hill_m[2],
        rateOutput.reference.velocity_ref_hill_mps[0],
        rateOutput.reference.velocity_ref_hill_mps[1],
        rateOutput.reference.velocity_ref_hill_mps[2],
      ];
      commandedForce_hill_N = translationController.step(nav_diag.state, manualReference, dt_s);
      commandedTorque_body_Nm = rateOutput.torque_body_Nm;
    } else {
      const pulse = attitudeController.shapePulse(manualCommand);
      commandedForce_hill_N = rotateVector(conjugateQuaternion(q_BH), pulse.force_body_N);
      // PULSE is direct translation/torque with no attitude or position HOLD,
      // but it keeps rate DAMPING (like real direct-RCS modes): stepping the
      // PD with the current attitude as its own target yields zero attitude
      // error, leaving pure -Kd(omega - omega_LVLH) on top of the pilot's
      // torque command. Without it, canted-jet quantization residue
      // integrates unopposed and tumbles the vehicle.
      const rateDamping_Nm = attitudeController.step(
        q_BH,
        omega_est_body_rps,
        q_BH,
        rotateVector(q_BH, [0, 0, meanMotionRadS]),
      );
      commandedTorque_body_Nm = [
        pulse.torque_body_Nm[0] + rateDamping_Nm[0],
        pulse.torque_body_Nm[1] + rateDamping_Nm[1],
        pulse.torque_body_Nm[2] + rateDamping_Nm[2],
      ];
    }
    if (controlMode === 'MANUAL') {
      // Cap manual translation demand so the allocator always retains torque
      // authority (see FswConfig.manualForceLimit_N).
      const forceNorm_N = Math.hypot(...commandedForce_hill_N);
      if (forceNorm_N > manualForceLimit_N) {
        const scale = manualForceLimit_N / forceNorm_N;
        commandedForce_hill_N = commandedForce_hill_N.map((value) => value * scale) as Vec3;
      }
    }
    const commandedForce_body_N = rotateVector(q_BH, commandedForce_hill_N);
    const allocation = allocator.allocate(
      commandedForce_body_N,
      commandedTorque_body_Nm,
      mergedAvailability(specs, allocatorConfig, operatorAvailability),
    );
    previousOnTimes = { ...allocation.onTimes };
    previousQ_HB = conjugateQuaternion(q_BH);
    lastAppliedMode = controlMode;
    lastAppliedSubMode = manualSubMode;

    const navCovPos_m2: Vec3 = [
      nav_diag.covariance[0]?.[0] ?? 0,
      nav_diag.covariance[1]?.[1] ?? 0,
      nav_diag.covariance[2]?.[2] ?? 0,
    ];
    const thrusterDuty: Record<string, number> = Object.fromEntries(
      specs.map((spec) => [spec.id, (allocation.onTimes[spec.id] ?? 0) / commandWindow_s]),
    );
    const telemetry: TelemetryFrame = {
      t_s: sensor.t_s,
      nav_r_hill_m: [nav_diag.state[0], nav_diag.state[1], nav_diag.state[2]],
      nav_cov_pos_m2: navCovPos_m2,
      nees: null,
      corridor_err_m: corridor.corridor_err_m,
      controller: selectedController,
      mpc_fallback: selectedController === 'MPC' && controlMode === 'AUTO' ? mpcFallback : false,
      outcome: 'NONE',
      abort: abortState,
      control_mode: controlMode,
      prop_kg: propEstimate_kg,
      thruster_duty: thrusterDuty,
      sat_flag: allocation.satFlag,
      q_BH_est: [...q_BH],
      body_rate_dps_est: omega_est_body_rps.map((value) => value * DEG_PER_RAD) as Vec3,
      att_sigma_deg: attitudeSigmaDeg(att_diag.covariance),
      manual_sub_mode: controlMode === 'MANUAL' ? manualSubMode : null,
      docking: dockingTelemetry(sensor, nav_diag.state, q_BH, omega_est_body_rps, meanMotionRadS),
      att_nees: null,
    };
    return { thrusters: allocation.onTimes, telemetry, nav_diag, att_diag, abort: abortState !== 'ARMED', abort_state: abortState };
  }) as FswTick;

  tick.setController = (controller: 'PID' | 'LQR' | 'MPC') => {
    if (controller !== 'PID' && controller !== 'LQR' && controller !== 'MPC') throw new RangeError('controller must be PID, LQR, or MPC');
    selectedController = controller;
    if (controller !== 'MPC') {
      mpcFallback = false;
    }
  };
  tick.setJetAvailability = (id: string, available: boolean) => {
    if (!specs.some((spec) => spec.id === id)) throw new RangeError(`unknown thruster ${id}`);
    operatorAvailability[id] = available;
    mpc = null;
    mpcUnavailable = false; // availability changed — reprobe on next MPC tick
    if (selectedController !== 'MPC') mpcFallback = false;
  };
  tick.setControlMode = (mode: ControlMode) => {
    if (mode !== 'AUTO' && mode !== 'MANUAL') throw new RangeError('control mode must be AUTO or MANUAL');
    controlMode = mode;
  };
  tick.setManualSubMode = (mode: ManualSubMode) => {
    if (mode !== 'RATE' && mode !== 'PULSE') throw new RangeError('manual sub-mode must be RATE or PULSE');
    manualSubMode = mode;
  };
  tick.setManualCommand = (command: ManualCommand) => {
    validateManualCommand(command);
    manualCommand = cloneManualCommand(command);
  };
  tick.commandAbort = () => {
    if (abortState === 'ARMED') abortRequested = true;
  };
  return tick;
}
