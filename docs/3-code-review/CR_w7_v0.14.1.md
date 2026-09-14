# Code Review: v0.14.1 — library atmosphere pipeline and volumetric weather as the only renderer

**Review Date**: 2026-09-14
**Version**: 0.14.1
**Files Reviewed**:

- `apps/web/src/scene/renderSelection.ts` (new) and `renderSelection.test.ts` (new)
- `apps/web/src/scene/renderProbeConfig.ts`
- `apps/web/src/scene/clouds/cloudSystemSelection.ts` and `cloudSystemSelection.test.ts`
- `apps/web/src/scene/SceneRoot.tsx`
- `apps/web/src/scene/LibraryEffects.tsx`
- `README.md`, `docs/ARCHI.md`, `docs/2-changelog/changelog_table.md`, `docs/2-changelog/w7_v0.14.1.md`, root `package.json`

**Plan**: no plan — hotfix for a confirmed live-site defect (bare `https://docking-sim.pages.dev/` and `?mode=mission` rendered the retired v0.8.0 renderer after the v0.14.0 release). Intent recorded in the local defect memo; the owner then decided the old renderer is not needed at all.

---

## Executive Summary

Two independent opt-in gates (`renderer=library` and a `cloudSystem` default of `legacy`) were never flipped when the volumetric weather renderer became the shipped presentation, so ordinary space views still mounted the old Earth shell and billboard clouds while FLIGHT, which passes both selections explicitly, looked right. The fix makes the library pipeline the only renderer, defaults the cloud system to volumetric, pins normal play to medium quality, DPR 1 and exposure 2, and resolves missing, empty and unknown selectors to those defaults. Independent review found no issues.

APPROVED

---

## Changes Overview

`renderSelection.ts` centralises every query-driven render setting in one pure resolver (`resolveRenderProbeConfig`) plus the selection LibraryEffects applies (`resolveLibraryEffectsSelection`, explicit FLIGHT props first). `renderProbeConfig.ts` derives its constants from it and exports `LIBRARY_RENDERER = true`; `SceneRoot` mounts `LibraryEffects` unconditionally and no longer mounts the legacy starfield, sun sprite or bloom composer. `resolveCloudSystem` defaults to `volumetric`, keeps the historical `eve` alias and keeps `cloudSystem=legacy` as the earlier library cloud backend for comparison. Numeric selectors fall back instead of producing NaN. No cloud density, shader, physics or weather-map content changed; FLIGHT graphics presets are untouched.

---

## Findings

Independent review reported no findings.

### Critical Issues

None.

### Major Issues

None.

### Minor Issues

None.

### Suggestions

- The retired renderer's component files (`Effects.tsx`, `Starfield.tsx`, `SunSprite.tsx`, `Clouds.tsx`, legacy branches in `Earth.tsx`, `TerrainPatches.tsx`, `terrainShaders.ts`, `ThrusterPlumes.tsx`) are now unreachable except for the shared `FRAME_TONE_MAPPING` constant used by `DockingCameraPiP`. Remove them in a separate cleanup so the hotfix stays minimal.

---

## Checklist

- [x] 1. Functional Requirements — passed: default renderer, volumetric weather, selector fallbacks, diagnostic legacy cloud backend and FLIGHT prop precedence match the intent
- [x] 2. Code Quality — passed: selection logic centralised, typed and covered by focused tests
- [x] 3. Architectural Compliance — passed: change stays inside the web rendering boundary
- [x] 4. Package Boundary & FSW Purity — passed; sim-core and scenario untouched
- [x] 5. GNC Conventions & Determinism — not applicable
- [x] 6. Error Handling — passed: empty, non-numeric and unknown selectors degrade to bounded defaults
- [x] 7. Security — passed: query inputs are enum-selected or numerically bounded
- [x] 8. Performance — passed: ordinary play pinned to medium quality and DPR 1; no new render-loop work

---

## Verdict

**APPROVED**

Independent reviewer: Codex CLI (`gpt-5.6-sol`, xhigh), one round, target `renderer-defaults-hotfix-2026-09-14`, no findings. Gate on the change: `tsc --noEmit` passed; the web suite passed 676 tests in 79 files (21 new selection cases); `pnpm --filter @docking/web build` passed and re-provisioned the 10 pinned Takram runtime files with matching checksums; `apps/web/dist` contains the volumetric weather and Takram assets. Browser validation is recorded in `docs/2-changelog/w7_v0.14.1.md` and the release report: the production build served on 127.0.0.1:5176 was driven through one Chrome tab at bare `/`, the previously explicit selection URL, `?mode=mission` (briefing, start, thrust), orbit, atmospheric transition and low-altitude framings and `?mode=flight`; the same bare-URL and mission checks were repeated against the live Cloudflare Pages deployment after publication.
