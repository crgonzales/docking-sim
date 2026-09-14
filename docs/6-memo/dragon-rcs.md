# Dragon capsule and RCS integration — 2026-09-11

The active chaser uses KUBAHA's CC BY 4.0 Dragon 2 model, attributed in
`apps/web/public/assets/ASSETS.md`. The downloaded GLB is kept unchanged. Its trunk,
capsule, nose cover and small hardware remain separate. Only the nose-cover
animation is sampled: playing the full source animation also detaches the trunk.
The model is scaled to a 3.7 m capsule diameter and its docking face is registered
to the simulation's +Y port anchor at 1.7 m.

Sixteen nozzle positions/axes were recovered from the source mesh. Side axes use
the recessed circular backplanes; origins sit at the mouth lips. Four forward
mouths exhaust along +Y. `CREW_DRAGON_THRUSTERS` is shared by simulation and
presentation, so force is opposite exhaust at the same body-frame point.
Geometry tests check all forward rays against the actual GLB and check mouth
separation. Positive/negative force and torque requests are feasible in all axes.

Exhaust uses small local volume meshes and actual fired duty, including fault
firing. Alpha-only plume meshes are excluded from opaque normals/lighting masks.
The library renderer composites emission after atmosphere and before tone mapping,
using original opaque depth to hide gas behind the capsule. Side and forward
mouths were inspected in the running game; this is stylized visible emission,
not a calibrated simulation of Draco combustion or vacuum plume chemistry.

Audio uses a bounded bank of 16 synthesized valve/body/gas voices, driven by
actual firing with positional panning and shared volume/mute controls. This is
designed vehicle feedback, including external camera views, not sound traveling
through vacuum. The offline preview exercises the same bank and checks channel
separation, finite output, release silence and clipping. It has not been assessed
by an audio listening test.

Integration exposed three simulation issues:

- The bounded allocator released variables twice per iteration and could cycle
  on the new clustered axes. It now completes the free-set solve before releasing
  another bound, with a small numerical tolerance at bounds.
- Endpoint-only 10 Hz gyro sampling aliases short torque pulses. The simulator
  now models an IMU window-mean rate from 100 Hz integration, retaining sensor
  bias/noise. Instantaneous rates remain the control feedback. A zero-noise
  gyro-only pulse test bounds attitude propagation error independently of docking.
- A 5 cm spherical contact trigger contradicted the 10 cm lateral capture
  envelope. Contact now uses the docking face and its 0.85 m modeled radius;
  speed, lateral, angle and rate capture criteria remain enforced. Tests cover
  valid 8 cm offset, collision at 15 cm, and a 90 cm miss.

The scripted operator now fits its takeover position/velocity, aligns the actual
port, holds LVLH angular rate and settles into a low-speed crawl. Monte Carlo uses
integer 10 Hz ticks instead of accumulating floating-point time. All 14 scenario
tests, including the required successful docking, pass. This does not establish
successful docking across every noise seed or failure combination.

The game retains its 25 N jets, tuned mass and inertia. Model geometry is an
artist's reconstruction, not a manufacturer-specified Dragon flight model.

Final validation: web build passed; 616 web tests, 127 simulation tests and 14
scenario tests passed. Cloud/foreground verification passed 806 GPU cases.
Audio evidence: `.evidence.local/rcs-audio-1789128366017.wav` and its JSON report.
Forward/side plume captures: `.evidence.local/rcs-J13-1789128365286.png` and
`.evidence.local/rcs-J1-1789127200707.png`. Only one game tab was used.
