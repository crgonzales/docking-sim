import { describe, expect, it } from 'vitest';
import { sceneSmaaLinearBlend } from './SceneSmaaFixture';

describe('independent SMAA GPU readback oracle', () => {
  it.each(['horizontal', 'vertical'])('checks fractional %s linear blending from measured weights', axis => {
    const input = new Float32Array(3 * 3 * 4), weights = new Float32Array(input.length);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
      const c = (axis === 'horizontal' ? x : y) === 2 ? 0.064 : 0.004;
      input.set([c, c, c, 1], (y * 3 + x) * 4);
    }
    // A half-pixel offset toward the bright neighbor. No opposite contribution.
    if (axis === 'horizontal') weights[(1 * 3 + 2) * 4 + 3] = 0.5;
    else weights[(2 * 3 + 1) * 4 + 1] = 0.5;
    const result = sceneSmaaLinearBlend(input, weights, 3, 3, 1, 1);
    expect(result[0]).toBeCloseTo(0.034, 7); expect(result[3]).toBe(1);
    expect(sceneSmaaLinearBlend(input, new Float32Array(weights.length), 3, 3, 1, 1)[0]).toBeCloseTo(0.004, 7);
  });
});
