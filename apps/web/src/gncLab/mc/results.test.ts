import { describe, expect, it } from 'vitest';
import { syntheticResult, syntheticSummary } from './fixtures';
import { isRunSummary, parseResultLine } from './results';

describe('parseResultLine', () => {
  it('accepts a well-formed ok line and a well-formed error line', () => {
    const ok = parseResultLine(JSON.stringify(syntheticResult()));
    expect(ok.error).toBeUndefined();
    expect(ok.ok?.summary?.outcome).toBe('DOCKED');
    const failed = parseResultLine(JSON.stringify(syntheticResult({
      status: 'error', summary: undefined, error: { class: 'RangeError', message: 'a run summary needs at least one FSW record' },
    })));
    expect(failed.error).toBeUndefined();
    expect(failed.ok?.status).toBe('error');
  });

  it('never throws and names the first structural problem', () => {
    expect(parseResultLine('{not json').error).toMatch(/invalid JSON/);
    expect(parseResultLine('null').error).toMatch(/JSON object/);
    expect(parseResultLine('[]').error).toMatch(/JSON object/);
    expect(parseResultLine('"text"').error).toMatch(/JSON object/);
    expect(parseResultLine('').error).toMatch(/invalid JSON/);
    expect(parseResultLine(JSON.stringify({ ...syntheticResult(), schema: 'gnc-mc-result/0' })).error).toMatch(/schema/);
    expect(parseResultLine(JSON.stringify({ ...syntheticResult(), caseId: 'FAULT' })).error).toMatch(/caseId/);
    expect(parseResultLine(JSON.stringify({ ...syntheticResult(), attempt: 0 })).error).toMatch(/attempt/);
    expect(parseResultLine(JSON.stringify({ ...syntheticResult(), host: { node: 'v22.12.0', arch: 'x64' } })).error).toMatch(/host/);
    expect(parseResultLine(JSON.stringify({ ...syntheticResult(), summary: undefined })).error).toMatch(/summary must be an object/);
    expect(parseResultLine(JSON.stringify(syntheticResult({ summary: syntheticSummary({ outcome: 'LANDED' as 'DOCKED' }) }))).error).toMatch(/summary.outcome/);
    expect(parseResultLine(JSON.stringify(syntheticResult({ summary: syntheticSummary({ interval: undefined as never }) }))).error).toMatch(/summary.interval/);
    expect(parseResultLine(JSON.stringify(syntheticResult({ summary: syntheticSummary({ truth: { r_hill_m: [0, 0], v_hill_mps: [0, 0, 0], prop_kg: 1 } as never }) }))).error).toMatch(/summary.truth/);
    expect(parseResultLine(JSON.stringify({ ...syntheticResult(), status: 'error' })).error).toMatch(/error.class/);
    expect(parseResultLine(JSON.stringify({ ...syntheticResult(), status: 'error', error: { class: 'X', message: 'y' } })).error).toMatch(/must not carry a summary/);
  });

  it('accepts a missing seed only on an error line', () => {
    const { seed: _seed, ...withoutSeed } = syntheticResult({
      status: 'error', summary: undefined, error: { class: 'RangeError', message: 'masterSeed must be an integer in [0, 2^32)' },
    });
    const parsed = parseResultLine(JSON.stringify(withoutSeed));
    expect(parsed.error).toBeUndefined();
    expect(parsed.ok?.seed).toBeUndefined();
    const { seed: _okSeed, ...okWithoutSeed } = syntheticResult();
    expect(parseResultLine(JSON.stringify(okWithoutSeed)).error).toMatch(/seed must be an integer/);
    expect(parseResultLine(JSON.stringify({ ...withoutSeed, seed: null })).error).toMatch(/seed must be an integer/);
  });

  it('exposes the summary structural check for callers holding objects', () => {
    expect(isRunSummary(syntheticSummary())).toBe(true);
    expect(isRunSummary(syntheticSummary({ lastDocking: { closing_mps: 1 } as never }))).toBe(false);
    expect(isRunSummary(syntheticSummary({ lastDocking: null }))).toBe(true);
    expect(isRunSummary({})).toBe(false);
  });
});
