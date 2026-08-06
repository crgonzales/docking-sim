# Architecture Documentation Rules

[ARCHI.md](ARCHI.md) documents the docking-sim (Orbital Docking GNC Lab) architecture. After each
task (new feature, refactor, bug fix), determine if ARCHI.md needs updating.

## When to Update

Update after ANY change that alters:

- Project structure (new packages, new directories under `packages/` or `apps/`)
- Technology stack (new dependencies — e.g. postprocessing, uPlot, a QP solver — or version changes)
- The package boundary (anything that would let rendering code import sim-core internals, or sim-core import React/Three.js/DOM)
- Conventions (frames, quaternion convention, units, integration rates, seeding) — these are authoritative; code that disagrees is wrong
- The roadmap (a phase completed or re-scoped)
- The testing gate (new oracle/invariant test categories)

## How to Update by Change Type

### Major Feature / Refactor

Review: Package boundary, Conventions, Stack, Roadmap, Testing gate

### Minor Feature / Enhancement

Update: Stack (if dependencies changed), Testing gate (if new test categories added)

### Bug Fix

Usually no update needed, unless it reveals/fixes an architectural flaw (e.g., a package-boundary or convention violation)

### Dependency Changes

Update: Stack, and Testing gate if the test toolchain is affected

## Guidelines

- Be precise and factual - reflect the actual codebase
- Be concise - ARCHI.md is deliberately compact ("keep compact" is in its header); prefer editing existing lines over adding sections
- Reference actual file paths
- Roadmap items get checked off, not deleted — the history of phases matters
