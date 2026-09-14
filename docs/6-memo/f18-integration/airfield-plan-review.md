# Independent airfield plan review

## Initial review

- [P2] [Line 10](docking-sim-flight-integrated/docs/1-plans/F_airfield-first-person.plan.md:10) — Define the survey against the runtime `height()` path, including its 35 m procedural detail and geometry LODs—not only the level 0–3 PNG pyramid—or terrain can protrude through the foundation. Fix: record the maximum runtime height and assert a concrete deck-clearance margin.

- [P2] [Line 13](docking-sim-flight-integrated/docs/1-plans/F_airfield-first-person.plan.md:13) — Route precedence is promised but unspecified. Fix: add a truth table, e.g. cloud fixture → fixture airborne; `character=0` → legacy airborne; otherwise `start=airborne` → character-enabled airborne; otherwise ground/on-foot.

- [P2] [Lines 14 and 21](docking-sim-flight-integrated/docs/1-plans/F_airfield-first-person.plan.md:14) — Deployed gear is required, but the necessary `HornetModel` change is called optional; the current adapter hides all gear. Fix: make the parked-model change mandatory while retaining airborne exclusions.

- [P2] [Line 33](docking-sim-flight-integrated/docs/1-plans/F_airfield-first-person.plan.md:33) — “Orbiting” parked view has no corresponding behavior or controls; the current session only supports CHASE/NOSE. Fix: say “chase/nose” or specify the orbit-camera behavior and tests.

REQUEST_CHANGES

## Convergence

1. “Survey the runtime `height()` path, including procedural detail and geometry LODs.” — **Addressed.** [Line 10](docking-sim-flight-integrated/docs/1-plans/F_airfield-first-person.plan.md:10) records all 12 octaves, raster LODs 0–3, geometry LODs 0–16, the continuous bound, allowance, and resulting clearance.

2. “Specify exact route precedence.” — **Addressed.** [Lines 13–21](docking-sim-flight-integrated/docs/1-plans/F_airfield-first-person.plan.md:13) provide an ordered route table covering the cloud fixture, `character=0`, airborne character mode, legacy airborne mode, and default ground mode.

3. “Make parked Hornet gear changes mandatory.” — **Addressed.** [Line 23](docking-sim-flight-integrated/docs/1-plans/F_airfield-first-person.plan.md:23) requires deployed gear, and [line 30](docking-sim-flight-integrated/docs/1-plans/F_airfield-first-person.plan.md:30) explicitly makes the `HornetModel` changes mandatory while preserving airborne exclusions.

4. “Clarify the undefined ‘orbiting’ parked view.” — **Addressed.** [Line 42](docking-sim-flight-integrated/docs/1-plans/F_airfield-first-person.plan.md:42) now correctly specifies the existing chase/nose views.

No new issues introduced by the edits.

APPROVED
