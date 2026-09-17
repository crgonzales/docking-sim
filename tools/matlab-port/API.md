# MATLAB-port API

All functions below are called after adding `tools/matlab-port` to the MATLAB
path. Vectors are columns unless stated.

`[config, fixtures] = docking.loadReference(referencePath)` loads
`fixtures/reference.json`. `config` is the `.config` object with `specs` as a
MATLAB struct array; `fixtures` is the complete decoded document. With one
output, `docking.loadReference()` returns the complete document. The config
schema includes `dt_s`, `window_s`, `truthHz`, `fswHz`, `ticksPerWindow`,
`meanMotionRadS`, `inertia_kg_m2`, `dryMass_kg`, `initialProp_kg`, `isp_s`,
`g0_mps2`, `minOnTime_s`, `initial.time_s`, `initial.state`, and `specs`.
Each spec has `id`, `position_body_m`, `direction_body`, `thrust_N`,
`nozzleRadiusM`, and `sourceComponent`.

`q = docking.normalizeQuat(q)` returns a 4x1 unit quaternion.
`q = docking.multiplyQuat(a,b)` and `q = docking.conjugateQuat(q)` implement
scalar-first Hamilton operations. `v = docking.rotateVector(q,v)` rotates a
3x1 vector. `q = docking.hillFromInertial(t_s,n)` returns q_IH.

`[nextState, derivative] = docking.stepTruth(state,dt_s,t_s,options)` uses
the numeric state `[r(3);v(3);q_BI(4);w(3);prop]` (14x1). `options` may contain
`meanMotionRadS`, `inertia_kg_m2`, `externalSpecificForce_body_mps2`,
`torque_body_Nm`, and `propellantRate_kg_s`. `derivative` is the RK4 weighted
derivative before propellant bookkeeping.

`application = docking.applyThrusters(command,config)` resolves one command
vector in `config.specs` order. Optional config fields are `states` (a struct
mapping IDs to `nominal`, `isolated`, `stuck_open`, or `stuck_closed`),
`prop_kg`, `window_s`, `truthHz`, `minOnTime_s`, `isp_s`, `g0_mps2`, and
`dryMass_kg`. The result has column vectors `quantizedOnTime_s`,
`activeOnTime_s`, `force_N`, `torque_Nm`, `specificForce_body_mps2`, plus
`specificForce_hill_mps2`, `propellantRate_kg_s`, `propellantUsed_kg`,
`exhausted`, and `ids`.

`result = docking.runPulseCase(caseDefinition,config)` integrates a fixture
case for `caseDefinition.ticks` updates. A case has `id`, `startTime_s`,
`dt_s`, `ticks`, `commands` (10 Hz structs with `quantizedOnTime_s` ID
fields), and `events` (`tick`, `kind` = `STUCK_OPEN` or `ISOLATE`, and
`thrusterId`). The result has `time_s` (1xN+1), `states` (14xN+1), one
`applications` struct per completed tick, and final `faults`. The initial
sample is before any update; the final sample is exactly after N updates.

`[phi,gamma] = docking.cwDiscreteMatrices(n,dt_s)` returns the 6x6 CW state
transition and 6x3 constant-specific-force input matrix.

`analysis = analyze_lqr(config,outputDirectory,fixtures)` performs the
augmented-exponential CW ZOH discretization and `dlqr` comparison. Its
`status` is `PASS` or `SKIPPED`; when available it includes `gain_3x6`,
`dareResidual`, `closedLoopEigenvalues`, `trajectory`, `forceDemand_N`, and
max-error comparisons to the fixture. It writes the ideal-analysis plot.

`[commands,faults] = docking.pulseInputs(caseDefinition,config)` converts raw 10 Hz
requests into the 100 Hz pulse and fault-code arrays used by Simulink.
Both numeric arrays have relative time in column one and 16 jet values in
the remaining columns. Fault codes are 0 nominal, 1 isolated, 2 stuck open,
and 3 stuck closed.

`modelPath = build_spacecraft_model(outputDirectory,config,caseDefinition)`
writes `dragon_sixdof.slx` in Normal mode. The case defaults to nominal.
Workspace pulse/fault sources drive `sfun_docking_rcs`; the resulting body
acceleration, torque and fuel flow drive `sfun_docking_sixdof`. The model
logs `truthLog` and `actuatorLog` and has propellant feedback. Its initial
sample precedes the first update. It requires Simulink and does not compile C.

`report = verify_matlab_port(outputDirectory)` runs source freshness,
independent analytical and actuator oracles, native/TypeScript parity, LQR
and real Simulink parity/reset checks. It writes `validation.json` before
raising an error on failure. Missing optional products yield `SKIPPED` checks
and overall `PARTIAL`; only all executed passes produce `PASSED`.

`report = run_matlab_port(outputDirectory)` first runs that complete gate,
then writes trajectory, attitude, fuel and ideal-LQR plots, `native-runs.mat`
and `run-summary.json`. All generated files default to this folder's ignored
`output/` directory. The saved Simulink model is runnable in the desktop;
batch execution does not attempt desktop-only diagram printing.
