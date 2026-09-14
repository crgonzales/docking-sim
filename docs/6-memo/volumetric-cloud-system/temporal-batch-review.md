# Bounded temporal depth implementation handoff

Worktree: `docking-sim-eve-clouds`

This report covers the assigned implementation slice only. It does not mark a plan phase complete or claim GPU/visual acceptance.

## Source scope

Changed only these assigned repository files:

- `apps/web/src/scene/clouds/vendor/takram/src/CloudsPass.ts`
- `apps/web/src/scene/clouds/vendor/takram/src/CloudsResolveMaterial.ts`
- `apps/web/src/scene/clouds/vendor/takram/src/shaders/cloudsResolve.frag`
- New `apps/web/src/scene/clouds/CloudTemporalState.ts`
- New `apps/web/src/scene/clouds/CloudTemporalState.test.ts`

The parent-owned `clouds.frag`, `CloudsMaterial.ts`, backend adapter, reprojection host, integration, plan, and provenance files were not edited. Existing BasicDepthPacking changes were preserved. No staging, commits, or branch changes were made. This handoff file is outside the repository to preserve the exclusive source scope.

## Pass and shader contract

- Source location 0 remains current RGBA16F cloud color. Source location 1 remains RGBA16F `(positive current view metres * 1e-4, UV velocity x, UV velocity y, expected previous view metres * 1e-4)`. The parent owns this encoder, including previous clip W capture before perspective division and world-to-ECEF metre scaling.
- Resolve/history location 0 is color, fixed location 1 is R16F positive current view depth * 1e-4, and optional shadow length moves to location 2. Current-pass shadow length remains location 2. Disabling shafts retains the depth attachment at 1.
- Both full-resolution ping-pong targets own their depth attachment. Resolve writes the current representative depth for each reconstructed pixel and zero for clear/invalid depth. The current low-resolution representative is used across its reconstructed Bayer block, consistent with current reconstruction support.
- Color, depth, and optional shadow history bindings swap together after resolve. Resolve samples the other history target and the distinct current target, never its own attachments.
- History starts invalid. First use, disabled history, current clear opacity, nonpositive/NaN/infinite current or expected previous depth, invalid UVs, and rejected history use the matched current color/depth/shadow tuple without reading history when validity is false.
- Reprojected history is reconstructed from the same four bilinear texels for color/depth/shadow. Every contributing tap must have finite positive stored depth agreeing with the current sample's expected previous depth, and finite color with opacity above the gap threshold. This prevents a nearest-depth check from validating filtered color from a different surface or clear gap.
- Depth acceptance is `abs(storedDepthM - expectedDepthM) <= max(depthAbsoluteThresholdM, depthRelativeThreshold * expectedDepthM)`. Defaults are 50 metres and 0.01 (1%). Stored values are decoded by multiplying by 1e4. The default opacity gap threshold is 0.001, using physical alpha = 1 - cloud transmittance. Thresholds are exposed as resolve uniforms/constructor parameters.
- Original Bayer reconstruction, closest-neighbor motion selection and moment/AABB variance clipping remain. Motion dilation is constrained to depth-compatible cloudy neighbors. Clipping uses a bounded 3x3 neighborhood, clamps RGB and opacity to neighborhood/moment bounds, and clamps variance gamma to [0,2]. All active neighbor integer fetches clamp coordinates, including odd-sized viewport edges.
- Fresh Bayer accumulation is optional and defaults off. With accumulation enabled, fresh pixels blend clipped history with current using clamped `temporalAlpha`; non-fresh Bayer pixels use clipped history. Native temporal antialiasing uses the same validated history and temporal alpha. Shadow length follows identical acceptance and accumulation weights.
- R16F uses nearest filtering; resolve performs the matched bilinear reconstruction explicitly. Sampler precision is highp. The additional two depth targets cost 8,294,400 bytes (about 7.91 MiB) at 1920x1080, for the parent to include in its total budget.

## Public APIs for parent integration

`CloudsPass`:

- `invalidateHistory(): void`
- Read-only `historyValid: boolean`
- `historyEnabled: boolean` (setter invalidates on an actual toggle)
- Read-only `outputDepthBuffer: Texture | null`, paired with `outputBuffer` after the swap
- Existing `temporalUpscale` and `lightShafts` setters invalidate and resize/recreate as needed
- `setSize` normalizes to positive integer pixels and skips all changes when dimensions are equal. It therefore avoids the current material's unconditional reprojection invalidation on repeated same-size calls.

Native no-history reference: set `pass.temporalUpscale = false` and `pass.historyEnabled = false`. This branches out before any history sampling. Re-enabling through the pass setter invalidates history before reuse. Optional fresh accumulation is `pass.resolveMaterial.uniforms.accumulateFreshSamples.value = true`; existing `temporalAlpha` controls its blend.

`CloudTemporalState` is pure TypeScript metadata, with no Three.js/DOM/GPU imports:

- Construct one instance per view with optional `{ distanceM, angleRad }` camera-cut thresholds. Defaults: 1000 metres and PI/6 (30 degrees) between rendered frames.
- Supply a `CloudTemporalFrame` with unjittered projection, actual framebuffer dimensions, DPR, backend key, float64 ECEF camera position, stable ECEF scalar-first `[w,x,y,z]` orientation, rebase origin, weather/light generations and compatibility keys, representation compatibility key, normalized near/far weights, and optional one-frame `cameraCut` flag.
- `beforeRender(frame)` returns `{ historyValid, reset, reasons }`. On `reset`, the parent calls `pass.invalidateHistory()`.
- Call `afterRender(frame)` only after a successful resolve; it copies caller arrays and publishes that rendered frame's metadata.
- `invalidateHistory()` supports external context-loss/discontinuity invalidation. `historyValid` exposes metadata validity; it does not replace the pass's independent GPU history validity.
- Also exports pure `cloudTemporalResetReasons(previous, current, thresholds)` and `isCloudCameraCut(previous, current, thresholds)`.

Projection, viewport, DPR, backend, camera cuts and changed compatibility keys reset history. Ordinary physical movement below the cut thresholds, rebase changes, compatible generation increments and compatible near/far weight changes retain history. The parent determines compatibility; it must change the weather/light/representation key for incompatible changes. Projection input must be unjittered. The existing `CloudReprojectionFrame.beforeRender/afterRender` host remains responsible for rebase matrices.

Camera displacement uses differences of float64 ECEF coordinates before taking the norm, retaining radial/altitude teleport sensitivity at Earth scale. Orientation uses normalized quaternion chord distance with sign equivalence, covering roll and tiny rotations. An explicit cameraCut flag handles user teleports below the configured thresholds. Cuts are strictly greater than the configured distance or angle.

## Verification and remaining parent work

No tests, typecheck, build, browser, shader compilation, or GPU execution was performed, honoring the active parent GPU testing restriction. A scoped `git diff --check` passed. Read-only source review checked pinned Three R16F allocation selection and Takram loop expansion; declarations were hoisted out of expanded loops to avoid duplicate GLSL declarations.

Authored metadata behavior tests cover initial/failed-render lifecycle, each reset cause, simultaneous incompatibilities, ordinary movement with a rebase and compatible generations, cumulative travel without false cuts, radial teleports hidden by origin shifts, explicit invalidation, mutable caller arrays, independent main/PiP state, finite-input handling, metre threshold boundaries, 3-axis displacement, explicit cuts, quaternion sign/scale, roll, tiny rotation thresholds and invalid cut policies. These tests are UNRUN.

Parent retains integration, capability/budget enforcement, provenance updates and acceptance. In particular, validate first-frame/reference output, both shaft modes and attachment layouts, odd viewport sizes, repeated same-size calls versus actual resize, stationary convergence, motion/rebase continuity, depth/clear-gap rejection, behind-camera expected depth rejection, fresh accumulation, and paired color/depth/shadow output on the real GPU. The conservative all-tap history rejection may trade accumulation for correctness near silhouettes; its visual/performance cost remains unmeasured.
