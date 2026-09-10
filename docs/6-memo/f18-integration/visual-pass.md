# Flight visual pass — 2026-09-10

Branch `codex/flight-visual-pass`, based on integration checkpoint `a6964c2`. One live game on port 5175; original checkouts preserved. Development checkpoint only, no release or push.

## Fixes

**Ocean cloud-shadow pattern.** The default ocean flight view had stippled bands and rectangular shadow patches. The same view at `flyto=0,0,1500&pitch=-15&yaw=0` became smooth with shadows off, isolating the shadow path. Ocean triangles and Earth-scale reconstruction can produce positions below the geoid; the light-volume cache starts at zero metres. Ambient queries switched to a different fallback on those pixels.

The shared opaque-water metadata is now available before shadow queries. Ocean shadow receivers use the physical geoid plus a 2 m precision margin. Actual depth, atmosphere, water BRDF positions and dry land remain unchanged. Fractional coast pixels blend visibility estimates rather than interpolate a receiver through the hard cache boundary. Only mixed coastal pixels require extra queries. No cloud density, quality or cache resolution was changed. Same-view screenshots confirmed the pattern disappeared with shadows enabled.

**Flight instrument contrast.** Numeric flight instruments have a dark backing because bright water reflection obscured their values. Readability verified in the actual Hornet chase and nose views.

**Paused camera cloud settling.** One demand-rendered frame froze noisy clouds after changing cameras. A bounded ref counter now requests successive redraws while flight physics remains paused. It waits for `libraryStatus.state === ready`; the existing asset-completion invalidation starts it. The 96-frame budget allows medium's column cache (1024 rows / 16 per frame = 64 frames), including its shorter light-volume build, followed by two 16-frame Bayer cycles. It then sleeps. There are no timers or a continuously running paused renderer. A ref is used because unrelated R3F updates can replace a bulk invalidate(n) request. The initial 32-frame attempt left too few fresh samples after cache publication on a new load; the final budget covers that dependency.

## Visual evidence

Evidence is local in `.evidence.local/` in this checkout. Captures have adjacent JSON pose/settings records.

- Before ocean, shadows on: `capture-eve-medium-full-1789082345835.png`.
- Control, shadows off: `capture-eve-medium-full-1789082387243.png`.
- After ocean, shadows on: `capture-eve-medium-full-1789083074582.png`.
- Comparison of the actual captures: `ocean-before-after.jpg`.
- Initial continuous 30 s reference descent, 400 km to surface: `descent-1789082434961.webm` and `descent-frames/contact.jpg`.
- Final descent after ocean/coast fix: `descent-1789083346364.webm`, `final-descent-frames/contact-1.jpg` and `contact-2.jpg`. Inspected 30 timepoints across orbit, the atmospheric transition, clouds and ground. Ground collision correctly stopped at about 140 m MSL over local terrain rather than the requested 50 m MSL.
- No full-screen black/white flash observed. A brightness scan covered 1326 recorded frames; largest successive mean-luma step was 3.694/255. This is a diagnostic for large full-screen flashes, not a complete perceptual oracle. Pose samples had no renderer errors. Recording overhead is not a frame-rate benchmark.
- Canada ground report at 46.472,-73.6077,459 m MSL: `capture-eve-medium-full-1789082879527.png`; no earlier speckling observed. A climb to 3 km through clouds, Florida low/wide coast views, and a night ocean view were also inspected. Night ocean looking down is black without incident sunlight; no exposure lift was added.
- Paused camera checks: NOSE–CHASE–NOSE changed the actual view and settled while the clock stayed at 30.4 s. Fresh-load pauses were also tested at 0.0–0.1 s. The final game is left paused in CHASE.

## Validation

- Full web suite: **487 tests / 51 files pass**. After final ocean/coast changes, affected aerial/water tests: **17/17 pass**. After paused-camera changes, flight session/input/frame tests: **31/31 pass**.
- GPU report: `flight-visual-gpu-conformance.json`, **367/367 pass**. Fourteen new cases exercise the actual aerial shader with logarithmic depth, material alpha and lighting mask, cache/fallback sentinels, sea-level offsets, dry land below sea level, coast fractions, shadow strength, and a negative control bypassing only the correction. No duplicate receiver math serves as the oracle.
- Web and full workspace builds passed; the final repeat and review verdict are in the review note. Logs: `/private/tmp/flight-visual-workspace-build-final.log`, `/private/tmp/flight-visual-flight-tests-final.log`.
- A transient shader-bridge exception occurred during the implementation agent's two-file hot reload and cleared once both files loaded. No new errors occurred in the final navigations. This was an editing-time mismatch, not a failure in the final build.
- Original checkout index SHA256 stayed `867112dd9ef10bc8e90f87b7838bb9d227df23322e958e60b197b192d7435d82`. No unrelated browser tabs or apps were changed. The unmarked temporary failed-load error tab is eligible for automatic turn-end cleanup.

## Limits

Near-ground imagery remains coarse, and temporal cloud reconstruction remains softer in motion at medium quality/DPR 1. This pass fixes reproduced rendering defects; it does not add terrain assets or change the cloud reconstruction architecture. Flight-model bounds and static model control surfaces remain as documented in `validation.md`. Screenshots and the tested routes are evidence for those views, not a claim that every possible location is artifact-free.

Independent review: **APPROVED**, all findings addressed; see [review record](visual-pass-review.md). The completed development checkpoint is saved on `codex/flight-visual-pass`. No release, merge or push was performed.
