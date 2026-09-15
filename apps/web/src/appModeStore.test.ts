import { describe, expect, it } from 'vitest';
import { resolveAppMode, useAppModeStore } from './appModeStore';

describe('app mode entry', () => {
  it.each([null, undefined, '', 'mission', 'unknown'])('opens the guided mission for %s', value => {
    expect(resolveAppMode(value)).toBe('MISSION');
  });
  it.each([['sandbox', 'SANDBOX'], ['analysis', 'ANALYSIS'], ['flight', 'FLIGHT']] as const)('keeps ?mode=%s explicit', (value, mode) => {
    expect(resolveAppMode(value)).toBe(mode);
  });
  it('initialises the store from the same resolver', () => {
    expect(useAppModeStore.getState().mode).toBe(resolveAppMode(null));
  });
});
