import { describe, expect, it } from 'vitest';
import { FINAL_APPROACH_01 } from './scenarios/finalApproach01.js';
import { validateScenario } from './schema.js';

describe('scenario schema', () => {
  it('validates FINAL_APPROACH_01', () => {
    expect(validateScenario(FINAL_APPROACH_01)).toBe(FINAL_APPROACH_01);
  });

  it('enforces schema version and rejects unknown fields at nested levels', () => {
    const wrongVersion = JSON.parse(JSON.stringify(FINAL_APPROACH_01)) as Record<string, unknown>;
    wrongVersion.schema_version = 2;
    expect(() => validateScenario(wrongVersion)).toThrow(/schema_version/);

    const unknownTopLevel = JSON.parse(JSON.stringify(FINAL_APPROACH_01)) as Record<string, unknown>;
    unknownTopLevel.extra = true;
    expect(() => validateScenario(unknownTopLevel)).toThrow(/unknown field/);

    const unknownNested = JSON.parse(JSON.stringify(FINAL_APPROACH_01)) as {
      monitors: { capture_envelope: Record<string, unknown> };
    };
    unknownNested.monitors.capture_envelope.extra = 1;
    expect(() => validateScenario(unknownNested)).toThrow(/capture_envelope.*unknown field/);
  });
});

