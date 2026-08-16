# Code Review: Phase 1 Cinematic Visual Base

**Review Date**: 2026-08-06  
**Version**: 0.2.0  
**Files Reviewed**:

- [apps/web/package.json](apps/web/package.json)
- [apps/web/src/App.tsx](apps/web/src/App.tsx)
- [pnpm-lock.yaml](pnpm-lock.yaml)

**Plan**: [docs/1-plans/F_0.2.0_phase1-cinematic-visual-base.plan.md](docs/1-plans/F_0.2.0_phase1-cinematic-visual-base.plan.md)

---

## Executive Summary

This change replaces the placeholder web shell with a cinematic Earth-and-spacecraft scene, telemetry-driven HUD, deterministic stub telemetry, bloom post-processing, and documented asset and testing debt. All review findings were resolved or accepted through explicitly documented fallbacks and release tasks.

APPROVED

---

## Changes Overview

The web application now composes a Three.js scene and DOM HUD through a Zustand telemetry seam, with a deterministic 10 Hz approach profile and render-rate spacecraft interpolation. It adds Earth and starfield assets, primitive spacecraft with future glTF support, post-processing dependencies, graceful model fallbacks, and coverage-debt records. The review also inspected the status-reported untracked feature files.

---

## Findings

### Critical Issues

None.

### Major Issues

- **Primitive spacecraft violated the ±Y docking-axis contract** — [Spacecraft.tsx:42](apps/web/src/scene/Spacecraft.tsx:42). X-axis rotations placed the station hub, docking port, and chaser along the wrong axes. **Disposition: addressed.** The station hub and port now use native-Y cylinder geometry at [Spacecraft.tsx:46](apps/web/src/scene/Spacecraft.tsx:46) and [Spacecraft.tsx:63](apps/web/src/scene/Spacecraft.tsx:63); the chaser’s narrow docking end points +Y at [Spacecraft.tsx:72](apps/web/src/scene/Spacecraft.tsx:72).

### Minor Issues

- **Scene telemetry flow contradicted the static-chaser requirement** — [plan:15](docs/1-plans/F_0.2.0_phase1-cinematic-visual-base.plan.md:15). **Disposition: addressed.** The plan binds the chaser to `nav_r_hill_m` at [plan:59](docs/1-plans/F_0.2.0_phase1-cinematic-visual-base.plan.md:59), implemented through the bus read and position update at [Spacecraft.tsx:108](apps/web/src/scene/Spacecraft.tsx:108).

- **HUD calculations left range, closing-rate sign, and NAV uncertainty ambiguous** — [plan:68](docs/1-plans/F_0.2.0_phase1-cinematic-visual-base.plan.md:68). **Disposition: addressed.** The formulas are fixed in the plan and implemented at [TelemetryStrip.tsx:31](apps/web/src/hud/TelemetryStrip.tsx:31), including the positive-approaching closing estimator at [TelemetryStrip.tsx:38](apps/web/src/hud/TelemetryStrip.tsx:38).

- **Spacecraft asset normalization was unspecified** — [plan:38](docs/1-plans/F_0.2.0_phase1-cinematic-visual-base.plan.md:38). **Disposition: addressed.** Meter scale, COM pivots, and ±Y docking alignment are mandatory at [plan:39](docs/1-plans/F_0.2.0_phase1-cinematic-visual-base.plan.md:39). The accepted primitive fallback and future model normalization contract are recorded at [ASSETS.md:9](apps/web/public/assets/ASSETS.md:9).

- **Bloom inputs did not guarantee night-light or glint bloom** — [plan:59](docs/1-plans/F_0.2.0_phase1-cinematic-visual-base.plan.md:59). **Disposition: addressed.** The final HDR contract pins the threshold and emissive gains at [plan:60](docs/1-plans/F_0.2.0_phase1-cinematic-visual-base.plan.md:60), with shader gains at [Earth.tsx:31](apps/web/src/scene/Earth.tsx:31) and bloom configuration at [Effects.tsx:12](apps/web/src/scene/Effects.tsx:12).

- **Suspense was incorrectly treated as glTF error handling** — [plan:87](docs/1-plans/F_0.2.0_phase1-cinematic-visual-base.plan.md:87). **Disposition: addressed.** A scene-local error boundary logs failures and renders primitive fallbacks at [Spacecraft.tsx:29](apps/web/src/scene/Spacecraft.tsx:29), while Suspense remains limited to pending loads.

- **Promised documentation and coverage-debt work was absent from the task list** — [plan:125](docs/1-plans/F_0.2.0_phase1-cinematic-visual-base.plan.md:125). **Disposition: addressed.** Coverage, ARCHI, and README release work is scheduled at [plan:160](docs/1-plans/F_0.2.0_phase1-cinematic-visual-base.plan.md:160); current web testing debt is recorded at [COVERAGE-DEBT.md:5](docs/4-unit-tests/COVERAGE-DEBT.md:5).

- **Direct 10 Hz chaser updates would visibly step and transmit navigation noise** — [plan:59](docs/1-plans/F_0.2.0_phase1-cinematic-visual-base.plan.md:59). **Disposition: addressed.** Render-rate exponential damping is implemented without per-frame allocation at [Spacecraft.tsx:108](apps/web/src/scene/Spacecraft.tsx:108).

- **The starfield could cross the global bloom threshold** — [plan:58](docs/1-plans/F_0.2.0_phase1-cinematic-visual-base.plan.md:58). **Disposition: addressed.** Stars are explicitly excluded from bloom, with background intensity capped at [Starfield.tsx:12](apps/web/src/scene/Starfield.tsx:12) and applied at [Starfield.tsx:18](apps/web/src/scene/Starfield.tsx:18).

- **The starmap exceeded the intended asset budget/specification** — [ASSETS.md:8](apps/web/public/assets/ASSETS.md:8). **Disposition: addressed.** It was reduced to 4096×2048 and approximately 2.6 MB; the intentional LDR choice is permitted at [plan:37](docs/1-plans/F_0.2.0_phase1-cinematic-visual-base.plan.md:37).

- **Closing-rate estimator lacked test coverage or approval-gate debt tracking** — [TelemetryStrip.tsx:38](apps/web/src/hud/TelemetryStrip.tsx:38). **Disposition: addressed.** Its display-only risk, extraction plan, and future Vitest coverage are recorded at [COVERAGE-DEBT.md:6](docs/4-unit-tests/COVERAGE-DEBT.md:6).

### Suggestions

None.

---

## Checklist

- [x] 1. Functional Requirements — passed; intentional primitive-model fallback is documented.
- [x] 2. Code Quality — passed.
- [x] 3. Architectural Compliance — passed.
- [x] 4. Package Boundary & FSW Purity — passed; web imports only sim-core’s public API.
- [x] 5. GNC Conventions & Determinism — passed; Hill-frame signs, SI units, and seeded telemetry are preserved.
- [x] 6. Error Handling — passed; glTF failures degrade to primitive craft with actionable logging.
- [x] 7. Security — passed; no sensitive data handling or externally reachable surface in this change.
- [x] 8. Performance — passed; render interpolation avoids allocations, bloom is half-resolution, DPR is capped, and the live visual pass succeeded.

---

## Verdict

**APPROVED**

No Critical, Major, or Minor findings remain open. Web unit testing, normalized glTF replacement, and ARCHI/README release synchronization remain intentionally deferred through the coverage ledger, asset manifest, and plan tasks.

---

*Post-approval note (same release): after live visual inspection the chaser's render-rate damping constant was lowered from λ=4 to λ=1.5 (`apps/web/src/scene/Spacecraft.tsx`) — the higher bandwidth visibly tracked nav-estimate noise at close range. Scoped tuning of an already-reviewed mechanism; gate re-run green (typecheck/build clean, 4 tests passed).*
