# Changelog Table

| Version | Week | Commit Message                          |
| ------- | ---- | --------------------------------------- |
| `0.4.2` | 1    | feat: KSP-style manual controls (Shift/Ctrl thrust, WASD pitch/yaw, QE roll, IJKL translate) |
| `0.4.1` | 1    | hotfix: manual-translation tumble — allocator force back-off, min-impulse accumulators, PULSE rate damping |
| `0.4.0` | 1    | feat: Phase 3 6-DOF attitude, MEKF, docking camera & manual fly |
| `0.3.0` | 1    | feat: Phase 2 real GNC — RK4 truth dynamics, 16-jet RCS + NNLS allocator, EKF navigation, PID/LQR closed loop |
| `0.2.0` | 1    | feat: Phase 1 cinematic visual base — Earth terminator scene, HUD skeleton, stub telemetry bus |
| `0.1.1` | 1    | chore: initialize project docs structure for docking-sim |

# Changelog Summary

- **v0.4.2 (KSP-style controls - Week 1, 06-08-2026)**:
  - **Controls**: rebound per pilot feedback - Shift/Ctrl forward/back, W/S pitch, A/D yaw, Q/E roll, I/K up/down, J/L left/right, right-drag additive pitch/yaw; README controls table + Ctrl+W browser caveat
  - **Known issue**: manual rotation response is over-damped (~0.15 deg/s effective vs 1.5 deg/s commanded) - rate-loop tuning pass scheduled with Phase 4

- **v0.4.1 (Hotfix - Week 1, 06-08-2026)**:
  - **Issue**: pressing W in MANUAL tumbled the vehicle 175 deg instead of translating (user-reported)
  - **Fix**: lexicographic force back-off in the allocator (torque tracking always wins), per-jet min-impulse accumulators (PWM across FSW cycles - also restores fine control that the deadband had silently zeroed since v0.3.0), PULSE-mode rate damping, 60 N manual force ceiling
  - **Root cause**: force/torque unit mismatch made torque cheap to sacrifice under saturation; see docs/6-memo/v0.4.1-manual-tumble-postmortem.md

- **v0.4.0 (Phase 3: 6-DOF + Manual Fly - Week 1, 06-08-2026)**:
  - **Attitude**: real rigid-body dynamics with thruster torques (momentum/spin/norm oracles), MEKF with gyro-bias estimation (honest ANEES gate), quaternion-error attitude control, 6-target NNLS allocation
  - **Manual fly**: AUTO/MANUAL with RATE (capture-integrate-latch fly-by-wire) and PULSE modes; deterministic scripted-command reproducibility; mouse+keyboard bindings with fail-safe zeroing
  - **Cameras**: truth render channel (visuals=reality, gauges=FSW belief), CINEMATIC/CHASE/COCKPIT rig, docking-camera PiP with alignment overlay + capture-envelope coloring
  - **Review**: review loop, 2 rounds → APPROVED (`CR_w1_v0.4.0.md`), 6 Majors regression-fixed; 61 tests

- **v0.3.0 (Phase 2: Real GNC - Week 1, 06-08-2026)**:
  - **Physics**: RK4 CW truth propagator (oracle-verified), 16-jet canted RCS with min-impulse/quantization/depletion/failure states
  - **FSW**: seeded sensors with degrade hooks, 6-state EKF (ANEES-gated at the honest 95% band), V-bar glideslope guidance, PID + LQR, bounded NNLS allocator, pure FswTick closure
  - **Seam**: SimLoop public command/injection APIs (honesty split for Phase 5); web emitter swapped to the real loop — the scene now flies actual closed-loop GNC
  - **Review**: review loop, 3 rounds → APPROVED with observations (`CR_w1_v0.3.0.md`); two Majors caught and regression-locked; web Vitest added, coverage ledger cleared
  - **Files**: 10 new sim-core modules + tests, linalg consolidation, web emitter/HUD/test changes

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
