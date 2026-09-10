# Code Review: Flight visual pass

**Review Date**: 2026-09-10
**Version**: Development checkpoint; no release/version change
**Plan**: `docs/1-plans/F_flight-visual-pass.plan.md`
**Files Reviewed**:

- `apps/web/src/flight/FlightMode.tsx`
- `apps/web/src/flight/flight.css`
- `apps/web/src/scene/clouds/EveAerialPerspectiveEffect.ts`
- `apps/web/src/scene/libraryWaterLighting.ts`
- `apps/web/src/scene/clouds/EveAerialPerspectiveEffect.test.ts`
- `apps/web/src/scene/clouds/CloudOceanReceiverFixture.ts`
- `apps/web/src/scene/clouds/CloudConformanceFixture.ts`
- `apps/web/src/scene/clouds/CloudConformanceResources.ts`
- Plan and `docs/6-memo/f18-integration/visual-pass.md`

## Executive Summary

Actual fly-throughs reproduced ocean shadow bands, low-contrast instruments and frozen noisy clouds after paused camera changes. The fixes retain cloud shadows and bounded rendering cost. Independent Codex CLI review converged in three rounds. **APPROVED**.

## Changes Overview

Shared opaque-water metadata identifies geoid-corrected shadow receivers, while fractional coasts blend visibility. Numeric instruments gain dark backing. Paused flight requests a finite sequence of rendering frames after asset readiness, including cache construction and temporal settling; physics remains paused.

## Findings

### Critical Issues

None.

### Major Issues

Full workspace build initially unconfirmed in the validation memo — addressed by repeated successful `pnpm -r build`, including the final delta. This was a verification gate, not a remaining code defect.

### Minor Issues

Paused redraw budget could expire before assets loaded (`FlightMode.tsx:51`) — addressed by preserving the budget until renderer readiness; `LibraryEffects.tsx:194-196` wakes demand rendering on asset completion. Fresh-start visual validation also increased the bound to cover cache construction before temporal settling.

### Suggestions

None open.

## Checklist

- [x] 1. Functional Requirements — passed
- [x] 2. Code Quality — passed
- [x] 3. Architectural Compliance — passed
- [x] 4. Package Boundary & FSW Purity — passed; physics untouched
- [x] 5. GNC Conventions & Determinism — passed; physics untouched
- [x] 6. Error Handling — passed
- [x] 7. Security — passed
- [x] 8. Performance — passed; bounded paused redraws and no higher cloud resolution

## Verdict

**APPROVED**. Full web tests, affected final tests, 367 production GPU checks, workspace builds and actual views are recorded in the validation memo. No open review findings or overrides. Source-data and medium-quality visual limitations remain explicitly documented.

## Independent final response

Prior findings:

- [Major] “Full workspace build is unconfirmed” — addressed. The successful final build is recorded at `docs/6-memo/f18-integration/visual-pass.md:33`.
- [Minor] “The frame budget can be consumed before EVE finishes loading” — addressed. The counter now decrements only when ready at `apps/web/src/flight/FlightMode.tsx:51-54`; asset completion sets readiness and wakes demand rendering at `apps/web/src/scene/LibraryEffects.tsx:194-196`. The 96-frame bound and fresh-load validation are documented at `docs/6-memo/f18-integration/visual-pass.md:13` and `:27`.

No new issues. All checklist sections pass: functional behavior, code quality, architecture, boundaries, determinism, error handling, security, and bounded performance/resource use. Tests, GPU conformance, documentation, and build gates are green.

APPROVED
