# Code Review: Guided Scenario Mode + Monte Carlo

**Review Date:** 2026-08-07  
**Version:** 0.6.0

**Files Reviewed:**

- `apps/web/package.json`
- `apps/web/src/App.tsx`
- `apps/web/src/analysis/Histogram.tsx`
- `apps/web/src/analysis/MonteCarloScreen.tsx`
- `apps/web/src/analysis/analysis.css`
- `apps/web/src/appModeStore.ts`
- `apps/web/src/hud/BriefingCard.tsx`
- `apps/web/src/hud/CautionWarningPanel.tsx`
- `apps/web/src/hud/DebriefCard.tsx`
- `apps/web/src/hud/Hud.tsx`
- `apps/web/src/hud/MissionClock.tsx`
- `apps/web/src/hud/ModeSwitcher.tsx`
- `apps/web/src/hud/OutcomeBanner.tsx`
- `apps/web/src/hud/SwitchPanel.tsx`
- `apps/web/src/hud/hud.css`
- `apps/web/src/hud/panelAudio.ts`
- `apps/web/src/input/manualControls.ts`
- `apps/web/src/telemetry/monteCarloStore.ts`
- `apps/web/src/telemetry/scenarioEmitter.ts`
- `apps/web/src/telemetry/scenarioStore.ts`
- `apps/web/src/workers/monteCarloWorker.ts`
- `docs/1-plans/F_0.6.0_phase5-guided-scenario-monte-carlo.plan.md`
- `docs/scenario-mode-spec.md`
- `packages/scenario/package.json`
- `packages/scenario/src/acceptance.test.ts`
- `packages/scenario/src/director.test.ts`
- `packages/scenario/src/director.ts`
- `packages/scenario/src/index.ts`
- `packages/scenario/src/monteCarlo.test.ts`
- `packages/scenario/src/monteCarlo.ts`
- `packages/scenario/src/perfectOperatorBot.ts`
- `packages/scenario/src/scenarioToSimConfig.ts`
- `packages/scenario/src/scenarios/finalApproach01.ts`
- `packages/scenario/src/schema.test.ts`
- `packages/scenario/src/schema.ts`
- `packages/scenario/tsconfig.json`
- `packages/sim-core/src/fsw.test.ts`
- `packages/sim-core/src/fsw.ts`
- `packages/sim-core/src/mekf.test.ts`
- `packages/sim-core/src/mekf.ts`
- `packages/sim-core/src/sensors.test.ts`
- `packages/sim-core/src/sensors.ts`
- `packages/sim-core/src/sim.test.ts`
- `packages/sim-core/src/sim.ts`
- `packages/sim-core/src/types.ts`
- `pnpm-lock.yaml`

**Plan:** `docs/1-plans/F_0.6.0_phase5-guided-scenario-monte-carlo.plan.md`

---

## Executive Summary

The implementation conforms to the guided-scenario and Monte Carlo plan, with clean typecheck/build results, 118 passing tests, and verified end-to-end SANDBOX, MISSION, and ANALYSIS flows. All eight findings raised during review were addressed; none remain open or were overridden.

APPROVED

---

## Changes Overview

This change adds guided mission scenarios, scenario-director behavior, deterministic operator automation, and Monte Carlo execution. The web application now supports SANDBOX, MISSION, and ANALYSIS modes, worker-based batch simulation, result histograms, guarded panel controls, debriefing, failure reporting, and synthesized panel audio. Supporting simulation-core sensor, FSW, MEKF, and state APIs were extended and covered by regression and acceptance tests.

---

## Findings

### Critical Issues

None.

### Major Issues

1. **[Major — Addressed] Sensor-degradation escalation replaced the active attitude-bias ramp.** The director now retains accumulated degradation state and merges later NAV degradation configurations while preserving the earliest start time and unioning bias fields (`packages/scenario/src/director.ts:121`, `packages/scenario/src/director.ts:195`, `packages/scenario/src/director.ts:202`). The regression test verifies that escalation retains both the original attitude ramp and new range-noise multiplier (`packages/scenario/src/director.test.ts:100`).

2. **[Major — Addressed] Monte Carlo run counts accepted non-finite or effectively unbounded values before allocation.** Run counts are now checked with `Number.isFinite` and clamped to the supported `[1, 2000]` range (`apps/web/src/analysis/MonteCarloScreen.tsx:13`, `apps/web/src/analysis/MonteCarloScreen.tsx:79`).

### Minor Issues

1. **[Minor — Addressed] Propellant consumption and docking time margin were not rendered as histograms.** The shared binning helper and result charts now cover both metrics, with time margin restricted to docked results (`apps/web/src/analysis/MonteCarloScreen.tsx:25`, `apps/web/src/analysis/MonteCarloScreen.tsx:186`).

2. **[Minor — Addressed] Worker construction and runtime failures did not produce an actionable UI error state.** The store now exposes `ERROR`, `errorMessage`, and a failure action; construction and asynchronous errors route into the visible failure path (`apps/web/src/telemetry/monteCarloStore.ts:4`, `apps/web/src/telemetry/monteCarloStore.ts:45`, `apps/web/src/analysis/MonteCarloScreen.tsx:110`).

3. **[Minor — Addressed] Planned switch-click and master-alarm audio was absent.** Synthesized WebAudio now provides interaction clicks and the pulsed alarm tone, including gesture-based context resumption and cleanup (`apps/web/src/hud/panelAudio.ts:17`, `apps/web/src/hud/panelAudio.ts:32`, `apps/web/src/hud/SwitchPanel.tsx:109`).

4. **[Minor — Addressed] A partial worker-spawn failure leaked workers held only in the local array.** The construction catch now terminates every locally created worker before the ref-based cleanup runs (`apps/web/src/analysis/MonteCarloScreen.tsx:121`).

5. **[Minor — Addressed] Constant-valued histogram inputs produced ten artificial ranges.** The binning helper now emits one exact-value bucket when the observed minimum equals the maximum (`apps/web/src/analysis/MonteCarloScreen.tsx:30`).

6. **[Minor — Addressed] The master alarm could continue sounding beneath the debrief overlay.** Alarm playback is now additionally gated on the scenario being in the `RUNNING` phase and is stopped by effect cleanup (`apps/web/src/hud/SwitchPanel.tsx:96`, `apps/web/src/hud/SwitchPanel.tsx:97`).

### Suggestions

None.

---

## Checklist

- [x] **1. Functional Requirements** — Plan behavior is implemented across guided scenarios, guarded controls, debriefing, and Monte Carlo analysis.
- [x] **2. Code Quality** — Responsibilities are separated across scenario, worker, store, HUD, and analysis modules.
- [x] **3. Architectural Compliance** — Changes follow the repository architecture and package ownership patterns.
- [x] **4. Package Boundary & FSW Purity** — Scenario orchestration remains outside simulation-core flight-software behavior.
- [x] **5. GNC Conventions & Determinism** — Sensor degradation, seeded runs, timing, and nominal-scenario behavior are deterministic and regression-tested.
- [x] **6. Error Handling** — Worker construction and runtime failures transition to a visible actionable error state with cleanup.
- [x] **7. Security** — User-provided run counts are validated and bounded before allocation; no sensitive-data or authorization scope was introduced.
- [x] **8. Performance** — Monte Carlo work is delegated to workers, run counts are capped, and normal, failed, and partial-start cleanup paths terminate workers.
- [x] **Testing Gate** — Typecheck/build clean; 118 tests passed, including 18 new tests; all three application modes were verified end-to-end in headless Edge.

---

## Verdict

**APPROVED**

All findings from the review cycle are addressed, with no overridden or open issues. The implementation meets the plan and review gate. The release changelog remains intentionally deferred to the release workflow.

