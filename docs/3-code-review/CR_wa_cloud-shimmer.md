# Code Review: Cloud shimmer

**Review Date**: 2026-09-11
**Version**: 0.8.0 (development checkpoint after f93b072; no release)
**Files Reviewed**:

- apps/web/src/scene/clouds/cloudViewSampling.ts
- apps/web/src/scene/clouds/EveCloudSystem.ts
- apps/web/src/scene/clouds/CloudSamplingFixture.ts
- docs/ARCHI.md
- docs/6-memo/f18-integration/cloud-shimmer-validation.md

**Plan**: no plan — unplanned change

## Executive Summary

Reduce cloud-boundary quadrature noise by using closer primary samples while
retaining iteration limits, render allocations, and temporal safeguards.
Independent Codex CLI review found no issues. APPROVED.

## Changes Overview

Shared sampling preferences set Medium/Low maximum preferred spacing to
160/320 m instead of 800 m. The production marcher remains responsible for
complete ray coverage within its fixed budget. Stationary reconstruction keeps
its original 800 m depth uncertainty independently of the new preferred spacing.
The GPU fixture replaces a surrogate marcher with production shader execution
against analytic thin-cloud profiles, including the former grazing-ray guard.

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
- [x] 2. Code Quality — passed; shared sampling preferences.
- [x] 3. Architectural Compliance — passed; rendering-layer scope.
- [x] 4. Package Boundary & FSW Purity — passed; untouched.
- [x] 5. GNC Conventions & Determinism — passed; deterministic GPU inputs.
- [x] 6. Error Handling — passed; shader instrumentation fails if its seam changes.
- [ ] 7. Security — not applicable.
- [x] 8. Performance — passed; fixed limits, measured view-dependent cost documented.

## Verdict

**APPROVED**

Workspace build, 55 affected tests, and all 781 GPU conformance cases passed.
Matched ground captures, banked flight, and 20/70/400 km views were checked in
one browser tab. Remaining motion softness and grazing-ray limits are explicit
in the validation memo. Review thread: `01a08f6e-5b98-7b03-b5b7-3a7f260e597f`.
