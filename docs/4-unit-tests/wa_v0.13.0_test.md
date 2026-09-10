# Test summary — F/A-18-style flight prototype

Planning version 0.13.0; no release/version bump. Date: 2026-09-10.

## New behavior tested

- 12 pure flight tests: atmosphere reference points/continuity; vacuum ballistic oracle; lift/sideforce orthogonality and drag work; wind Galilean invariance; torque-free momentum, energy and quaternion norm; aerodynamic damping; solved trim/90 s level flight; control signs; analytic engine spool lag; density/thrust lapse; zero/reverse airflow and post-stall continuation; determinism, immutability, contact/domain latches and invalid input rejection.
- 5 web adapter/session tests: cardinal frame mapping, altitude, metric and handedness invariants; identical flight trajectory at 30/144 render fps; pause/blur/reset/catch-up handling; control signs and held throttle/trim.
- Isolated browser: keyboard pitch/roll/yaw/throttle/trim, pointer-held pitch, slider, wind, pause/reset/blur, chase/nose cameras, mode disposal/reentry and default SANDBOX. Screenshots visually inspected at 1440×900 and 900×650.

## Results

- New flight tests: **17 passed**, zero failures.
- Workspace typecheck and production build: **passed**. Existing shared-bundle size warning only.
- Full sim-core regression suite: **117 tests across 20 files passed** (1,887.13 s wall time). This includes the 12 new core flight tests. With 5 focused web tests, **122 tests passed total, 17 new**.
- Final core typecheck and final flight-test rerun after parameter-validation review: **passed**.
- `git diff --check`: **passed**; index remains unstaged.
- Coverage percentage: not measured; no coverage exemptions introduced.
- Browser: no application exception. Confirmed inherited `/favicon.ico` 404. An initial development screenshot timeout/hot-reload interruption was superseded by the clean browser pass.

No new test exclusion, timeout extension, or baseline-test change. The large orbital suite ran on a heavily loaded shared host; no frame-rate guarantee is inferred from this run. No external agent review was invoked under the explicit no-further-agents instruction.

See [handoff and evidence](../6-memo/f18-flight-prototype.md) for commands, actual browser observations, data provenance, limits and ignored evidence artifacts.
