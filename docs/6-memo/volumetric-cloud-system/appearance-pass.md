# Cloud appearance pass — September 10, 2026

Worktree: `docking-sim-eve-clouds`. The imported
`docking-sim` checkout is unchanged. Previous rollback:
`eve-integrated-checkpoint` (`9ec0000abdd45f57a82a0478535991222324c418`).

The user accepted the new visual direction at the original 20 km, pitch −20°,
yaw 90° reference view. This is acceptance of the direction, not a claim of full
Blackrack EVE parity or completion of all renderer-plan phases.

## Appearance

The old field repeated small, similar lumps and lost most cloud coverage from
orbit. The new field combines coherent large formations with a separately
rotated, finer Perlin/Worley field. Smaller billows now influence the silhouette
instead of only eroding an otherwise flat cloud top. Weather coverage continues
to open real gaps; it does not multiply the opacity of every existing cloud.
Camera rays, sunlight, ambient visibility and surface shadows use the same
physical density function. Type transitions blend samples from fixed physical
domains, preserving the earlier fix for moving texture phases.

The noise texture is now 64³ RGBA8, up from 32³. This gives four samples per
smallest Worley cell instead of two. All weather textures, including mipmaps,
use 2,618,320 nominal GPU bytes; the medium light volume remains 3,145,728 bytes.
No additional view/history targets were introduced. At the tested 972 × 1115
view, the cloud view/history allocation is 22,760,352 bytes.

The near-sun integral now uses four samples over 1,200 m for local self-shadowing.
The cached remainder still starts at the integrated near endpoint, so the two
segments do not count the same extinction twice.

Stationary reconstruction uses exact previous-pixel correspondence, avoiding
roundoff-induced sampling across clear edges. Fresh rays now accumulate. An
opt-in 800 m representative-depth allowance follows the authored maximum ray
step; moving cameras keep the strict depth guard. This is an error budget,
not a proven bound: real stationary depth changes within 800 m can blend, and
budget-driven ray segments can exceed it. Clear pixels, cuts, nonfinite data
and larger depth changes still reject history.

## Validation and limits

The affected cloud unit suite passes 105 tests in seven files. The workspace
production build passes, with the existing large-bundle warning.

Views inspected during authoring include 400 km, 20 km, 6 km, 3 km and 1 km.
The settled 20 km and 400 km reference views reached 60 FPS on the local Apple
M3 at DPR 1, medium quality. An inside-cloud 3 km view was around 25–28 FPS;
loading, cache construction and concurrent previews also produced much slower
transients. These observations are not a controlled hardware benchmark or a
claim about low-end hardware. Final evidence and independent review are recorded
alongside this note after verification.

The rotated secondary field suppresses obvious short repeats; it is not modern
EVE's complete detiling implementation. Its finite periodic data still has long
common repeats (for example, the current stratus scales along ECEF Z). The
weather field further modulates those patterns. Some grain during movement and
the wider terrain/descent performance work remain open.

Architectural reference: the author's [raymarched cloud configuration](https://github.com/LGhassen/EnvironmentalVisualEnhancements/wiki/Raymarched-cloud-configuration)
and [temporal upscaling and noise detiling](https://github.com/LGhassen/EnvironmentalVisualEnhancements/wiki/Temporal-upscaling-and-noise-detiling)
documentation. This remains an EVE-inspired field on the maintained Takram
backend, not a verbatim copy of the modern EVE renderer.
