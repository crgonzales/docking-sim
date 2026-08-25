import { describe, expect, it } from 'vitest';
import { geoidSurfacePosition, isWaterHeight } from './terrainWater';

describe('terrain water selection', () => {
  it('selects sea level and below without selecting positive land', () => {
    expect(isWaterHeight(-0.1)).toBe(true);
    expect(isWaterHeight(0)).toBe(true);
    expect(isWaterHeight(0.1)).toBe(false);
  });

  it('places selected vertices exactly on the geoid', () => {
    const surface = geoidSurfacePosition([3, 4, 12], 10);
    expect(Math.hypot(...surface)).toBeCloseTo(10, 12);
    expect(surface[0] / surface[2]).toBeCloseTo(3 / 12, 12);
  });
});
