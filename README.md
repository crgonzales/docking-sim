# Orbital Docking GNC Lab

**v0.6.0** — browser-based spacecraft rendezvous & docking simulator, built as a
GNC portfolio piece. Real dynamics, estimation, and constrained control behind a
cinematic Three.js front end. Repo: https://github.com/crgonzales/docking-sim

Inside:

- pnpm workspace: `packages/sim-core` (pure TS flight software + dynamics),
  `packages/scenario` (pure TS mission scripting + Monte Carlo), and
  `apps/web` (Vite + React + react-three-fiber shell)
- Core types and conventions (`docs/ARCHI.md` — read it first, it's the law)
- A real analytic oracle: closed-form CW propagation + 4 passing Vitest tests,
  as the reference pattern for every math module that follows
- Phase 1 cinematic base (v0.2.0): shader Earth with day/night terminator +
  atmosphere, ESO starfield, bloom, primitive station/chaser on the ±ŷ docking
  axis, flight-software HUD over a telemetry bus
- Phase 2 real GNC (v0.3.0): RK4 CW truth dynamics, 16-jet RCS with failure
  states, bounded-NNLS allocator, seeded sensors, ANEES-gated 6-state EKF,
  V-bar guidance with PID/LQR — the scene flies actual closed-loop control fed
  by the `SimLoop` command/injection seam
- Phase 3 (v0.4.0): full 6-DOF rigid-body attitude with thruster torques,
  MEKF attitude estimation (gyro bias + star tracker), 6-target force/torque
  allocation, **manual fly** (AUTO/MANUAL, RATE fly-by-wire or PULSE direct),
  truth render channel, switchable cameras, and a docking-camera PiP with
  capture-envelope alignment display
- Phase 4 (v0.5.0): **constrained MPC terminal approach** (pure-TS active-set
  QP, corridor + capture-envelope constraints, probed thrust authority),
  two-level corridor monitoring with **passive abort** (keep-out-proven safing
  burn), and truth-side contact outcomes — fly it to a real **DOCKED /
  COLLISION / ABORT** ending with HUD banners and live caution/warning tiles
- Phase 5 (v0.6.0): **guided scenario mode** ("Final Approach" — a 6-minute
  timed emergency with scripted failures cleared by real panel controls:
  nav-source switch, jet isolation, MPC recapture, manual takeover; GUIDED
  hints, briefing/debrief/retry, guarded switches with audio) and a
  **Monte Carlo analysis screen** (seeded batch runs in a Web Worker pool,
  outcome/grade/prop/time-margin histograms) — spec in
  `docs/scenario-mode-spec.md`, mission modes: SANDBOX / MISSION / ANALYSIS
- Project docs under `docs/` — architecture, plans, changelogs, code reviews
- CI workflow (install + test)

## Flying it (manual controls)

KSP-style layout (rotation on WASD, translation on Shift/Ctrl + IJKL):

| Input | Action |
| --- | --- |
| `M` | toggle AUTO / MANUAL |
| `T` | toggle RATE (fly-by-wire w/ hold) / PULSE (direct) |
| `V` | cycle controller: PID → LQR → MPC |
| `C` | cycle camera: cinematic → chase → cockpit |
| `H` / `?` | keybinds overlay |
| `Backspace` | ABORT (passive safing sequence) |
| `Shift` / `Ctrl` | thrust forward / back (±ŷ) |
| `W`/`S` | pitch down / up |
| `A`/`D` | yaw left / right |
| `Q`/`E` | roll left / right |
| `I`/`K` | translate up / down (±ẑ) |
| `J`/`L` | translate left / right (∓x̂) |
| right-drag | orbit camera (chase/cinematic) |
| scroll | zoom camera |

Ship rotation is keys-only; the mouse drives the camera.
⚠ Browser caveat: avoid `Ctrl+W` combos (reversing while pitching down) —
the browser may close the tab before the page sees the keystroke.

## Run it

```bash
pnpm install
pnpm test        # oracle + consistency suites (sim-core) and web tests
pnpm dev         # live closed-loop approach at localhost:5173
```

## Workflow

Each change gets a feature/fix branch, which is fast-forward merged into `main`
at release time — keeping a single clean linear history, never a merge commit.
The cycle is plan → implement → code review → release, with the plan, review,
and changelog for every version kept under `docs/`.

## Roadmap

See `docs/ARCHI.md` (authoritative). Phases 1–5 complete. Next: portfolio
video (manual), then backlog (visual pass, guidance tuning UI).
