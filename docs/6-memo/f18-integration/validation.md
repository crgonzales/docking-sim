# F/A-18 / EVE integration validation — 2026-09-10

Current checkout: `docking-sim-flight-integrated`, branch `f18-eve-integration`, based on renderer checkpoint `e2f0977`. The reviewed F18 source snapshot is `753b609d`; only its flight delta was imported. Port 5175 serves this integration, and 5173 is reserved for another app.

## Implemented

- Explicit library atmosphere, EVE clouds and shadows, opaque Earth/terrain in FLIGHT, regardless of plain/query mode entry. One composer, one flight camera and floating origin.
- KSP primary controls: W/S pitch down/up, A/D yaw left/right, Q/E roll left/right, Shift/Ctrl throttle up/down. Both modifier sides work and Ctrl allows simultaneous steering; unrelated modifier shortcuts and focused form navigation stay native.
- Licensed textured Hornet, source preserved with attribution in `apps/web/public/assets/ASSETS.md`. Runtime length 17.06 m, source axes converted to body forward/right/down, clean airborne configuration. Original procedural aircraft is the loading/error fallback.
- Pause/blur clear controls and accumulated physics time. Paused Canvas renders on demand. Discrete P/R/C commands request a UI update independently of animation frames; asynchronous atmosphere loading invalidates the paused view.

## Automated checks

- Full sim-core public API/regression suite: **123 tests, 20 files passed**. No flight physics changes were made after this run.
- Final affected web tests: **65 tests, 7 files passed** — input (19), session (10), frame (2), terrain coverage/explicit rendering overrides (12), surface normals (12), water lighting (7), lighting mask (3).
- Workspace build passed after environment integration. Final web typecheck and production build passed after the GLB, KSP input and paused-render changes. Existing large shared-bundle warning remains.
- Final flight chunk: 94.36 kB / 29.47 kB gzip, plus the separate 4,756,768-byte GLB. Triangle count is 9,935; this is not a measured draw-call or frame-rate claim.
- Whitespace/diff check passed. Original checkout index SHA-256 remains `867112dd9ef10bc8e90f87b7838bb9d227df23322e958e60b197b192d7435d82`.

Logs retained locally: `/private/tmp/docking-f18-integration-core-tests.log`, `/private/tmp/docking-f18-integration-build.log`, `/private/tmp/docking-f18-final-web-tests.log`, `/private/tmp/docking-f18-final-lighting-tests.log`, `/private/tmp/docking-f18-final-web-build.log`.

## Browser evidence and limits

One game tab was used at a time. Actual screenshots showed the textured, correctly oriented aircraft with cloud volume, atmospheric horizon and ocean lighting. Chase/nose switching and FLIGHT → ANALYSIS → FLIGHT were inspected before the final on-demand pause changes; the nose view hides the aircraft. No shader/application errors were observed in that pass. The final launch on `?mode=flight` showed the expected HUD and initial state.

Final browser checks passed through the browser tab interface after native control reported the Mac locked: P paused and resumed, C changed the actual camera image while paused, ANALYSIS unloaded the flight view, and returning to FLIGHT reloaded the textured model and EVE environment without console errors. The paused camera check initially caught a stale-image bug; an explicit camera-change invalidation fixed it, verified with new screenshots. The final scene was left paused in a single game tab. Automated tests additionally verify the actual key-handler/control/physics path and the paused-command update signal. No sustained real-key hold or frame-rate benchmark is claimed from these browser taps.

Independent review: **APPROVED, no findings**. See [the review record](code-review.md). All integration changes are saved in the development checkpoint on `f18-eve-integration`; no merge, push or release was performed.

## Deliberate limits

The aerodynamic coefficients remain an engineering approximation, not validated F/A-18C data. The physics chart is bounded to equatorial ocean (50 km radius, 20 km altitude, Mach 0.95). Sea contact stops flight; this is not landing gear or terrain collision. The imported visual model's control surfaces are static, with no cockpit or weapon system. EVE shadows apply to the environment; aircraft uses separate sun/sky material lighting. No new performance benchmark or 60 fps claim is made.
