# Flight stress pass after 8728d77

## Confirmed fixes

The vertical seam under the aircraft was water reflection banding. It survived disabling cloud shadows and disappeared with water reflections disabled. The normal render target is RGBA8; smooth ocean curvature crosses its quantization steps. Feeding those steps into Fresnel/GGX and the reflected-sky direction amplifies them into visible lines. The statistical ocean now derives its reflection normal analytically from the spherical surface position. Incident sun/sky lighting uses the same precise spherical direction for ocean, with a continuous geographic coverage blend at shores and the original terrain normal on dry land. This changes neither cloud density nor buffer resolution/memory. Land normals and the geographic water mask remain intact.

Evidence (ignored local artifacts in `.evidence.local`): original shadows-off `capture-eve-medium-full-1789085716573.png`; corrected shadows-off `capture-eve-medium-full-1789087140747.png`; `water-seam-before-after.jpg` compares the same crop. `flight-stress-gpu-conformance.json` records 370 passing actual GPU cases, including a packed-normal negative control that reproduces the reflection discontinuity and the corrected shader retaining a nonzero sun glint.

Ordinary flight contact/envelope termination now also pauses rendering, so the stopped simulation can settle its temporal buffers and sleep. The exercise implementation review also restored the existing partial-tick discard invariant on pause/focus loss.

## Repeatable flight tests

Development-only `?mode=flight&flightProbe=1` exposes bounded exercises driven through the same 100 Hz flight dynamics. Start explicitly resets to the airborne trim. The short bank/climb/descent poses supplement a 75 s climb from 1500 m to about 3238 m and a 50 s descent to about 297 m. Completion or Stop pauses; physical controls, sliders, pause, reset and focus loss cancel scripted ownership. Camera switching is allowed during an exercise. Normal game UI is unchanged without the opt-in query.

Browser checks: 107-degree bank in both CHASE and NOSE, short nose-up climb, a completed 75 s climb to 3238 m, and a completed 50 s descent to 297 m with both camera views inspected. No browser console errors were reported. Reflection stays continuous as the camera changes. Close clouds still show coarse grain in medium quality, particularly while moving; this pass does not claim to resolve that sampling limitation. The NOSE view is still a camera view without a modeled cockpit. No extra browser tabs were opened.

Gate: full workspace build passed; 62 affected tests passed, including 14 new behavioral exercise tests. Actual 370 GPU checks passed. Final low-altitude browser check passed. After the 17:34 incident-lighting follow-up, the affected 17 water/aerial tests passed again (`/private/tmp/flight-stress-water-final-tests.log`), the web build passed again (`/private/tmp/flight-stress-water-final-build.log`), and all 370 GPU cases passed again in final capture `1789087140747`. Full-workspace build and the 62-test gate precede only that shader follow-up; unchanged flight/core code retains their coverage. Independent review round 1 found no functional defect but requested this refreshed gate record; final independent review APPROVED with no new findings. See `flight-stress-review.md` for the review record.

First-person character development is isolated on `codex/first-person-character` in `/Users/carlosgonzales/dev/docking-sim-character`, based on 8728d77. Its FlightMode/session integration must be reconciled with this pass before adoption; it is not silently integrated here.
