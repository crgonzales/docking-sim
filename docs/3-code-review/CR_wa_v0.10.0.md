# Code Review: Ground presentation and volumetric weather over a full day

**Review Date**: 2026-09-10
**Version**: 0.10.0 (planned milestone; unreleased)
**Files Reviewed**:

- `apps/web/src/airfield/Airfield.tsx`
- `apps/web/src/airfield/airfieldGeometry.ts`
- `apps/web/src/airfield/airfieldSurface.ts`
- `apps/web/src/character/characterSession.ts`
- `apps/web/src/flight/FlightEnvironmentPanel.tsx`
- `apps/web/src/flight/FlightEvidenceCapture.tsx`
- `apps/web/src/flight/FlightLighting.tsx`
- `apps/web/src/flight/FlightMode.tsx`
- `apps/web/src/flight/HornetModel.tsx`
- `apps/web/src/flight/flight.css`
- `apps/web/src/flight/flightEnvironment.test.ts`
- `apps/web/src/flight/flightEnvironment.ts`
- `apps/web/src/flight/flightInput.ts`
- `apps/web/src/flight/flightSession.ts`
- `apps/web/src/scene/Clouds.tsx`
- `apps/web/src/scene/Earth.tsx`
- `apps/web/src/scene/LibraryEffects.tsx`
- `apps/web/src/scene/VolumetricClouds.tsx`
- `apps/web/src/scene/clouds/CloudConformanceFixture.ts`
- `apps/web/src/scene/clouds/CloudDistantFixture.ts`
- `apps/web/src/scene/clouds/CloudLightVolume.ts`
- `apps/web/src/scene/clouds/CloudMotionFixture.ts`
- `apps/web/src/scene/clouds/EveCloudSystem.ts`
- `apps/web/src/scene/clouds/cloudMotion.test.ts`
- `apps/web/src/scene/clouds/cloudMotion.ts`
- `apps/web/src/scene/clouds/cloudWeather.ts`
- `apps/web/src/scene/clouds/shaders/cloudDensity.glsl`
- `apps/web/src/scene/clouds/shaders/distantCloud.glsl`
- `apps/web/src/scene/clouds/vendor/takram/manifest.json`
- `apps/web/src/scene/clouds/vendor/takram/src/CloudsMaterial.ts`
- `apps/web/src/scene/clouds/vendor/takram/src/CloudsPass.ts`
- `apps/web/src/scene/clouds/vendor/takram/src/shaders/clouds.frag`
- `apps/web/src/scene/terrain/terrainShaders.ts`
- `docs/1-plans/F_0.10.0_ground-weather-cycle.plan.md`
- `docs/4-unit-tests/COVERAGE-DEBT.md`
- `docs/4-unit-tests/TESTING.md`
- `docs/6-memo/f18-integration/ground-weather-code-review.md`
- `docs/6-memo/f18-integration/ground-weather-gpu-conformance.json`
- `docs/6-memo/f18-integration/ground-weather-plan-review.md`
- `docs/6-memo/f18-integration/ground-weather-validation.md`
- `docs/ARCHI.md`

**Plan**: `docs/1-plans/F_0.10.0_ground-weather-cycle.plan.md`

---

## Executive Summary

This change adds a deterministic flight-environment clock, full-day physical lighting, canonical wind-driven volumetric weather, bounded cloud caching and reprojection, and improved ground presentation. Every review finding was addressed, and the recorded test, GPU, build, performance, and visual-validation gates passed.

APPROVED

---

## Changes Overview

`FlightMode` now owns an environment clock independent of aircraft dynamics and shares its time and sun state with Earth, local PBR lighting, and volumetric weather. Cloud motion uses canonical inverse-ECEF advection with a static orbital atlas, bounded live-light generations, motion-aware temporal reprojection, and pause-safe cache completion. The airfield adds filtered site-local surface detail, one bounded 1024 shadow map, nighttime lighting behavior, adjacent deterministic tests, GPU conformance fixtures, and updated architecture and validation records.

---

## Findings

### Critical Issues

None.

### Major Issues

#### Verification gate initially incomplete

- **Location:** [ground-weather-code-review.md:9](/Users/carlosgonzales/dev/docking-sim-flight-integrated/docs/6-memo/f18-integration/ground-weather-code-review.md:9)
- **Description:** Round 1 found that GPU motion conformance, regressions, preview checks, and a complete build were still pending, with one new advection test initially failing.
- **Disposition:** **Addressed.** The corrected suite records 591 web tests and 649 GPU cases passing, complete workspace and post-fix web builds, static-fixture/orbital regressions, 60x preview checks, and full-day visual inspection. [ground-weather-validation.md:31](/Users/carlosgonzales/dev/docking-sim-flight-integrated/docs/6-memo/f18-integration/ground-weather-validation.md:31) [ground-weather-validation.md:34](/Users/carlosgonzales/dev/docking-sim-flight-integrated/docs/6-memo/f18-integration/ground-weather-validation.md:34) [ground-weather-validation.md:40](/Users/carlosgonzales/dev/docking-sim-flight-integrated/docs/6-memo/f18-integration/ground-weather-validation.md:40)

#### Paused post-preview light cache did not refresh

- **Location:** [ground-weather-code-review.md:63](/Users/carlosgonzales/dev/docking-sim-flight-integrated/docs/6-memo/f18-integration/ground-weather-code-review.md:63)
- **Description:** A saved 60x preview showed a paused light cache aged 99.66 seconds, invalid and with no pending work, because the active-time cadence stopped when paused.
- **Disposition:** **Addressed.** Paused dynamic weather now requests the final stopped timestamp exactly once without invalidating history or rebuilding the canonical atlas. [EveCloudSystem.ts:212](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/scene/clouds/EveCloudSystem.ts:212) [EveCloudSystem.ts:224](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/scene/clouds/EveCloudSystem.ts:224) The final paired capture preserves the same timestamp and generation 16 with valid age-zero lighting, no pending slices, all 1024 atlas rows ready, and no history reset. [flight-base-1789100598613.json:919](/Users/carlosgonzales/dev/docking-sim-flight-integrated/.evidence.local/flight-base-1789100598613.json:919) [flight-base-1789100598613.json:1030](/Users/carlosgonzales/dev/docking-sim-flight-integrated/.evidence.local/flight-base-1789100598613.json:1030)

### Minor Issues

#### DEV exercise reset bypassed environment reset

- **Location:** [ground-weather-code-review.md:11](/Users/carlosgonzales/dev/docking-sim-flight-integrated/docs/6-memo/f18-integration/ground-weather-code-review.md:11)
- **Description:** Character-enabled airborne exercise starts reset `FlightSession` directly while the environment listened only to `CharacterSession`.
- **Disposition:** **Addressed.** Airborne routes subscribe to flight resets, while ground routes subscribe to character resets, yielding exactly one environment discontinuity. [flightEnvironment.ts:286](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/flight/flightEnvironment.ts:286) Regression coverage includes keyboard, direct, exercise, and unsubscribe paths. [flightEnvironment.test.ts:69](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/flight/flightEnvironment.test.ts:69)

#### Light-cache diagnostics retained stale `ready` state

- **Location:** [ground-weather-code-review.md:13](/Users/carlosgonzales/dev/docking-sim-flight-integrated/docs/6-memo/f18-integration/ground-weather-code-review.md:13)
- **Description:** Cache invalidation cleared validity and generation but could continue reporting `ready` while fallback rendering and reconstruction were active.
- **Disposition:** **Addressed.** Invalidation now reports `invalidated` while preserving terminal `failed`, `unsupported`, and `disposed` states. [CloudLightVolume.ts:248](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/scene/clouds/CloudLightVolume.ts:248) [CloudLightVolume.ts:256](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/scene/clouds/CloudLightVolume.ts:256)

### Suggestions

None.

---

## Checklist

- [x] 1. Functional Requirements — Passed; all planned clock, reset, daylight, weather-motion, cache, reprojection, ground, fixture, and pause behaviors are implemented.
- [x] 2. Code Quality — Passed; responsibilities are separated, complex renderer logic is documented, and no unjustified dynamic typing or duplication was found.
- [x] 3. Architectural Compliance — Passed; one flight-owned environment, canvas, composer, canonical atlas, and bounded local shadow implementation follow `ARCHI.md`.
- [x] 4. Package Boundary & FSW Purity — Passed; production changes remain in `apps/web` and do not alter sim-core, scenario, or FSW boundaries.
- [x] 5. GNC Conventions & Determinism — Passed; SI units, simulation time, seeded weather, and established world/ECEF frame authority are preserved.
- [x] 6. Error Handling — Passed; invalid light data uses bounded fallback, publication is atomic, terminal diagnostics are preserved, and resources are disposed.
- [x] 7. Security — Not applicable; no authentication, authorization, sensitive-data, or external-input surface was introduced.
- [x] 8. Performance — Passed; atlas and light work remain bounded, pause refresh is one-shot, local shadows are limited to 1024, and the recorded integrated-GPU sample exceeds the accepted 30 FPS floor.

---

## Verdict

**APPROVED**

All findings are closed; none were overridden or left open. The actual-GPU pause lifecycle remains documented in the coverage-debt ledger with a concrete browser regression path. [COVERAGE-DEBT.md:10](/Users/carlosgonzales/dev/docking-sim-flight-integrated/docs/4-unit-tests/COVERAGE-DEBT.md:10) The final game tab was left paused at 10:00 and 1x with no post-reload errors. This is an unreleased local milestone-0.10.0 checkpoint; no release, tag, merge, or push is part of this checkpoint.
