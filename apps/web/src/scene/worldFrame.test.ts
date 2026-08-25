import { describe, expect, it } from 'vitest';
import {
  WORLD_FRAME_REBASE_THRESHOLD_M,
  SKY_CONFIG,
  SKY_DERIVED,
  worldFrameRebaseThresholdMFromKm,
} from './sky/skyConfig';
import {
  WorldFrame,
  distanceF64,
  rebaseAnchor,
  relativeToRender,
  shouldRebase,
  subtractF64,
  toRender,
} from './worldFrame';

describe('world frame', () => {
  it('subtracts the f64 anchor before converting to render units', () => {
    const anchor = [6_371_000_000, -2_000_000_000, 4_000_000_000] as const;
    const position = [6_371_012_500, -1_999_998_000, 4_000_003_500] as const;

    expect(toRender(position, anchor, 1)).toEqual([12_500, 2_000, 3_500]);
    expect(subtractF64(position, anchor)).toEqual([12_500, 2_000, 3_500]);
    expect(toRender(position, anchor, 1000)).toEqual([12.5, 2, 3.5]);
  });

  it('derives the rebase threshold from the physical sky configuration', () => {
    expect(SKY_DERIVED.worldFrameRebaseThresholdM)
      .toBe(worldFrameRebaseThresholdMFromKm(SKY_CONFIG.worldFrame.rebaseThresholdKm));
    expect(SKY_DERIVED.worldFrameRebaseThresholdScene)
      .toBe(WORLD_FRAME_REBASE_THRESHOLD_M / SKY_CONFIG.renderScaleMPerUnit);
    expect(WORLD_FRAME_REBASE_THRESHOLD_M).toBeGreaterThan(0);
  });

  it('rebases only beyond the threshold and snaps to the camera', () => {
    const anchor = [100_000, -200_000, 300_000] as const;
    const cameraAtThreshold = [100_000 + WORLD_FRAME_REBASE_THRESHOLD_M, -200_000, 300_000] as const;
    const cameraBeyondThreshold = [100_000 + WORLD_FRAME_REBASE_THRESHOLD_M + 1, -200_000, 300_000] as const;

    expect(shouldRebase(cameraAtThreshold, anchor)).toBe(false);
    expect(shouldRebase(cameraBeyondThreshold, anchor)).toBe(true);
    expect(rebaseAnchor(anchor, cameraAtThreshold)).toEqual(anchor);
    expect(rebaseAnchor(anchor, cameraBeyondThreshold)).toEqual(cameraBeyondThreshold);
    expect(distanceF64(cameraBeyondThreshold, anchor)).toBeGreaterThan(WORLD_FRAME_REBASE_THRESHOLD_M);
  });

  it('keeps the relative render-position oracle invariant across a rebase', () => {
    const frame = new WorldFrame([6_371_000_000, -2_000_000_000, 4_000_000_000], {
      metersPerUnit: 1,
      rebaseThresholdM: 100,
    });
    const camera = [6_371_000_250, -1_999_999_750, 4_000_000_125] as const;
    const objectA = [6_371_000_300, -1_999_999_700, 4_000_000_175] as const;
    const objectB = [6_371_000_450, -1_999_999_600, 4_000_000_225] as const;

    const beforeA = frame.toRender(objectA);
    const beforeB = frame.toRender(objectB);
    const before = subtractF64(beforeA, beforeB);
    expect(frame.rebase(camera)).toBe(true);
    const afterA = frame.toRender(objectA);
    const afterB = frame.toRender(objectB);
    const after = subtractF64(afterA, afterB);

    expect(after).toEqual(before);
    expect(afterA).not.toEqual(beforeA);
    expect(frame.anchor).toEqual(camera);
    expect(relativeToRender(objectA, objectB, 1)).toEqual(before);
  });

  it('does not expose mutable anchor storage', () => {
    const frame = new WorldFrame([1, 2, 3]);
    const anchor = frame.anchor as [number, number, number];
    anchor[0] = 99;

    expect(frame.anchor).toEqual([1, 2, 3]);
  });
});
