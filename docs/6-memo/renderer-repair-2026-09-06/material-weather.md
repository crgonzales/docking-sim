# Material and weather increment — 2026-09-06

Patch 06 fixes a verified Earth-map orientation error and improves the library renderer's surface-lighting inputs. The structured cloud field is implemented but remains opt-in: its shallow orbital appearance is still too flat and grainy to replace the previous cloud field. This is a bounded prototype increment, not visual or performance approval for the renderer as a whole.

Apply `06-material-weather.patch` after patch 05. Base tree `d7be80e61dc99900ff6acab8fbc2a55e15a34a14`; result `22e78a9563b6dce7172d928785478cfd55acbc9f`. `material-weather-manifest.json` pins every changed source file and patch hash. A private temporary Git index applied the patch and exactly recreated that tree. The imported checkout and its original staged index remain byte-for-byte preserved; nothing was committed or merged.

## Confirmed defects and changes

**Earth imagery and the water mask were upside down.** SphereGeometry/geographic UVs put north at V=1, but the packaged KTX2 maps retain north-first rows without an upload flip. At the center-ray footprint of `flyto=40.5,-75,20000&pitch=-45&yaw=90`, the old lookup decoded southern-ocean RGB (20,56,109) and a water-mask value of 255. Flipping V decoded land RGB (64,55,30) and a mask near 1. The new regression test decodes an embedded mip of both shipped day-map tiers and the specular/water mask with the already bundled Basis transcoder. It requires no new dependency or network access.

The shared `earthMapUv` adapter corrects library-mode Earth day/spec lookups and terrain day lookups. It does not flip the PNG/global-weather field, DEM coordinates or geometry. The inactive legacy renderer still has other KTX consumers (night/normal/clouds); a legacy repair must coordinate their orientation and normal tangent conventions. Do not blanket-flip every texture.

**Low, flat land was also being painted sand-colored.** Library terrain now takes the same linear imagery albedo as the globe, removing the elevation-based sand tint. This exposes the actual map resolution; it does not create landing-scale surface detail.

**Water's normal coverage did not match its visible coverage.** The stock NormalPass overrides the custom water discard. `SurfaceNormalPass` retains Three's normal packing and logarithmic depth but applies the same interpolated water-mask discard. Two cached materials are restored after the pass, including error paths; ownership/disposal and pinned shader seams have tests.

**Water was diffuse-only.** The existing aerial lighting pass now reads water material metadata from opaque color alpha, evaluates dielectric Fresnel/GGX sunlight plus a rough sky reflection using the existing atmosphere LUT, then restores opaque alpha. Existing cloud attenuation precedes the BRDF and the aerial/cloud composite still runs once. Land has alpha 1; water has alpha 0.5. This contract is restricted to the current opaque library pipeline. Albedo-debug mode bypasses its decoder and exposes metadata alpha.

The water model remains approximate: fixed statistical roughness, no animated wave normals and no reflected clouds. It can remain dark looking steeply down under overcast skies. Do not brighten everything with an altitude-dependent exposure workaround.

## Structured cloud candidate

`weatherStructure=structured` enables a deterministic 1024×512 RGBA weather texture generated once from the existing NASA coverage proxy. Independent low-cloud, taller-formation and cirrus channels feed the existing Takram raymarch and shared shadow transport. Zero-valued coverage stays clear, longitude wraps, poles use a bounded mip reduction, and primary shape scale is larger than the previous small-puff field. CPU generation measured by the worker agent was 96 ms cold and 39–53 ms warm, excluding readback/upload; RGBA plus mips is approximately 2.67 MiB.

This is illustrative procedural weather, not inferred meteorology. The new field does not yet achieve the requested modern-EVE orbital cloud look. The default remains `weatherStructure=legacy`; the candidate needs further cloud-type/shape art and a measured distant representation. No new atmosphere solver, lighting cache or far shell was added.

## Validation and practical limits

- 225 affected tests / 20 files pass. Scope: library adapters, terrain water, terrain node sets and workers. `pnpm -r build` passes; its existing bundle-size warning remains. The final build includes the legacy-default selection.
- Independent agent review checked the integrated normal/mask/opaque-alpha/water/weather ownership path. The subsequent map-orientation change was independently diagnosed, proven against shipped pixels, and checked by the parent on the GPU. This is not a production release review.
- Parent inspected shallow orbit at 400 km, 20 km terrain/shadows, 3 km clouds and KSC shoreline, 50 m ocean, and the night side. Probe samples now record actual latitude, longitude, altitude and pitch so requested URLs cannot masquerade as actual camera poses.
- Two final cold descent recordings cover 400 km → 50 m at 50°N, 35°W, pitch −20°, yaw 90°, medium quality and DPR 1. Final timed samples stop at 63 m (structured) and 54 m (legacy); the live probe subsequently reaches 50 m. Nine sampled frames of the structured recording were inspected. No full-screen white frames appeared in those samples; this is not proof that every intervening frame is flash-free.
- Cold structured mean of one-second FPS intervals: **46.26**, minimum **18.9**, maximum interval P95 **238 ms**. Cold legacy: **45.79**, minimum **18.1**, maximum interval P95 **251.6 ms**. Both stall around terrain startup. An earlier warm structured run averaged 58.55 FPS. These are same-machine frame timings with recording overhead, not GPU timings or a controlled weak-hardware benchmark. Similar cold stalls in both cloud modes point toward terrain startup/compilation and warrant profiling before blaming the new weather texture.
- KSC shoreline inspection still reveals coarse polygonal water boundaries and dark, low-detail ground. Those are retained in evidence, not accepted as finished terrain. Cloud profiles remain visually unaccepted from orbit; night emissive/PiP integration and earlier prototype limitations also remain open.

`evidence-material-weather/manifest.json` identifies captures, JSON context, videos, test/build output and performance summaries. Earlier static images precede diagnostic-only changes; the final cold pair uses the result source tree. The initial cloud-size comparison is kept separately under the spike's `.evidence.local/material-weather/initial`.

## Continuation

Read this note and the previous handoff before changing the renderer. Preserve imported staged work; review/apply patch 06 after 05 as a separate increment. Use port 5174, never 5173. Confirm the real map orientation and preserve the material-alpha/normal-coverage contract. First profile the cold terrain engagement stalls, then improve coastal geometry and cloud shape/distant appearance using the existing library. Keep the structured weather opt-in until the same orbital, descent and shoreline views actually improve. Do not claim the renderer is finished because tests pass.

Default: `http://127.0.0.1:5174/?renderer=library&probe=1&quality=medium&dpr=1&flyto=40.5,-75,20000&pitch=-45&yaw=90`.

Candidate: add `&weatherStructure=structured`. Water comparison: add `&water=diffuse` or use the live water-reflection buttons.
