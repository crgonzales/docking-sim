# Renderer stabilization — 2026-09-10

Work is being completed in the isolated EVE checkout, not handed back to another
workflow. This report covers the ten-item paused backlog. It does not mark the
entire v0.12 plan released or promote the development renderer to the root URL.

## Backlog results

| Item | Result |
| --- | --- |
| Build error | Removed the duplicate terrain uniform declaration. Full workspace build passes. |
| Ground artifacts | Replaced unstable screen derivatives of sampled heights with baked spatial slopes; retained double-precision patch phase reduction. Verified the reported Canadian views and daylight mountains, plus GPU checks at sub-centimetre footprints and shared patch phases. |
| Terrain appearance | Added coherent material color/normal detail, shared geographic water classification and bounded imagery calibration. Raised the already budgeted geometry depth ceiling from 10 to 16, resolving more existing height detail locally. |
| Cloud transitions | Global weather remains world-fixed; the authored reference region is opt-in. Prepared orbital columns and nearby volumes blend once across 50–120 km. Limb, far crossing and restored-context cases pass. |
| Lighting | Globe and terrain share material calibration and coast classification. Fixed a further shadow bug: filtering noise before the cloud threshold erased extinction. The light cache now averages transmitted light from four canonical subrays. |
| Performance | Measured single-tab frame times and render-resource stability during altitude travel and regional changes. Details and limits below; final shadow-cost comparison is recorded separately. |
| Validation | Full web suite 454/454; unchanged sim-core 105/105 and scenario 14/14 passed in the earlier workspace run. After the final shadow change: 47 affected tests, 353/353 actual GPU cases, and full workspace build pass. |
| Checkpoint | Final snapshot is saved under `codex/render-stabilization-2026-09-10`, using a temporary index so the ordinary staging state is preserved. |
| F/A-18 | Independent review found three input/trim issues, now fixed with 37 focused tests and both package typechecks passing. Saved separately at `codex/f18-reviewed-checkpoint-2026-09-10` (`753b609d596726c01b9d37852c5623efe0ca11e3`). No integration. |
| Browser / agents | Stale-tab cleanup confirmed. Testing reused one game tab on port 5174. Review helpers are closed when finished; port 5173 remains reserved. |

## What the verification establishes

The Canadian cold URL at 46.472°, −73.6077°, 459 m MSL now settles at 459 m,
instead of remaining lifted by the first coarse terrain estimate. Only an
untouched explicit teleport may undo its own temporary lift. Normal movement,
external camera commands and mode changes cancel that correction. The normal
upward ground clamp remains active. The 615 m view and a daylight Rockies view
at 2767 m showed no earlier dotted/speckled normal artifacts.

The terrain selector still reserves complete siblings and ancestors within 300
records. Observed deepest selected levels were 13 in the Rockies at 2767 m MSL,
15 at the Canadian 459 m site, and 16 at KSC at 5 m. Approximate local vertex
spacing was 38 m, 10 m and 5 m respectively, compared with roughly 300 m at the
old depth ceiling. These are local maxima under a fixed budget. Neither the
source DEM nor the geographic imagery was replaced.

The 353 GPU checks include production cloud transport, temporal reconstruction,
column opacity, limb/occlusion, context restoration and terrain color/normal
output. The six final light-cache regressions use a thresholded half-space and
an independent curved-shell Beer oracle: a half-cloudy cell transmits about
0.68394 of direct light and 0.61003 of the sampled ambient light. The former
prefilter-before-threshold path incorrectly transmits 1. The regression reads
stored GPU texels, so consumer interpolation cannot hide a broken producer.

Independent review approved the material/coast changes and the subsequent
camera/LOD fixes. The final light-cache delta also received **APPROVED** in convergence
review; its result is saved in `evidence-stabilization/independent-review-final.txt`.

## Measurements and scope

Hardware: Apple M3, ANGLE Metal WebGL2, one visible game tab, DPR 1, measured
drawing buffer 981×1043. No second game instance, video recorder or test runner
was active during the final clean flight measurements. GPU timer queries were
supported. Profile mode itself adds measurement overhead.

The terrain/camera resource run covered 340.1 seconds, including descent from
orbit, low-altitude Canada, the reference region, Formation and KSC. Textures
stayed at 34; terrain residency never exceeded 298; no renderer errors were
reported. Normal-rendering intervals had median 60 FPS, minimum 58.1 FPS, and
median interval p95 18.5 ms. The worst one-second interval p95 was 43.3 ms during
travel/loading. Shadow-diagnostic intervals are excluded from those frame-rate
statistics. This run predates the final light filtering correction; its final
movement comparison is saved separately. Render-resource counts establish a
bounded observed plateau, not a complete JavaScript-heap leak proof.

The earlier recorded 30-second descent and contact sheet show the prior
orbit-to-ground transition without a full-white flash in the captured frames.
That recording predates final material/camera/shadow changes and ran at a lower
encoded frame rate; it is historical visual evidence, not a 60 Hz benchmark.
Final captures and non-recorded travel measurements are labeled separately.

The final shadow-corrected descent and warmed ascent are retained separately in
`evidence-stabilization/performance-summary.json`. The first descent had loading
hitches: median 60 FPS, minimum one-second FPS 12.7, and worst interval p95
181 ms. Its largest light-cache GPU query was 56.34 ms while terrain was also
loading. The warmed ascent plus subsequent free-camera travel had median 60 FPS,
minimum 58.9 FPS, median interval p95 17.7 ms and worst interval p95 20.8 ms; its
maximum light-cache query was 15.89 ms. Textures remained at 34 on the return,
terrain never exceeded 298 records, and neither run reported renderer errors.
These results close the measured cost check while retaining the first-load
hitch as a known limitation, rather than hiding it behind settled averages.

## Remaining quality limits, rather than hidden completion claims

- The packaged day map is only 4096×2048, water/specular mask 2k, and geographic
  DEM much coarser than the new local mesh. Close imagery remains blurry, and
  fine shoreline shape cannot be recovered from those assets. Material detail
  is plausible and deterministic, not surveyed land cover.
- The shared imagery-to-reflectance adjustment is artistic calibration, not
  measured Earth albedo. Atmospheric scattering, sunlight and exposure were
  not retuned to conceal the material bug.
- Cached cloud shadows remain broad: medium-quality light texels cover roughly
  9.85 km at 3 km altitude and 14.71 km at 20 km. The filtering fix restores
  extinction; it does not provide crisp shadows for every small puff.
- Clouds currently sample one-quarter width and height per frame and reconstruct
  detail from history. Camera motion rejects incompatible history and exposes
  softer spatial reconstruction until fresh samples accumulate. Increasing
  fresh sampling during movement is a separate quality/performance tradeoff;
  this stabilization has not claimed to eliminate that softness.
- The M3 measurements do not establish performance on weaker hardware. Loading,
  camera cuts and fast travel can still hitch; settled 60 FPS is not a promise
  for every frame or viewport.
- F/A-18 coefficients, stall continuation and thrust lapse remain approximate.
  Its isolated prototype has an airborne start and a 50 km / 20 km / Mach 0.95
  envelope. Surface contact is terminal; landing physics is not implemented.
- Broader v0.12 work such as weather advection, shared atmospheric shafts, PiP
  integration and default-renderer promotion is outside this stabilization
  backlog and has not been marked complete.

## Reproduce / rollback

Use the existing server on port 5174 from
`/Users/carlosgonzales/dev/docking-sim-eve-clouds`. Normal global weather:

`?renderer=library&cloudSystem=eve&quality=medium&dpr=1&flyto=40.5,-75,20000&pitch=-20&yaw=90`

Add `probe=1&profile=1` for measurements. `weatherRegion=reference` is an
explicit authored-cloud test field, not the normal global weather mode. Reuse
the existing browser tab when checking other elevations.

The imported `/Users/carlosgonzales/dev/docking-sim` checkout and its staged
index remain separate and preserved. The pre-transition snapshot is
`codex/eve-pre-orbit-transition` at `153957bd9861ee27cd1604370683d7e6f5f31388`;
it retains the known old orbital/reference-region defects. Final checkpoints
use separate refs and do not reset, merge, push or replace either working tree.
