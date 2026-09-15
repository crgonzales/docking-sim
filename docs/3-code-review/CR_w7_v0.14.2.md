# Code Review: v0.14.2 — retire the v0.8.0 renderer

**Review Date**: 2026-09-14
**Version**: 0.14.2
**Files Reviewed**:

- Deleted: `apps/web/src/scene/{Effects,Starfield,SunSprite,Clouds,VolumetricClouds}.tsx`, `scene/cloudCoverage.ts`, `scene/EarthMath.ts` (+ test), `scene/sky/{cloudCoverage,cloudPlacement,lighting}.ts` (+ tests), `apps/web/public/assets/hdri/starmap.jpg`, `assets/textures/{earth_night_2k,earth_normal_4k,earth_clouds_4k}.ktx2`, `assets/textures/cloud_coverage_mask.png`, `apps/web/scripts/{makeCloudMask,makeEarthNormal}.mjs`
- Rewritten to the library-only path: `scene/Earth.tsx`, `scene/terrain/terrainShaders.ts`, `scene/terrain/TerrainPatches.tsx`
- Edited: `scene/ThrusterPlumes.tsx`, `scene/RenderProbe.tsx`, `scene/renderProbeConfig.ts`, `scene/renderEvidenceName.ts` (+ test), `scene/renderSelection.test.ts`, `scene/DockingCameraPiP.tsx`, `scene/libraryEarthTextureOrientation.ts` (+ test), `scene/libraryWaterLighting.test.ts`, `scene/libraryCloudWeatherField.test.ts`, `scene/terrain/terrainSurfaceCoverage.test.ts`, `scene/terrain/TerrainSurfaceFixture.ts`, `scene/terrain/quadtree.test.ts`, `scene/sky/skyConfig.ts`, `flight/FlightMode.tsx`, `hud/KeybindsOverlay.tsx`, `apps/web/public/assets/ASSETS.md`
- New: `scene/frameToneMapping.ts`, `scene/sky/cloudSphericalUv.ts`
- Docs/metadata: `README.md`, `docs/ARCHI.md`, `docs/2-changelog/changelog_table.md`, `docs/2-changelog/w7_v0.14.2.md`, root `package.json`

**Plan**: no plan — owner-requested cleanup following the v0.14.1 hotfix ("we don't need the old renderer"; "clean it up").

---

## Executive Summary

v0.14.1 made the library atmosphere pipeline the only renderer but left the v0.8.0 renderer as unreachable code and still shipped its textures. This release deletes the legacy bloom composer, starfield, sun sprite, shell and billboard cloud stack, coverage/placement helpers and Earth math, collapses the Earth and terrain shaders to their former `LIBRARY_LIGHTING` branches, removes the transparent terrain water overlay, drops five legacy-only textures (≈16 MB), and prunes the orphaned sky-config exports. Independent review found no issues.

APPROVED

---

## Changes Overview

`Earth.tsx` is now an opaque globe emitting linear albedo plus water metadata from the day and water-mask textures only; terrain keeps one opaque material with the same output contract and no procedural palette, cloud shadow or water overlay. `TerrainPatches` loses its renderer, opacity, cloud, LUT and deck-rotation props and the animated water mesh. `LIBRARY_RENDERER` is gone; `FRAME_TONE_MAPPING` lives in `frameToneMapping.ts` and the canonical equirect helper `cloudSphericalUv` in `sky/cloudSphericalUv.ts`. Credits and the provenance table follow the removed assets (Dragon and Hornet CC BY 4.0 lines added in-app). Net: 45 files, +153/−2931 lines.

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

- The transmittance LUT bake (`scripts/bakeAtmosphere.mjs`, `assets/lut/`) remains only because the sandbox sun tint samples the transmittance table; the multiple-scattering table is now unused at runtime and could be dropped from the bake in a later pass.

---

## Checklist

- [x] 1. Functional Requirements — passed: Earth and terrain preserve the former library-only GLSL output and water metadata contract; `LIBRARY_LIGHTING` remains set for the composer's lighting mask
- [x] 2. Code Quality — passed: legacy branches, assets and imports removed cleanly; moved helpers keep their behaviour
- [x] 3. Architectural Compliance — passed: single volumetric-weather renderer matches `ARCHI.md`
- [x] 4. Package Boundary & FSW Purity — passed; sim-core and scenario untouched
- [x] 5. GNC Conventions & Determinism — not applicable
- [x] 6. Error Handling — passed: no new failure paths
- [x] 7. Security — not applicable
- [x] 8. Performance — passed: retired render work and ≈16 MB of assets removed; disposal paths intact

---

## Verdict

**APPROVED**

Independent automated reviewer, one round, target `retire-legacy-renderer-2026-09-14`, no findings; repository-wide sweeps found no references to deleted modules or assets. Gate: `tsc --noEmit` passed; web suite 659 tests in 76 files passed (17 cases covering only the removed code went with it); production build passed with the Takram assets re-provisioned; dist shrank from 136 MB to 120 MB and ships only the day, water-mask and logo textures. Headless browser sweep of the built site at bare `/`, the explicit-selection URL, `?mode=mission` (start + thrust), 400 km, 100 km and 3 km framings and `?mode=flight` matched the v0.14.1 frames with zero console errors or exceptions (favicon 404 excepted) and KTX2 requests down from five to two.
