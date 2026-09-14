# Full update audit — 2026-09-13

**Later workspace cleanup:** use `docking-sim` now. The old sibling path below is historical. Renderer naming and folder consolidation are recorded in [workspace cleanup](workspace-cleanup-2026-09-14.md); this audit remains evidence for its original snapshot.

**Subsequent instruction (2026-09-14):** The user authorized publishing the latest update to GitHub and then updating the existing Cloudflare-hosted website; the release is recorded in [the v0.14.0 changelog](../2-changelog/w7_v0.14.0.md). The no-release/no-push statements below describe the completed audit, not a restriction on that newly authorized work. This addendum was written after the preserved audit snapshot; application code is unchanged.

Audit the accumulated working tree in `docking-sim-flight-integrated`, branch `codex/gameplay-first-docking`, against HEAD `77ec02ccbce69f5cb4c85272b9cdfd5dfeed7cfd` (last flight/cloud-shimmer checkpoint).

## Scope and method

The user requested the normal TRIP independent Codex CLI review loop, with one reviewer, fixes and retesting until approval. No release, version bump, merge or push is part of this audit. Keep the visible game closed; any necessary runtime validation must use one temporary offscreen instance and stop it afterward. Preserve all existing work. The original `docking-sim` checkout owns the review checklist/template; local prompt copies only correct their stale paths.

Review tracked changes AND every new source file. The prior first-docking approval excluded unrelated renderer, allocator, sensors and livery. It is evidence for that feature only, not approval of this update. Its raw synthesis listed too many files and omitted new files; do not reuse that list as coverage evidence. No changelog/release exists for this accumulated update; version remains 0.8.0 and 0.14.0 is a feature-plan candidate.

Groups: (1) Dragon thruster geometry, allocator, IMU propagation, contact, scenario configuration/bot/Monte Carlo; (2) first-docking mission, public hold, keyboard/pointer/pause/retry and all mode transitions; (3) cloud-top response, sparse cloud reconstruction/occlusion, normal and mask materials, final SMAA, emissive exhaust/composer/livery; (4) audio lifecycle, diagnostics, asset provenance and cross-group integration. Read the first-docking plan and relevant memos for intent, without restricting review to its files.

Important invariants: pure sensor-driven FSW, seeded fixed steps, public APIs, SI/Hill/scalar-first quaternions, real pulse duty and real capture outcomes; independent mission/flight/sandbox ownership; bounded renderer memory and disposal; matching depth/color/normal silhouettes and single final color encoding. Artist-derived Dragon geometry and empirical cloud-top brightening are documented approximations; manufacturer fidelity and radiometric calibration were not promised.

Gate logs and exact before-file SHA256 values are under `.evidence.local/audit-2026-09-13/`. Build and full affected-package suites are being rerun serially with one test worker. Prior GPU/visual checks are documented in `dragon-rcs.md`, `volumetric-cloud-system/foreground-edges.md`, `volumetric-cloud-system/cloud-top-lighting.md` and `first-docking-gameplay.md`; those are historical evidence, not new audit-time browser checks. If an audit fix changes a shader or appearance, rerun its relevant GPU/visual checks before claiming verification. The game remains closed during the code audit.

## Baseline inventory (83 files)

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
- `apps/web/src/telemetry/simEmitter.ts`
- `apps/web/src/viewStore.ts`
- `apps/web/vite.config.ts`
- `docs/1-plans/F_0.14.0_first-docking-gameplay.plan.md`
- `docs/6-memo/dragon-rcs.md`
- `docs/6-memo/volumetric-cloud-system/cloud-top-lighting.md`
- `docs/6-memo/volumetric-cloud-system/foreground-edges.md`
- `docs/6-memo/first-docking-gameplay.md`
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

## Initial testing gate

Full workspace build passed on the unchanged baseline. Full package suites passed serially: web 641 tests in 76 files, sim-core 132 in 21 files, scenario 38 in 6 files (811 total). One pnpm invocation rejected test-runner options before running tests; corrected to `pnpm --filter <package> run test --maxWorkers=1 --minWorkers=1`, retaining the invocation error separately. No source changes were needed for this gate. `git diff --check HEAD` passed. Existing large-bundle advisory remains.

All 83 original changed/new file hashes were unchanged during the gate. `before-files.tar.gz`, `before-tracked.patch` and `before-manifest.json` preserve the audit starting point locally; they are not a reviewed Git checkpoint. No game listener was running on port 5175.

The independent reviewer is the normal Codex CLI loop, thread `01a09ea6-694f-7cf2-919c-3ad0aa659ba8`, target `full-update-audit-2026-09-13`. Review state is archived locally outside the repository. An earlier fallback helper was stopped before reading application code and closed; it produced no approval.

Review status: APPROVED on both independent rounds. Final confirmation verified both implementer findings as addressed, the restored/strengthened regression coverage, and all eight checklist sections. No unresolved findings were reported. The earlier scoped first-mission approval is not being reused as full-update evidence.

## Implementer findings and regression fixes

- **Major — inspection can start a competing simulation.** `inspectThruster()` could reset/start the sandbox publisher in MISSION, FLIGHT or ANALYSIS. The panel mounted from the query without a mode guard, making a direct mission URL with `thrusterProbe=1` able to race the scenario publisher. Added a SANDBOX guard at the command and panel mount. The actual publisher regression reproduced a new interval in all three forbidden modes before the fix; sandbox firing/stop remains functional.
- **Minor — paused/finished mission can sustain thruster sound.** The render snapshot retains the last truth firing window, while the audio bank loops until given zero duty. Audio now checks mission phase/pause both on new render samples and on scenario transitions, including first voice initialization. Sandbox remains independent of stale scenario state. Tests reproduced 0.6 duty instead of zero during pause/briefing; the fix leaves truth/render samples unchanged.

Seven focused regression cases cover these fixes. An initial test harness run exposed a missing oscillator-frequency field and an overly strict floating-point assertion; after correcting those, the unmodified behavior failed five cases for the expected reasons. Logs: `lifecycle-before.log`, `lifecycle-after.log` under the audit evidence directory. No new shader math, visual assets, physical coefficients or capture criteria changed in these fixes.

## Final confirmation gate

The follow-up workspace build passed. The full web suite passed 648 tests in 77 files, including the original emitter determinism test restored after it was inadvertently replaced while adding the new regression cases. No pre-existing coverage was removed. The seven new regression cases add to the 811-test baseline: 818 total across the three affected packages. Core and scenario source has not changed since their successful initial suite runs. The briefing audio case was additionally strengthened to seed frozen firing before voice initialization; see `lifecycle-final.log` for its targeted rerun. `final-gate.json` names the final supporting logs.

Audit additions beyond the 83-path baseline: `apps/web/src/hud/flightAudio.test.ts`, changes to existing `apps/web/src/telemetry/simEmitter.test.ts`, and this memo. The independent reviewer inspected these too; final confirmation explicitly covers the restored/strengthened tests and the implementer findings. The raw round-1 response/events are preserved in the audit evidence directory. No fresh browser/GPU run was performed, and the two fixes do not change visual or physical behavior.

## Continuation and limits

Consolidated record: `docs/3-code-review/CR_wa_update-audit-2026-09-13.md` (saved after both independent approvals). Resume in `docking-sim-flight-integrated` on `codex/gameplay-first-docking`; the original checkout is not the active game working tree. Read `docs/ARCHI.md`, `docs/scenario-mode-spec.md`, the first-docking plan and this review before changes. Use the current agent's TRIP skill files.

The update remains an uncommitted working tree based on `77ec02ccbce69f5cb4c85272b9cdfd5dfeed7cfd`. Nothing was released, merged or pushed. A local snapshot of all 87 changed/new files, including the final review report, is saved in `.evidence.local/audit-2026-09-13/after-files.tar.gz`, with hashes in `after-manifest.json` and tracked changes in `after-tracked.patch`; it is a recovery artifact, not a Git tag. Restore into a separate checkout for comparison rather than overwriting current work.

The game stays closed. No listener was running on 5174 or 5175 at the audit's final check. If a future task requires a live check, use the existing integrated game on 5175 and at most one game tab; 5173 is reserved for another app.

Approval covers the code change and recorded tests. No new visual sweep, frame-time benchmark, audio listening session or manufacturer-fidelity validation was performed. Historical GPU/visual evidence remains in the linked memos. Sparse-ray cloud reconstruction can still soften very thin moving silhouettes; final SMAA is not full-scene temporal antialiasing. The capsule and tuned jet/mass/inertia model is not a manufacturer-accurate Dragon simulator. Terrain imagery detail and other visual-polish requests remain separate work, not audit blockers silently declared solved.
