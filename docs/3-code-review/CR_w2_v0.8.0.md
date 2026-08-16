# Code Review: Sky & Cloud System Overhaul

**Review Date**: 2026-08-16  
**Version**: 0.8.0  
**Files Reviewed**:

- `.gitignore`
- `apps/web/package.json`
- `apps/web/public/assets/ASSETS.md`
- `apps/web/public/assets/lut/multiple_scattering.bin`
- `apps/web/public/assets/lut/transmittance.bin`
- `apps/web/public/assets/models/chaser.glb`
- `apps/web/public/assets/models/target.glb`
- `apps/web/public/assets/textures/cloud_coverage_mask.png`
- `apps/web/public/assets/textures/earth_clouds_4k.ktx2`
- `apps/web/public/assets/textures/earth_day.jpg`
- `apps/web/public/assets/textures/earth_day_2k.ktx2`
- `apps/web/public/assets/textures/earth_day_4k.ktx2`
- `apps/web/public/assets/textures/earth_night.png`
- `apps/web/public/assets/textures/earth_night_2k.ktx2`
- `apps/web/public/assets/textures/earth_normal_4k.ktx2`
- `apps/web/public/assets/textures/earth_spec.jpg`
- `apps/web/public/assets/textures/earth_spec_2k.ktx2`
- `apps/web/public/assets/textures/lucky_marlin_logo.png`
- `apps/web/public/basis_transcoder.js`
- `apps/web/public/basis_transcoder.wasm`
- `apps/web/scripts/bakeAtmosphere.mjs`
- `apps/web/scripts/makeCloudMask.mjs`
- `apps/web/scripts/makeEarthNormal.mjs`
- `apps/web/src/hud/FpsCounter.tsx`
- `apps/web/src/hud/KeybindsOverlay.tsx`
- `apps/web/src/hud/ModeBar.tsx`
- `apps/web/src/hud/hud.css`
- `apps/web/src/input/bindings.ts`
- `apps/web/src/input/manualControls.ts`
- `apps/web/src/scene/CameraRig.tsx`
- `apps/web/src/scene/Clouds.tsx`
- `apps/web/src/scene/Earth.tsx`
- `apps/web/src/scene/EarthMath.test.ts`
- `apps/web/src/scene/EarthMath.ts`
- `apps/web/src/scene/SceneRoot.tsx`
- `apps/web/src/scene/Spacecraft.tsx`
- `apps/web/src/scene/SunSprite.tsx`
- `apps/web/src/scene/VolumetricClouds.tsx`
- `apps/web/src/scene/cloudCoverage.ts`
- `apps/web/src/scene/modelNormalization.test.ts`
- `apps/web/src/scene/modelNormalization.ts`
- `apps/web/src/scene/sky/atmosphereMath.test.ts`
- `apps/web/src/scene/sky/atmosphereMath.ts`
- `apps/web/src/scene/sky/cloudCoverage.ts`
- `apps/web/src/scene/sky/cloudPlacement.test.ts`
- `apps/web/src/scene/sky/cloudPlacement.ts`
- `apps/web/src/scene/sky/lighting.ts`
- `apps/web/src/scene/sky/skyConfig.test.ts`
- `apps/web/src/scene/sky/skyConfig.ts`
- `apps/web/src/viewStore.ts`
- `docs/1-plans/F_0.8.0_sky-overhaul.plan.md`
- `docs/1-plans/F_0.8.0_visual-pass.plan.md`
- `docs/4-unit-tests/COVERAGE-DEBT.md`
- `pnpm-lock.yaml`

**Plan**: `docs/1-plans/F_0.8.0_sky-overhaul.plan.md`

---

## Executive Summary

This change rebuilds the Earth rendering stack around shared physical configuration, precomputed atmospheric scattering, aligned surface/cloud lighting, coverage-driven volumetric clouds, and a camera-relative sun. Seven correctness, fallback, resource-management, and documentation findings were raised during review; all were addressed and the final build, tests, and GPU verification passed.

APPROVED

---

## Changes Overview

The implementation adds atmosphere LUT generation and runtime loading, aerial perspective, shared sky lighting, corrected cloud shadows and drift, coverage-mask rejection sampling, FBM volumetric clouds, and an optical-infinity sun. It also introduces KTX2 Earth assets, surface relief and water effects, normalized spacecraft assets, debug-camera controls, an FPS counter, asset provenance, analytic tests, and shader coverage-debt records.

Owner flight testing additionally corrected instance-field culling, billboard footprint fading, atmosphere silhouette artifacts, orbital-scale ocean shimmer, and night-map minification behavior.

---

## Findings

### Critical Issues

None.

### Major Issues

1. **Cloud shadows and volumetric clouds rotated 180° from the visible deck**  
   **Location**: `apps/web/src/scene/Earth.tsx:190`, `apps/web/src/scene/VolumetricClouds.tsx:114`, `apps/web/src/scene/sky/cloudPlacement.ts:31`, `apps/web/src/scene/EarthMath.ts:36`  
   The world-to-equirectangular conversion originally added an extra `0.5`, mapping +x to `u=0` instead of Three.js `SphereGeometry`’s `u=0.5`. This placed shadows and volumetric density half a planet away from the rendered deck.  
   **Disposition**: Addressed. The offset was removed consistently and both UV-oracle tests were updated.

2. **Malformed committed cloud-coverage mask**  
   **Location**: `apps/web/scripts/makeCloudMask.mjs:105`, `apps/web/scripts/makeCloudMask.mjs:111`, `apps/web/public/assets/ASSETS.md:11`  
   The generator supplied a one-byte grayscale buffer to pngjs’s default four-byte RGBA writer, leaving cloud data confined to the artifact’s top quarter.  
   **Disposition**: Addressed. The writer now declares grayscale input and output explicitly, and the regenerated 512×256 artifact is valid across all rows with SHA-256 `f562b5aa57d4541faf39ca1a23887b97af354965eb32a17e96be69be501c2d52`.

3. **CPU placement and GPU cloud gating used different color-space values**  
   **Location**: `apps/web/scripts/makeCloudMask.mjs:56`, `apps/web/scripts/makeCloudMask.mjs:65`, `apps/web/src/scene/Earth.tsx:539`  
   CPU mask generation initially applied the coverage transfer to encoded source bytes, while GPU sampling decoded the cloud texture from sRGB first. This caused placement acceptance and runtime density gating to disagree.  
   **Disposition**: Addressed. The generator now decodes sRGB channels before calculating coverage, matching GPU sampling.

4. **Half-float LUT fallback corrupted low transmittance values**  
   **Location**: `apps/web/src/scene/Earth.tsx:117`, `apps/web/src/scene/Earth.tsx:119`  
   The original logarithm-based converter did not support half-float subnormals, turning the LUT’s `1e-6` floor into sign-set invalid values on fallback hardware.  
   **Disposition**: Addressed. Conversion now uses Three.js `DataUtils.toHalfFloat` with an upper-range clamp.

5. **Second volumetric puff-size octave was unreachable**  
   **Location**: `apps/web/src/scene/VolumetricClouds.tsx:142`, `apps/web/src/scene/VolumetricClouds.tsx:147`  
   Selecting `max(largeSize, detailSize × 0.72)` meant the 14–22 km large octave always exceeded the detail octave, contrary to the planned mixed-size cloud field.  
   **Disposition**: Addressed. A deterministic instance-seed split now assigns approximately 40% of instances to the detail octave.

### Minor Issues

1. **Imperative volumetric-cloud resources leaked on Canvas remount**  
   **Location**: `apps/web/src/scene/VolumetricClouds.tsx:357`, `apps/web/src/scene/VolumetricClouds.tsx:360`  
   The geometry, shader material, and instance buffers owned by the R3F primitive were not disposed when switching away from and back to the Canvas.  
   **Disposition**: Addressed. An effect cleanup now disposes the geometry, material, and instanced mesh.

2. **Shader coverage-debt gate was incomplete**  
   **Location**: `docs/4-unit-tests/COVERAGE-DEBT.md:3`, `docs/4-unit-tests/COVERAGE-DEBT.md:5`  
   GPU-only Earth, cloud-deck, and volumetric-cloud shader paths lacked the coverage-debt records required by the implementation plan and review gate.  
   **Disposition**: Addressed. Three entries now document why the paths are hard to unit test and identify their escape plans.

### Suggestions

None.

---

## Checklist

- [x] 1. Functional Requirements — Passed; all reported rendering and fallback defects were resolved.
- [x] 2. Code Quality — Passed; shared configuration, descriptive naming, typing, and shader commentary are appropriate.
- [x] 3. Architectural Compliance — Passed; rendering, asset generation, and UI changes remain within `apps/web`.
- [x] 4. Package Boundary & FSW Purity — Passed; sim-core, scenario, and FSW boundaries are untouched.
- [x] 5. GNC Conventions & Determinism — Passed; Hill-frame conventions remain intact, placement is seeded, and new math carries oracle tests.
- [x] 6. Error Handling — Passed; LUT fallback, model loading, checksum validation, and neutral tint fallback are handled.
- [x] 7. Security — Not applicable; no authentication, authorization, sensitive-data, or externally supplied runtime-input surface was added.
- [x] 8. Performance — Passed; Three.js resources are disposed and the integrated GPU screenshot loop sustained 60 fps.

---

## Verdict

**APPROVED**

All seven review findings were addressed; none were overridden or left open. The requester reported a clean typecheck/build, 145 passing tests across sim-core, scenario, and web, and successful GPU visual verification at 60 fps.
