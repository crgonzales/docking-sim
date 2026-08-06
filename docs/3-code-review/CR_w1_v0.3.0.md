# Code Review: Phase 2: Discrete RCS Thrusters, Sensors & EKF

**Review Date**: 2026-08-06  
**Version**: 0.3.0  
**Files Reviewed**:

- `local tooling tooling/state/.gitignore`
- `local tooling tooling/scripts/resume.sh`
- `apps/web/package.json`
- `apps/web/src/App.tsx`
- `apps/web/src/hud/TelemetryStrip.tsx`
- `apps/web/src/hud/closingRate.test.ts`
- `apps/web/src/hud/closingRate.ts`
- `apps/web/src/telemetry/simEmitter.test.ts`
- `apps/web/src/telemetry/simEmitter.ts`
- `apps/web/src/telemetry/stubEmitter.ts`
- `apps/web/vitest.config.ts`
- `docs/1-plans/F_0.3.0_phase2-thrusters-sensors-ekf.plan.md`
- `docs/4-unit-tests/COVERAGE-DEBT.md`
- `packages/sim-core/src/allocator.test.ts`
- `packages/sim-core/src/allocator.ts`
- `packages/sim-core/src/control.test.ts`
- `packages/sim-core/src/control.ts`
- `packages/sim-core/src/dynamics.test.ts`
- `packages/sim-core/src/dynamics.ts`
- `packages/sim-core/src/ekf.test.ts`
- `packages/sim-core/src/ekf.ts`
- `packages/sim-core/src/fsw.test.ts`
- `packages/sim-core/src/fsw.ts`
- `packages/sim-core/src/guidance.test.ts`
- `packages/sim-core/src/guidance.ts`
- `packages/sim-core/src/index.ts`
- `packages/sim-core/src/linalg.ts`
- `packages/sim-core/src/rng.test.ts`
- `packages/sim-core/src/rng.ts`
- `packages/sim-core/src/sensors.test.ts`
- `packages/sim-core/src/sensors.ts`
- `packages/sim-core/src/sim.test.ts`
- `packages/sim-core/src/sim.ts`
- `packages/sim-core/src/thrusters.test.ts`
- `packages/sim-core/src/thrusters.ts`
- `packages/sim-core/src/types.ts`
- `pnpm-lock.yaml`

**Plan**: `docs/1-plans/F_0.3.0_phase2-thrusters-sensors-ekf.plan.md`

---

## Executive Summary

This change replaces stub telemetry with a deterministic closed-loop GNC simulation containing RK4 truth dynamics, discrete RCS actuation, seeded sensors, EKF navigation, PID/LQR control, and web integration. The two major runtime defects found during review were corrected and protected by regression assertions; release-document synchronization remains deferred to the subsequent documentation/release step.

APPROVED with observations

---

## Changes Overview

The sim-core package now owns truth propagation, thruster physics and allocation, sensor modeling, translational EKF navigation, guidance, controllers, and the public `SimLoop` command/injection seam. The web app now publishes real simulation telemetry, displays live propellant, and tests its closing-rate estimator and deterministic emitter. The diff also updates implementation-session tooling and clears the previous web coverage-debt entries.

---

## Findings

### Critical Issues

None.

### Major Issues

1. **Nominal thruster pulses were discarded at truth rate** — `packages/sim-core/src/sim.ts:115`, `packages/sim-core/src/sim.ts:128`, `packages/sim-core/src/thrusters.ts:99`. The truth loop split allocator pulses into 10 ms slices and reapplied the 20 ms minimum-on-time filter, causing every nominal slice to produce zero thrust and zero truth-side propellant consumption. **Disposition: addressed** by consuming already-quantized slices with `minOnTime_s: 0`; regression coverage verifies nominal truth propellant decreases at `packages/sim-core/src/sim.test.ts:71`.

2. **PROP telemetry reported FSW’s nominal estimate instead of truth** — `packages/sim-core/src/fsw.ts:132`, `packages/sim-core/src/sim.ts:150`. Stuck-open and stuck-closed failures could therefore make the HUD silently diverge from the actual tank state. **Disposition: addressed** by truth-overriding `TelemetryFrame.prop_kg` alongside NEES; nominal and stuck-open regression assertions are at `packages/sim-core/src/sim.test.ts:74` and `packages/sim-core/src/sim.test.ts:92`.

### Minor Issues

1. **Public `thrust_N` configuration was silently ignored** — `packages/sim-core/src/thrusters.ts:23`, `packages/sim-core/src/thrusters.ts:155`, `packages/sim-core/src/thrusters.ts:164`. Calculations always used each `ThrusterSpec.thrust_N`, making the additional model-level option misleading. **Disposition: addressed** by removing the unused option and retaining per-jet thrust as the authoritative configuration.

2. **Release documentation and version remain at Phase 1/v0.2.0** — `README.md:3`, `README.md:14`, `README.md:26`, `README.md:40`, `package.json:3`, `docs/2-changelog/changelog_table.md:3`. **Disposition: accepted with override** — version, README, and changelog synchronization are deferred to the project release/documentation step.

### Suggestions

None.

---

## Checklist

- [x] 1. Functional Requirements — passed after nominal-thrust and truth-propellant corrections
- [x] 2. Code Quality — passed after removal of the ignored configuration option
- [x] 3. Architectural Compliance — passed
- [x] 4. Package Boundary & FSW Purity — passed
- [x] 5. GNC Conventions & Determinism — passed
- [x] 6. Error Handling — passed
- [x] 7. Security — passed
- [x] 8. Performance — passed

---

## Verdict

**APPROVED with observations**

The requester reported a clean typecheck/build, 40 passing tests, and successful live-browser verification. All correctness findings are addressed with regression assertions; only the explicitly deferred release-document and version synchronization remains for the promotion workflow.
