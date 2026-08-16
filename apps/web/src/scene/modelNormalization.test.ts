import { describe, expect, it } from 'vitest';
import {
  CHASER_MODEL_NORMALIZATION,
  computeModelNormalizationTransform,
  maxAbsComponent,
  TARGET_MODEL_NORMALIZATION,
} from './modelNormalization';

describe('model normalization', () => {
  it('maps a declared source-space port to its sim anchor', () => {
    const transform = computeModelNormalizationTransform({
      scale: 2,
      rotation: [0, 0, Math.PI / 2],
      pivotOffset: [1, 2, 3],
      portLocal: [1, 0, 0],
      portAnchor: [1, 4, 3],
    });

    expect(transform.portPosition[0]).toBeCloseTo(1, 12);
    expect(transform.portPosition[1]).toBeCloseTo(4, 12);
    expect(transform.portPosition[2]).toBeCloseTo(3, 12);
    expect(maxAbsComponent(transform.portError)).toBeLessThanOrEqual(0.01);
  });

  it('registers both supplied model ports within the docking tolerance', () => {
    for (const normalization of [CHASER_MODEL_NORMALIZATION, TARGET_MODEL_NORMALIZATION]) {
      const transform = computeModelNormalizationTransform(normalization);
      expect(maxAbsComponent(transform.portError)).toBeLessThanOrEqual(0.01);
    }
  });
});
