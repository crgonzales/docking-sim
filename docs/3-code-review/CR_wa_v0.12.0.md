# Code Review: EVE cloud system integrated development batch

**Review Date**: 2026-09-09
**Version**: 0.12.0 planned; development batch only, unreleased
**Files Reviewed**:

- `apps/web/src/scene/RenderProbe.tsx`, `CameraRig.tsx`, `LibraryEffects.tsx`, `SceneRoot.tsx`
- `apps/web/src/scene/clouds/EveCloudSystem.ts`, `EveAerialPerspectiveEffect.ts`
- `apps/web/src/scene/clouds/CloudLightVolume.ts`, `cloudLightVolumeLayout.ts`, `CloudTemporalState.ts`
- `apps/web/src/scene/clouds/cloudConfig.ts`, `cloudWeather.ts`, `cloudWeatherAssets.ts`
- `apps/web/src/scene/clouds/shaders/`, `takramCloudBackend.ts`
- `apps/web/src/scene/clouds/vendor/takram/` source, manifest and provenance
- Cloud conformance fixtures, affected unit tests, asset setup and implementation evidence

**Plan**: `docs/1-plans/F_0.12.0_volumetric-cloud-system.plan.md`

---

## Executive Summary

The opt-in EVE backend integrates authored coverage/type/noise, shared direct and ambient lighting, near/far alternative integration, and depth-validated reconstruction. This review approves the implemented development batch after regression fixes; the complete feature, visual quality and performance have not been accepted.

APPROVED

---

## Changes Overview

The cloud test view now explains why Earth is hidden and provides a return-to-flight link. A shader uniform validator crash, low-opacity weather field and history-off resolution mismatch were corrected. Review follow-ups add local texture-footprint filtering, opacity-weighted transition depth, and spatial reconstruction for unsampled moving/cut pixels while retaining exact fresh samples and stationary per-pixel history. The reference renderer remains selected for normal library flights.

---

## Findings

### Critical Issues

None remaining in the implemented batch.

### Major Issues

- **GLSL prose parsed as a uniform** — `EveAerialPerspectiveEffect.ts`: comment stripping and a real-binding regression prevent the reload crash. Addressed.
- **Coverage scaled only transparency** — `shaders/cloudDensity.glsl`, `cloudConfig.ts`: coverage now changes spatial support; actual raw-asset columns and opacity were measured. Addressed.
- **History-off silently reduced resolution** — `EveCloudSystem.ts`: native comparison preserves the quality-capped output size. Addressed.
- **Local map reused global LOD** — `shaders/cloudDensity.glsl:61`: independent dimensions/angular bounds drive reference filtering; 17 explicit-mip GPU checks cover the contract. Addressed.
- **Transition depth ignored opacity** — `vendor/takram/src/shaders/clouds.frag:1119`: finite opacity contributions weight reconstruction depth; exact endpoints and real depth-attachment checks cover unequal/empty alternatives. Addressed.
- **Moving/cut pixels repeated a block ray** — `vendor/takram/src/shaders/cloudsResolve.frag:201`: jitter-aware spatial interpolation replaces the broadcast fallback. Full-Bayer linear-field and gap-edge tests complement multi-frame stationary/cut recovery. Addressed.

### Minor Issues

Vendor hashes were refreshed and verified after the final shader edits. Addressed.

### Suggestions

None added by the final incremental review. Planned visual/performance and feature work remains explicitly open below.

---

## Checklist

- [x] 1. Functional Requirements — passed for implemented batch; future plan phases are not claimed complete.
- [x] 2. Code Quality — passed.
- [x] 3. Architectural Compliance — passed.
- [x] 4. Package Boundary & FSW Purity — passed.
- [x] 5. GNC Conventions & Determinism — passed.
- [x] 6. Error Handling — passed.
- [x] 7. Security — no applicable regression.
- [ ] 8. Performance — no new unbounded resource defect identified; frame-rate, moving-image and soak acceptance remain open.

---

## Verdict

**APPROVED**

Independent Codex review session `01a0899e-c06b-7372-b347-eb6c43959370` converged after the three final Major corrections. The [verbatim result](../6-memo/volumetric-cloud-system/integrated-batch-review.txt) and [210 passing GPU cases](../6-memo/volumetric-cloud-system/gpu-conformance-final-batch.json) are retained. All 103 affected unit tests and the workspace build pass; the existing bundle-size warning remains. A recorded descent and mountain-to-coast teleport check supplement numerical tests without establishing visual or performance acceptance.

Grain, sparse orbital appearance, the prepared far representation, independent overlapping layers, advection/detiling, atmospheric shafts, PiP integration, capability fallback and the full visual/performance/soak matrix remain in the approved plan. No default promotion, merge, release or push is implied.
