import { expect, it } from 'vitest';
import { createSimLoop, smallAngleExp, type TelemetryFrame } from '@docking/sim-core';
import { createFirstDockingConfig, createFirstDockingScenario } from '@docking/scenario';
import { approachRingVisible, dockingAbortAdvice, dockingEnvelopeReadout, dockingFailureAdvice, dockingLesson, portGeometry } from './dockingGuidance';

function frame(): TelemetryFrame {
  return createSimLoop(createFirstDockingConfig(createFirstDockingScenario()), 1).stepTo(0.1)[0]!;
}
it('measures contact from both docking ports and gives the correct lateral input', () => {
  const f = frame();
  f.nav_r_hill_m = [0.25, -16.4, 0.15]; f.q_BH_est = [1, 0, 0, 0];
  f.docking = { closing_mps: 0, lateral_m: 0.29, misalign_deg: 0, rate_dps: 0 };
  const lesson = dockingLesson(f, true)!;
  expect(lesson.gap).toBeCloseTo(6, 10);
  expect(lesson.body[0]).toBeCloseTo(-0.25, 10);
  expect(lesson.hint).toContain('J to slide left');
  f.nav_r_hill_m = [0, -12.4, 0]; f.docking.lateral_m = 0;
  expect(dockingLesson(f, true)!.gap).toBeCloseTo(2, 10);
});
it('requests braking before close high-speed contact and never declares success from alignment', () => {
  const f = frame(); f.nav_r_hill_m = [0, -11.4, 0]; f.q_BH_est = [1, 0, 0, 0];
  f.docking = { closing_mps: 0.3, lateral_m: 0, misalign_deg: 0, rate_dps: 0 };
  expect(dockingLesson(f, false)!.hint).toContain('Press Space to brake');
  f.docking.closing_mps = 0.07;
  expect(dockingLesson(f, true)!.stage).toBe(2);
  f.outcome = 'DOCKED';
  expect(dockingLesson(f, true)!.stage).toBe(3);
});
it('handles missing navigation and explains a measured contact failure', () => {
  expect(dockingLesson(null, true)).toBeNull();
  const f = frame(); f.docking = { closing_mps: 0.4, lateral_m: 0, misalign_deg: 0, rate_dps: 0 };
  expect(dockingFailureAdvice(f)).toContain('closing speed was too high');
  f.docking.closing_mps = 0.07;
  f.nav_r_hill_m = [0, -12.4, 0]; f.q_BH_est = [1, 0, 0, 0];
  expect(dockingFailureAdvice(f)).toContain('last navigation estimate looked safe');
});

it('uses the tilted nose port for lateral alignment and warns at the actual spin limit', () => {
  const f = frame(); f.nav_r_hill_m = [0, -12.4, 0];
  f.q_BH_est = smallAngleExp([3.5 * Math.PI / 180, 0, 0]);
  f.docking = { closing_mps: 0.07, lateral_m: 0, misalign_deg: 3.5, rate_dps: 0 };
  expect(dockingLesson(f, true)!.lateral).toBeGreaterThan(0.1);
  expect(dockingLesson(f, true)!.aligned).toBe(false);
  expect(dockingFailureAdvice(f)).toContain('port offset was too large');
  f.q_BH_est = [1, 0, 0, 0]; f.docking.misalign_deg = 0; f.docking.rate_dps = 0.2;
  expect(dockingLesson(f, true)!.hint).toContain('above the capture limit');
});

it('warns about a corridor excursion ahead of every other hint and explains the abort ending', () => {
  const f = frame(); f.nav_r_hill_m = [0.25, -16.4, 0.15]; f.q_BH_est = [1, 0, 0, 0];
  f.docking = { closing_mps: 0.3, lateral_m: 0.29, misalign_deg: 0, rate_dps: 0 };
  f.corridor_err_m = null;
  const absent = dockingLesson(f, true)!.hint;
  f.corridor_err_m = 0;
  expect(dockingLesson(f, true)!.hint).toBe(absent);
  expect(absent).toContain('J to slide left');
  f.corridor_err_m = 0.4;
  expect(dockingLesson(f, true)!.hint).toContain('outside the approach corridor');
  expect(dockingAbortAdvice(f)).toContain('safe corridor');
  expect(dockingAbortAdvice(f)).toContain('0.29 m off axis with 6.0 m to contact');
  expect(dockingAbortAdvice(null)).toContain('safe corridor');
});

it('grades the docking-camera envelope on the rotated port lateral', () => {
  const f = frame(); f.nav_r_hill_m = [0, -12.4, 0];
  f.q_BH_est = smallAngleExp([3.5 * Math.PI / 180, 0, 0]);
  f.docking = { closing_mps: 0.07, lateral_m: 0, misalign_deg: 3.5, rate_dps: 0 };
  const tilted = dockingEnvelopeReadout(f)!;
  expect(tilted.lateral_m).toBeGreaterThan(0.1);
  expect(tilted.lateral_m).toBe(dockingLesson(f, true)!.lateral);
  expect(tilted).toMatchObject({ closing_mps: 0.07, misalign_deg: 3.5, rate_dps: 0, inside: false });
  f.q_BH_est = [1, 0, 0, 0]; f.docking.misalign_deg = 0;
  expect(dockingEnvelopeReadout(f)).toMatchObject({ lateral_m: 0, inside: true });
  f.docking = null;
  expect(dockingEnvelopeReadout(f)).toBeNull();
  expect(dockingEnvelopeReadout(null)).toBeNull();
});

it('retires approach rings on the rotated port gap, not a fixed nose offset', () => {
  const f = frame(); f.nav_r_hill_m = [0, -12.3, 0];
  f.q_BH_est = smallAngleExp([30 * Math.PI / 180, 0, 0]);
  const tilted = portGeometry(f);
  expect(tilted.gap).toBeCloseTo(3.6 - 1.7 * Math.cos(30 * Math.PI / 180), 10);
  expect(tilted.gap).toBeCloseTo(2.128, 3);
  expect(approachRingVisible(tilted, 2)).toBe(true);
  expect(approachRingVisible(tilted, 4)).toBe(false);
  f.q_BH_est = [1, 0, 0, 0];
  const level = portGeometry(f);
  expect(level.gap).toBeCloseTo(1.9, 10);
  expect(approachRingVisible(level, 2)).toBe(false);
  f.nav_r_hill_m = [0, -12.4, 0];
  expect(portGeometry(f).gap).toBeCloseTo(2, 10);
  // The rule is strict: the 2 m ring retires as the port gap passes its label, never before.
  f.nav_r_hill_m = [0, -12.41, 0];
  expect(approachRingVisible(portGeometry(f), 2)).toBe(true);
  f.nav_r_hill_m = [0, -12.39, 0];
  const passed = portGeometry(f);
  expect(passed.gap).toBeCloseTo(1.99, 10);
  expect(approachRingVisible(passed, 2)).toBe(false);
  expect(approachRingVisible(passed, 4)).toBe(false);
  expect(approachRingVisible(passed, 6)).toBe(false);
  expect(approachRingVisible(null, 6)).toBe(true);
});
