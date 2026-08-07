import { describe, expect, it } from 'vitest';
import { BINDINGS, HANDLED_CODES, HANDLED_KEYS } from './bindings';

describe('bindings table', () => {
  it('covers every handled keyboard code and key exactly once', () => {
    const tableCodes = BINDINGS
      .map((binding) => binding.code)
      .filter((code): code is string => code !== null);
    const tableKeys = BINDINGS
      .map((binding) => binding.key)
      .filter((key): key is string => key !== undefined);

    expect(HANDLED_CODES).toEqual(tableCodes);
    expect(HANDLED_KEYS).toEqual(tableKeys);
    expect(new Set(HANDLED_CODES).size).toBe(HANDLED_CODES.length);
    expect(new Set(HANDLED_KEYS).size).toBe(HANDLED_KEYS.length);
    expect(BINDINGS.every((binding) => binding.label.length > 0 && binding.description.length > 0)).toBe(true);
  });
});
