# Airfield and first-person start

Ordinary `?mode=flight` opens on foot beside the parked Hornet on an original space-center airfield. The base adds a runway, taxiway/apron, hangars, control tower and separate landing pad to the existing Earth and EVE scene.

## Controls

WASD walks; Shift runs. Click the scene for mouse look; drag the scene if capture is unavailable, or use the arrow keys. F boards/exits the nearby parked aircraft. P pauses, R returns to the runway start, and Escape releases mouse look and pauses. 1/2/3 select empty hands, a tool or an inert equipment placeholder.

The parked aircraft stays stationary after boarding. Takeoff, landing gear suspension and runway contact physics are not implemented in this iteration. `?mode=flight&start=airborne` retains the airborne flight experience and its KSP-style controls. Development cloud-base fixtures retain their explicit airborne start.

## Surface and integration

The base uses one fixed tangent surface at the surveyed inland prototype site near 7°N, 0.02°E. Airfield geometry, character support and parked gear height share the site definition. The surface sampler intersects the radial direction from the existing flight chart with this plane, so curvature cannot separate the feet from the runway toward its ends. The base perimeter and building footprints bound walking; the aircraft itself has no collision volume and building interiors are not accessible.

This integrates the reviewed `first-person-character` prototype from its preserved worktree. The integrated version reconciles the flight session's private controls and exercise cancellation on parking, keeps flight controls isolated from walking, and retains the paused resize cloud warmup from c160798. It adds no renderer, composer or texture service.

## Validation

The integrated full workspace build passed. The affected suite passed 104 tests across 14 files, including base surface geometry, 210 m runway traversal, building/perimeter rejection, gear clearance, control ownership and boarding/reset. A browser-discovered mouse-capture refusal prompted the drag fallback and five further lifecycle cases; the final workspace rebuild passed and the 18-case lifecycle suite passed, for 109 distinct affected tests (61 added with this integration).

One game tab verified default spawn, actual keyboard walking/look, nearby board/exit, chase view, equipment switches and pause. An actual key-driven walk changed north position by 0.960 m and yaw from −1.391 to −0.023 rad with feet remaining on the plane (evidence flight-base-1789092645083). Embedded-browser mouse capture was not accepted during automation; drag ownership and cleanup are covered through the event adapter, while native dragging itself was not automated. The prior character prototype browser gap is closed for the integrated behaviors listed here, not for unimplemented ground flight physics.

Survey evidence `.evidence.local/airfield-terrain-survey.json` records all source hashes, runtime height/detail bounds and clipped mesh LOD 0–16. The final deck is 105 m MSL with bottom 70 m and ≥1.775 m clearance after conservative chart allowance. Runtime geometry uses 11 instanced material batches; no hardware performance improvement is claimed.

Final spawn evidence: `.evidence.local/flight-base-1789093347211.png` and matching JSON (feet 105.000010 m, aircraft COM 107.400000 m, correct on-foot camera, renderer ready). Explicit airborne start and conflicting ground/character cloud-fixture query were also checked in the browser. No new console errors appeared after the final reload; earlier HMR missing-module errors occurred while the delegated files were being created.

Independent plan review: APPROVED; verbatim findings and convergence are in `airfield-plan-review.md`. Final code review: APPROVED, no findings; see `airfield-code-review.md`. The integrated source checkout and the original character prototype worktree remain preserved.
