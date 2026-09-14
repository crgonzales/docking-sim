# Procedural terrain materials — stabilized first pass

User direction (2026-09-10): derive close terrain detail from the broad Earth
image and regional properties, inspired by SpaceEngine.

SpaceEngine documents medium-scale biome samples and fine soil materials,
selected by color and slope, with multiple detail scales and tiling reduction:
https://spaceengine.org/manual/making-addons/planet-biome-presets/
Its terrain engine also uses material weights in quadtree splat maps:
https://spaceengine.org/news/blog171102/

Our current Earth image is 4096×2048. At the reported Canadian site, a pixel
covers about 6.7 km east-west and 9.8 km north-south. Decoding the actual packaged
image gives RGB (90,94,87) and (125,127,122) for adjacent pixels. The gray blur is
already visible in the albedo-only diagnostic with clouds disabled; it is not
solely an atmosphere or cloud problem.

First slice: preserve geographic DEM geometry and coastlines, and add
deterministic material detail conditioned on imagery, elevation, latitude and
slope. Regional imagery remains the large-scale color anchor. Color alone is
ambiguous, so material selection is an artistic heuristic, not real land-cover
classification. Generated surface details are plausible, not surveyed features.

- [x] Add a small shared, seeded, mipmapped material-noise resource, with bounded
  memory and explicit owner disposal; no per-tile texture allocation.
- [x] Add medium/fine color variation and matching small-scale shading normals,
  fixed in planet coordinates. Fade unresolved frequencies and preserve the
  orbital color. Keep water and the legacy renderer outside this material pass.
- [x] Verify cloud-free and fully lit views at the reported Canadian location,
  reference site, mountains and several elevations. Run affected tests/build and
  independent review. Record limitations and evidence before claiming success.

## Precision correction during ground testing

The first integrated detail shader produced diagonal striping at 4.311 km MSL
and black speckles in the close view at 46.472°, −73.6077°, 615 m MSL,
pitch −53.02°, yaw 90°. It evaluated fine noise and derivatives in Earth-sized
float coordinates. Fine differences were lost before the normal gradient was
computed.

Noise and footprint derivatives now use patch-local metre coordinates. The CPU
reduces each patch origin into the periodic field's phase in double precision,
using the same domain matrices as the shader. This preserves a geographically
fixed field while retaining local precision. Footprint derivatives execute
before surface selection so neighboring fragment lanes stay coherent.

The cloud-free live view at the exact 615 m position no longer showed the black
speckles after phase reduction. The 4.311 km view also lost the diagonal striping.
Subsequent stabilization checked near-ground Canada, daylight mountains,
shoreline classification and actual GPU output. Fine imagery remains blurry;
material variation does not recover missing geographic data.

Closer testing at an actual 459 m MSL exposed another defect: differentiating
filtered, quantized heights at millimetre-sized pixel footprints produced a
regular dotted grid. The material now bakes periodic spatial slopes alongside
heights. The normal shader reads those slopes and transforms them by the same
domain matrices used for the height field; it never differentiates sampled
height. GPU cases compare normal output across centimetre/sub-centimetre
footprints. The grid is absent in the latest 459 m and 615 m views.

The resource is four shared 32³ RGBA16F textures (1,198,368 bytes including
mips). RGB stores signed spatial slope and alpha stores height. Each material
evaluation still uses four filtered samples with unresolved frequency
suppression. The normal pass shares the owning patch's uniform objects and
releases its cached material when that patch is disposed. All four textures
belong to the terrain component, not to individual normal materials.

Library terrain now samples the same geographic water mask as the globe in
both color and normal passes. Water fraction suppresses soil detail, blends
toward the radial ocean normal, and supplies the existing opaque water metadata.
The specular asset contains low gray values over land, so a shared filtered
classifier (0.4–0.6) rejects weak land reflectivity before encoding ocean material
coverage. This removes triangle-dependent material classification without adding
another coplanar water draw. It does not increase the 2k water mask's resolution or fix
every disagreement between that mask, imagery and DEM geometry.

The stabilization evidence includes 353 passing actual GPU cases, including
production terrain color tests where geographic water deliberately disagrees
with vertex masks, real gray coast samples, and bounded reflectance calibration.
The final web suite passed 454 tests, and the full workspace build passed.
The unchanged sim-core (105) and scenario (14) suites passed in the preceding
workspace run. See `evidence-stabilization/` and `stabilization-completion.md`
for visual observations, performance, independent review and limitations.

This first slice adds no geometric displacement. Later procedural hills must
use the same height function for visible geometry and ground collision, with
scale-aware LOD, shore protection and terrain-data blending. A full cached
quadtree material system or streaming high-resolution land-cover data is a
follow-up, not a claim of this first slice.

## Material calibration

The packaged day image is an appearance map, not measured reflectance. Comparing
albedo-only, lighting-only and full-atmosphere views over Florida showed that
very dark image pixels became nearly black after Lambertian lighting, leaving
aerial scattering dominant. A single shared imagery-to-reflectance function
now raises low luminance while preserving hue and caps the result at 0.9. Both
globe and terrain use it, and the normal material uses the same calibrated input
for its biome weights. This is an artistic material calibration, not a claim of
measured Earth albedo. Atmospheric scattering, solar energy, cloud lighting and
exposure were not changed to obtain the comparison. The GPU verifies finite
black, bounded bright values and preserved dark-land channel ratios.

## Local geometry and cold spawns

The old mesh depth limit of 10 capped nearby vertex spacing around 300 m.
The existing best-first selector already bounds work by the 300-record budget,
reserving ancestors and complete sibling sets. Raising the depth limit to 16
allows more detail near the viewer under that same budget. In measured selected
sets, Rockies at 2767 m MSL reached level 13 (~38 m spacing), Canada at 459 m
reached level 15 (~10 m), and KSC at 5 m reached level 16 (~5 m); all used 298
evaluated records. These are local maxima, not a global tessellation density.
The DEM and existing shore-protected procedural height field remain unchanged.
Both geometry and ground collision use that height pipeline. This resolves more
of its existing detail; it does not create higher-resolution geographic data.

An untouched explicit FLY spawn now remembers its requested position. If coarse
resident ground temporarily lifts it, finer ground may undo only that lift.
User movement, view changes, mode changes or external position commands cancel
the correction. Missing ground invents no floor; normal flight still clamps
upward. The reported Canadian cold URL now settles at the requested 459 m MSL
instead of remaining elevated at the coarse estimate.
