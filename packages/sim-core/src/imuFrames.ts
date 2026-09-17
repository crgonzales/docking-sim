import { conjugateQuaternion, rotateVector } from './attitude.js';
import type { MountCalibration } from './mounts.js';
import type { Quat, Vec3 } from './types.js';

/** Measured inertial angular rate expressed in IMU sensor axes. No installation
 * geometry or true bias travels with a sample. Standalone endpoint samples omit
 * the mean; SimLoop supplies it after accumulating the full truth window. */
export interface ImuRawSample {
  mount_id: string;
  gyro_sensor_rps: Vec3;
  gyro_mean_sensor_rps?: Vec3;
}

/** Calibration-only boundary. Snapshot the assumed sensor→body rotation once;
 * neither actual installation nor truth state is an input to this adapter. */
export function createImuBodyAdapter(calibration: MountCalibration, mountId: string) {
  if (calibration?.role !== 'CALIBRATION') throw new RangeError('IMU adapter requires assumed CALIBRATION');
  const entries = calibration.sensors.filter(m => m.id === mountId);
  const mount = entries[0];
  if (entries.length !== 1 || mount?.kind !== 'IMU') throw new RangeError(`Missing or ambiguous IMU calibration: ${mountId}`);
  if (!Array.isArray(mount.q_SB) || mount.q_SB.length !== 4 || !Array.from(mount.q_SB).every(Number.isFinite)
    || Math.abs(Math.hypot(...mount.q_SB) - 1) > 1e-10) throw new RangeError('IMU calibration q_SB must be unit length');
  const q_BS = conjugateQuaternion([...mount.q_SB] as Quat);
  const body = (v: Vec3): Vec3 => {
    if (!Array.isArray(v) || v.length !== 3 || !Array.from(v).every(Number.isFinite)) throw new RangeError('IMU rates must contain three finite values');
    return rotateVector(q_BS, v);
  };
  return (raw: ImuRawSample): { gyro_rps: Vec3; gyro_mean_rps?: Vec3 } => {
    if (raw.mount_id !== mountId) throw new RangeError(`IMU sample/calibration id mismatch: ${raw.mount_id}`);
    return { gyro_rps: body(raw.gyro_sensor_rps),
      ...(raw.gyro_mean_sensor_rps === undefined ? {} : { gyro_mean_rps: body(raw.gyro_mean_sensor_rps) }) };
  };
}
