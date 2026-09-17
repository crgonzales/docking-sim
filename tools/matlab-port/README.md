# Native MATLAB six-DOF port

This folder is an offline analysis companion for the browser simulator. It
contains a portable native MATLAB plant, deterministic TypeScript-generated
fixtures, an executable Normal-mode Simulink model, and an independent CW LQR
analysis. It does not port sensors, navigation, FSW, MPC, docking latches, or
the browser flight loop.

## Run

From the repository root:

```sh
node tools/matlab-port/exportReference.mjs
node tools/matlab-port/exportReference.mjs --check
```

In MATLAB, add `tools/matlab-port` to the path and run `report = run_matlab_port;`.
The entry point writes ignored diagnostics to `tools/matlab-port/output/`.
`build_spacecraft_model` writes `dragon_sixdof.slx`; open it with
`open_system('tools/matlab-port/output/dragon_sixdof.slx')`. Simulink and the
Control System Toolbox are optional. A missing product is reported as
`SKIPPED`, with overall `PARTIAL` status. The entry point calls
`verify_matlab_port.m` first, including actual model simulation when Simulink
is installed. A failed check writes its report and stops the entry point.

## State, frames, and equations

Every native plant function uses the numeric 14x1 state
`[r_hill_m(3); v_hill_mps(3); q_BI(4); w_body_rps(3); prop_kg]` with time
passed separately. Quaternions are scalar-first Hamilton `[w x y z]`; `q_BI`
rotates inertial vectors into body axes. Hill x is radial-outward, y is
along-track, and z is cross-track. All quantities are SI.

The translational equations are CW:

```text
x'' = 3 n² x + 2 n y' + a_x
y'' = -2 n x' + a_y
z'' = -n² z + a_z
```

Body acceleration is rotated with
`q_HB = conjugate(normalize(q_BI * q_IH))`, where `q_IH` is the +z rotation
by `n*t`. Attitude uses
`q' = 0.5 * [0,-w_body] ⊗ q_BI` and
`w' = (torque - cross(w, I.*w))./I`. RK4 runs at 100 Hz and the quaternion is
normalized after each complete step. Inertia is constant diagonal
`[600 400 600] kg m²`; mass is dry mass plus current propellant held for the
step.

## Actuators and model blocks

`applyThrusters` uses the public Crew Dragon artist-model registration (16
jets), 25 N per jet, 220 s Isp, 976 kg dry mass, 24 kg initial propellant,
and 9.80665 m/s². It preserves 20 ms whole-pulse deadband, 100 Hz rounding,
nominal/isolated/stuck-open/stuck-closed states, `r cross F` torque, and
common exhaustion scaling. `runPulseCase` supplies quantized 10 Hz windows
as ten real 100 Hz slices; slice calls set `minOnTime_s=0` as required by the
browser truth loop.

The Simulink model has editable 16-channel pulse and fault sources, separate
Level-2 MATLAB S-functions `sfun_docking_rcs` and `sfun_docking_sixdof`, and
actuator/truth loggers. The actuator computes force, torque and fuel flow;
the plant integrates all 14 states and feeds remaining fuel back to the
actuator. Initial state is emitted at time zero, followed by 1,000 real
10 ms updates. The saved nominal model contains its inputs and can be run
directly after adding this folder to the MATLAB path. It uses Normal mode
and requires no generated C or compiler.

## Verification interpretation

`exportReference.mjs` is the checkout-based parity source. It loads the public
sim-core index through the installed Vite server-side loader, records geometry,
constants, commands, faults, every truth sample, actuator oracles, CW
matrices, and LQR values, then records SHA256 hashes of the source files used.
`--check` fails if any recorded source is missing or changed. Native MATLAB
functions remain usable without Node; only parity validation needs the
checkout and installed dependencies. Regenerate twice to verify byte stability
before comparing native output.

The LQR plots and metrics describe unsaturated ideal full-state feedback. They
are not a thruster-limited docking demonstration or a noisy navigation
experiment. Geometry and numerical parameters are artist-derived/tuned game
values, not SpaceX flight data.

On 2026-09-17, MATLAB R2026a Update 5 on Apple silicon passed all eight checks.
Both the nominal and stuck-open/isolation cases matched the TypeScript
trajectories to within 2.3e-16 m in position and 2.1e-15 in quaternion component
distance. Simulink matched native MATLAB exactly across 1,001 samples in each
case; repeated runs reset to identical results. Independent conservation,
analytical dynamics, actuator and LQR checks also passed. These are numerical
verification results, not validation against a real spacecraft.

The generated `output/validation.json` contains source hashes and measured
errors for every check. `output/run-summary.json`, figures and `native-runs.mat`
are produced by the complete entry point. See `VERIFICATION.md` for the current
measured results and artifact location, and `API.md` for function signatures.
Regenerating fixtures after source changes requires a fresh MATLAB run.

## Public helpers and next steps

Exact MATLAB signatures and returned schemas are in `API.md`. The next larger
scope is closed-loop integration: full FSW, noisy sensors, estimators, MPC,
contact logic and the planned SIL bridge. Those systems remain unfinished in
this native port.
