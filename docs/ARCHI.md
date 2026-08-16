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
  APIs only. App modes: SANDBOX / MISSION / ANALYSIS (`appModeStore`).
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

## Stack

TypeScript + Vite + pnpm workspace. Web: React 18, react-three-fiber, drei,
@react-three/postprocessing (bloom), zustand, uPlot (MC histograms). Tests:
Vitest. QP: in-house pure-TS active-set solver (`qp.ts`, KKT-oracle-tested).
CI: GitHub Actions (install + `pnpm -r test`). Web telemetry seam: zustand
bus in `apps/web/src/telemetry/` (sandbox `simEmitter` / mission
`scenarioEmitter`, both wall-clock-paced publishers over sim-time loops);
Monte Carlo batches run `@docking/scenario` in a Web Worker pool
(`monteCarloWorker.ts`, strided global-index shards, progressive results).

## Roadmap

1. ~~Restructure + cinematic visual pass (Earth, starfield, craft, HUD)~~ ✅ v0.2.0 (primitive craft; normalized glTF models are a documented follow-up — see `apps/web/public/assets/ASSETS.md`)
2. ~~Discrete RCS thrusters + allocator, sensor models, EKF~~ ✅ v0.3.0 (16-jet canted RCS, NNLS allocator, seeded sensors + degrade hooks, 6-state EKF, PID/LQR, `SimLoop` command/injection seam; attitude = kinematic LVLH hold pending Phase 3)
3. ~~6-DOF attitude + MEKF + docking camera + manual fly~~ ✅ v0.4.0 (rigid-body truth + thruster torques, MEKF w/ gyro-bias states, 6-target allocator, AUTO/MANUAL-RATE/PULSE via deterministic command API, truth render channel, camera rig + docking PiP)
4. ~~MPC terminal approach + passive abort safety~~ ✅ v0.5.0 (active-set QP + 1 Hz condensed CW MPC w/ soft corridor/terminal constraints + probed octahedral authority; two-level corridor monitor, keep-out-proven passive abort, truth-side DOCKED/COLLISION/ABORT outcome latch)
5. ~~Monte Carlo + guided scenario mode (`docs/scenario-mode-spec.md`)~~ ✅ v0.6.0 (`packages/scenario`: schema v1 + validator, ScenarioDirector w/ merged failure injection + BRIEFING/RUNNING/DEBRIEF, perfect-operator bot, seeded MC runner; sim-core nav-source/guidance-freeze/vel-bias command surface; MISSION switch panel + ANALYSIS worker-pool MC screen; demo video remains a manual follow-up)
6. ~~Flight feel: manual authority, thruster plumes, procedural audio~~ ✅ v0.7.0 (`MANUAL_AUTHORITY_PRESETS` LOW/HIGH resolving through `getResolvedManualLimits()`, manual gains isolated on `stepManualDamping` so `step()`/`stepAuto()` — and the shared ABORT COASTING damping path — keep AUTO gains; `setManualAuthority` deterministic command; truth-side per-jet duty in `RenderState`, accumulated across truth ticks and latched at the FSW boundary; shader plumes + pooled-voice WebAudio over a shared master gain. Open: 60 fps benchmark and integrated flight/audio check need real hardware)

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
