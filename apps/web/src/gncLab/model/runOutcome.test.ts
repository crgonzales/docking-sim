import { expect, it } from 'vitest';
import { createLabSession } from '../session/labSession';
import { NOMINAL_CASE, RCS_STUCK_OPEN_CASE } from '../session/demoRun';
import { exportRun, importRun } from '../session/runExport';
import { runOutcome } from './runOutcome';

it('exports the real boundary-latched fault outcome without rewriting the preceding plant record', () => {
  const session = createLabSession(RCS_STUCK_OPEN_CASE, { runId: 'fault', epoch: 1, poseEpoch: 1 });
  try {
    expect(runOutcome(session.snapshot())).toBeNull();
    session.advanceTo(RCS_STUCK_OPEN_CASE.maxTicks);
    const tick = session.snapshot();
    expect(session.state).toBe('COMPLETE'); expect(session.tick).toBe(35910);
    expect(tick.plantTickRecord!.outcome).toBe('NONE');
    expect(tick.frame!.outcome).toBe('ABORT'); expect(runOutcome(tick)).toBe('ABORT');
    const metadata = importRun(exportRun(session, 16)).metadata;
    expect(metadata.outcome).toBe('ABORT');
    // This metric explicitly measures a witnessed TRUTH transition, not the FSW latch.
    expect(metadata.outcomeFirstObserved_tick).toBeNull();
    expect(metadata.metrics.timeToOutcome_s).toBeNull();
    expect(session.snapshot().plantTickRecord).toBe(tick.plantTickRecord);
  } finally { session.dispose(); }
});

it('preserves an early physical contact outcome before another FSW sample', () => {
  const session = createLabSession({ ...NOMINAL_CASE, config: { ...NOMINAL_CASE.config,
    initial: { ...NOMINAL_CASE.config.initial, r_hill_m: [0, -10.41, 0], v_hill_mps: [0, 0.06, 0] } } },
  { runId: 'contact', epoch: 1, poseEpoch: 1 });
  try {
    for (let i = 0; i < 100 && session.snapshot().plantTickRecord?.outcome !== 'DOCKED'; i++) session.advanceTo(session.tick + 1);
    const tick = session.snapshot();
    expect(tick.plantTickRecord!.outcome).toBe('DOCKED'); expect(runOutcome(tick)).toBe('DOCKED');
    expect(tick.stamp.plantTick % 10).not.toBe(0); expect(tick.frame?.outcome ?? 'NONE').toBe('NONE');
  } finally { session.dispose(); }
});
