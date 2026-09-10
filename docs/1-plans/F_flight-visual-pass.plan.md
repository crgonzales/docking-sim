# Flight visual inspection and fixes

User request: do a fly-through and work out visual bugs. Continue from integration checkpoint a6964c2 in a dedicated branch, use one game instance on 5175, preserve the original checkouts. No release/push.

## Reproductions

- Hornet airborne start: the bright ocean glint washes out airspeed and nearby instrument labels. Give the numeric instruments a bounded translucent dark backing without changing camera exposure or obscuring the aircraft.
- Shared EVE scene at latitude 0, longitude 0, 1500 m, pitch -15°, yaw 0°: warmed ocean shows regular stippled bands near the horizon and rectangular shadow blocks. Shadows off removes both, leaving smooth reflection. Trace and fix the shadow producer/consumer while retaining cloud extinction and bounded GPU cost.

## Work

- [x] Capture a continuous orbit-to-ground descent and inspect multiple elevations, cloud boundaries and viewing angles, including terrain and the Hornet.
- [x] Keep the flight instrument numbers readable over the sun reflection.
- [x] Fix the reproduced shadow pattern at its cause, with a focused regression for any changed math/shader behavior.
- [x] Repeat relevant views and motion after changes; check errors and loading behavior. Record remaining source-data/performance limits honestly.
- [x] Let temporal clouds settle for a bounded number of redraws when the paused flight camera changes, without advancing physics.
- [x] Affected tests, build and independent review; save checkpoint and leave one paused game tab.

Architecture: shared library/EVE renderer, opaque material metadata and one composer remain. Pure flight dynamics and control mappings are unchanged. Shader tests should exercise production GPU code or independent numerical invariants where feasible. Browser visual checks are mandatory. Document evidence and limitations in docs/6-memo/f18-integration/visual-pass.md; no new user workflow or dependency is planned.
