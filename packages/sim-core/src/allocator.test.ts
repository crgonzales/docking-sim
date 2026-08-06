import { describe, expect, it } from 'vitest';
import { FSW_HZ, TRUTH_HZ } from './constants.js';
import { createAllocator } from './allocator.js';
import { DRACO_THRUSTER_SPECS } from './thrusters.js';
import type { Vec3 } from './types.js';

const magnitude = (value: Vec3): number => Math.hypot(...value);

describe('bounded thruster allocator', () => {
  it('tracks feasible positive and negative force axes without saturation', () => {
    const allocator = createAllocator({ torqueWeight: 0.05 });
    for (const axis of [0, 1, 2] as const) {
      for (const sign of [-1, 1]) {
        const command: Vec3 = [0, 0, 0];
        command[axis] = sign * 5;
        const result = allocator.allocate(command);
        expect(result.satFlag).toBe(false);
        expect(magnitude(result.solveResidual_N)).toBeLessThan(0.05 * magnitude(command));
      }
    }
  });

  it('honors availability masks, bounds, deadband, and truth-tick quantization', () => {
    const allocator = createAllocator();
    const masked = Object.fromEntries(DRACO_THRUSTER_SPECS.slice(0, 4).map((spec) => [spec.id, false]));
    const result = allocator.allocate([4, -2, 3], masked);
    for (const spec of DRACO_THRUSTER_SPECS.slice(0, 4)) expect(result.onTimes[spec.id]).toBe(0);
    for (const spec of DRACO_THRUSTER_SPECS) {
      const onTime_s = result.onTimes[spec.id] ?? 0;
      expect(onTime_s).toBeGreaterThanOrEqual(0);
      expect(onTime_s).toBeLessThanOrEqual(1 / FSW_HZ);
      expect(onTime_s * TRUTH_HZ).toBeCloseTo(Math.round(onTime_s * TRUTH_HZ), 12);
    }

    const deadband = allocator.allocate([0.01, 0, 0]);
    expect(Object.values(deadband.onTimes).every((onTime_s) => onTime_s === 0)).toBe(true);
  });

  it('uses torque as a secondary objective instead of force-only allocation', () => {
    const demand: Vec3 = [4, -3, 2];
    const torqueAware = createAllocator({ torqueWeight: 0.05 }).allocate(demand);
    const forceOnly = createAllocator({ torqueWeight: 1e-10 }).allocate(demand);
    expect(magnitude(torqueAware.achievedTorque_Nm)).toBeLessThanOrEqual(
      magnitude(forceOnly.achievedTorque_Nm) + 1e-6,
    );
  });

  it('reports infeasible force demand using the pre-quantization residual', () => {
    const allocator = createAllocator();
    const feasible = allocator.allocate([5, 0, 0]);
    const infeasible = allocator.allocate([1_000, 0, 0]);
    expect(feasible.satFlag).toBe(false);
    expect(infeasible.satFlag).toBe(true);
    expect(magnitude(infeasible.solveResidual_N)).toBeGreaterThan(0.05 * 1_000);
  });
});
