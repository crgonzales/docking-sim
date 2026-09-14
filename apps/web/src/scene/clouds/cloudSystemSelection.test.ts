import { describe, expect, it } from 'vitest';
import { resolveCloudSystem } from './cloudSystemSelection';

describe('cloud system selection', () => {
  it.each(['volumetric', 'eve'])('opens the volumetric renderer for %s URLs', value => {
    expect(resolveCloudSystem(value)).toBe('volumetric');
  });

  it.each([null, undefined, '', 'legacy', 'unknown'])('preserves the existing default for %s', value => {
    expect(resolveCloudSystem(value)).toBe('legacy');
  });
});
