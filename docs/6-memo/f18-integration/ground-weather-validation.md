# Ground and volumetric weather validation

Verified local checkpoint on `ground-weather-cycle`, based on `56be888`. Consolidated review: [CR_wa_v0.10.0.md](../../3-code-review/CR_wa_v0.10.0.md). One in-app game tab on port 5175; Apple M3. No changes to the source checkout or shared asset symlinks.

## Confirmed

- Shared environment time defaults to 1x and 10:00 at the reference meridian. It advances independently of parked aircraft dynamics, wraps its displayed day while preserving continuous weather time, and freezes on pause/focus loss.
- Keyboard/HUD resets restore configured environment start time. Preview speed scales environment only. Manual time entry now handles the native input event; typing 15:00 was verified to update the header and rendered weather.
- Ground material variation uses filtered site-local coordinates without changing collision geometry. One 1024-square local shadow map renders 31 visible potential casters in the baseline view; the actual aircraft shadow is visible beneath its wheels.
- Sun color for local PBR materials borrows the existing atmosphere transmittance LUT through the library helper. No extra LUT loading.
- Weather motion uses inverse ECEF north-axis rotation for the weather maps and both noise domains. Seeded fronts are continuous 3D functions restricted to the sphere, including the longitude seam/poles. Empty authored coverage stays empty.
- Corrected review bugs: scaled-delta cap depended on FPS; reset ignored constructor start; keyboard/character resets skipped the environment; time input changed without committing; local UI overlapped controls; original front function had longitude/pole seams; paused media retained its last nonzero velocity; cloud-front motion rotated altitude correction.

## Captured frames

- `flight-base-1789098384256.png/.json`: 12.00000 local solar hours, paused=True, cloud renderer=ready.
- `flight-base-1789098922250.png/.json`: 10.01106 local solar hours, paused=True, cloud renderer=ready.
- `flight-base-1789099018117.png/.json`: 15.00000 local solar hours, paused=True, cloud renderer=ready.
- `flight-base-1789099165847.png/.json`: 15.01180 local solar hours, paused=False, cloud renderer=ready.
- `flight-base-1789100376080.png/.json`: 18:00 sunset, paused, renderer ready.
- `flight-base-1789100483761.png/.json`: 22:00 night, paused, renderer ready.

## Performance sample

At 981 x 1115, medium quality, DPR 1, the stationary camera with moving afternoon weather completed 1409 composer frames in 42.2311 s (33.36 FPS). Composer CPU average 9.3448 ms, max 49.1 ms. This is one warm 42-second sample, not a sustained-travel or all-weather benchmark. GPU timings are asynchronous per-pass samples and must not be summed as a frame time.

Cloud atlas: 22,369,624 bytes, all 1024 rows ready, zero GPU rebuild time throughout the sample. Light volume: 3,145,728 bytes, 2-second refresh cadence; generation 41 valid at age 2.1098 s while the next generation had 38 pending slices. View buffers: 22,974,444 bytes. No temporal history reset in the ending snapshot.

## Completed validation

- Full web suite: 64 files, 591 tests passed. The initial advection witness was moved from empty reference coverage to a covered zone; the nonempty-density assertion remains. Final log: `/private/tmp/ground-weather-web-tests-final.log`.
- Actual GPU conformance: **649 / 649 passed**, including existing renderer cases and new canonical weather-map/noise advection, CPU parity, seam/pole continuity, stationary moving-cloud history, paused zero velocity, and physical cloud-front reprojection with nonzero altitude correction. Full report: [ground-weather-gpu-conformance.json](ground-weather-gpu-conformance.json). Source evidence: `.evidence.local/capture-eve-medium-full-1789099681866.json/.png`.
- A new GPU sensitivity witness initially sampled only fully clear/solid plateaus; the fixture now selects a coverage shoulder and retains the positive sensitivity requirement for both real 3D noise textures. No production behavior was changed to satisfy the witness.
- Complete workspace build passed (sim-core, scenario, web; existing bundle-size warning only). Log: `/private/tmp/ground-weather-workspace-build-final.log`.
- Static cloud-base fixture rendered at its captured 2830 m / 91.9 s pose with dynamic environment disabled. Evidence: `.evidence.local/flight-cloud-base-1789099333760.json/.png`.
- Orbital regression at 400 km rendered terrain, clouds and atmospheric limb with legacy static weather. One UI sample was about 54 FPS, not a matched ground benchmark.
- Actual UI 60x preview advanced from 10:04 to 10:31 while the aircraft stayed parked. Paused evidence: `.evidence.local/flight-base-1789100080438.json/.png` (environment time 37900.6097 s, speed 60, no discontinuity). Restored default 10:00 and 1x afterward.
- Ground views inspected at dawn, morning, noon, afternoon, sunset and night. Expanded control panel fits without overlap or overflowing labels. Manual native time input commits on input.
- Independent review found the DEV exercise reset bypass and stale light-cache diagnostic state. Both are corrected. The affected reset/input/character/exercise suite passes all 63 tests; reset coverage includes flight-only, airborne character and ground character routes, single notifications, exercise start, and unsubscribe. Log: `/private/tmp/ground-weather-review-fix-tests.log`.
- Post-review web build is also green: `/private/tmp/ground-weather-review-fix-build.log`.
- The 60x preview capture exposed a stalled paused light cache (age 99.66 s, no pending slices). The scheduler now requests the final stopped weather time once during paused settling. Browser recheck passed: `.evidence.local/flight-base-1789100547143.json/.png` is paused at 15:27:55 (60x), light generation 16 ready/valid, age 0, no pending slices, atlas still ready with all 1024 rows, no history reset. Repeated capture `flight-base-1789100598613.json/.png` retained exactly the same time and light generation, proving the paused request is bounded. Final web build passed: `/private/tmp/ground-weather-paused-cache-build.log`.
- Independent review approved the final code in round 3; its verbatim rounds are kept in [ground-weather-code-review.md](ground-weather-code-review.md).

- Final normal game route is left paused at 10:00, speed 1x, in the same single tab. No errors were recorded after that final reload; earlier intermediate edit/HMR errors remain in the tab log.

## Limits

- Equinox solar model with reference solar time, not a date-specific ephemeris.
- Wind-driven procedural cloud weather; no precipitation or full meteorological dynamics.
- Night sky has no new stars/city-light implementation. Local runway lights are emissive, not additional point-light shadow maps.
- Cloud grain and mesh edge aliasing remain visible at medium quality; these are not declared solved by the ground/weather change.
- Aircraft/base use local PBR shading. Full spatial cloud-shadow attenuation on those excluded PBR receivers remains a separate limitation; existing terrain/ocean cloud receivers retain their canonical cloud lighting.
- Parked aircraft is still a parked presentation, with no new takeoff/ground-roll solver.
