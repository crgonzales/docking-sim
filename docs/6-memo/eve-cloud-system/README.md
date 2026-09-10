# EVE cloud system implementation

**Current stabilization status (2026-09-10):** see
[completion report](stabilization-completion.md),
[orbital transition](orbital-transition.md), and
[terrain materials](procedural-terrain.md). The sections below retain the
historical batch sequence; their counts and open-work lists describe those
batches, not the current result.


Implementation worktree: `/Users/carlosgonzales/dev/docking-sim-eve-clouds`, branch
`codex/eve-cloud-system`. Rollback: `codex/renderer-pass06-checkpoint` at
`ffd53b55a4e9a7748720f9d01e5792ea7f97a5a2`. The imported checkout and its index
remain separate. Development server uses port **5174**.

The tested integrated development batch is also preserved at
`codex/eve-integrated-checkpoint`, parented to `codex/eve-phase1-checkpoint`.
This is a rollback snapshot, not whole-renderer acceptance.
The independent [incremental review](integrated-batch-review.txt) approved this
development batch after its three remaining Major findings were corrected.
The [formal review record](../../3-code-review/CR_wa_v0.12.0.md) limits that verdict
to implemented behavior; future plan phases and visual/performance acceptance
remain open.

## Verified Phase 1

The coherent Takram 0.7.6 fork has immutable media/lighting shader hooks. Its
48-file upstream inventory is verified against the pinned installed package;
local modifications and added files are hashed in the vendor manifest.
GPU execution exposed issues that a TypeScript build cannot detect: decorated
shader properties need assignment-style class fields, depth packing needs its
real enum value, cloud opacity must be `1 - T`, and the atmosphere compositor
requires a single-color target. These are fixed in the implementation fixture
and source boundary.

[GPU evidence](gpu-conformance-phase1.json) records 15 passing cases on Apple M3
WebGL2: empty/slab/overlap, real logarithmic terrain occlusion, shadow and secondary
optical depth, disjoint near/cache sunlight, invalid-cache and zero-budget
fallback, and atmosphere overlay composition. The latter uses identity clear-air
LUTs; it proves the composition ABI, not atmospheric model accuracy. Maximum
absolute error is under 0.000064 against a 0.001 tolerance.

Validation at this batch: `pnpm --filter @docking/web build` and all 304 web tests
in 36 files pass. Vite retains the existing large-bundle warning. These results
do not constitute whole-renderer acceptance.

## Performance remains open

The [timing evidence](evidence-profile/manifest.json) includes cold/warm ascent
and descent with clouds enabled and disabled. Instrumented runs show poor frame
rates, including roughly 11–13 FPS at a settled near-ground pose. At that pose,
terrain selection, reconciliation and worker builds stop after the new input
memoization and dirty-cover scheduling settle. This eliminates measured work but
does not solve the overall frame rate. CPU wall timings and GPU timings measure
different intervals and should not be added to claim a complete frame budget.

## Integrated development batch

`cloudSystem=eve` now renders the authored weather/type field with one shared
physical density evaluator, an atomic direct/ambient light volume, ground/water
lighting, near/far alternative ray integration, and depth-validated temporal
reconstruction. The normal library selector remains the reference renderer.
`fixture=clouds` is an isolated GPU test view: it intentionally hides Earth and
now displays that explanation and a **Return to flight** link. Keep automated
fixtures in a separate background tab so the visible flight view stays usable.

[Integrated GPU evidence](gpu-conformance-integrated.json) records **123 passing
cases**: 24 base/transport/far cases, 3 physical surface-lighting cases, 76 actual
temporal resolve cases, and 20 canonical-weather cases including the generated
raw assets. The web suite at this batch passed **396 tests in 43 files** and the
workspace build passed. A subsequent TypeScript check also passed. These
fixtures prove the tested shader calculations and resource interfaces; they do
not establish visual quality, hardware-wide support, or performance acceptance.

The latest [integrated regression evidence](gpu-conformance-final-batch.json)
records **210 passing GPU cases** after the review fixes: 60 base/transport/far
cases, 3 surface-lighting cases, 108 temporal cases and 39 weather cases. The
near/far depth attachment now follows each representation's opacity contribution;
local reference weather uses its own angular bounds and texture resolution for
physical-footprint filtering. At the reference latitude, a 20 km footprint needs
LOD 2.242 in the local map while the global map still uses LOD 0.
The final affected unit suite passes **103 tests in 7 files**, and the workspace
build passes (the existing bundle-size warning remains). These are the
current cloud suites; the earlier 396-test full-web result above belongs to its
recorded batch and is not presented as a fresh full-suite run.

The weather textures use 1,569,744 bytes including mipmaps. The medium light
volume uses two R16F arrays totaling 3,145,728 bytes. View/history allocation is
reported separately in the probe and remains bounded by the selected quality.
`history=off` disables reconstruction at the same output dimensions (subject to
the same quality pixel cap), rather than silently halving the reference image.
No claim that the unsmoothed mode meets a gameplay frame-rate target is made.

### Open visual and integration work

The initial 20 km approach was too hazy and lacked formation structure.
The problem persisted without temporal smoothing; see the saved
[native comparison](evidence-integrated/20000m-native-before-density.png) and
[capture context](evidence-integrated/20000m-native-before-density.json).
The [density diagnosis](density-diagnosis.md) measured 16–38% vertical opacity
at the reference centres and nearly unchanged occupied volume as coverage
varied. Coverage now selects spatial support using the measured raw-noise range;
per-profile extinction makes those same vertical columns 98.27%, 99.47%, and
99.85% opaque. The clear centre remains exactly empty. Scattering equals
extinction here, following the maintained backend's conservative visible-cloud
approximation; these are authored coefficients, not calibrated microphysics.

The [corrected native image](evidence-integrated/20000m-native-after-density.png)
shows distinct bodies and gaps, and [125 GPU cases pass](gpu-conformance-density.json).
This exposed a separate 4×4 reconstruction mosaic in the upscaled view. The
stationary resolver now preserves each unsampled pixel's matched color/depth
history until that pixel's own Bayer refresh. [149 GPU cases](gpu-conformance-reconstruction.json)
include two full settled cycles, changed media, cuts and recovery with real
ping-pong buffers. The [stationary capture](evidence-integrated/20000m-reconstructed.png)
shows the blocks removed, with visible noise still present.

Review also exposed the moving/cut fallback: one coarse ray was broadcast to all
16 output pixels. Unsampled pixels now interpolate premultiplied color and shafts
on the current jittered ray lattice, using opacity-weighted depth and motion;
fresh rays stay exact and incompatible history stays rejected. Additional GPU
cases test linear fields across every Bayer phase and clear-to-cloud edges with
invalid or moving history. These tests verify reconstruction behavior, not
fine-detail recovery or a finished moving-image quality target.
The aerial binding validator also now strips GLSL comments: parsing prose as a
uniform declaration had caused a reload crash during the density change. A test
using the real shared bindings covers that failure.

A recorded [30-second descent](evidence-integrated/descent-reconstruction.webm)
ran from the 400 km start to terrain clearance at 140 m MSL without reported
renderer/light-volume errors. Its [1 Hz samples](evidence-integrated/descent-reconstruction.json)
span 337,807 m to 140 m; this is smoke-test evidence, not frame-by-frame visual
or controlled performance acceptance. A separate clouds-off camera check moved
from resolved mountain terrain at 6,935 m to KSC at the requested 50 m, verifying
that a teleport clears the remembered local ground elevation.

The 3 km cloud entry, clear-gap terrain view, and orbital view have been inspected
but are not accepted. Do not promote this selector based on the passing GPU
suite. Concurrent browser views and compilation affect the exploratory frame
rates; they are not matched performance measurements.

Weather/time is intentionally static while the authored field is validated.
Independent overlapping layers, detiling/advection, shared atmospheric shafts,
PiP cloud integration, explicit whole-backend capability fallback, the complete
visual/performance/soak matrix, and final handoff remain open in the
[approved plan](../../1-plans/F_0.12.0_eve-cloud-system.plan.md). The current far
alternative uses 24/32 samples through the curved cloud support in the same
material, blends alternative radiance/transmittance once, and skips the unused
schedule at either endpoint. It is not yet the planned prepared distant layer;
its grazing-angle quality and cost must determine the next refinement.

Research and agent reports in this directory are working evidence, not accepted
claims unless verified above. No merge, release or default promotion is implied.
