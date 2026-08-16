# Changelog Table

| Version | Week | Commit Message                          |
| ------- | ---- | --------------------------------------- |
| `0.8.0` | 2    | feat: physically-based sky overhaul — atmospheric scattering LUTs, volumetric clouds, terrain relief & debug camera |
| `0.7.0` | 2    | feat: flight feel — selectable manual authority, truth-driven thruster plumes & procedural RCS audio |
| `0.6.0` | 1    | feat: Phase 5 guided scenario mode, Monte Carlo analysis & mission switch panel |
| `0.5.0` | 1    | feat: Phase 4 MPC terminal approach, passive abort safety & flight-deck UX |
| `0.4.2` | 1    | feat: KSP-style manual controls (Shift/Ctrl thrust, WASD pitch/yaw, QE roll, IJKL translate) |
| `0.4.1` | 1    | hotfix: manual-translation tumble — allocator force back-off, min-impulse accumulators, PULSE rate damping |
| `0.4.0` | 1    | feat: Phase 3 6-DOF attitude, MEKF, docking camera & manual fly |
| `0.3.0` | 1    | feat: Phase 2 real GNC — RK4 truth dynamics, 16-jet RCS + NNLS allocator, EKF navigation, PID/LQR closed loop |
| `0.2.0` | 1    | feat: Phase 1 cinematic visual base — Earth terminator scene, HUD skeleton, stub telemetry bus |
| `0.1.1` | 1    | chore: initialize project docs structure |

# Changelog Summary

- **v0.8.0 (Sky Overhaul - Week 2, 16-08-2026)**:
  - **Atmosphere**: baked Hillaire transmittance/multiple-scattering LUTs drive a 12-step limb raymarch, surface aerial perspective, and sun extinction tint; fixed the WebGL2 unfilterable-RGB-float bug that had left the shell invisible since Phase B
  - **Clouds**: deck + cirrus + 12k volumetric puffs from one shared coverage function and a seeded mask placement; fixed 180° UV misregistration, a malformed mask asset, whole-field frustum culling, and sub-pixel shimmer via footprint fades
  - **Surface & sun**: GEBCO relief, orbit-correct smooth ocean with steady glint, camera-relative sun at optical infinity, 192-segment silhouettes
  - **UX**: debug camera + arrow-key camera controls + FPS counter; owner kept primitive craft models (glTF hull bake too dark, deferred)
  - **Review**: Codex loop 2 rounds -> APPROVED (`CR_w2_v0.8.0.md`); 145 tests; 60 fps GPU checkpoints

- **v0.7.0 (Flight Feel - Week 2, 15-08-2026)**:
  - **Controls**: measurement found manual flight limited by both a 1.5 deg/s cap (~6% of available torque) and a slow, underdamped attitude loop (32% overshoot, >15 s to settle); manual now resolves through LOW/HIGH authority presets with their own gains, hitting commanded rate in 1.5 s at <=10% overshoot on HIGH while LOW reproduces v0.6.0 exactly
  - **Safety**: manual gains route through a new `stepManualDamping`, leaving `step()`/`stepAuto()` on AUTO gains — `fsw.ts` shares `step()` with ABORT COASTING damping, and a test asserts abort torque is authority-invariant
  - **Plumes**: per-jet duty accumulated across truth ticks and latched at the FSW boundary (single-tick sampling would alias short pulses); truth-sourced, so a stuck-open jet renders even when FSW thinks it is closed; shader falloff with hot core, allocation-free render loop
  - **Audio**: shared AudioContext + master gain so one mute covers all layers; a single pooled noise voice tracks aggregate duty rather than one node per jet per tick; contact thump on DOCKED/COLLISION only, stingers from scenario state, teardown on HUD unmount
  - **Review**: review loop 2 rounds -> APPROVED with observations (`CR_w2_v0.7.0.md`); 125 tests
  - **Open**: 60 fps benchmark and integrated flight/audio check need real hardware; plume visual pass landed post-verdict and was not re-reviewed

- **v0.6.0 (Phase 5: Guided Scenario + Monte Carlo - Week 1, 07-08-2026)**:
  - **Scenario**: new pure-TS `@docking/scenario` package — spec-v1 schema + strict validator, `FINAL_APPROACH_01` ("Final Approach" timed emergency), `ScenarioDirector` acting only through public SimLoop APIs (honesty invariant compile- and test-enforced), deterministic perfect-operator bot
  - **sim-core**: `setNavSource` (MEKF BACKUP gyro dead-reckoning), guidance-freeze fault, truth-layer velocity-bias nudge, per-channel noise degrade, continuous attitude-bias ramp, `corridor_level`/`range_m`/`body_rate_dps` telemetry
  - **UI**: SANDBOX/MISSION/ANALYSIS modes — guarded switch panel with WebAudio clicks + master alarm, mission clock, briefing/debrief/retry flow; Monte Carlo screen with worker-pool batch runs and uPlot histograms (outcomes, grades, prop, time margin)
  - **Review**: review loop, 3 rounds → APPROVED (`CR_w1_v0.6.0.md`), 2 Majors + 6 Minors fixed; 118 tests incl. the 5 spec acceptance tests; browser-verified end-to-end
  - **Spec fix**: Beat B2 thruster id corrected `B2` → `J6` (real jet ids are J1–J16)

- **v0.5.0 (Phase 4: MPC + Abort Safety - Week 1, 06-08-2026)**:
  - **Guidance**: pure-TS active-set QP (KKT-oracle-verified) powering a 1 Hz condensed CW MPC with soft corridor/terminal constraints and probed octahedral thrust authority; headline test flies 250 m to a green-envelope DOCKED outcome
  - **Safety**: two-level corridor monitor, passive abort with keep-out-oracle-proven safing burn, truth-side contact detection latching DOCKED/COLLISION/ABORT (sim is now a completable docking loop)
  - **UX**: camera orbit/zoom on mouse, keybinds overlay (H) from a single-source bindings table, outcome banners, live C&W tiles, V controller cycle, Backspace abort; manual-rate over-damping fixed
  - **Review**: review loop, 2 rounds -> APPROVED (`CR_w1_v0.5.0.md`), 5 Majors fixed; 99 tests


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
  - **Setup**: Initialized project docs structure; repo pushed to GitHub (`crgonzales/docking-sim`, `main` branch, GitHub-first flow — commits on main, always pushed)
  - **Documentation**: Folded in pre-seeded ARCHI.md (full-stack web sim: pure-TS sim-core library + React/react-three-fiber front end); created ARCHI-rules.md and TESTING.md
  - **Skills**: Adapted all project tooling to the project (pnpm/Vitest commands, root package.json as version file, week anchor 2026-08-03, main-only release flow, GNC-specific plan guidance and review checklist)
  - **Files Added**: docs/ARCHI-rules.md, docs/2-changelog/changelog_table.md, docs/4-unit-tests/TESTING.md
