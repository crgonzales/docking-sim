# Correct the near/ orbital cloud separation

This is corrective implementation of phases 4 and 5 of `F_0.12.0_volumetric-cloud-system.plan.md`, explicitly requested by the user on 2026-09-14. The original direction was to adopt modern EVE's overall system, not merely its visual style. No new renderer, cloud art redesign or physics work is authorized by this correction.

## Confirmed gaps

The current `VolumetricCloudSystem` computes an orbital column atlas and near/far weights, but executes both representations in the same 4x4 temporally sparse view shader before reconstruction. That differs from the accepted architecture, which reconstructs nearby volumes before blending with the distant layer. The resolve can also have no compatible current sample next to moving opaque objects; its fallback returns no clouds. Final SMAA cannot recover those missing samples.

## Required behavior

- Nearby volumetric marching and the curved orbital layer have independent view sampling. The orbital layer is current-frame, spatially filtered, deterministic for a fixed camera/weather/sun, and does not enter near-volume temporal history.
- The orbital view uses the prepared world-fixed opacity/height atlas and bounded shared lighting. Do not run the expensive near volume or the subtexel radial-density recovery across the whole screen in orbit. Keep the lit cloud tops, atmosphere, terminator and shared weather/shadow placement.
- Resolve near radiance/transmittance first, then blend it once with far radiance/transmittance. Both outputs use the existing atmosphere-treatment convention; do not apply atmosphere or opacity twice. Suppress unused near view work at full orbital weight and unused far view work at zero weight. Preserve the 50–120 km overlap/readiness behavior while verifying it at multiple elevations.
- Foreground silhouettes use the full scene depth. A cloud sample hidden behind a foreground ship must not remove clouds from a neighboring exposed pixel. When sparse reconstruction lacks a valid current sample, use fresh depth-correct sampling where needed; do not smear or widen the foreground mask. Support moving objects with a stationary camera, thin geometry and partial cloud occlusion.
- Preserve context loss/disposal, DPR changes, odd viewport sizes, rebasing, cloud motion, cloud-off and comparison diagnostics. Keep allocations bounded and report changed budgets. The near-only and native/no-history references remain available for comparisons.

## Scope / collaboration

Only `apps/web/src/scene/clouds/`, its backend integration in `LibraryEffects.tsx`, focused diagnostic/tests and this plan/evidence memo. The main checkout has a separate concurrent mission-entry update (README, package/version/changelog, appModeStore and ARCHI); do not modify, stage, revert or include those files. Do not create worktrees, switch the shared branch, commit, push or deploy during implementation. This exception to branch creation avoids moving the other writer's active checkout.

## Work

- [ ] Separate current-frame orbital sampling and post-near-resolve composition with bounded resources.
- [ ] Correct foreground reconstruction's missing-current-sample behavior without mask dilation.
- [ ] Add behavioral/GPU regressions for stationary phase invariance, moving silhouettes, depth, odd sizes and single near/far blending.
- [ ] Verify one running game view at orbital/transition/near altitudes, motion and object boundaries; measure frame times, run the affected test/build gate and independent review.

## Verification

Use at most one game tab, reuse it, and close it afterward. Port 5175 currently belongs to a different project; leave that server alone and use an available 5174 in the canonical docking-sim folder. Save before/after evidence under `.evidence.local/cloud-representation-correction/`. Compare the same camera, weather, sun, DPR and quality. The 30 FPS accepted floor is the minimum measured target on this Mac; report cold-start separately. Passing shader fixtures is evidence for their cases, not a substitute for motion/image acceptance.

The upstream public configuration documents scaled-fade altitude controls and temporal upscaling. Its unavailable shader internals are not being claimed as copied source. References are already recorded in the original plan.
