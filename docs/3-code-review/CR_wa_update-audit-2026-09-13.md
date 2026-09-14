# Code Review: full-update-audit-2026-09-13

**Review Date**: 2026-09-14  
**Version**: 0.8.0 (unreleased working-tree audit; 0.14.0 is a feature-plan candidate)  
**Files Reviewed**:

- `apps/web/public/assets/ASSETS.md`
- `apps/web/public/assets/models/dragon/crew-dragon.glb`
- `apps/web/src/appModeStore.ts`
- `apps/web/src/hud/BriefingCard.tsx`
- `apps/web/src/hud/DebriefCard.tsx`
- `apps/web/src/hud/FirstDockingHud.tsx`
- `apps/web/src/hud/Hud.tsx`
- `apps/web/src/hud/KeybindsOverlay.tsx`
- `apps/web/src/hud/ModeBar.tsx`
- `apps/web/src/hud/dockingGuidance.test.ts`
- `apps/web/src/hud/dockingGuidance.ts`
- `apps/web/src/hud/dockingLesson.css`
- `apps/web/src/hud/flightAudio.test.ts`
- `apps/web/src/hud/flightAudio.ts`
- `apps/web/src/hud/rcsAudio.ts`
- `apps/web/src/hud/rcsAudioPreview.ts`
- `apps/web/src/input/bindings.ts`
- `apps/web/src/input/manualControls.test.ts`
- `apps/web/src/input/manualControls.ts`
- `apps/web/src/scene/CameraRig.tsx`
- `apps/web/src/scene/DockingGuide.tsx`
- `apps/web/src/scene/DragonCapsule.tsx`
- `apps/web/src/scene/DragonLivery.tsx`
- `apps/web/src/scene/LibraryEffects.tsx`
- `apps/web/src/scene/RenderProbe.tsx`
- `apps/web/src/scene/SceneRoot.tsx`
- `apps/web/src/scene/SceneSmaaFixture.test.ts`
- `apps/web/src/scene/SceneSmaaFixture.ts`
- `apps/web/src/scene/Spacecraft.tsx`
- `apps/web/src/scene/SpacecraftExhaustPass.test.ts`
- `apps/web/src/scene/SpacecraftExhaustPass.ts`
- `apps/web/src/scene/ThrusterPlumes.tsx`
- `apps/web/src/scene/ThrusterProbe.tsx`
- `apps/web/src/scene/clouds/CloudConformanceFixture.ts`
- `apps/web/src/scene/clouds/CloudDistantFixture.ts`
- `apps/web/src/scene/clouds/CloudMotionFixture.ts`
- `apps/web/src/scene/clouds/CloudTemporalFixture.ts`
- `apps/web/src/scene/clouds/EveAerialPerspectiveEffect.ts`
- `apps/web/src/scene/clouds/EveCloudSystem.ts`
- `apps/web/src/scene/clouds/shaders/distantCloud.glsl`
- `apps/web/src/scene/clouds/vendor/takram/src/CloudsPass.ts`
- `apps/web/src/scene/clouds/vendor/takram/src/CloudsResolveMaterial.ts`
- `apps/web/src/scene/clouds/vendor/takram/src/shaders/clouds.frag`
- `apps/web/src/scene/clouds/vendor/takram/src/shaders/cloudsResolve.frag`
- `apps/web/src/scene/libraryLightingMask.test.ts`
- `apps/web/src/scene/libraryLightingMask.ts`
- `apps/web/src/scene/librarySmaa.test.ts`
- `apps/web/src/scene/librarySmaa.ts`
- `apps/web/src/scene/librarySurfaceMaterials.ts`
- `apps/web/src/scene/librarySurfaceNormalPass.test.ts`
- `apps/web/src/scene/librarySurfaceNormalPass.ts`
- `apps/web/src/scene/rcsInspection.ts`
- `apps/web/src/scene/thrusterPresentation.test.ts`
- `apps/web/src/scene/thrusterPresentation.ts`
- `apps/web/src/telemetry/scenarioEmitter.test.ts`
- `apps/web/src/telemetry/scenarioEmitter.ts`
- `apps/web/src/telemetry/scenarioStore.ts`
- `apps/web/src/telemetry/simEmitter.test.ts`
- `apps/web/src/telemetry/simEmitter.ts`
- `apps/web/src/viewStore.ts`
- `apps/web/vite.config.ts`
- `docs/1-plans/F_0.14.0_first-docking-gameplay.plan.md`
- `docs/6-memo/dragon-rcs.md`
- `docs/6-memo/volumetric-cloud-system/cloud-top-lighting.md`
- `docs/6-memo/volumetric-cloud-system/foreground-edges.md`
- `docs/6-memo/first-docking-gameplay.md`
- `docs/6-memo/update-audit-2026-09-13.md`
- `docs/ARCHI.md`
- `docs/scenario-mode-spec.md`
- `packages/scenario/src/director.test.ts`
- `packages/scenario/src/dockingRobustness.test.ts`
- `packages/scenario/src/firstDocking.test.ts`
- `packages/scenario/src/index.ts`
- `packages/scenario/src/monteCarlo.ts`
- `packages/scenario/src/perfectOperatorBot.ts`
- `packages/scenario/src/scenarioToSimConfig.ts`
- `packages/scenario/src/scenarios/firstDocking01.ts`
- `packages/sim-core/src/allocator.ts`
- `packages/sim-core/src/crewDragon.ts`
- `packages/sim-core/src/fsw.ts`
- `packages/sim-core/src/hold-position.test.ts`
- `packages/sim-core/src/index.ts`
- `packages/sim-core/src/mekf.ts`
- `packages/sim-core/src/sim.test.ts`
- `packages/sim-core/src/sim.ts`
- `packages/sim-core/src/types.ts`

**Plan**: no plan — unplanned aggregate audit; `docs/1-plans/F_0.14.0_first-docking-gameplay.plan.md` was used as intent context, with no formal aggregate plan or changelog.

---

## Executive Summary

This audit began on 2026-09-13 and covered the complete 86-path uncommitted update, including simulation, scenario, mission lifecycle, renderer, audio, livery, integration, tests, documentation, and the Dragon GLB. Both implementer-found defects were independently confirmed as addressed in round 2; independent round 1 found no additional issues.

APPROVED

---

## Changes Overview

The update adds Crew Dragon geometry and presentation, revised RCS allocation and IMU propagation, docking contact behavior, first-docking gameplay, input and scenario lifecycle handling, procedural audio, cloud/rendering improvements, final SMAA, and supporting tests and documentation. The audit covered 51 tracked deltas and 35 untracked paths against HEAD `77ec02ccbce69f5cb4c85272b9cdfd5dfeed7cfd`.

The Dragon GLB was assessed structurally, without a new render. Historical visual evidence was considered only within its documented scope. No fresh visual validation, frame-time benchmark, audio listening session, or manufacturer-fidelity analysis was performed; artist-derived Dragon fidelity and sparse cloud reconstruction limitations remain documented constraints rather than blockers.

---

## Findings

Independent round 1 reported no additional findings. The two implementer-found issues below were independently verified during round 2; no findings were overridden or remain open.

### Critical Issues

None.

### Major Issues

#### Inspection could start a competing simulation

- **Location**: `apps/web/src/telemetry/simEmitter.ts:105-113`; `apps/web/src/scene/SceneRoot.tsx:185-187,239`
- **Description**: `inspectThruster()` could previously reset and start the SANDBOX publisher while MISSION, FLIGHT, or ANALYSIS owned simulation state. A direct `thrusterProbe=1` mission URL could also mount the inspection panel and create competing publishers.
- **Disposition**: **Addressed and independently confirmed in round 2.** The command now requires both DEV and SANDBOX, and the panel independently requires SANDBOX. Regression coverage verifies all three forbidden modes, SANDBOX firing, and cleanup at `apps/web/src/telemetry/simEmitter.test.ts:19-38`. The original fixed-seed determinism regression is restored at `apps/web/src/telemetry/simEmitter.test.ts:7-14`.

### Minor Issues

#### Paused or inactive missions could sustain stale RCS audio

- **Location**: `apps/web/src/hud/flightAudio.ts:95-105,118-127,145-162`
- **Description**: Paused, briefing, and debrief states retain the last truth/render firing window, while the procedural audio bank continues looping until explicitly given zero duty.
- **Disposition**: **Addressed and independently confirmed in round 2.** Mission RCS audio is enabled only while the scenario is RUNNING and unpaused, including initial voice creation, render updates, and scenario transitions. Truth/render state remains unchanged, and SANDBOX audio remains independent of stale mission state. Coverage is at `apps/web/src/hud/flightAudio.test.ts:28-66`; the briefing case seeds stale firing before a real pointer event and awaited audio resume at `apps/web/src/hud/flightAudio.test.ts:47-55`.

### Suggestions

None.

---

## Checklist

- [x] 1. Functional Requirements — passed
- [x] 2. Code Quality — passed
- [x] 3. Architectural Compliance — passed
- [x] 4. Package Boundary & FSW Purity — passed
- [x] 5. GNC Conventions & Determinism — passed
- [x] 6. Error Handling — passed
- [x] 7. Security — passed
- [x] 8. Performance — passed; no new benchmark was performed, and historical performance evidence remains scoped to its existing memos

---

## Verdict

**APPROVED**

The final gate is recorded in `.evidence.local/audit-2026-09-13/final-gate.json`: the full workspace build passed, along with 648 web tests, 132 sim-core tests, and 38 scenario tests—818 total. The strengthened briefing test was the only change after the full web run and passed in the final focused 8/8 lifecycle rerun recorded by `lifecycle-final.log`; supporting logs are `build-followup.log`, `web-final.log`, `sim-core-gate.log`, and `scenario-gate.log`. Final source hashes are recorded in `.evidence.local/audit-2026-09-13/reviewed-source-manifest.json`, and the review thread is `01a09ea6-694f-7cf2-919c-3ad0aa659ba8`. The reviewer started no tests, servers, browsers, GPU checks, or other agents; no release, commit, merge, or push was performed. This archival review artifact is added after, and is not counted among, the 86 reviewed paths.
