# Code Review: v0.14.0 — first docking gameplay, Crew Dragon RCS, volumetric weather naming and audited flight/cloud fixes

**Review Date**: 2026-09-14
**Version**: 0.14.0
**Files Reviewed**:

- The complete 86-path uncommitted update against base `77ec02ccbce69f5cb4c85272b9cdfd5dfeed7cfd`: simulation (`packages/sim-core/src/{allocator,crewDragon,fsw,mekf,sim,types,index}.ts` + tests), scenario (`packages/scenario/src/{monteCarlo,perfectOperatorBot,scenarioToSimConfig,index}.ts`, `scenarios/firstDocking01.ts` + tests), web mission/HUD/input (`appModeStore.ts`, `hud/*`, `input/*`, `telemetry/*`, `viewStore.ts`), renderer (`scene/*`, `scene/clouds/*`, vendored Takram passes and shaders), audio, the Dragon GLB and `assets/ASSETS.md`, plans, memos and `docs/ARCHI.md` / `docs/scenario-mode-spec.md`. The full path list is recorded in `CR_wa_update-audit-2026-09-13.md`.
- The 52-path consolidation/naming delta (`VolumetricCloudSystem`, `VolumetricAerialPerspectiveEffect`, `cloudSystemSelection.ts` + test, volumetric asset paths and `setupVolumetricCloudAssets.mjs`), recorded in `CR_wa_workspace-cleanup-2026-09-14.md`.
- Release-only additions, not part of the independent review: `apps/web/package.json` (build now provisions pinned renderer assets first), `apps/web/scripts/setupRendererSpikeAssets.mjs` (verifies against the committed `asset-checksums.json`), `.gitattributes`, root version, changelog, README, ARCHI roadmap and vendor README notes.

**Plan**: `docs/1-plans/F_0.14.0_first-docking-gameplay.plan.md` (intent context). The release also publishes the space-to-ground, volumetric weather, F/A-18 flight, airfield and flight visual-quality work accumulated since v0.8.0 (`F_0.9.0_space-to-ground`, `F_0.10.0_ground-weather-cycle`, `F_0.11.0_flight-visual-quality`, `F_0.11.0_volumetric-clouds`, `F_0.12.0_volumetric-cloud-system`, `F_0.13.0_f18-flight-prototype`, `F_airfield-first-person`), each with its own review record under this folder and `docs/6-memo/`.

---

## Executive Summary

The release ships the approachable first docking mission on a Crew Dragon with RCS geometry registered from the model, the volumetric weather renderer under neutral project naming, FLIGHT mode with the airfield and environment clock, and the two lifecycle fixes found during the full-update audit. Two independent review rounds approved the complete 86-path update, and a focused follow-up round approved the naming/consolidation delta with no new findings.

APPROVED

---

## Changes Overview

Since v0.8.0 the planet became a place (quadtree terrain, inside-atmosphere sky), the cloud stack became a canonical volumetric weather system hosted on Takram's atmosphere and clouds passes, and an optional FLIGHT mode added a licensed F/A-18C, an airfield with an on-foot start and real-time daylight. The final uncommitted update added the Crew Dragon model and RCS registration, revised allocation and IMU propagation, docking contact behaviour, the `FIRST_DOCKING_01` manual mission with its guidance HUD and pause/retry loop, procedural RCS audio, final SMAA, emissive exhaust and livery, and then renamed the renderer to volumetric naming while keeping a legacy URL alias. Release packaging hooks the checksum-verified renderer-asset provisioning into the web build so a fresh Cloudflare Pages checkout builds the same site.

---

## Findings

Independent round 1 reported no additional findings. The two implementer-found issues below were independently confirmed as addressed in round 2. The naming/consolidation follow-up reported no findings. Nothing was overridden or remains open.

### Critical Issues

None.

### Major Issues

#### Inspection could start a competing simulation

- **Location**: `apps/web/src/telemetry/simEmitter.ts`; `apps/web/src/scene/SceneRoot.tsx`
- **Description**: `inspectThruster()` could reset and start the SANDBOX publisher while MISSION, FLIGHT or ANALYSIS owned simulation state, and a direct `thrusterProbe=1` mission URL could mount the inspection panel and create competing publishers.
- **Disposition**: **Addressed and independently confirmed.** The command requires DEV and SANDBOX; the panel independently requires SANDBOX. Regression coverage in `simEmitter.test.ts` exercises all three forbidden modes, SANDBOX firing and cleanup, and restores the original fixed-seed determinism case.

### Minor Issues

#### Paused or inactive missions could sustain stale RCS audio

- **Location**: `apps/web/src/hud/flightAudio.ts`
- **Description**: Paused, briefing and debrief states retained the last truth/render firing window while the procedural audio bank kept looping until given zero duty.
- **Disposition**: **Addressed and independently confirmed.** Mission RCS audio is enabled only while the scenario is RUNNING and unpaused, including initial voice creation, render updates and scenario transitions; truth/render state is unchanged and SANDBOX audio stays independent. Coverage in `flightAudio.test.ts`, including a briefing case that seeds stale firing before a real pointer event.

### Suggestions

- Release-time observation (not from the independent review): CI runs `pnpm -r test` only, so the production build and the renderer-asset provisioning are exercised by the Cloudflare Pages build rather than by CI. Adding `pnpm -r build` to the workflow would surface provisioning regressions earlier.

---

## Checklist

- [x] 1. Functional Requirements — passed
- [x] 2. Code Quality — passed
- [x] 3. Architectural Compliance — passed
- [x] 4. Package Boundary & FSW Purity — passed (no incremental core/scenario changes in the naming delta; core and scenario hashes matched the approved audit)
- [x] 5. GNC Conventions & Determinism — passed
- [x] 6. Error Handling — passed (unknown cloud selectors keep the existing default)
- [x] 7. Security — passed (renderer selectors are allowlisted)
- [x] 8. Performance — passed; no new benchmark, historical evidence scoped to its memos

---

## Verdict

**APPROVED**

Audit gate: full workspace build plus 648 web, 132 sim-core and 38 scenario tests (818). Consolidation gate: full build plus 655 web tests in 78 files. Release gate on the final tree (2026-09-14): `pnpm -r build` passed and the three suites passed serially with one worker — 132 sim-core, 38 scenario and 655 web tests (825 total); the ignored Takram runtime files were deleted and re-provisioned by the new build hook with checksums matching the committed manifest. Independent review thread `01a09ea6-694f-7cf2-919c-3ad0aa659ba8` (two audit rounds and one consolidation round); raw rounds and gate logs are archived locally under `.evidence.local/`. No fresh visual sweep, frame-time benchmark, audio listening session or manufacturer-fidelity validation was performed for this release; the artist-derived Dragon geometry, empirical cloud-top brightening and thin moving cloud silhouettes remain documented approximations.
