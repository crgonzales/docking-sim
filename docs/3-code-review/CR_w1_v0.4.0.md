# Code Review: Phase 3 — 6-DOF Attitude, MEKF, Docking Camera & Manual Fly

**Review Date**: 2026-08-06  
**Version**: 0.4.0  
**Files Reviewed**:

- `apps/web/src/App.tsx`
- `apps/web/src/hud/Hud.tsx`
- `apps/web/src/hud/ModeBar.tsx`
- `apps/web/src/hud/TelemetryStrip.tsx`
- `apps/web/src/hud/hud.css`
- `apps/web/src/input/manualControls.ts`
- `apps/web/src/scene/CameraRig.tsx`
- `apps/web/src/scene/DockingCameraPiP.tsx`
- `apps/web/src/scene/SceneRoot.tsx`
- `apps/web/src/scene/Spacecraft.tsx`
- `apps/web/src/telemetry/bus.ts`
- `apps/web/src/telemetry/simEmitter.ts`
- `apps/web/src/viewStore.ts`
- `docs/1-plans/F_0.4.0_phase3-6dof-mekf-manual-fly.plan.md`
- `packages/sim-core/src/allocator.test.ts`
- `packages/sim-core/src/allocator.ts`
- `packages/sim-core/src/attitude.test.ts`
- `packages/sim-core/src/attitude.ts`
- `packages/sim-core/src/control.test.ts`
- `packages/sim-core/src/control.ts`
- `packages/sim-core/src/dynamics.test.ts`
- `packages/sim-core/src/dynamics.ts`
- `packages/sim-core/src/ekf.test.ts`
- `packages/sim-core/src/ekf.ts`
- `packages/sim-core/src/fsw.test.ts`
- `packages/sim-core/src/fsw.ts`
- `packages/sim-core/src/index.ts`
- `packages/sim-core/src/mekf.test.ts`
- `packages/sim-core/src/mekf.ts`
- `packages/sim-core/src/sensors.test.ts`
- `packages/sim-core/src/sensors.ts`
- `packages/sim-core/src/sim.test.ts`
- `packages/sim-core/src/sim.ts`
- `packages/sim-core/src/thrusters.ts`
- `packages/sim-core/src/types.ts`

**Plan**: `docs/1-plans/F_0.4.0_phase3-6dof-mekf-manual-fly.plan.md`

---

## Executive Summary

The change replaces kinematic attitude handling with 6-DOF rigid-body dynamics, MEKF navigation, force-and-torque allocation, manual RATE/PULSE flight, truth-pose rendering, and switchable docking cameras. All six major findings were addressed during iteration; the required release-documentation update remains open.  
NEEDS REVISION

---

## Changes Overview

The simulation core now propagates rotational truth, gyro bias, star-tracker measurements, MEKF state, attitude control, and six-axis thruster allocation while preserving deterministic command semantics and package boundaries. The web application adds manual keyboard/mouse controls, cinematic/chase/cockpit cameras, a scissored docking-camera PiP, and attitude/docking telemetry. The requester reported a clean build, 61 passing tests, and successful live-browser flight verification before the final review corrections.

---

## Findings

### Critical Issues

None.

### Major Issues

- **Mouse-up reasserted stale rotation** — `apps/web/src/input/manualControls.ts:119`. The zero command was followed by another interval using retained drag accumulators. **Disposition: addressed** — `dragPitch` and `dragYaw` are now cleared before zeroing at `apps/web/src/input/manualControls.ts:121-125`.

- **Docking-camera pass rendered before the main frame** — `apps/web/src/scene/DockingCameraPiP.tsx:22`. Negative render priority allowed the full-viewport composer output to overwrite the inset. **Disposition: addressed** — the pass now uses explicit priority 2 after the priority-1 composer at `apps/web/src/scene/DockingCameraPiP.tsx:8-13` and `apps/web/src/scene/DockingCameraPiP.tsx:56`.

- **PiP image and targeting overlay used different rectangles** — `apps/web/src/scene/DockingCameraPiP.tsx:23`. Separate WebGL and CSS sizing placed the crosshair over a different region from the camera image. **Disposition: addressed** — the measured overlay rectangle is published at `apps/web/src/scene/DockingCameraPiP.tsx:83-111`, stored at `apps/web/src/viewStore.ts:6-22`, and consumed by the scissor pass at `apps/web/src/scene/DockingCameraPiP.tsx:25-50`.

- **Manual roll and yaw axes were swapped** — `apps/web/src/input/manualControls.ts:67`. Q/E roll was mapped to body-Z while mouse yaw was mapped to the forward body-Y axis. **Disposition: addressed** — commands now use `[pitch, roll, yaw]`, with the body-axis convention documented at `apps/web/src/input/manualControls.ts:64-67`.

- **Range-sensor dropout blanked valid docking telemetry** — `packages/sim-core/src/fsw.ts:115`. The display was gated on the raw range measurement instead of the maintained navigation solution. **Disposition: addressed** — gating now uses navigation-state range at `packages/sim-core/src/fsw.ts:117-118`.

- **MANUAL/RATE transitions retained PID integral state** — `packages/sim-core/src/fsw.ts:210`. Capturing a fresh manual reference without resetting the translational controller could produce a snap command from stale integral windup. **Disposition: addressed** — controller state is reset on every transition into RATE at `packages/sim-core/src/fsw.ts:215-220`.

### Minor Issues

- **Release documentation remains stale** — `README.md:44-46`. The README still identifies Phase 3 as planned and does not document the new manual controls, contrary to `docs/1-plans/F_0.4.0_phase3-6dof-mekf-manual-fly.plan.md:161-165`; the superseded memo cleanup also remains unchecked at `docs/1-plans/F_0.4.0_phase3-6dof-mekf-manual-fly.plan.md:195`. **Disposition: open** — complete the planned README/roadmap/control-table sync and memo removal before promotion.

### Suggestions

None.

---

## Checklist

- [x] 1. Functional Requirements — passed after all six major functional findings were addressed.
- [ ] 2. Code Quality — passed with caveat: required release documentation remains open.
- [x] 3. Architectural Compliance — passed.
- [x] 4. Package Boundary & FSW Purity — passed.
- [x] 5. GNC Conventions & Determinism — passed after correcting the manual rotation-axis mapping.
- [x] 6. Error Handling — passed after fail-safe zeroing and range-dropout handling were corrected.
- [x] 7. Security — not applicable; no security-sensitive surface was introduced.
- [x] 8. Performance — passed; PiP rendering is gated and correctly ordered after the main composer pass.

---

## Verdict

**NEEDS REVISION**

All code-level findings from the review were addressed, and no critical or major issues remain open. Promotion is held only on the plan-required README/roadmap/control documentation and superseded-memo cleanup; the thread does not record a post-correction build/test rerun, so that should accompany the final documentation pass.

---

*Promotion note (release ceremony, same day): the sole open Minor — README/roadmap/controls documentation and superseded-memo cleanup — was completed as release documentation sync in the release commit this CR ships with (README updated to v0.4.0 with a controls table, `docs/6-memo/camera-views-phase3.md` deleted as superseded). The post-correction gate was re-run green (typecheck/build clean, 61 tests) before the release commit, closing the verdict's remaining conditions.*
