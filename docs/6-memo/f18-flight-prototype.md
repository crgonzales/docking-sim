# F/A-18 flight mode guide

Date: 2026-09-10. This guide describes the integrated FLIGHT mode in the
`docking-sim-flight-integrated` checkout. It combines the reviewed prototype with the stabilized renderer. No deployment, merge or release operation is part of this guide.

## What is playable

Select **FLIGHT** in the existing application. It starts a Hornet-style aircraft at 1,500 m MSL, 180 m/s true airspeed, heading north over the equatorial ocean. It starts at a solved wings-level equilibrium with about 17% throttle and 3.9% pitch trim. The default aircraft is the acquired, painted McDonnell Douglas F/A-18C GLB; the original procedural Hornet remains the loading/error fallback. The adapter uses a clean airborne configuration with gear, doors, hook, pylons and tank hidden. No weapon geometry or combat features are added, and no cockpit fidelity claim is made.

The mode owns a separate simulation session, camera, input, HUD and floating
origin; switching away disposes its listeners and Canvas. Its scene explicitly
uses the stabilized library atmosphere, EVE clouds/shadows and opaque terrain,
with one final `LibraryEffects` composer. Orbital emitter/manual controls/audio
run only in SANDBOX/MISSION as before. Leaving and reentering FLIGHT creates a
fresh flight. No settings or session persistence.

```bash
cd /Users/carlosgonzales/dev/docking-sim-flight-integrated
pnpm install --frozen-lockfile
pnpm --filter @docking/web exec vite --host 127.0.0.1 --port 5175 --strictPort
```

Open [the integrated flight mode](http://127.0.0.1:5175/?mode=flight). A page
without `mode=flight` still defaults to SANDBOX, and FLIGHT does not require
`renderer=library` or `cloudSystem=eve` in the URL. Plain FLIGHT defaults are
medium EVE quality, exposure 2 and DPR 1; the existing diagnostic `quality`,
`dpr`, `exposure` and `clouds=0` overrides remain available. Earth and EVE
assets can take time to load; the aircraft/HUD and blue fallback remain usable
while they do.

| Control | Action |
| --- | --- |
| S / W or arrow down / up | Nose up / down |
| Q / E or left / right arrows | Roll left / right |
| A / D | Yaw left / right |
| Shift / Ctrl | Increase / decrease throttle; last setting holds |
| ] / [ | Increase / decrease nose-up pitch trim; last setting holds |
| P | Pause/resume; clears held controls and catch-up time; paused rendering runs on demand |
| R | Reset airborne, calm wind, solved trim; resume |
| C | Chase / nose camera; nose view hides mesh |
| Pointer | Hold on-screen pitch/roll/yaw buttons; throttle slider; pause/reset/camera buttons |
| Wind selector | Calm or a 10 m/s wind toward east (an abrupt wind step, not turbulence) |
| Window blur / hidden tab | Pause and clear held controls; explicitly resume with P/button |

HUD: true and ground speed in knots, Mach, MSL altitude in feet, vertical speed in ft/min, heading, pitch/bank, angle of attack, sideslip, body normal specific-force load, thrust, throttle and trim. These are exact model-derived instruments, with no sensor error or navigation filter. The attitude indicator is a basic visual reference; it is not flight-rated avionics.

## Provenance and model choice

- [JSBSim official project](https://github.com/JSBSim-Team/jsbsim) and [manual](https://jsbsim-team.github.io/jsbsim-reference-manual/) establish a configurable C++ nonlinear 6DOF solver with XML aircraft/engine/system data, under LGPL. Its integration model is a strong follow-up to this prototype. No JSBSim code or aircraft coefficients are copied into this slice.
- [JSBSim frame documentation](https://jsbsim-team.github.io/jsbsim-reference-manual/user/concepts/frames-of-reference/) provides the conventional forward/right/down body and north/east/down local frame reference. This prototype follows those conventions, keeping the game's destination-first quaternion notation.
- [@0x62/jsbsim-wasm author repository](https://github.com/0x62/jsbsim-wasm) offers an ESM/TypeScript SDK, JSBSim WASM, MEMFS data loading and property access. Its wrapper is MIT and bundled runtime/compatibility patches LGPL-2.1. The author marks it early development. It documents Vite dependency optimization exclusions for the WASM URL exports. This substantially reduces the browser-porting work; it does not supply a verified F/A-18C dataset or eliminate integration testing.
- [Older JSBSim.js port](https://github.com/csbrandt/JSBSim.js/) documents Emscripten and a Node-oriented command interface based on JSBSim 1.0. It was considered, but the newer SDK provides a clearer interactive seam.
- [FlightGear FA-18 repository](https://github.com/FGMEMBERS-NONGPL/FA-18) advertises undeclared licensing and a temporary BY-NC-SA restriction. It contains a JSBSim aircraft configuration and model assets, but no permission or provenance conclusion sufficient for importing them was established. No files were downloaded into the product.
- [NASA F/A-18 fact sheet](https://www.nasa.gov/wp-content/uploads/2021/09/fs-006-afrc_0.pdf) gives approximately 17.06 m length, 12.29 m span and two 17,700 lbf engines. The prototype rounds the span to 12.3 m and combined maximum thrust to 157.47 kN. These dimensions/rating guide the silhouette and parameter scale, not a performance validation. NASA's research aircraft/configurations are not automatically the requested F/A-18C.
- [NASA TM-4786](https://ntrs.nasa.gov/citations/19970010502), with its [public PDF](https://ntrs.nasa.gov/api/citations/19970010502/downloads/19970010502.pdf), gives the 400 ft² wing-area reference (37.1612 m²) and investigates lateral/directional derivatives for a research F-18. Its derivative identification and configuration caveats make it a candidate for a later carefully scoped dataset, not a plug-in complete F/A-18C model. No graph values were transcribed.
- [NASA lift equation](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/lift-equation/) supports the dynamic-pressure × area × coefficient force formulation. [NASA's atmosphere explanation](https://www.grc.nasa.gov/www/k-12/airplane/atmosmet.html) describes a lapse-rate troposphere and an isothermal lower stratosphere. The code uses dry standard constants, not that page's rounded curve-fit constants: 288.15 K, 101325 Pa, 287.05287 J/(kg·K), 0.0065 K/m and a continuous join at 11 km. Geometric altitude is treated as geopotential altitude in this bounded approximation.
- The acquired source is [McDonnell Douglas F/A-18C Hornet by Rhine_Lab_Muelsyse](https://sketchfab.com/3d-models/mcdonnell-douglas-fa-18c-hornet-c68c8417c8e84864b2a5e0c35c178fd9), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The original 4,756,768-byte GLB is retained unchanged with its embedded creator/source/license metadata. The narrow adapter preserves glTF root transforms, maps source `(x,y,z)` to body FRD `(z,-x,-y)`, scales its measured 16.9529317 m length uniformly to 17.06 m, centers left/right and fore/aft while retaining the source vertical origin, and hides deployed gear, doors, hook, pylons and tank. Source control groups remain neutral static geometry; the procedural model is only the loading/error fallback. The source hierarchy, geometry and textures are cached across reentry, while each instance owns only cloned materials for disposal.

**All aerodynamic derivatives, mass (14,500 kg), diagonal inertia (23,000 / 140,000 / 160,000 kg·m²), effective chord (3.5 m), dry thrust (98 kN), density thrust lapse and spool time (1.5 s) are explicit engineering assumptions.** They are centralized in `HORNET_PROTOTYPE` or documented equations, not measured F/A-18C performance. Do not describe this as a JSBSim implementation or validated Hornet simulation.

## Dynamics and frame seam

Pure API: `createTrimmedFlight`, `stepFlight`, `flightLoads`, `flightInstruments`, `flightAtmosphere` and types, exported from `@docking/sim-core`. No React/Three/DOM imports in flight dynamics. Existing quaternion helpers are reused. No orbital `SimLoop`, sensor pipeline or FSW is modified.

State is local NED position/ground velocity in SI, body FRD angular rates in rad/s, unit scalar-first Hamilton `q_BN` rotating NED→body, engine spool fraction, simulation time and terminal status. Positive pitch input produces nose-up moment, positive roll lowers the right wing and positive yaw turns the nose right. Angular rates evolve through Euler rigid-body equations `I ωdot = M − ω×Iω`; attitudes are never directly reset to commanded angles during flight. `qdot_BN = −½[0,ω_B]⊗q_BN`.

Airflow is `R(q_BN)(v_N − wind_N)`. Alpha is `atan2(w,u)`; beta is `atan2(v,hypot(u,w))`. At zero speed, angles and dynamic pressure are finite. Dynamic pressure scales lift, induced/profile drag, sideforce, and static/control/damping moments. Lift and sideforce are perpendicular to airflow; drag opposes it. Rate derivatives use nondimensional span/chord rates. Positive normal load is minus body-z nongravitational force divided by mass × standard gravity. Gravity is added in NED, outside aerodynamic/body forces.

Below the assumed 0.35 rad stall angle, lift is affine in alpha. Over a further 0.25 rad it blends to a flat-plate sine continuation with extra drag. This avoids unbounded linear extrapolation, but does **not** model Hornet vortex lift, departure, spin or recovery faithfully. No Mach dependence or compressibility is modeled; Mach 0.95 is a stop boundary, and fidelity should not be inferred near transonic flight.

Throttle 0–80% spans the assumed dry-thrust rating; 80–100% spans dry to rated maximum. Engine follows a first-order lag, then thrust scales approximately as `(rho/1.225)^0.7`, aligned with body +x. There is no fuel use/mass change, engine asymmetry or inlet/Mach map. Initial trim solves vertical/horizontal forces including the thrust tilt and zero pitch moment; holding trim does not hold altitude or angle. Buttons/keys act through these forces and moments.

Truth integrates at 100 Hz with RK4 and quaternion renormalization after each step. `FlightSession` holds pilot state and a render-time accumulator, submitting only complete truth steps. It caps catch-up at 0.1 seconds per frame; overload slows simulation rather than running a giant timestep. Pause, blur and reset discard leftover accumulated time. Replaying the same fixed-step input/environment history is deterministic; real-time human keyboard timing under overloaded rendering is not claimed to replay identically.

`flightWorldFrame` converts local NED into the existing world's axes and floating origin. With `lat=N/R`, `lon=E/R`, altitude `−D`, radius `r=R−D`, it maps to world `[r cos(lat)cos(lon) − earthCenterDistance, r sin(lat), −r cos(lat)sin(lon)]`. At the equatorial origin, north is world +Y, east −Z, down −X. The local basis is right-handed; body axes are transformed through it before the Three quaternion is constructed. Only rendering knows about Earth/WorldFrame/Three. An original 17 m aircraft is rendered at metres / `renderScaleMPerUnit`.

The physics frame is flat and nonrotating. The spherical presentation is a local chart, with no Coriolis/transport-rate/curved-Earth flight dynamics. Flight stops beyond 50 km from origin, above 20 km or Mach 0.95. Reaching a 2 m COM altitude latches sea contact and freezes at the crossing step. This is not terrain collision or landing gear; the initial bounded area is ocean. No runway/carrier/takeoff/landing, structural damage, autopilot, HOTAS, audio or avionics fidelity is included.

## JSBSim follow-up cost and recommendation

Prefer an isolated JSBSim worker adapter for the next fidelity milestone, with the existing controls/pose/instrument boundary retained. A proposed integration sequence (engineering estimate, not measured delivery time):

1. Half to one day: pin/review a WASM SDK and JSBSim revision; package module/binary with notices, source/rebuild/relink information; load a known upstream sample aircraft and fixed-step worker lifecycle.
2. One to two days: implement property mapping, unit conversions (JSBSim properties include feet, ft/s, pounds, radians), NED/body quaternion/position conventions, trim, pause/reset and 10 Hz output; compare native and WASM sample trajectories at identical rates.
3. Several further days or more, depending on evidence and permissions: identify an appropriately licensed F/A-18C aircraft-dynamics dataset and its full aircraft/engine/FCS/system dependency graph, validate configuration, coefficient provenance and published benchmarks. The acquired visual GLB is not an aerodynamic or cockpit-fidelity dataset. No reliable upper bound was established for actual Hornet fidelity.

Treat a native JSBSim sample and the WASM build agreeing as a porting oracle; it does not prove an aircraft model matches reality. A broader ECEF/world adapter should replace the local chart before increasing the geographic envelope. Keep the parallel renderer independent throughout.

## Unresolved questions and recommended defaults

| Question | Recommended default / current assumption |
| --- | --- |
| Integrated mode or standalone app? | Integrated selectable FLIGHT mode; port 5175 is reserved for review. |
| Exact variant? | F/A-18C-style silhouette and controls; no C-specific data fidelity claim. |
| Fidelity investment? | Next investigate JSBSim + a verified coefficient set, before avionics polish. |
| Asset source? | Use the retained Rhine_Lab_Muelsyse CC BY 4.0 GLB through the narrow adapter; keep the procedural model as loading/error fallback. |
| Start/landing scope? | Airborne start; runway/gear/contact mechanics deserve a separate milestone. |
| Inputs? | Keyboard + on-screen controls now; user-mapped gamepad/HOTAS later. |
| Wider world? | Preserve local ocean bounds until curved-Earth dynamics and terrain collision are implemented. |

## Historical standalone prototype verification

The following records the original prototype, before independent review, control remapping and environment/model integration. It is retained as historical evidence. See [the integration validation](f18-integration/validation.md) for current checks.

**Complete:** workspace typecheck/build passed; final core typecheck passed. Full sim-core regression suite: **117 tests / 20 files passed**. Focused web frame/session tests: **5 passed**. Total **122 passed, including 17 new tests**. The final flight test rerun also passed after parameter-validation review. `git diff --check` passed and the index remains unstaged. Commands:

```bash
pnpm --filter @docking/sim-core test
pnpm --filter @docking/web exec vitest run src/flight/flightFrame.test.ts src/flight/flightSession.test.ts
pnpm -r build
git diff --check
```

No independent agent review was run. The explicit user constraints override TRIP-1's additional review/approval and TRIP-2's delegation, staging and release workflow. Direct review covers the public boundary, signs/frame transforms, lifecycle, determinism and disposal. No permission gate is pending.

The full core run took 1,887 seconds on the loaded shared host, including the existing 1,200-second simulated MPC docking case. All baseline tests completed successfully; no tests were skipped, weakened or given new timeouts. Detailed summary: `docs/4-unit-tests/wa_v0.13.0_test.md`.

Browser review used a newly launched, private **headless Chrome process**, without attaching to user tabs. Both 1440×900 and 900×650 screenshots were visually inspected. Verified actual keyboard pitch/roll/yaw/throttle/trim, pause freezing sim time, reset returning 0° bank / 1.4° pitch, nose camera, FLIGHT→ANALYSIS→FLIGHT disposal/reentry, blur pause and a plain URL opening SANDBOX. A separate test exercised pointer-held nose-up, the throttle slider (50%), and crosswind selection. Recorded yaw response reached heading 008°, sideslip −7.8°; crosswind changed sideslip to −10.8°. Keyboard throttle reached 100% AB and thrust rose to 110.7 kN; pointer-held pitch reached 20.6°. These are functionality observations, not aircraft benchmark claims.

No application exception was recorded. The sole browser console resource error was the existing missing `/favicon.ico` (confirmed by console source URL); it is outside this flight change. Cold Earth texture loading was slow on the shared host, with aircraft/HUD appearing before the ocean. One first-pass screenshot timed out and an earlier development capture was invalidated by hot reload; both were replaced by a clean pass. The inherited ocean/horizon presentation is coarse. No renderer/cloud corrections were attempted. No reliable 60 fps claim is made; full-scene performance remains subject to the existing renderer and host load.

Production output: separate FLIGHT JS chunk 18.52 kB / 6.97 kB gzip and CSS 4.24 kB / 1.40 kB gzip. Vite reports the existing shared application chunk above 500 kB; build exits successfully. The scene/model are memoized against 10 Hz HUD updates, and owned procedural geometry is disposed on unmount.

Ignored local evidence (not production dependencies): `.evidence.local/visual-check.cjs`, `controls-check.cjs`, `browser-result.json`, `controls-result.json`, `f18-turn.png`, `f18-nose-ready.png`, `f18-compact-ready.png`, `f18-controls.png`; plus the local Playwright install/browser temporary directory. The first scratch smoke script and superseded screenshots remain there as diagnostic history. `node_modules/` and `apps/web/dist/` are normal ignored install/build outputs. The task's local headless browser processes close after testing.

## Changed source and documentation paths

1. `README.md`
2. `apps/web/src/App.tsx`
3. `apps/web/src/appModeStore.ts`
4. `apps/web/src/hud/ModeSwitcher.tsx`
5. `apps/web/src/hud/flightAudio.ts`
6. `apps/web/src/flight/FlightMode.tsx`
7. `apps/web/src/flight/HornetModel.tsx`
8. `apps/web/src/flight/flight.css`
9. `apps/web/src/flight/flightFrame.ts`
10. `apps/web/src/flight/flightFrame.test.ts`
11. `apps/web/src/flight/flightSession.ts`
12. `apps/web/src/flight/flightSession.test.ts`
13. `packages/sim-core/src/flight.ts`
14. `packages/sim-core/src/flight.test.ts`
15. `packages/sim-core/src/index.ts`
16. `docs/ARCHI.md`
17. `docs/1-plans/F_0.13.0_f18-flight-prototype.plan.md`
18. `docs/6-memo/f18-flight-prototype.md`
19. `docs/4-unit-tests/wa_v0.13.0_test.md`
