import { describe, expect, it } from 'vitest';
import { renderEvidenceName } from './renderEvidenceName';

describe('development evidence recorder names', () => {
  it('fits the existing recorder whitelist and 100-character limit for every supported mode', () => {
    for (const backend of ['volumetric', 'lib'] as const) {
      for (const quality of ['low', 'medium'] as const) {
        for (const stage of ['full', 'albedo', 'lighting']) {
          const name = renderEvidenceName(backend, quality, stage, 8_640_000_000_000_000);
          expect(name).toMatch(/^[a-zA-Z0-9_-]{1,100}$/);
          expect(name).toContain(`-${stage}-`);
        }
      }
    }
  });
  it('keeps repeated and differently staged captures distinct', () => {
    expect(new Set([
      renderEvidenceName('volumetric', 'medium', 'albedo', 1),
      renderEvidenceName('volumetric', 'medium', 'lighting', 1),
      renderEvidenceName('volumetric', 'medium', 'full', 1),
      renderEvidenceName('volumetric', 'medium', 'full', 2),
    ]).size).toBe(4);
  });
  it('does not include arbitrary query content in a filesystem name', () => {
    expect(renderEvidenceName('volumetric', 'medium', '../'.repeat(100), 1)).toBe('capture-volumetric-medium-full-1');
  });
});
