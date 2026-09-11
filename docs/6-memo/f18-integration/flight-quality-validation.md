# Flight visual quality validation

Completed local checkpoint on `codex/flight-visual-quality`, based on `5a34b36`.
Trees and birds follow this pass; they are not included in this checkpoint.

The subsequent [aircraft shadow-band fix](flight-shadow-bands-validation.md)
updates shadow settings and records new matched visual evidence and costs.

## Baseline

One existing in-app browser tab on port 5175, Apple M3, 981 × 1115 viewport.
The camera is paused beside the parked aircraft at 10:00:16 local solar time.
Before evidence: `.evidence.local/flight-base-1789101614867.png/.json`.

Visible issues: bright washed-out upper fuselage, jagged silhouettes and markings,
and pavement with little visible texture. The existing 1024-square local shadow
is visible and must survive the changes. Baseline composer has no multisampling
or final scene anti-aliasing. The prior warm moving-weather sample at this size
was 33.36 FPS; it is a reference, not a matched performance comparison yet.

## Source asset audit

The Hornet GLB has a 2048-square RGB hull map, with sRGB/trilinear filtering
already set correctly but anisotropy 1. Its painted hull roughness is 0.94054;
glass roughness is 0.96502 with alpha 0.15086. Metalness is zero. There are no
normal, AO, emissive or metallic-roughness maps. All 38 primitives have UVs and
finite unit normals. Preserve those source normals and cached materials/textures;
recomputing normals would facet the many split vertices. New filtering settings
belong to owned texture handles, whose disposal must not close shared images.

## Verification scope

Ground close-ups and grazing views, lit/shaded aircraft, noon/overcast/sunset/night,
paused preset comparisons, moving flight and cloud-base views are checked in one
game tab. The sections below distinguish intermediate evidence from final checks.

## Offscreen atmosphere regression found during this pass

Adding any pass after atmosphere (SMAA or a plain CopyPass) exposed shared GPU
depth storage in the installed postprocessing6.39.4 / Three r170 combination.
The composer clones its input, output and stable depth textures; Three shares
their Source and reuses the same WebGLTexture. Direct inspection confirmed both
input/stable and output/stable GPU handles were identical. Each offscreen
atmosphere draw returned GL1282 and left the raw scene in the output. Rendering
the atmosphere directly to the screen hid the problem.

The app now detaches cloned depth sources before first GPU use, preserving the
texture objects already borrowed by passes. The same trace then showed distinct
GPU handles and GL0 in cloud, atmosphere and SMAA passes. At a clear-sky pixel,
the atmosphere changed the raw scene to its expected blue and the final pass
displayed RGB[37,60,103]. The actual screenshot again includes sky and clouds.
Temporary pixel-readback/copy diagnostics were removed; DEV sceneAA=off remains
for an explicit comparison. No shared dependency files were modified.

Other review corrections: Canvas owns the resolved capped DPR to prevent parent
updates restoring an uncapped value; enabling AA from the legacy fixture creates
the required pass; late-loading effects adopt the latest selected preset. Both
presets cap scene pixels at2.5M so High never becomes lower-resolution than
Balanced on large displays. Filtering is8x/16x, clamped to device support.

## First graphics-switch check (before final local-light integration)

Paused Balanced→High→Balanced captures: `flight-base-1789104525513.json`, `flight-base-1789104555516.json`, `flight-base-1789104582095.json`. Camera, character and full environment-clock snapshots are identical in all three. Drawing size changed981×1115→1471×1672→981×1115. Geometries148/textures46 remained stable; programs39→40→41 (follow-up needed to distinguish warmed shader variants from a leak). Cloud light-cache generation stayed1. Cloud view resources increased from22,974,444 to31,464,384bytes at the existing1.5M-pixel ceiling, then returned to22,974,444; High does not expand that ceiling. These captures precede the sky/cloud receiver integration and are not final appearance/performance evidence.

Second High/Balanced cycle (`flight-base-1789104659988.json`, `flight-base-1789104688424.json`) stayed at148geometries/46textures/41programs. The two additional programs were bounded warm variants, not growth on every switch.

## GPU depth regression

The single-tab production conformance run passed687cases, including38new composer-depth assertions, with no failed cases. It checks actual float-buffer pixels after two offscreen effect swaps, distinctGPUdepthhandles, independentresize, and synchronouscanvas/renderer-state restoration. Evidence: `.evidence.local/capture-eve-medium-full-1789104785299.json`. This run precedes final localPBRshader integration.

## Preliminary running cost

Before the localPBRcloud integration, Balanced at981×1115 with live1xweather recorded1,466scene frames over32.3342s =45.34FPS after terrain/LUTwarmup (`flight-base-1789104891761.json`). This is a preliminary single-view sample; repeat after the full lighting bridge lands.

Preliminary High warmed run: 1122frames /38.2620s = 29.32FPS at1471×1672. Returned to paused Balanced immediately afterward. Final lighting may change this cost.

## Integrated PBR verification

The complete GPU conformance run passed 732/732 cases, including 45 new actual StandardMaterial/airfield assertions, with no failed cases (`capture-eve-medium-full-1789106015802.json`). The full web suite passed 608 tests in 69 files and the complete workspace build passed. This precedes the final diffuse-cloud correction described below; its affected GPU checks must be rerun.

Two real integration defects were corrected: missing media ABI declarations broke the first PBR shaders, and marking StandardMaterial with LIBRARY_LIGHTING selected a second aerial relighting pass. Standard materials now remain outside that mask. Already-compiled Three program uniform maps also adopt borrowed identities in place, so asynchronous binding and cloud-owner recreation cannot leave stale placeholder/disposed texture uniforms. Actual GPU tests exercise pre-bind compilation, clear/rebind on the same material, ordinary/instanced rebases, point lights, emission and shared ownership release.

The close High pavement view exposed oversized smooth noise. Asphalt is now a 0.75 m tile with fine aggregate and grain; concrete uses 1.5 m tiles. Explicit linear-light mips and normal filtering remain, as does the six-texture ~2 MiB budget. High close-up evidence: `flight-base-1789105970779.png`.

## Overcast correction

At 15:00, cloud attenuation made the aircraft almost black (`flight-base-1789106305555.png`). Isolating that hook restored visible fuselage detail, while captured sky-probe coefficients were finite and nonzero. The shared ambient integration had reused direct Beer extinction, treating scattered photons as lost.

The ambient cache/fallback now uses symmetric two-flux transmission along the same quadrature paths, integrating absorption, scattering and its phase-weighted asymmetry. The conservative limit is `1/(1+(1-g)*tau/2)`, while a pure absorber keeps `exp(-tau)`. Direct shadows, cache/channel counts and ray budgets are unchanged. This is an approximation to diffuse transport, not full 3D scattering or a solar-to-diffuse source solve. References: [conservative Coakley–Chylek solution, eq.11](https://amt.copernicus.org/articles/13/3909/2020/), [two-stream transfer coefficients](https://proteus-framework.org/SOCRATES/Explanations/two_stream.html). Corrected 15:00 view: `flight-base-1789106624021.png/.json`.

Noon and 17:30/18:00 were visually inspected. The fixed daylight exposure retains strong backlighting at sunset. At 22:00 the direct light is zero and the base is dark (`flight-base-1789106643675.png/.json`); artificial runway lighting, moonlight and eye adaptation are not implemented by this pass.

Before the diffuse correction, the integrated Balanced ground view ran 3,481 scene frames /70.1294 s =49.64 FPS after warmup (`flight-base-1789106129757.json`). Its initial loading sample was 35.99 FPS and the first composer use took 301.8 ms including shader setup; these are excluded from steady-state figures. Recheck after the final correction.

## Final verification

- Complete GPU run: **759/759 passed**, including 27 diffuse-transport checks against analytical limits and an independently integrated boundary-value oracle (`capture-eve-medium-full-1789106878848.json`). The existing thresholded-coverage cache oracle now uses conservative scattering for its ambient expectation; direct Beer expectations remain unchanged.
- Full web suite: **608/608**, 69 files. After the final scattering/texture changes, focused material/sky/bridge tests passed 9/9 and the complete workspace build passed again. Build retains the pre-existing large-bundle advisory.
- Final paused Balanced/High/Back/High evidence: `flight-base-1789106653837.json`, `1789106669464.json`, `1789106690536.json`, `1789106709355.json`. Camera, character, physical state and environment-clock snapshots are exactly equal. Shadow maps switch 1024→2048→1024→2048. Geometries/textures remain148/47; programs settle38→39→40→40. Light-cache generation remains22, valid at age0, with unchanged3MiB light-cache allocation. Cloud-view allocation returns to its prior size each time.
- Final High moving-weather sample: **1186frames/36.0827s =32.87FPS**, 1471×1672, DPR1.5 (`flight-base-1789106788946.json`). This is one M3 viewport/view, not a universal performance promise. GPU timings overlap and are not summed into frame times.
- An airborne climb was observed from1500m through~3000m, plus the banked cloud-base fixture with explicit Balanced graphics. No new shader/GL errors appeared; the console's earlier05:42 errors belong to the already-fixed ABI experiment. The airborne check exposed controls overlapping the airspeed instrument; the settings stack now sits above the instruments.

Remaining visual limits: the source Hornet uses a2K painted map with no normal/AO map, so High cannot invent finer aircraft detail. Thin cloud edges can retain temporal grain on medium; this pass adds scene AA, not a new cloud reconstruction method. Overcast diffuse transmission is approximate and omits a full solar-to-diffuse source solution. Fixed exposure can produce sunset silhouettes, and the base has no moon/artificial night lighting. Local shadow resolution is finite; High improves it at a measured cost.

Final Balanced sample after diffuse correction: **3,435frames/71.8196s =47.83FPS**, 981×1115, DPR1 (`flight-base-1789107260509.json`). Geometries/textures/programs were148/47/38 on this fresh mount. Both final preset costs exceed the accepted30FPS floor in this single warmed view; High remains opt-in because cost varies with viewport and weather.

The final independent code review returned **APPROVED**, with no findings (`docs/3-code-review/CR_wa_v0.11.0.md`, review thread `01a08f07-2737-7680-8461-03569fee3579`). Additional shared-renderer views at400km and20km showed no new rendering failure. The normal `?mode=flight` runway view was restored and paused on Balanced; only one game tab remained. No new console errors after the fixed05:42 shader experiment. Trees/birds remain the next scope.
