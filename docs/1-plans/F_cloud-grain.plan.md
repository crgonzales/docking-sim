# Cloud base grain repair

Follow a85d669 on codex/flight-visual-pass. User reports persistent stipple at cloud undersides in paused flight at 2830 m and while moving. Preserve one game tab on 5175 and medium/DPR1 rendering; do not change character checkout or source indexes. No release/merge/push.

## Work

- [x] Add a bounded development reproduction/evidence control for the captured flight state (91.92s, 2830m, bank -29.9deg). Reuse the existing opt-in flightProbe panel and evidence endpoint. Capture after composer rendering; include physical state, camera and library status. Provide a paused named cloud-base fixture selected only with DEV flightProbe and flightFixture=cloud-base. Default flight stays unchanged. Remove the temporary always-DEV Flight snapshot details after capture tooling works. Parent has the captured state in .evidence.local/cloud-grain-flight-state.json.
- [x] Diagnose noise at the actual captured view with controlled sampling comparisons, then repair the confirmed source while preserving clear gaps, disocclusion rejection, physical cloud lighting, shape and bounded GPU cost.
- [x] Validate paused convergence, real moving flight, lower cloud view and orbit. Record screenshots and cost/limitations. Add a meaningful GPU/behavior regression for the discovered mechanism. Full build, affected tests and independent review; save development checkpoint.

## Acceptance

The reported cloud-base stipple is visibly reduced at the same pose without a global blur or loss of orbital cloud shape. Moving and paused comparisons must exercise the real renderer. Do not claim all grain gone based only on synthetic tests.

## Confirmed diagnosis and final sampling scope

Baseline capture flight-cloud-base-1789088224638: historyReset=[] but persistent cloud-base grain. Primary midpoint alone replaced grain with horizontal bands. Replacing the equal-share budget floor (full remaining path / remaining samples) with a geometric reserve floor removed most bands, and restoring original random primary sampling retained the improvement. Equal-share allocation started long grazing rays with kilometre-size segments even near the camera. Keep full suffix coverage, reference midpoint behavior, distant uniform scheduling and iteration caps.

Final shader work: factor a small tested GLSL budget helper, use geometric reserve weights with ratio sqrt(max(perspectiveStepScale,1)), falling back to uniform in the limit ratio=1. Do not increase ray or step counts. Preserve the tested ~1.02 ratio for EVE's 1.04 perspective growth. Fix blue-noise/Bayer alias separately: fresh rays at a given final pixel arrive once per16 frames; index the STBN temporal axis by completed Bayer cycles and its spatial axis by the actual jittered final pixel. Native and shadow callers retain their per-frame sequence. Do not loosen clear/depth history guards or change density/lighting functions. Verify paused resize restarts the existing finite warmup budget.
