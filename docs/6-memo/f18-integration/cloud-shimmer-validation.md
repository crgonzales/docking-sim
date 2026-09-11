# Cloud shimmer — 2026-09-11

Follow-up to `f93b072`, integrated checkout on port 5175. One game tab only.

## Diagnosis and change

The reported ground view showed fine grain when paused and coarser sparkling
edges with realtime wind, even with a stationary camera. The primary raymarch
started at 80 m but accelerated through empty space toward an 800 m step.
It continued increasing its step inside occupied media. A single jittered
density sample represented each entire segment; narrow soft cloud edges could
therefore alternate between being missed and overrepresented.

A matched-camera negative control reproduced the grain by restoring only the
800 m cap. Restoring 160 m reduced it without changing density, lighting,
temporal depth rejection, wind reprojection, or adding a blur pass. History
rejection amplifies stochastic depth differences during movement, but weakening
the existing disocclusion guards was unnecessary for this fix.

`cloudViewSampling` shares the production view settings with the GPU oracle.
Medium now prefers at most 160 m per segment; Low prefers 320 m. Both retain
their original 80 m starting step, growth factor and 192/128 iteration budgets.
These are preferred caps: the existing budget floor can exceed them to finish
long grazing rays. The orbital column representation, light cache, ray lattice,
render targets and memory limits are unchanged. More density evaluations can
occur before a near ray finishes or reaches opaque cloud, so GPU cost is
view-dependent despite the unchanged maximum iteration count.
The stationary resolve retains its prior 800 m uncertainty allowance independently
of the new preferred spacing, since the remaining-ray budget can exceed that spacing.

## Matched ground evidence

Local ignored artifacts under `.evidence.local/`:

- Old 800 m control: `flight-base-1789112298605`.
- Corrected 160 m sampling: `flight-base-1789112336552`.

JSON confirms exactly equal camera, character, aircraft, environment clock,
and drawing-buffer dimensions. Both are High at 10:05:08 local solar time.
Each comparison was allowed to settle through the existing paused warmup.
The early unpaused High 160 m sample recorded 1297 frames / 37.2448 s =
34.82 FPS (`1789112002891` → `1789112040136`). This is one view, not a broad
performance guarantee or a controlled before/after speedup claim.

Final Balanced sampling at this ground pose recorded 2011 frames / 45.0458 s =
44.64 FPS (`1789112376867` → `1789112421912`), with continuous 1x weather,
981×1115 drawing pixels and no competing build/test job. The matched images
precede restoring the original 800 m stationary allowance; live moving-weather
measurements are unaffected because that allowance is disabled during motion.

Additional views: original cloud-base flight at 2830 m
(`flight-cloud-base-1789112531153`), completed banked turn at 1368 m
(`flight-cloud-base-1789112565974`), and SceneRoot views at 20, 70 and 400 km.
The separate dynamic-weather flight check hit the existing Mach 0.95 envelope
after 8.3 seconds; it was not a sustained-flight performance measurement.

## Limits

This is reduced quadrature noise, not full-resolution cloud rendering. Fast
camera movement can still look softer while temporal reconstruction catches up.
Thin distant features and long grazing rays remain budget-limited. Cloud
sampling improvements do not change the authored cloud shapes or turn the
procedural weather into a meteorological simulation.

## Final validation

Full workspace build and 55 affected tests pass (sampling, temporal-state and
weather-motion suites). All 781 GPU conformance cases pass, including the
existing motion/disocclusion/clear-gap cases. The new production-march oracle
measures a Gaussian cloud of known opacity after 10 km of empty space over
64 jitter phases. Opacity RMS error: old 800 m = 0.187210; Low = 0.007556;
Medium = 0.00000577. These are synthetic integration errors, not percentages
of visible shimmer removed. The retained thin-near-cloud/400 km grazing-ray
oracle measures RMS 0.002034 and complete path coverage within the same budget.

The full GPU report is saved in
`.evidence.local/capture-eve-medium-full-1789112747506.json` (last sample's
`conformance` field). No console errors were observed after the visual checks.

Independent Codex CLI review returned APPROVED with no findings, thread
`01a08f6e-5b98-7b03-b5b7-3a7f260e597f`; see
`docs/3-code-review/CR_wa_cloud-shimmer.md`. The ordinary game URL is restored
on port 5175, paused at the runway on High, with one tab open. Temporary
capture visibility and the old-sampling override were removed.
