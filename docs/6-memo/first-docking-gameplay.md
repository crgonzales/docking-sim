# First docking gameplay

Use MISSION → First docking, or `?mode=mission` with the existing renderer query.
The default sandbox and optional flight mode remain available. The mission
picker keeps the original six-minute emergency scenario as the advanced option.

The prepared Dragon starts six metres from port contact with a small sideways
offset. Live estimated port error drives Align / Approach / Capture prompts and
the head-on alignment diamond. A scene marker uses the existing physical port
datum. Capture is still the actual simulation outcome; no proximity-only win.

Shift/Ctrl translate fore/aft, I/J/K/L slide, WASD/QE rotate. X selects 0.07 or
0.25 m/s target translation; RATE holds attitude and the commanded position
after input release. Space recaptures the estimated pose and brakes using real
thrusters. Keep approaching explicitly maintains forward manual input, with
no automatic alignment. Fore/aft input, hold, pause and retry cancel it.

P pauses/resumes, R restarts the full approach, C changes view. Pointer clicks
produce a small minimum three-tick nudge; short keyboard taps survive a tick.
Focus loss pauses and clears controls; resuming needs an explicit action. The
two-metre practice option is a fresh prepared simulation, not a saved rewind.
No-input practice expires at 20 minutes; the emergency countdown remains visible.

Headless evidence: default-noise FINAL docks in 28.0s with fixed fine forward
input. A telemetry-only manually scripted full approach docks in 64.4s; both
produce identical seeded retry trajectories. Neither docks with no inputs over
1200s. Excessive forward speed collides. Vehicle coefficients and contact limits were unchanged. The timing figures above predate the damping adjustment below.

Limits: the HUD reads estimates and cannot guarantee the truth contact envelope.
RATE is a strong position/attitude assist; this is an introductory exercise,
not an orbital rendezvous campaign. Ground flight/character mode is unchanged.

## Live QA and follow-up

A full live approach exposed a hold-controller limitation: contact failed without
pilot rotation input. A headless reproduction measured 0.169 deg/s spin and only
2 mm lateral error. First docking now uses manual angular damping
[1200,800,1200] N m s/rad, providing I/Kd=0.5 s rate response for the shared
inertia. Proportional gains, vehicle dynamics, 20 ms minimum impulse, sensor
noise and capture envelope are unchanged. This is controller tuning, not a
truth-state correction. Quantized pulses can still produce short rate transients.

The HUD now derives lateral error from the rotated nose port, asks for a 6 cm
alignment margin inside the physical 10 cm envelope, and warns at the actual
0.15 deg/s spin limit. Contact advice reports estimates without claiming the
pilot pressed a particular control. Native Space button activation, cinematic
zoom bounds and short-viewport panel scrolling were corrected during review.

A full live mouse-controlled approach after the fix docked at 141.7 s, with
0.07 m/s closing speed, about 4 cm port offset, 0.55 kg propellant used and zero
corridor violations. The final-two-metre practice also reached the real DOCKED
debrief before tuning. Retry restored the seeded start. No second game tab was
opened.

Validation: 641 web tests, 132 sim-core tests and 24 first-docking tests passed.
The latter include 10 varied waiting/correction timings and seeded retries.

Full workspace build passed. Independent gameplay review approved after fixing
its five findings. The original emergency mission selection was verified live.
The Lucky Marlin source logo was visually verified on the curved Dragon shell
from the side; native capture `.evidence.local/rcs-J1-1789132461362.png`.
The corrected SMAA detector passed four GPU cases (see foreground-edges.md).
No release, merge, or push was performed.

Consolidated independent review: `.evidence.local/first-docking-code-review.txt`
(APPROVED / PROMOTION_READY). The raw synthesis lists working-tree files outside
its explicitly excluded renderer/livery scope and loosely mentions scoring/audio.
For clarity: this mission pass changed HUD/debrief port geometry, not scoring or
audio behavior. The five findings and their resolution are the reviewed changes.
