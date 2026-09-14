import { describe, expect, it } from 'vitest';
import { resolveCloudSystem } from './cloudSystemSelection';

describe('cloud system selection', () => {
  it.each(['volumetric', 'eve'])('opens the volumetric renderer for %s URLs', value => {
    expect(resolveCloudSystem(value)).toBe('volumetric');
  });

  it.each([null, undefined, '', 'unknown'])('defaults missing, empty and unknown selectors (%s) to volumetric', value => {
    expect(resolveCloudSystem(value)).toBe('volumetric');
  });

  it('keeps the legacy cloud backend as an explicit comparison override', () => {
    expect(resolveCloudSystem('legacy')).toBe('legacy');
  });
});
