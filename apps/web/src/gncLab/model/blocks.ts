import type * as SimCore from '@docking/sim-core';
import { immutable, type TracePath } from './tracePaths';

export type RateLabel = 'TRUTH_100HZ' | 'FSW_10HZ' | 'MPC_1HZ_IN_10HZ' | 'EVENT';
export const RATE_LABELS = immutable({ TRUTH_100HZ: '100 Hz truth', FSW_10HZ: '10 Hz FSW',
  MPC_1HZ_IN_10HZ: '1 Hz re-solve / 10 Hz call', EVENT: 'Event; observed at next FSW sample' });
export interface BlockDescriptor {
  readonly id: string;
  readonly label: string;
  readonly group: 'PLANT' | 'SENSORS' | 'NAV' | 'GUIDANCE' | 'CONTROL' | 'ALLOCATION' | 'SAFETY' | 'PILOT';
  readonly source: { readonly module: string; readonly symbol: keyof typeof SimCore | 'tick' | 'evaluateContact';
    readonly kind: 'export' | 'module-private'; readonly member?: string };
  readonly rate: RateLabel;
  readonly truth: boolean;
  readonly params: readonly string[];
  readonly inspect: readonly TracePath[];
}
function block(id: string, label: string, group: BlockDescriptor['group'], module: string,
  symbol: BlockDescriptor['source']['symbol'], inspect: readonly TracePath[], rate: RateLabel = 'FSW_10HZ',
  truth = false, kind: BlockDescriptor['source']['kind'] = 'export', member?: string): BlockDescriptor {
  return { id, label, group, source: { module, symbol, kind, ...(member ? { member } : {}) }, rate, truth, params: [], inspect };
}

export const BLOCKS: readonly BlockDescriptor[] = immutable([
  block('plant.truth', '6-DOF truth plant (RK4)', 'PLANT', 'dynamics.ts', 'stepTruth', ['plantTick.truth'], 'TRUTH_100HZ', true),
  block('plant.thrusters', 'Thruster model + propellant', 'PLANT', 'thrusters.ts', 'applyThrusterCommand', ['plantWindow.activeTime_s', 'plantWindow.impulse_hill_Ns', 'pendingWindow.activeTime_s'], 'TRUTH_100HZ', true),
  block('plant.contact', 'Capture envelope / contact', 'PLANT', 'sim.ts', 'evaluateContact', ['plantTick.outcome', 'plantTick.docked'], 'TRUTH_100HZ', true, 'module-private'),
  block('sensors.suite', 'Range/bearing/gyro/star tracker', 'SENSORS', 'sensors.ts', 'createSensorModel', ['fsw.sensor'], 'FSW_10HZ', true),
  block('nav.mekf', 'Attitude MEKF + gyro bias', 'NAV', 'mekf.ts', 'createMekf', ['fsw.mekf', 'fsw.omega_est_body_rps']),
  block('nav.frames', 'q_BI → q_BH', 'NAV', 'attitude.ts', 'hillToBody', ['fsw.q_BH']),
  block('nav.ekf', 'Translational EKF (CW)', 'NAV', 'ekf.ts', 'createEkf', ['fsw.nav']),
  block('nav.feedforward', 'Previous-command specific force', 'NAV', 'thrusters.ts', 'applyThrusterCommand', ['fsw.feedforward_specificForce_hill_mps2']),
  block('guidance.vbar', 'V-bar glideslope profile', 'GUIDANCE', 'guidance.ts', 'createGuidance', ['fsw.guidance']),
  block('safety.corridor', 'Two-level corridor monitor', 'SAFETY', 'monitors.ts', 'createCorridorMonitor', ['fsw.corridor']),
  block('safety.abort', 'Abort state machine + safing burn', 'SAFETY', 'monitors.ts', 'computeSafingBurn', ['fsw.abort']),
  block('fsw.modeSwitch', 'AUTO/MANUAL/abort branch', 'CONTROL', 'fsw.ts', 'tick', ['fsw.mode', 'fsw.command'], 'FSW_10HZ', false, 'module-private'),
  block('control.pid', 'PID translational control', 'CONTROL', 'control.ts', 'createPidController', ['fsw.mode']),
  block('control.lqr', 'LQR translational control', 'CONTROL', 'control.ts', 'createLqrController', ['fsw.mode']),
  block('control.mpc', 'Condensed CW MPC (active-set QP)', 'CONTROL', 'mpc.ts', 'createMpc', ['fsw.mpc'], 'MPC_1HZ_IN_10HZ'),
  block('control.attitude', 'Quaternion-error PD / rate / pulse', 'CONTROL', 'control.ts', 'createAttitudeController', ['fsw.manual.rateReference', 'fsw.command.torque_body_Nm']),
  // setManualCommand is a SimLoop method, not a top-level package export.
  block('pilot.manual', 'Pilot input', 'PILOT', 'sim.ts', 'createSimLoop', ['fsw.manual.command'], 'EVENT', false, 'export', 'setManualCommand'),
  block('alloc.jets', '6-target bounded allocator', 'ALLOCATION', 'allocator.ts', 'createAllocator', ['fsw.allocation']),
]);
