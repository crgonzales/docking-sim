import type { RateLabel } from './blocks';
import { immutable, readField, resolveTracePath, traceProvenance, type ProvenanceClass, type TracePath, type TraceRecords } from './tracePaths';
export type { ProvenanceClass } from './tracePaths';

export interface PortDescriptor {
  readonly id: string; readonly block: string; readonly direction: 'IN' | 'OUT'; readonly name: string;
  readonly dataType: 'double' | 'boolean' | 'enum' | 'quaternion';
  readonly dims: readonly [number] | readonly [number, number]; readonly unit: string;
  /** For quaternions this names the source frame: q_BI = ECI → BODY, q_BH = HILL → BODY. */
  readonly frame: 'HILL' | 'BODY' | 'ECI' | 'JET' | 'NONE'; readonly rate: RateLabel;
  readonly provenance: ProvenanceClass; readonly trace: TracePath;
  /** Pure selection, never arithmetic: e.g. state[0..2] or J1..J16 in fixed order. */
  readonly components?: readonly string[];
  readonly sampled?: boolean; readonly held?: boolean;
  readonly enumValues?: readonly string[];
  readonly when?: readonly (readonly { readonly path: TracePath; readonly value: string | boolean }[])[];
}
type Options = Partial<Omit<PortDescriptor, 'id' | 'block' | 'direction' | 'name' | 'trace' | 'unit' | 'frame' | 'dims'>>;
export const JET_IDS: readonly string[] = immutable(Array.from({ length: 16 }, (_, i) => `J${i + 1}`));
function out(block: string, name: string, trace: TracePath, unit: string, frame: PortDescriptor['frame'],
  dims: PortDescriptor['dims'] = [1], options: Options & { components?: readonly string[] } = {}): PortDescriptor {
  const provenance = traceProvenance(trace);
  if (provenance === null) throw new Error(`No provenance for ${trace}`);
  return { id: `${block}/out/${name}`, block, direction: 'OUT', name, trace, unit, frame, dims,
    dataType: 'double', rate: 'FSW_10HZ', provenance, ...options };
}
const truth = { rate: 'TRUTH_100HZ' } as const;
const quat = { dataType: 'quaternion' } as const;
const enumeration = (enumValues: readonly string[]): Options => ({ dataType: 'enum', enumValues });
const outputs: PortDescriptor[] = [
  out('plant.truth', 'position', 'plantTick.truth.r_hill_m', 'm', 'HILL', [3], truth),
  out('plant.truth', 'velocity', 'plantTick.truth.v_hill_mps', 'm/s', 'HILL', [3], truth),
  out('plant.truth', 'attitude', 'plantTick.truth.q_BI', '1', 'ECI', [4], { ...truth, ...quat }),
  out('plant.truth', 'rate', 'plantTick.truth.w_body_rps', 'rad/s', 'BODY', [3], truth),
  out('plant.truth', 'propellant', 'plantTick.truth.prop_kg', 'kg', 'NONE', [1], truth),
  out('plant.thrusters', 'activeTime', 'plantWindow.activeTime_s', 's', 'JET', [16], { components: JET_IDS, sampled: true }),
  out('plant.thrusters', 'impulseHill', 'plantWindow.impulse_hill_Ns', 'N*s', 'HILL', [3], { sampled: true }),
  out('plant.thrusters', 'impulseBody', 'plantWindow.impulse_body_Ns', 'N*s', 'BODY', [3], { sampled: true }),
  out('plant.thrusters', 'angularImpulse', 'plantWindow.angularImpulse_body_Nms', 'N*m*s', 'BODY', [3], { sampled: true }),
  out('plant.thrusters', 'propellantUsed', 'plantWindow.propellantUsed_kg', 'kg', 'NONE', [1], { sampled: true }),
  out('sensors.suite', 'range', 'fsw.sensor.range_m', 'm', 'NONE'),
  out('sensors.suite', 'bearing', 'fsw.sensor.bearing_body_rad', 'rad', 'BODY', [2]),
  out('sensors.suite', 'gyro', 'fsw.sensor.gyro_rps', 'rad/s', 'BODY', [3]),
  out('sensors.suite', 'gyroMean', 'fsw.sensor.gyro_mean_rps', 'rad/s', 'BODY', [3]),
  out('sensors.suite', 'starTracker', 'fsw.sensor.star_tracker_q_BI', '1', 'ECI', [4], quat),
  out('nav.mekf', 'attitude', 'fsw.mekf.q_ref_BI', '1', 'ECI', [4], quat),
  out('nav.mekf', 'bias', 'fsw.mekf.bias_rps', 'rad/s', 'BODY', [3]),
  out('nav.mekf', 'rate', 'fsw.omega_est_body_rps', 'rad/s', 'BODY', [3]),
  out('nav.frames', 'attitude', 'fsw.q_BH', '1', 'HILL', [4], quat),
  out('nav.ekf', 'position', 'fsw.nav.state', 'm', 'HILL', [3], { components: ['0', '1', '2'] }),
  out('nav.ekf', 'velocity', 'fsw.nav.state', 'm/s', 'HILL', [3], { components: ['3', '4', '5'] }),
  out('nav.ekf', 'positionVariance', 'fsw.nav.covariance', 'm^2', 'HILL', [3], { components: ['0.0', '1.1', '2.2'] }),
  out('nav.ekf', 'velocityVariance', 'fsw.nav.covariance', 'm^2/s^2', 'HILL', [3], { components: ['3.3', '4.4', '5.5'] }),
  out('nav.mekf', 'attitudeVariance', 'fsw.mekf.covariance', 'rad^2', 'BODY', [3], { components: ['0.0', '1.1', '2.2'] }),
  out('nav.mekf', 'biasVariance', 'fsw.mekf.covariance', 'rad^2/s^2', 'BODY', [3], { components: ['3.3', '4.4', '5.5'] }),
  out('nav.feedforward', 'propellantEstimate', 'fsw.propEstimate_kg', 'kg', 'NONE'),
  out('nav.feedforward', 'specificForce', 'fsw.feedforward_specificForce_hill_mps2', 'm/s^2', 'HILL', [3]),
  out('guidance.vbar', 'position', 'fsw.guidance.reference.r_hill_m', 'm', 'HILL', [3]),
  out('guidance.vbar', 'velocity', 'fsw.guidance.reference.v_hill_mps', 'm/s', 'HILL', [3]),
  out('guidance.vbar', 'frozen', 'fsw.guidance.frozen', '1', 'NONE', [1], { dataType: 'boolean' }),
  out('safety.corridor', 'error', 'fsw.corridor.corridor_err_m', 'm', 'HILL'),
  out('safety.corridor', 'caution', 'fsw.corridor.caution', '1', 'NONE', [1], { dataType: 'boolean' }),
  out('safety.corridor', 'abortTrigger', 'fsw.corridor.abortTrigger', '1', 'NONE', [1], { dataType: 'boolean' }),
  out('safety.abort', 'targetVelocity', 'fsw.abort.targetVelocity_hill_mps', 'm/s', 'HILL', [3]),
  out('safety.abort', 'state', 'fsw.abort.state', '1', 'NONE', [1], enumeration(['ARMED', 'BURNING', 'COASTING'])),
  out('fsw.modeSwitch', 'branch', 'fsw.mode.branch', '1', 'NONE', [1], enumeration(['ABORT_BURN', 'ABORT_COAST', 'AUTO', 'MANUAL_RATE', 'MANUAL_PULSE'])),
  out('fsw.modeSwitch', 'controller', 'fsw.mode.controller', '1', 'NONE', [1], enumeration(['PID', 'LQR', 'MPC'])),
  out('fsw.modeSwitch', 'forceHill', 'fsw.command.force_hill_N', 'N', 'HILL', [3]),
  out('fsw.modeSwitch', 'forceBody', 'fsw.command.force_body_N', 'N', 'BODY', [3]),
  // Only AUTO arms expose an un-clamped PID/LQR result in this trace. Manual
  // demands remain on modeSwitch; no inactive controller receives a fake output.
  out('control.pid', 'force', 'fsw.command.force_hill_N', 'N', 'HILL', [3], { when: [[
    { path: 'fsw.mode.branch', value: 'AUTO' }, { path: 'fsw.mode.controller', value: 'PID' }]] }),
  out('control.lqr', 'force', 'fsw.command.force_hill_N', 'N', 'HILL', [3], { when: [
    [{ path: 'fsw.mode.branch', value: 'AUTO' }, { path: 'fsw.mode.controller', value: 'LQR' }],
    [{ path: 'fsw.mode.branch', value: 'AUTO' }, { path: 'fsw.mode.controller', value: 'MPC' }, { path: 'fsw.mpc.fallback', value: true }]] }),
  out('control.attitude', 'torque', 'fsw.command.torque_body_Nm', 'N*m', 'BODY', [3]),
  out('control.mpc', 'acceleration', 'fsw.mpc.result.accel_hill_mps2', 'm/s^2', 'HILL', [3], { rate: 'MPC_1HZ_IN_10HZ' }),
  out('control.mpc', 'status', 'fsw.mpc.result.status', '1', 'NONE', [1], enumeration(['optimal', 'iteration_capped', 'numerical_failure'])),
  out('control.mpc', 'iterations', 'fsw.mpc.result.diagnostics.iterations', '1', 'NONE'),
  out('control.mpc', 'corridorSlack', 'fsw.mpc.result.diagnostics.slacks.corridor_m', 'm', 'HILL'),
  out('control.mpc', 'terminalPositionSlack', 'fsw.mpc.result.diagnostics.slacks.terminalPosition_m', 'm', 'HILL'),
  out('control.mpc', 'terminalVelocitySlack', 'fsw.mpc.result.diagnostics.slacks.terminalVelocity_mps', 'm/s', 'HILL'),
  out('control.mpc', 'fallback', 'fsw.mpc.fallback', '1', 'NONE', [1], { dataType: 'boolean' }),
  out('control.mpc', 'unavailable', 'fsw.mpc.unavailable', '1', 'NONE', [1], { dataType: 'boolean' }),
  out('pilot.manual', 'translation', 'fsw.manual.command.translation', '1', 'BODY', [3]),
  out('pilot.manual', 'rotation', 'fsw.manual.command.rotation', '1', 'BODY', [3]),
  out('alloc.jets', 'onTimes', 'fsw.allocation.onTimes', 's', 'JET', [16], { components: JET_IDS }),
  out('alloc.jets', 'preQuantizedOnTimes', 'fsw.allocation.preQuantizedOnTimes_s', 's', 'JET', [16], { components: JET_IDS }),
  out('alloc.jets', 'forceResidual', 'fsw.allocation.solveResidual_N', 'N', 'BODY', [3]),
  out('alloc.jets', 'torqueResidual', 'fsw.allocation.solveTorqueResidual_Nm', 'N*m', 'BODY', [3]),
  out('alloc.jets', 'forcePredicted', 'fsw.allocation.achievedForce_N', 'N', 'BODY', [3]),
  out('alloc.jets', 'torquePredicted', 'fsw.allocation.achievedTorque_Nm', 'N*m', 'BODY', [3]),
  out('alloc.jets', 'forceQuantized', 'fsw.allocation.achievedQuantizedForce_N', 'N', 'BODY', [3]),
  out('alloc.jets', 'torqueQuantized', 'fsw.allocation.achievedQuantizedTorque_Nm', 'N*m', 'BODY', [3]),
  out('alloc.jets', 'saturated', 'fsw.allocation.satFlag', '1', 'NONE', [1], { dataType: 'boolean' }),
];

/** Inputs copy the actual signal contract; boundary changes must be explicit. */
export function inputFrom(source: PortDescriptor, block: string, name = source.name,
  overrides: Partial<PortDescriptor> = {}): PortDescriptor {
  return { ...source, id: `${block}/in/${name}`, block, name, direction: 'IN', ...overrides };
}
export const OUTPUT_PORTS: readonly PortDescriptor[] = immutable(outputs);
export function readPort(records: TraceRecords, port: PortDescriptor): unknown {
  if (port.when && !port.when.some(group => group.every(c => resolveTracePath(records, c.path) === c.value))) return null;
  const value = resolveTracePath(records, port.trace);
  return port.components && value != null ? port.components.map(component => readField(value, component)) : value;
}

export interface ExportColumn {
  readonly id: string; readonly trace: TracePath; readonly component?: string;
  readonly unit: string; readonly frame: PortDescriptor['frame']; readonly provenance?: ProvenanceClass;
  readonly dataType: PortDescriptor['dataType'];
  readonly rate: 'FSW_10HZ'; readonly sourceRate: RateLabel; readonly enumValues?: readonly string[]; readonly portId?: string;
}
const clock = (id: string, trace: TracePath, unit: string): ExportColumn => ({ id, trace, unit, frame: 'NONE', dataType: 'double', rate: 'FSW_10HZ', sourceRate: 'FSW_10HZ' });
/** Schema v1: fixed numeric columns. Null → NaN; booleans → 0/1; enums → listed index.
 * B4 owns storage/encoding. No raw plant slices, pending windows or MPC horizons.
 * Plant truth columns are boundary samples; DELIVERED columns integrate the preceding window.
 */
export const EXPORT_COLUMNS: readonly ExportColumn[] = immutable([
  clock('time_s', 'plantWindow.bounds_s.1', 's'),
  clock('windowIndex', 'plantWindow.windowIndex', '1'),
  clock('windowStart_tick', 'plantWindow.bounds_tick.0', '1'),
  clock('windowEnd_tick', 'plantWindow.bounds_tick.1', '1'),
  clock('sourceFswSequence', 'plantWindow.sourceFswSequence', '1'),
  clock('sourceSamplePlantTick', 'plantWindow.sourceSamplePlantTick', '1'),
  clock('fswSequence', 'fsw.fswSequence', '1'),
  clock('samplePlantTick', 'fsw.samplePlantTick', '1'),
  clock('sampleTime_s', 'fsw.sampleTime_s', 's'),
  clock('commandStart_tick', 'fsw.commandInterval_tick.0', '1'),
  clock('commandEnd_tick', 'fsw.commandInterval_tick.1', '1'),
  ...OUTPUT_PORTS.filter(port => !port.when).flatMap(port => {
    const components = port.components ?? (port.dims[0] === 1 ? [undefined] : Array.from({ length: port.dims[0] }, (_, i) => String(i)));
    return components.map(component => ({ id: `${port.id}${component === undefined ? '' : `/${component}`}`,
      portId: port.id, trace: port.trace, component, unit: port.unit, frame: port.frame, dataType: port.dataType,
      rate: 'FSW_10HZ' as const, sourceRate: port.rate,
      provenance: port.provenance, enumValues: port.enumValues }));
  }),
]);
export const EXPORT_SCHEMA_VERSION = 1;
export const EXPORT_COLUMN_COUNT = EXPORT_COLUMNS.length;
