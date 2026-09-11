# Code Review: Flight lighting, ground materials and optional High graphics

**Review Date**: 2026-09-10
**Version**: 0.11.0 (feature checkpoint; no release/version bump)
**Files Reviewed**:

- `apps/web/src/airfield/Airfield.tsx`
- `apps/web/src/airfield/airfieldSurface.ts`
- `apps/web/src/airfield/airfieldSurfaceTextures.test.ts`
- `apps/web/src/airfield/airfieldSurfaceTextures.ts`
- `apps/web/src/flight/FlightEvidenceCapture.tsx`
- `apps/web/src/flight/FlightGraphicsPanel.tsx`
- `apps/web/src/flight/FlightLighting.tsx`
- `apps/web/src/flight/FlightMode.tsx`
- `apps/web/src/flight/HornetModel.tsx`
- `apps/web/src/flight/flight.css`
- `apps/web/src/flight/flightGraphics.test.ts`
- `apps/web/src/flight/flightGraphics.ts`
- `apps/web/src/flight/flightLocalLighting.test.ts`
- `apps/web/src/flight/flightLocalLighting.ts`
- `apps/web/src/flight/hornetMaterials.test.ts`
- `apps/web/src/flight/hornetMaterials.ts`
- `apps/web/src/scene/ComposerDepthFixture.ts`
- `apps/web/src/scene/FlightCloudLightingFixture.ts`
- `apps/web/src/scene/LibraryEffects.tsx`
- `apps/web/src/scene/clouds/CloudConformanceFixture.ts`
- `apps/web/src/scene/clouds/CloudDiffuseTransportFixture.ts`
- `apps/web/src/scene/clouds/CloudLightVolumeFixture.ts`
- `apps/web/src/scene/clouds/CloudOceanReceiverFixture.ts`
- `apps/web/src/scene/clouds/EveAerialPerspectiveEffect.ts`
- `apps/web/src/scene/clouds/shaders/cloudTransport.glsl`
- `apps/web/src/scene/flightCloudLighting.test.ts`
- `apps/web/src/scene/flightCloudLighting.ts`
- `apps/web/src/scene/libraryComposerDepth.ts`
- `docs/1-plans/F_0.11.0_flight-visual-quality.plan.md`
- `docs/4-unit-tests/COVERAGE-DEBT.md`
- `docs/4-unit-tests/TESTING.md`
- `docs/6-memo/f18-integration/flight-quality-plan-review.md`
- `docs/6-memo/f18-integration/flight-quality-validation.md`
- `docs/ARCHI.md`

**Plan**: `docs/1-plans/F_0.11.0_flight-visual-quality.plan.md`

---

## Executive Summary

Corrected local aircraft lighting, added filtered ground materials and optional High graphics, and fixed the depth attachment and cloud diffuse-light defects found during visual verification. The independent Codex review found no actionable issues after inspecting implementation and validation evidence.

APPROVED

## Changes Overview

One flight-owned configuration controls bounded resolution, final SMAA, shadows and material filtering. Local PBR borrows atmosphere and cloud lighting safely; shared diffuse cloud transport includes scattering. Owned texture/material resources preserve source assets and simulation/collision behavior. Real-GPU, unit, build, single-tab visual and M3 performance checks are recorded in the validation memo.

## Findings

### Critical Issues

None.

### Major Issues

None.

### Minor Issues

None.

### Suggestions

None.

## Checklist

- [x] 1. Functional Requirements — passed.
- [x] 2. Code Quality — passed.
- [x] 3. Architectural Compliance — passed.
- [x] 4. Package Boundary & FSW Purity — passed; simulation untouched.
- [x] 5. GNC Conventions & Determinism — passed; coordinate transforms verified.
- [x] 6. Error Handling — passed.
- [x] 7. Security — passed.
- [x] 8. Performance — passed; M3 costs and known visual limits recorded.

## Verdict

**APPROVED**

Local checkpoint only; no merge, release, tag or push. The source model's detail limit, medium cloud-edge grain, approximate diffuse cloud transport and missing moon/artificial night lighting remain documented limitations. Trees and birds follow this checkpoint.

## Independent review (verbatim)

No findings.

- Functional requirements and plan conformance: complete.
- Code quality and architecture: clear; renderer responsibilities remain separated.
- Package boundaries, FSW purity, and GNC conventions: unaffected.
- Error handling and security: no actionable issues.
- Performance and lifecycle: DPR/shadow resizing, cached uniforms, borrowed textures, composer resources, and material hooks are handled safely.
- Approval gate: final validation reports 759/759 GPU checks, 608/608 web tests, focused tests 9/9, and a green workspace build in the [validation memo](/Users/carlosgonzales/dev/docking-sim-flight-integrated/docs/6-memo/f18-integration/flight-quality-validation.md:94). New logic has corresponding tests and documentation.

APPROVED
