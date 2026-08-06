# Changelog Table

| Version | Week | Commit Message                          |
| ------- | ---- | --------------------------------------- |
| `0.2.0` | 1    | feat: Phase 1 cinematic visual base — Earth terminator scene, HUD skeleton, stub telemetry bus |
| `0.1.1` | 1    | chore: initialize project docs structure for docking-sim |

# Changelog Summary

- **v0.2.0 (Phase 1: Cinematic Visual Base - Week 1, 06-08-2026)**:
  - **Scene**: shader Earth with day/night terminator + fresnel atmosphere (scaled group, log depth), clamped ESO starfield, sun-aligned lighting, half-res bloom under an HDR contract, primitive craft on the ±ŷ docking axis with damped bus-driven approach motion
  - **HUD**: phosphor flight-software skeleton — telemetry strip (pinned display formulas), C&W tile grid, controller/mode bar
  - **Telemetry**: zustand bus + deterministic seeded stub emitter at FSW rate (the Phase 2 swap point)
  - **Review**: review loop, 4 rounds → APPROVED (`CR_w1_v0.2.0.md`); coverage debt ledger opened
  - **Files**: 16 new under `apps/web/` (scene/hud/telemetry/assets), `App.tsx` rewired; sim-core untouched

- **v0.1.1 (Docs initialization - Week 1, 06-08-2026)**:
  - **Setup**: Initialized project docs structure with docs structure; repo pushed to GitHub (`crgonzales/docking-sim`, `main` branch, GitHub-first flow — commits on main, always pushed)
  - **Documentation**: Folded in pre-seeded ARCHI.md (full-stack web sim: pure-TS sim-core library + React/react-three-fiber front end); created ARCHI-rules.md and TESTING.md
  - **Skills**: Adapted all project tooling to the project (pnpm/Vitest commands, root package.json as version file, week anchor 2026-08-03, main-only release flow, GNC-specific plan guidance and review checklist)
  - **Files Added**: docs/ARCHI-rules.md, docs/2-changelog/changelog_table.md, docs/4-unit-tests/TESTING.md
