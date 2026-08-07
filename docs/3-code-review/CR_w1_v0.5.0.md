# Code Review: Phase 4 — MPC Terminal Approach, Passive Abort Safety & Flight-Deck UX

**Review Date**: 2026-08-06  
**Version**: 0.5.0  
**Files Reviewed**:

- `apps/web/src/hud/CautionWarningPanel.tsx`
- `apps/web/src/hud/Hud.tsx`
- `apps/web/src/hud/KeybindsOverlay.tsx`
- `apps/web/src/hud/OutcomeBanner.tsx`
- `apps/web/src/hud/hud.css`
- `apps/web/src/input/bindings.test.ts`
- `apps/web/src/input/bindings.ts`
- `apps/web/src/input/manualControls.ts`
- `apps/web/src/scene/CameraRig.tsx`
- `apps/web/src/telemetry/simEmitter.ts`
- `apps/web/src/viewStore.ts`
- `docs/1-plans/F_0.5.0_phase4-mpc-abort-safety.plan.md`
- `packages/sim-core/src/allocator.ts`
- `packages/sim-core/src/authority.ts`
- `packages/sim-core/src/corridor.test.ts`
- `packages/sim-core/src/corridor.ts`
- `packages/sim-core/src/fsw.test.ts`
- `packages/sim-core/src/fsw.ts`
- `packages/sim-core/src/index.ts`
- `packages/sim-core/src/manual-rate.test.ts`
- `packages/sim-core/src/monitors.test.ts`
- `packages/sim-core/src/monitors.ts`
- `packages/sim-core/src/mpc.test.ts`
- `packages/sim-core/src/mpc.ts`
- `packages/sim-core/src/qp.test.ts`
- `packages/sim-core/src/qp.ts`
- `packages/sim-core/src/sim.test.ts`
- `packages/sim-core/src/sim.ts`
- `packages/sim-core/src/types.ts`

**Plan**: `docs/1-plans/F_0.5.0_phase4-mpc-abort-safety.plan.md`

---

## Executive Summary

This change adds constrained MPC terminal guidance, corridor monitoring, passive abort handling, truth-side docking outcomes, manual-rate tuning, and flight-deck camera/control UX. Five major correctness and safety findings were corrected during review; two minor findings were resolved through an explicit plan amendment and an accepted release-stage documentation deferral.

APPROVED

---

## Changes Overview

The sim-core change introduces a dense QP solver, shared corridor and capture-envelope geometry, acceleration-authority probing, a 1 Hz MPC controller with LQR fallback, abort sequencing, and immutable docking outcomes. The web application gains camera orbit and zoom, centralized keybindings, live MPC and abort commands, outcome banners, and active caution/warning indicators. Tests cover the new mathematical modules and primary closed-loop outcomes; the requester reported a clean build and 99 passing tests.

---

## Findings

### Critical Issues

None.

### Major Issues

1. **Truth capture ignored roll misalignment** — `packages/sim-core/src/sim.ts:200`. The original axis-only comparison allowed a craft rolled about its docking axis to satisfy the attitude envelope. **Disposition: addressed** — capture now evaluates the full attitude error with `smallAngleLog(q_BH)` at `packages/sim-core/src/sim.ts:204`, matching FSW telemetry.

2. **Corridor monitor operated outside its engagement range** — `packages/sim-core/src/monitors.ts:52`. Far-range AUTO states could trigger corridor caution or immediate abort before entering terminal operations. **Disposition: addressed** — port-relative engagement gating is implemented at `packages/sim-core/src/monitors.ts:57`, and caution/timer state resets while disengaged at `packages/sim-core/src/monitors.ts:63`.

3. **Docked attitude was not continuously pinned** — `packages/sim-core/src/sim.ts:228`. The original docked branch advanced sim time while retaining the contact-epoch inertial quaternion, causing `q_BH` to drift at orbital rate. **Disposition: addressed** — each docked tick recomputes `q_BI` for the new LVLH epoch at `packages/sim-core/src/sim.ts:233`.

4. **Acceleration-authority probing ignored torque-reserve delivery** — `packages/sim-core/src/authority.ts:34`. Force-only acceptance could overstate usable MPC authority when the allocator sacrificed attitude torque. **Disposition: addressed** — acceptance now checks force residual, torque residual, and allocator saturation at `packages/sim-core/src/authority.ts:37`.

5. **Degenerate MPC authority could crash the flight tick** — `packages/sim-core/src/fsw.ts:193`. A zero octahedral radius flowed into MPC configuration validation and threw instead of degrading gracefully. **Disposition: addressed** — degenerate authority returns unavailable at `packages/sim-core/src/fsw.ts:203`, AUTO executes LQR fallback at `packages/sim-core/src/fsw.ts:289`, and availability changes re-enable probing at `packages/sim-core/src/fsw.ts:417`.

### Minor Issues

1. **CHASE camera used a Hill-frame rather than attitude-aware orbit** — `apps/web/src/scene/CameraRig.tsx:45`. **Disposition: accepted with override** — the implementation intentionally keeps both orbit views Hill-frame to avoid spinning the camera during manual rotation or abort tumbles. The plan records this amendment and rationale at `docs/1-plans/F_0.5.0_phase4-mpc-abort-safety.plan.md:87`.

2. **README remained stale for Phase 4 controls and release state** — `README.md:3`, `README.md:42`, `README.md:69`. **Disposition: accepted with override** — README/version/roadmap synchronization is explicitly deferred to the release ceremony at `docs/1-plans/F_0.5.0_phase4-mpc-abort-safety.plan.md:148` and `docs/1-plans/F_0.5.0_phase4-mpc-abort-safety.plan.md:178`.

### Suggestions

None.

---

## Checklist

- [x] 1. Functional Requirements — passed; all major functional findings were addressed, with the camera behavior incorporated through a plan amendment.
- [x] 2. Code Quality — passed.
- [x] 3. Architectural Compliance — passed.
- [x] 4. Package Boundary & FSW Purity — passed.
- [x] 5. GNC Conventions & Determinism — passed.
- [x] 6. Error Handling — passed; loss of MPC authority now degrades to LQR fallback.
- [x] 7. Security — passed; no security-sensitive surfaces were introduced.
- [x] 8. Performance — passed.

---

## Verdict

**APPROVED**

All code-level critical and major findings are resolved. The Hill-frame CHASE camera is an accepted, documented design amendment, while README and release-documentation synchronization remains intentionally deferred to release. The requester reported a clean typecheck/build, 99 passing tests, and completed live visual verification.

---

*Promotion note (release ceremony, same day): the deferred README/controls/version sync was completed as release documentation sync in this release commit; the final gate re-ran green (build clean, 99 tests) before the commit.*
