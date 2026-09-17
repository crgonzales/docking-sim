# GNC tools in v0.15.0

Open `?mode=gnc` or choose GNC from the mode switcher. The ordinary URL still
opens the first-docking briefing. The GNC mode owns one simulation session;
leaving it stops its publisher. Its diagram and plots subscribe to trace data
and do not drive the plant or expose truth to the flight software.

## Live and recorded data

The nominal and stuck-thruster cases use the same vehicle and initial state.
The fault case schedules J6 stuck open at 300 seconds and isolation at 340
seconds through the public injection/command API. Isolation is scripted, not
an autonomous fault detector. ABORT means the controller latched an abort;
it does not establish completed safe departure.

Pause, step a plant tick or an FSW window, inspect the signal blocks, and open
plots to compare requested and realized actuation. Plant truth, measurements,
estimates and commands retain separate provenance and timestamps. Recorded
JSON/CSV pairs include run identity and completeness. Import displays recorded
evidence separately from live telemetry; it does not replay the spacecraft.
Full session replay and live MATLAB integration remain future work.

## Headless Monte Carlo

Use Node 22 and the pinned pnpm version. Build the CLI separately from the game:

```sh
pnpm --filter @docking/web mc:build
node apps/web/dist/gnc-mc/gnc-mc.mjs
```

Invoking the CLI without a subcommand prints the required arguments and exits
with status 2. Choose `manifest`, `verify-bundle`, `run` or `aggregate` for an
actual operation.

The CLI runs without a renderer or real-time pacing. Worker threads process
independent seed pairs; the default concurrency is two. Its manifest fixes the
population before execution, and results carry bundle/configuration identities.
Aggregation rejects inconsistent duplicates and remains provisional while
expected runs are missing or unresolved. Sensor noise is the implemented
dispersion; vehicle mass, initial conditions and the fault schedule remain fixed.

The September 15 local campaign completed 1,000 pairs (2,000 runs): nominal
736 DOCKED / 264 COLLISION, and fault 1,000 ABORT after scripted isolation.
The nominal docking proportion was 73.6%, with Wilson 95% interval
[70.78%, 76.24%]. These are historical results for that frozen campaign,
not a new campaign against this release or a hardware reliability claim.
Remote Runpod execution is not delivered by this release.

## MATLAB and Simulink

From MATLAB in the repository root:

```matlab
addpath('tools/matlab-port');
report = run_matlab_port;
```

The model computes native six-DOF dynamics from valve pulses and fault codes;
it does not replay reference states. Verification compares the offline plant
with the TypeScript model and independent analytic/conservation checks.
See [usage](../../tools/matlab-port/README.md),
[API](../../tools/matlab-port/API.md) and
[measured verification](../../tools/matlab-port/VERIFICATION.md).
The separate LQR analysis is not a complete MATLAB docking autopilot.
Sensors, FSW/MPC, contact, live SIL/HWIL and automatic C/C++ generation remain
outside this MATLAB increment.

## Simulation foundations

The world-anchor and mount APIs declare coordinate frames and separate actual
installation geometry from assumed calibration. Optional mounted IMU sampling
generates noise and bias in sensor axes, then converts measured rates through
assumed calibration before the unchanged body-frame FSW interface. Tests use
synthetic mounts; no manufacturer sensor-layout accuracy is claimed.

Procedural vehicle/ascent APIs calculate geometry, mass/inertia, thrust/fuel,
aerodynamic forces, separation, parachute behavior and ground contact. They are
core foundations, with approximate aerodynamic coefficients and documented
integration limits. A rocket designer, guidance-driven launch, mission planner
and playable launch contract are not present in this release.
