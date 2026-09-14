import { expect, it } from 'vitest';
import { createSimLoop, smallAngleExp, type TelemetryFrame } from '@docking/sim-core';
import { createFirstDockingConfig, createFirstDockingScenario } from '@docking/scenario';
import { dockingFailureAdvice, dockingLesson } from './dockingGuidance';

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
