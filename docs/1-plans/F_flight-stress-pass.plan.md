# Flight visual stress pass

Scope: follow checkpoint 8728d77 with actual aircraft maneuvers. Inspect the reported center line, banked chase/nose views, changing sun reflection angles, climbs into clouds and low-altitude descent. Keep one game tab on port 5175. Character work lives in a separate worktree.

## Implementation

- [x] Add a small development-only flight exercise panel behind `?mode=flight&flightProbe=1`. Reusable, bounded maneuver inputs run through the existing fixed-step flight dynamics. No camera/position teleporting during exercises; existing contact/envelope limits remain active. Include turn, climb and descent choices with explicit Start/Stop and status. Start resets to the known airborne trim; completion pauses. Manual input, reset, pause or focus loss cancels the exercise and releases its ownership. Default flight stays unchanged.
- [x] Reproduce and fix confirmed visual defects observed during flight. Record cause and before/after evidence; distinguish the physical sun reflection and instrument horizon from actual seams.

## Test impact / acceptance

- [x] Behavioral tests: identical maneuver trajectory across render rates; bounded completion; pause/focus-loss/reset/manual override clears scripted controls; safety terminal states stop exercises.
- [x] Actual browser passes in both cameras at banked attitudes and through cloud altitude changes, with screenshot evidence and console checks. One tab only.
- [x] Full workspace build and affected tests; independent code review; save development checkpoint and brief remaining limitations. No release, merge or push.
