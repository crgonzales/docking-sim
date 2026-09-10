# Integrate the reviewed flight mode with the stabilized EVE environment

User authorization: integrate the flight prototype now, use KSP primary flight controls, and find a better reusable Hornet model. Reuse only one game tab on port 5175; 5173 is reserved. This worktree starts from renderer snapshot e2f0977 and imports only reviewed flight delta 153957b..753b609d. Original checkouts and indices remain intact.

## Required behavior

- [x] Import the reviewed independent FLIGHT session, HUD, physical model and frame adapter.
- [x] W/S nose down/up; A/D yaw left/right; Q/E roll left/right; Shift/Ctrl increase/decrease throttle. Keep arrow aliases, trim/pause/reset/camera. Ctrl must be accepted as a throttle key; allow simultaneous steering, preserve native widgets and unrelated modifier shortcuts. Both left/right modifier keys work. Keyboard/pointer ownership and pause/blur cleanup survive.
- [x] FLIGHT always uses the stabilized library atmosphere, EVE clouds, cloud shadows and opaque terrain, including entering via the mode selector from a plain URL. Existing nonflight renderer query behavior stays unchanged. Use explicit component options for renderer selection rather than new globals or rewriting the URL. LibraryEffects owns the one final compose; FlightScene owns its one camera and floating origin. Parameterize every Earth/TerrainPatches/terrainShaders library dependency consistently; no duplicate shaders or new renderer.
- [x] Retain the bounded equatorial ocean physics chart and its contact rules; no land collision or flight physics redesign. Lit aircraft and camera offsets have correct units. Use realistic existing sun/sky treatment where possible, avoid double exposure/atmosphere. Preserve usable fallback while assets load. Medium EVE quality and DPR1 defaults for FLIGHT with existing diagnostic query overrides.
- [x] Find a better clearly licensed Hornet asset, download only if authorized reuse and official access are available. Normalize dimensions/axes and budget before replacing original mesh. No purchases. Parent owns this independent research/integration item.
- [x] Update current guide and architecture notes, noting integrated environment and actual model provenance.

## Implementation batch

Delegate only environment integration checkbox and its docs: Earth/terrain shader library flags, LibraryEffects explicit EVE/exposure/quality options and FlightMode wiring. Keep changes near 300 lines, avoid broad refactors. Parent owns control tests, assets, browser, final review.

## Validation

Affected web controls/frame/terrain/lighting tests and workspace build. Full sim-core public API gate for imported flight additions, with bounded worker count. Use same browser tab to check actual control directions/throttle/release, chase/nose and FLIGHT → other mode → FLIGHT (plain URL mode entry too). Check no GLSL errors, no missing atmosphere/runtime assets, correct sky/ocean/cloud presence. Independent review; save a verified checkpoint without release/merge/push. Document measured limitations honestly.
