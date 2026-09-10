import { describe, expect, it } from 'vitest';
import { TERRAIN_SURFACE_DOMAINS, TERRAIN_SURFACE_PERIOD_CELLS, TERRAIN_SURFACE_WAVELENGTHS_M, terrainSurfacePhases } from './terrainSurfacePhase';

describe('planet-fixed surface phases', () => {
  it('preserves a physical point across patch origins, including negative coordinates', () => {
    const point = [3_516_217.123, 4_617_432.765, -2_617_001.341];
    const centers = [point, [3_515_000, 4_617_000, -2_618_000], [3_517_000, 4_618_000, -2_616_000]];
    for (const center of centers) {
      const phases = terrainSurfacePhases(center);
      TERRAIN_SURFACE_DOMAINS.forEach((rows, band) => rows.forEach((row, axis) => {
        const period = TERRAIN_SURFACE_WAVELENGTHS_M[band]! * TERRAIN_SURFACE_PERIOD_CELLS;
        const phase = phases[band]!.getComponent(axis);
        expect(phase).toBeGreaterThanOrEqual(0); expect(phase).toBeLessThan(1);
        const local = row.reduce<number>((s, v, i) => s + v * (point[i]! - center[i]!), 0) / period + phase;
        const global = row.reduce<number>((s, v, i) => s + v * point[i]!, 0) / period;
        // Phases differ only by full repetitions of the same periodic field.
        expect(Math.abs((global - local) - Math.round(global - local))).toBeLessThan(1e-9);
      }));
    }
  });

  it('rejects invalid geographic origins', () => {
    for (const point of [[], [0, 0], [0, NaN, 0], [0, Infinity, 0]]) {
      expect(() => terrainSurfacePhases(point)).toThrow('finite 3-vector');
    }
  });
});
