# Orbital Docking GNC Lab — starter

Pre-built workspace for the docking sim upgrade. Already inside:

- pnpm workspace: `packages/sim-core` (pure TS flight software + dynamics) and
  `apps/web` (Vite + React + react-three-fiber shell)
- Core types and conventions (`docs/ARCHI.md` — read it first, it's the law)
- A real analytic oracle: closed-form CW propagation + 4 passing Vitest tests,
  as the reference pattern for every math module that follows
- Guided-scenario spec for Phase 5 (`docs/scenario-mode-spec.md`)
- CI workflow (install + test)

## On your Mac (once)

```bash
xcode-select --install
brew install node pnpm gh
```

## Bring the repo up

```bash
cd docking-sim
git init && git add -A && git commit -m "scaffold: workspace, conventions, CW oracle"
pnpm install
pnpm test        # CW oracle tests should pass
pnpm dev         # placeholder shell at localhost:5173
```

## Phase 1 scope

Per the `docs/ARCHI.md` roadmap:

1. **Cinematic visual base** — Earth with atmosphere shader and day/night
   terminator, HDRI starfield, sun-aligned lighting, glTF spacecraft models
   (NASA 3D Resources), bloom via `@react-three/postprocessing`.
2. **HUD skeleton** — dark flight-software theme, mono type, telemetry strip
   placeholders.
3. **Stubbed telemetry bus** in `apps/web` emitting fake TelemetryFrame data so
   visuals develop against stable interfaces.

Constraints: no changes to `packages/sim-core` beyond exporting existing types;
rendering code never imports sim-core internals; keep 60 fps on integrated GPUs.
Out of scope: dynamics, sensors, controllers, docking camera PiP. Visual review
is manual (screenshots), not the automated test gate.

## Parallel lanes (after the first commit lands on main)

```bash
git worktree add ../sim-visuals feat/visuals    # Lane B
git worktree add ../sim-infra   feat/infra      # Lane C
```

One terminal tab per worktree, each running its own plan/implement/review cycle.
Merges land on main one at a time, rebase first. ARCHI.md gets edited only at
merge time on main.
