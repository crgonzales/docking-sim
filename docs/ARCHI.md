# ARCHI.md — Orbital Docking GNC Lab

Persistent architecture reference. Authoritative on conventions — if code
disagrees, the code is wrong. Keep it compact.

## What this is

Browser-based spacecraft rendezvous & docking simulator, built as a GNC
portfolio piece. Real dynamics, estimation, and constrained control behind a
cinematic Three.js front end, verified by analytic oracle tests and Monte Carlo.

## Package boundary (hard rule)

- `packages/sim-core` — pure TypeScript. Truth dynamics, sensors, thrusters,
  FSW (nav filters, guidance, controllers, allocator). **No React, no Three.js,
  no DOM imports, ever.** Runs identically in page, workers, and Node tests.
- `packages/scenario` — pure TypeScript, same no-DOM rule. Scenario schema +
  validator, `FINAL_APPROACH_01` data, `ScenarioDirector`, perfect-operator
  bot, Monte Carlo runner. Imports sim-core **only** via its public export map
  and is typed against `ScenarioSimPort` (`Omit<SimLoop, truth/render getters>`)
  — the honesty invariant is compile-enforced and test-greped
  (`acceptance.test.ts`).
- `apps/web` — Vite + React + react-three-fiber. Rendering, HUD, switch
  panel, scenario/Monte Carlo UI. Consumes sim-core/scenario through public
  APIs only. App modes: SANDBOX / MISSION / ANALYSIS / FLIGHT (`appModeStore`).
  Optional FLIGHT owns its input, camera and fixed-step session; no orbital
  SimLoop, FSW or spacecraft audio runs while it is selected.
- FSW is a pure function of sensor data: `FswTick(SensorFrame) →
  {ThrusterCommand, TelemetryFrame}`. FSW never reads `TruthState`.
- External actors (UI, ScenarioDirector, Monte Carlo) act only through the
  public injection + command APIs.

## Conventions (authoritative — if code disagrees, the code is wrong)

- **Hill/LVLH frame:** origin at target COM. x̂ radial outward from Earth,
  ŷ along-track (+velocity), ẑ = x̂ × ŷ (cross-track). V-bar approach ⇒ y < 0.
- **Inertial frame:** Earth-centered inertial (ECI), J2000-like; two-body only.
- **Quaternions:** Hamilton convention, **scalar-first `[w, x, y, z]`**, unit
  norm. `q_BI` rotates vectors inertial → body. Renormalize after integration.
- **Units:** SI everywhere in sim-core (m, m/s, rad, kg, s). Degrees only at
  UI/schema boundaries.
- **Time:** sim-time seconds; fixed-step integration. Truth: RK4 @ 100 Hz.
  FSW: 10 Hz. MPC: 1 Hz. No wall-clock coupling anywhere in sim-core.
- **Randomness:** all noise from seeded RNG; a run is fully determined by
  (scenario, seed, inputs).
- **Sky/equirect UV (render-side):** three.js SphereGeometry convention —
  −x̂ → u=0, +x̂ → u=0.5. Every cloud/shadow/placement lookup shares it
  (`cloudSphericalUv`); renderer values derive from `SKY_CONFIG`, never
  free-standing constants.

## Atmospheric flight prototype (isolated from orbital GNC)

`sim-core/flight.ts` exports a deterministic 100 Hz RK4 rigid-body model,
solved level-flight trim and truth-derived instruments. Pure TS, no sensors
or FSW coupling. SI and scalar-first Hamilton quaternions still apply.
Flight-only N = north/east/down, B = forward/right/down; q_BN rotates N→B.
Gravity is constant local down; wind is NED; rates and diagonal inertia are
body-frame. Lift/drag/sideforce, stability/control moments, rate damping,
dry atmosphere and spool-lag thrust use documented approximate parameters.
These coefficients are not a validated F/A-18 dataset.

`apps/web/src/flight` owns pacing (whole truth ticks, capped catch-up),
pause/reset/blur handling, aircraft visuals, HUD and NED→world adapter.
It reuses Earth/WorldFrame through explicit renderer options without changing
the renderer internals: FLIGHT owns one camera/floating origin and one
`LibraryEffects` composer, with medium volumetric weather, exposure 2 and DPR 1 by
default. Existing `quality`, `dpr`, `exposure` and cloud diagnostic query
overrides remain available. Flat local physics are mapped onto a spherical
equatorial ocean chart for presentation; 50 km radius, 20 km ceiling and M
0.95 boundaries stop the run. Sea contact is a terminal latch, not a
landing-gear solver. FLIGHT uses the retained CC BY 4.0 Rhine_Lab_Muelsyse
F/A-18C GLB through a narrow adapter; the original procedural Hornet remains
the loading/error fallback. The adapter preserves source transforms, maps
glTF `(x,y,z)` into body FRD `(z,-x,-y)`, normalizes the measured length to
17.06 m and hides deployed stores/gear without animating source control
groups. Default mode stays SANDBOX; `?mode=flight` explicitly selects FLIGHT.
Provenance, frame math and limits: `docs/6-memo/f18-flight-prototype.md`.

## Stack

TypeScript + Vite + pnpm workspace. Web: React 18, react-three-fiber, drei,
@react-three/postprocessing (bloom), zustand, uPlot (MC histograms). Tests:
Vitest. QP: in-house pure-TS active-set solver (`qp.ts`, KKT-oracle-tested).
CI: GitHub Actions (install + `pnpm -r test`). Web telemetry seam: zustand
bus in `apps/web/src/telemetry/` (sandbox `simEmitter` / mission
`scenarioEmitter`, both wall-clock-paced publishers over sim-time loops);
Monte Carlo batches run `@docking/scenario` in a Web Worker pool
(`monteCarloWorker.ts`, strided global-index shards, progressive results).
Sky rendering: `apps/web/src/scene/sky/` single-source config (`skyConfig.ts`
physical inputs → in-code derivations), baked Hillaire atmosphere LUTs
(`scripts/bakeAtmosphere.mjs` → committed `assets/lut/*.bin`, RGBA float —
RGB float is unfilterable in WebGL2), KTX2/UASTC textures + seeded cloud
placement mask via `scripts/make*.mjs` (provenance: `assets/ASSETS.md`).

Library renderer (`renderer=library&cloudSystem=eve` for query-selected
SceneRoot diagnostics; FLIGHT selects the same components explicitly): Takram
Bruneton atmosphere and a maintained Three-clouds fork provide the host passes.
Canonical world-fixed cloud density feeds local volumes, shared lighting and a
prepared opacity/height column atlas for orbital views. Light-cache texels
average transmitted light from canonical subrays, never prethreshold noise.
Premultiplied transport blends once over 50–120 km. The reference weather patch
is opt-in. Terrain selection uses a bounded best-first quadtree (300 records,
depth ≤16); workers build the existing DEM/procedural height field. Four shared
periodic RGBA16F textures hold material heights and baked spatial slopes.
Patch-local phase reduction preserves ground precision. Color and normal passes
share the geographic water classifier and bounded imagery-to-reflectance
calibration. The latter is artistic calibration, not measured albedo. Resource
ownership and verified limits: `6-memo/eve-cloud-system/stabilization-completion.md`.
The query-selected SceneRoot behavior remains unchanged for nonflight modes;
integrated FLIGHT opts into the library Earth, terrain and effects explicitly.

## Roadmap

1. ~~Restructure + cinematic visual pass (Earth, starfield, craft, HUD)~~ ✅ v0.2.0 (primitive craft; normalized glTF models are a documented follow-up — see `apps/web/public/assets/ASSETS.md`)
2. ~~Discrete RCS thrusters + allocator, sensor models, EKF~~ ✅ v0.3.0 (16-jet canted RCS, NNLS allocator, seeded sensors + degrade hooks, 6-state EKF, PID/LQR, `SimLoop` command/injection seam; attitude = kinematic LVLH hold pending Phase 3)
3. ~~6-DOF attitude + MEKF + docking camera + manual fly~~ ✅ v0.4.0 (rigid-body truth + thruster torques, MEKF w/ gyro-bias states, 6-target allocator, AUTO/MANUAL-RATE/PULSE via deterministic command API, truth render channel, camera rig + docking PiP)
4. ~~MPC terminal approach + passive abort safety~~ ✅ v0.5.0 (active-set QP + 1 Hz condensed CW MPC w/ soft corridor/terminal constraints + probed octahedral authority; two-level corridor monitor, keep-out-proven passive abort, truth-side DOCKED/COLLISION/ABORT outcome latch)
5. ~~Monte Carlo + guided scenario mode (`docs/scenario-mode-spec.md`)~~ ✅ v0.6.0 (`packages/scenario`: schema v1 + validator, ScenarioDirector w/ merged failure injection + BRIEFING/RUNNING/DEBRIEF, perfect-operator bot, seeded MC runner; sim-core nav-source/guidance-freeze/vel-bias command surface; MISSION switch panel + ANALYSIS worker-pool MC screen; demo video remains a manual follow-up)
6. ~~Flight feel: manual authority, thruster plumes, procedural audio~~ ✅ v0.7.0 (`MANUAL_AUTHORITY_PRESETS` LOW/HIGH resolving through `getResolvedManualLimits()`, manual gains isolated on `stepManualDamping` so `step()`/`stepAuto()` — and the shared ABORT COASTING damping path — keep AUTO gains; `setManualAuthority` deterministic command; truth-side per-jet duty in `RenderState`, accumulated across truth ticks and latched at the FSW boundary; shader plumes + pooled-voice WebAudio over a shared master gain. Open items closed in v0.8.0: FPS counter + GPU-verified 60 fps checkpoints)
7. ~~Sky overhaul: physically-based atmosphere, EVE-style clouds, relief, debug camera~~ ✅ v0.8.0 (`sky/skyConfig.ts` single source + derivation oracles; baked transmittance/multiple-scattering LUTs driving limb raymarch, aerial perspective, and sun extinction tint; deck + cirrus + 12k seeded volumetric puffs off one shared coverage function and mask; GEBCO relief normals, orbit-correct ocean, camera-relative sun at derived infinity; debug camera `B` + arrow-key orbit + FPS counter; owner accepts a 30 fps floor for visual quality — measured 60 at every checkpoint. Craft stay primitive — glTF hull bake too dark, flip deferred)

## Testing gate (oracle tests, not vibes)

- CW closed form: identity at t=0, composition, cross-track SHM invariant
  (implemented: `packages/sim-core/src/cw.test.ts`)
- Numeric propagator vs. `propagateCW` at small separations (implemented:
  `dynamics.test.ts`, multi-orbit)
- Filter consistency: 50-run ANEES within the 95% χ²₆ₙ/N band, ≥90% of epochs
  + window mean (implemented: `ekf.test.ts`)
- End-to-end determinism + FSW purity grep + failure-injection honesty
  (implemented: `sim.test.ts`, `fsw.test.ts`)
- Quaternion norm drift bound; torque-free full-vector momentum conservation;
  MEKF 50-run attitude ANEES in the 95% χ²₆ₙ/N band (implemented:
  `dynamics.test.ts`, `mekf.test.ts`)
- QP KKT oracles; MPC constraint satisfaction + headline 250 m MPC-docks-green
  run; abort passive-safety keep-out over 2 orbits (implemented: `qp.test.ts`,
  `mpc.test.ts`, `monitors.test.ts`, `sim.test.ts`)
- Scenario mode: determinism, zero-input never docks, perfect-operator docks,
  schema unknown-field rejection, honesty-invariant static import check
  (implemented: `packages/scenario/src/acceptance.test.ts`; director beat
  rules + MC scoring/seed-uniqueness in `director.test.ts`, `monteCarlo.test.ts`)
- Manual authority: HIGH step response (≥90% of commanded by 1.5 s, ≤110% peak,
  settled ±5% by 3 s) with LOW unchanged; paired tumble regression (commanded-axis
  rate ≥85% of the rotation-only baseline under full translation, off-axis rates
  <1 deg/s); abort-damping torque invariant across authority levels; authority-switch
  continuity (implemented: `manual-rate.test.ts`, `control.test.ts`, `fsw.test.ts`)
- Render duty honesty: a sub-window pulse survives accumulation rather than being
  aliased away, and a stuck-open jet reports duty FSW never commanded (implemented:
  `sim.test.ts`)
- Sky pipeline: config derivation oracles; LUT bake determinism + golden
  transmittance values + energy bounds; cloud placement determinism, mask
  registration, and CPU/GPU transfer-function pinning; glTF port normalization
  (implemented: `skyConfig.test.ts`, `atmosphereMath.test.ts`,
  `cloudPlacement.test.ts`, `EarthMath.test.ts`, `modelNormalization.test.ts`)

### Airfield and on-foot flight start

- Ordinary `?mode=flight` starts on foot beside a parked, gear-down Hornet. `start=airborne` or `character=0` retains legacy airborne flight; `character=1&start=airborne` retains character-owned airborne mode. The DEV cloud-base fixture takes precedence.
- `character/CharacterSession` coordinates exclusive ON_FOOT/VEHICLE input and camera ownership; walking uses a 100 Hz fixed step, clears held input on pause/blur/transition, and supports nearby boarding/guarded exits. Parked aircraft physics stays frozen even after boarding. `FlightSession.park()` cancels exercises and reconciles private throttle/trim.
- `airfield/airfieldSite.ts` owns the surveyed 105 m tangent plane near 7°N/0.02°E, runway/apron/pad definitions and building/perimeter collision footprints. Ground support intersects the existing flight-chart radial direction with that same plane; async terrain streaming cannot displace it. `airfieldGeometry.ts` partitions coplanar deck cells; `Airfield.tsx` batches static geometry into 11 instanced material groups, updating after camera rebasing and disposing resources on unmount.
- One Earth/volumetric-weather composer and shared terrain source remain in FlightMode; first-person uses 1.7 m eyes and an 80° vertical field of view. Base UI hides inactive flight controls and exercise resets, and DEV evidence records the active character/camera. Airborne 50 km / 20 km / M 0.95 limits remain unchanged; no runway contact/ground-roll solver, building interiors or aircraft body collision.

### Flight environment time and weather

- `flight/FlightEnvironmentClock` owns render-side time separately from aircraft/walking fixed steps. Default is 10:00 reference local solar time at 1x; explicit seeks/reset are discontinuities, while continuous time never wraps at midnight. Pause/focus loss freezes daylight/weather even during the 96-frame paused render warmup. UI notifications are bounded to ~10 Hz.
- Optional environment state reaches Earth and LibraryEffects; ordinary SceneRoot and the original cloud-base fixture retain static defaults. One normalized equinox sun drives sky, terrain/ocean and local PBR. `FlightLighting` borrows the composer-owned transmittance LUT for sunlight color, plus one 1024 local shadow map updated only for the color render. Filtered airfield detail stays in surveyed site coordinates and never changes collision height.
- `cloudMotion.ts` rotates physical ECEF about north +Z at 15 m/s equatorial wind; maps and both noise domains sample the inverse canonical transform. Seeded fronts are continuous 3D fields restricted to the sphere. The orbital atlas stays canonical; physical light-volume snapshots refresh every 2 seconds and validate against live time/sun. Only cloud-front reprojection includes media motion; scene depth stays camera-only, and stationary history reuse is disabled while media moves.
- User-facing naming is volumetric weather. Legacy `eve` URLs/shader identifiers remain compatible, with existing third-party attribution retained. Weather is procedural advection, not precipitation or a meteorological solver. See `docs/6-memo/f18-integration/ground-weather-validation.md` for measured evidence and remaining visual limits.
