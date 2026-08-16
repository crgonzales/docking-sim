import { describe, expect, it } from 'vitest';
import {
  CLOUD_COVERAGE_DETAIL_MODULATION,
  CLOUD_COVERAGE_REMAP_CENTER,
  CLOUD_COVERAGE_SMOOTH_MAX,
  CLOUD_COVERAGE_SMOOTH_MIN,
  CLOUD_DECK_CONTRAST,
  CLOUD_DECK_DETAIL_STRENGTH,
  cloudCoverageAtCpu,
} from './skyConfig';
import { CLOUD_COVERAGE_GLSL } from './cloudCoverage';
import {
  cloudSphericalUv,
  sampleCloudPlacements,
  sampleCoverageMask,
  type CoverageMask,
} from './cloudPlacement';

function maskWithBands(width = 64, height = 32): CoverageMask {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data[y * width + x] = x < width / 2 ? 51 : 204;
  }
  return { width, height, data };
}

describe('cloud mask placement', () => {
  it('is deterministic for a fixed seed', () => {
    const mask = maskWithBands();
    const first = sampleCloudPlacements(256, 0.48, mask, 0x12345678);
    const second = sampleCloudPlacements(256, 0.48, mask, 0x12345678);
    expect(Array.from(first.positions)).toEqual(Array.from(second.positions));
    expect(Array.from(first.seeds)).toEqual(Array.from(second.seeds));
    expect(first.attempts).toBe(second.attempts);
  });

  it('keeps every accepted sample above the final coverage threshold and inside the cap', () => {
    const result = sampleCloudPlacements(512, 0.48, maskWithBands());
    for (let index = 0; index < result.coverages.length; index += 1) {
      const x = result.positions[index * 3];
      expect(result.coverages[index]).toBeGreaterThan(0);
      expect(x).toBeGreaterThanOrEqual(0.48);
    }
  });

  it('makes accepted density proportional to coverage', () => {
    const result = sampleCloudPlacements(4000, 0.48, maskWithBands(), 0xdecafbad);
    let low = 0;
    let high = 0;
    for (let index = 0; index < result.coverages.length; index += 1) {
      const [u] = cloudSphericalUv(
        result.positions[index * 3],
        result.positions[index * 3 + 1],
        result.positions[index * 3 + 2],
      );
      if (u < 0.5) low += 1;
      else high += 1;
    }
    expect(high / low).toBeCloseTo(4, 0);
  });

  it('keeps the mask registration aligned with the 4k equirectangular map convention', () => {
    // SphereGeometry convention (the deck's vUv): -x is u=0, +x is u=0.5.
    // The previous expectations encoded a +0.5 offset that rotated shadows
    // and volumetrics 180 deg from the visible deck.
    expect(cloudSphericalUv(1, 0, 0)[0]).toBeCloseTo(0.5, 12);
    expect(cloudSphericalUv(-1, 0, 0)[0]).toBeCloseTo(0, 12);
    expect(cloudSphericalUv(0, 1, 0)[1]).toBeCloseTo(1, 12);
    const mask = { width: 4, height: 2, data: new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255]) };
    expect(sampleCoverageMask(mask, 0, 0.5)).toBeCloseTo(1, 3);
  });

  it('pins the CPU transfer function to the GLSL constants', () => {
    const base = 0.73;
    const detail = 0.31;
    const remapped = Math.max(0, Math.min(1,
      (base * (1 - CLOUD_DECK_DETAIL_STRENGTH * CLOUD_COVERAGE_DETAIL_MODULATION * (1 - detail))
        - CLOUD_COVERAGE_REMAP_CENTER) * CLOUD_DECK_CONTRAST + CLOUD_COVERAGE_REMAP_CENTER,
    ));
    const edge = Math.max(0, Math.min(1,
      (remapped - CLOUD_COVERAGE_SMOOTH_MIN) / (CLOUD_COVERAGE_SMOOTH_MAX - CLOUD_COVERAGE_SMOOTH_MIN),
    ));
    expect(cloudCoverageAtCpu(base, detail)).toBeCloseTo(edge * edge * (3 - 2 * edge), 12);
    expect(CLOUD_COVERAGE_GLSL).toContain(CLOUD_COVERAGE_DETAIL_MODULATION.toFixed(2));
    expect(CLOUD_COVERAGE_GLSL).toContain(CLOUD_COVERAGE_SMOOTH_MAX.toFixed(2));
  });
});
