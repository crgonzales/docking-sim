# Orbital Docking GNC Lab

**v0.4.2** — browser-based spacecraft rendezvous & docking simulator, built as a
GNC portfolio piece. Real dynamics, estimation, and constrained control behind a
cinematic Three.js front end. Repo: https://github.com/crgonzales/docking-sim

Inside:

- pnpm workspace: `packages/sim-core` (pure TS flight software + dynamics) and
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

## Flying it (manual controls)

KSP-style layout (rotation on WASD, translation on Shift/Ctrl + IJKL):

| Input | Action |
| --- | --- |
| `M` | toggle AUTO / MANUAL |
| `T` | toggle RATE (fly-by-wire w/ hold) / PULSE (direct) |
| `C` | cycle camera: cinematic → chase → cockpit |
| `Shift` / `Ctrl` | thrust forward / back (±ŷ) |
| `W`/`S` | pitch down / up |
| `A`/`D` | yaw left / right |
| `Q`/`E` | roll left / right |
| `I`/`K` | translate up / down (±ẑ) |
| `J`/`L` | translate left / right (∓x̂) |
| right-drag | pitch / yaw (additive) |

⚠ Browser caveat: avoid `Ctrl+W` combos (reversing while pitching down) —
the browser may close the tab before the page sees the keystroke.
- project docs structure skills in `local tooling`, project docs under `docs/`
- Guided-scenario spec for Phase 5 (`docs/scenario-mode-spec.md`)
- CI workflow (install + test)

## Run it

```bash
pnpm install
pnpm test        # oracle + consistency suites (sim-core) and web tests
pnpm dev         # live closed-loop approach at localhost:5173
```

## Workflow (GitHub-first)

Work happens directly on `main`; every release release commits, tags, and pushes
to GitHub immediately — no local-only branches or worktrees. development cycle:
`planning` → `implementation` → `release`, with code reviews in
the loop (see `local tooling`). Windows note: `local tooling` needs the
machine-local trusted-project grant in `~/.tooling/config.toml` — see the comment
in `local tooling tooling/scripts/start.sh`.

## Roadmap

See `docs/ARCHI.md` (authoritative). Next: Phase 4 — MPC terminal approach +
corridor constraint + passive-abort safety.
