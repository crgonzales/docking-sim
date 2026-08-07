import { createAllocator, type AllocatorConfig } from './allocator.js';
import { DRACO_THRUSTER_SPECS } from './thrusters.js';
import type { Vec3 } from './types.js';

function norm(vector: Vec3): number {
  return Math.hypot(...vector);
}

function axisVector(axis: number, value: number): Vec3 {
  const vector: Vec3 = [0, 0, 0];
  vector[axis] = value;
  return vector;
}

function probeAxis(
  allocatorConfig: AllocatorConfig,
  massEstimate_kg: number,
  torqueReserve_Nm: number,
  axis: number,
  sign: -1 | 1,
): number {
  const specs = allocatorConfig.specs ?? DRACO_THRUSTER_SPECS;
  const totalThrust_N = specs.reduce((sum, spec) => sum + spec.thrust_N, 0);
  let candidate_mps2 = Math.max(1e-6, 2 * totalThrust_N / massEstimate_kg);
  const torqueDemand: Vec3 = [torqueReserve_Nm, torqueReserve_Nm, torqueReserve_Nm];

  // Each probe gets a fresh allocator. Its impulse carry is stateful, so even
  // a scratch allocator must not be reused across independent authority points.
  while (candidate_mps2 >= 1e-8) {
    const scratch = createAllocator({ ...allocatorConfig });
    const commandedForce_N = axisVector(axis, sign * candidate_mps2 * massEstimate_kg);
    const allocation = scratch.allocate(commandedForce_N, torqueDemand);
    const requestedForce_N = norm(commandedForce_N);
    const forceResidualFraction = requestedForce_N > 0
      ? norm(allocation.solveResidual_N) / requestedForce_N
      : 0;
    // The point is only "authority" if the TORQUE reserve was also delivered
    // cleanly — accepting on force residual alone would declare acceleration
    // the allocator can produce only by giving up the attitude margin the
    // reserve exists to protect.
    const torqueDemand_Nm = norm(torqueDemand);
    const torqueResidualOk = torqueDemand_Nm <= 1e-12
      || (norm(allocation.solveTorqueResidual_Nm) / torqueDemand_Nm < 0.05 && !allocation.satFlag);
    if (forceResidualFraction < 0.05 && torqueResidualOk) return candidate_mps2;
    candidate_mps2 /= 2;
  }
  return 0;
}

/** Six independently probed ±axis magnitudes and their symmetric octahedron. */
export interface AccelerationAuthority {
  positive_mps2: Vec3;
  negative_mps2: Vec3;
  /** Conservative symmetric radii used by the inscribed MPC octahedron. */
  symmetric_mps2: Vec3;
}

/**
 * Probe a fresh allocator for each axis/sign pair. The flight allocator is
 * never passed probe traffic, and only pre-quantization residuals determine
 * whether a candidate is accepted.
 */
export function probeAccelerationAuthority(
  allocatorConfig: AllocatorConfig,
  massEstimate_kg: number,
  torqueReserve_Nm: number,
): AccelerationAuthority {
  if (!(massEstimate_kg > 0) || !Number.isFinite(massEstimate_kg)) throw new RangeError('massEstimate_kg must be positive');
  if (!(torqueReserve_Nm >= 0) || !Number.isFinite(torqueReserve_Nm)) throw new RangeError('torqueReserve_Nm must be finite and non-negative');
  const positive: Vec3 = [0, 0, 0];
  const negative: Vec3 = [0, 0, 0];
  const symmetric: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    positive[axis] = probeAxis(allocatorConfig, massEstimate_kg, torqueReserve_Nm, axis, 1);
    negative[axis] = probeAxis(allocatorConfig, massEstimate_kg, torqueReserve_Nm, axis, -1);
    symmetric[axis] = Math.min(positive[axis]!, negative[axis]!);
  }
  return { positive_mps2: positive, negative_mps2: negative, symmetric_mps2: symmetric };
}
