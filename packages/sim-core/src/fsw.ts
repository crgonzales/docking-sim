import { FSW_HZ, TRUTH_HZ } from './constants.js';
import { createAllocator, type AllocatorConfig } from './allocator.js';
import { createEkf, type EkfConfig } from './ekf.js';
import { createGuidance, type GuidanceConfig } from './guidance.js';
import { createLqrController, createPidController, type LqrConfig, type PidGains, type StateController } from './control.js';
import { applyThrusterCommand } from './thrusters.js';
import { DRACO_THRUSTER_SPECS } from './thrusters.js';
import type { FswTick, SensorFrame, TelemetryFrame, ThrusterCommand, Vec3 } from './types.js';

export interface FswMassModel {
  dryMass_kg: number;
  initialProp_kg: number;
}

export interface FswConfig {
  controller: 'PID' | 'LQR';
  pidGains?: PidGains;
  allocatorConfig?: AllocatorConfig;
  ekfConfig?: EkfConfig;
  guidanceConfig?: GuidanceConfig;
  lqrConfig?: LqrConfig;
  massModel: FswMassModel;
}

const DEFAULT_GUIDANCE_STATE: [number, number, number, number, number, number] = [0, -250, 12, 0, 0, 0];
const DEFAULT_PID_GAINS: PidGains = {
  kp_N_per_m: [0.2, 0.2, 0.2],
  ki_N_per_m_s: [0.002, 0.002, 0.002],
  kd_N_s_per_m: [2, 2, 2],
};
const ZERO_COMMAND: ThrusterCommand = {};

function validateConfig(config: FswConfig): void {
  if (config.controller !== 'PID' && config.controller !== 'LQR') throw new RangeError('controller must be PID or LQR');
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

/** Create the pure FSW closure, including its operator command surface. */
export function createFsw(config: FswConfig): FswTick {
  validateConfig(config);
  const allocatorConfig = config.allocatorConfig ?? {};
  const specs = allocatorConfig.specs ?? DRACO_THRUSTER_SPECS;
  const commandWindow_s = 1 / (allocatorConfig.fswHz ?? FSW_HZ);
  const truthHz = allocatorConfig.truthHz ?? TRUTH_HZ;
  const guidance = createGuidance(stateGuidanceConfig(config));
  const ekf = createEkf(config.ekfConfig);
  const pid = createPidController({ gains: config.pidGains ?? DEFAULT_PID_GAINS });
  const lqr = createLqrController({
    ...(config.lqrConfig ?? {}),
    mass_kg: config.lqrConfig?.mass_kg ?? config.massModel.dryMass_kg + config.massModel.initialProp_kg,
  });
  const allocator = createAllocator(allocatorConfig);
  const operatorAvailability: Record<string, boolean> = {};
  specs.forEach((spec) => { operatorAvailability[spec.id] = true; });

  let selectedController: 'PID' | 'LQR' = config.controller;
  let propEstimate_kg = config.massModel.initialProp_kg;
  let lastSensorTime_s: number | null = null;
  let previousOnTimes: ThrusterCommand = { ...ZERO_COMMAND };

  const tick = ((sensor: SensorFrame) => {
    const dt_s = finiteDt(sensor, lastSensorTime_s, commandWindow_s);
    lastSensorTime_s = sensor.t_s;
    const reference = guidance.reference(sensor.t_s);
    const previousApplication = applyThrusterCommand(previousOnTimes, {
      specs,
      prop_kg: propEstimate_kg,
      dryMass_kg: config.massModel.dryMass_kg,
      truthHz,
      window_s: commandWindow_s,
    });
    propEstimate_kg = Math.max(0, propEstimate_kg - previousApplication.propellantUsed_kg);

    const previousSpecificForceImpulse_mps: Vec3 = previousApplication.specificForce_hill_mps2.map(
      (value) => value * commandWindow_s,
    ) as Vec3;
    const previousSpecificForce_mps2: Vec3 = previousSpecificForceImpulse_mps.map(
      (value) => value / dt_s,
    ) as Vec3;
    ekf.step(sensor, dt_s, reference.v_hill_mps, previousSpecificForce_mps2);
    const nav_diag = ekf.getNavDiag();
    const controller: StateController = selectedController === 'PID' ? pid : lqr;
    const commandedForce_N = controller.step(nav_diag.state, reference, dt_s);
    const allocation = allocator.allocate(
      commandedForce_N,
      mergedAvailability(specs, allocatorConfig, operatorAvailability),
    );
    previousOnTimes = { ...allocation.onTimes };

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
      corridor_err_m: null,
      controller: selectedController,
      control_mode: 'AUTO',
      prop_kg: propEstimate_kg,
      thruster_duty: thrusterDuty,
      sat_flag: allocation.satFlag,
    };
    return { thrusters: allocation.onTimes, telemetry, nav_diag };
  }) as FswTick;

  tick.setController = (controller: 'PID' | 'LQR') => {
    if (controller !== 'PID' && controller !== 'LQR') throw new RangeError('controller must be PID or LQR');
    selectedController = controller;
  };
  tick.setJetAvailability = (id: string, available: boolean) => {
    if (!specs.some((spec) => spec.id === id)) throw new RangeError(`unknown thruster ${id}`);
    operatorAvailability[id] = available;
  };
  return tick;
}
