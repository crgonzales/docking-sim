# ARCHI.md — Orbital Docking GNC Lab

Persistent architecture reference. Pre-seeded before `initialization`; init should
fold this in rather than regenerate from scratch. Keep compact (`compaction`).

## What this is

Browser-based spacecraft rendezvous & docking simulator, built as a GNC
portfolio piece. Real dynamics, estimation, and constrained control behind a
cinematic Three.js front end, verified by analytic oracle tests and Monte Carlo.

## Package boundary (hard rule)

- `packages/sim-core` — pure TypeScript. Truth dynamics, sensors, thrusters,
  FSW (nav filters, guidance, controllers, allocator). **No React, no Three.js,
  no DOM imports, ever.** Runs identically in page, workers, and Node tests.
- `apps/web` — Vite + React + react-three-fiber. Rendering, HUD, panel,
  scenario director UI. Consumes sim-core through its public API only.
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
zustand, uPlot (Phase 1+). Tests: Vitest. QP: quadprog now, OSQP-WASM if
needed. CI: GitHub Actions (install + `pnpm -r test`).

## Roadmap

1. Restructure + cinematic visual pass (Earth, starfield, glTF craft, HUD)
2. Discrete RCS thrusters + allocator, sensor models, EKF
3. 6-DOF attitude + MEKF + docking camera + manual fly
4. MPC terminal approach + passive abort safety
5. Monte Carlo + guided scenario mode (`docs/scenario-mode-spec.md`) + video

## Testing gate (oracle tests, not vibes)

- CW closed form: identity at t=0, composition, cross-track SHM invariant
  (implemented: `packages/sim-core/src/cw.test.ts`)
- Numeric propagator vs. `propagateCW` at small separations
- Quaternion norm drift bound; torque-free momentum conservation
- Filter consistency: NEES within chi-square bounds on seeded runs
- Scenario mode: determinism, zero-input never docks, perfect-operator docks
