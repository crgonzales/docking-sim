# Orbital cloud transition — working implementation

The previous EVE far mode was a 24/32-step version of the view ray marcher. It
was not the scaled cloud layer described in the plan. Normal flight also enabled
the authored reference-weather rectangle around the initial demonstration site.
That replaced global weather inside its bounds, making the test region visible
from orbit and changing appearance as the camera left it.

## Current changes

- The reference weather asset is opt-in with `weatherRegion=reference`. Normal
  EVE flight uses global coverage and type maps everywhere.
- `CloudColumnAtlas` prepares a global curved-layer data source from the exact
  canonical density shader. Columns use profile-specific vertical support,
  midpoint extinction with analytic Beer integration and analytic first-event
  height. A 2×2 subcolumn filter precedes mip generation. Noise itself is not
  prefiltered before the nonlinear density threshold in this producer.
- RGBA16F holds opacity, opacity-weighted first-event height in kilometres,
  opacity-weighted thickness in kilometres, and opacity-weighted albedo. Mips
  average those quantities; averaging optical depth would fill sparse gaps.
- One atlas is published only after all rows and mips are ready. Medium reserves
  22,369,624 bytes and low 5,592,408 bytes. Publication does not rebuild when the
  weather generation is unchanged. Camera movement does not move this map.
- The far view uses a curved-layer intersection, bounded slant thickness and
  live shared solar/cloud transport. At nearer orbital distances, 16 canonical
  radial samples recover detail smaller than an atlas texel; at larger projected
  footprints this fades into the prepared opacity mip chain. This is a radial
  column approximation, not a full view-ray volume and not a texture-only pass.
- Local Bruneton sun/sky irradiance is evaluated at the far cloud point to keep
  the terminator independent of camera position. The nearby view still uses its
  existing rendering path.
- The host reuses its existing depth, temporal reconstruction and atmosphere
  composition. Each representation gets atmosphere at its own depth; their
  premultiplied radiance/transmittance is blended once. Near marching stops at
  full far weight. The initial altitude band is 50–120 km, with a 750 ms readiness
  ramp after atlas publication. Low-altitude horizon styling remains separate.
- Probe status identifies `referenceWeather`, `representation`, `farWeight` and
  atlas progress. `cloudView=volume` and `cloudView=scaled` support controlled
  comparisons. Scaled override still requires a camera above all cloud support.

The new source is integrated through the fork's lighting hook instead of adding
another fullscreen pass and duplicating composition buffers. This is a deliberate
implementation variation from the plan's provisional `DistantCloudPass.ts` file.

## Verification so far

- The earlier orbital GPU report contains 309 cases (the previous memo's 302
  count was incorrect). It remains historical evidence.
- On the resumed stabilization pass, 231 affected code tests passed. The actual
  GPU probe passed 353 cases at tolerance 0.001, including cloud-column, limb,
  far-side crossing, restored-context publication and terrain material checks.
  Current report: `evidence-stabilization/gpu-conformance.json`.
- Workspace build passed. Independent convergence review and the broader
  visual matrix are tracked in the stabilization completion report; these automated
  passes alone do not establish visual acceptance.

Development now uses one reused game tab. Performance observations made while
tests or recording run are not used as a clean game benchmark. No weaker target
hardware has been measured.

## Rollback / isolation

`codex/eve-pre-orbit-transition` points to
`153957bd9861ee27cd1604370683d7e6f5f31388`. It includes prior appearance and horizon
styling, plus the known old orbital/reference-region defects. Work is isolated in
`/Users/carlosgonzales/dev/docking-sim-eve-clouds`. The original checkout and its
staged index are preserved. The independently requested F/A-18 work is isolated
in `/Users/carlosgonzales/dev/docking-sim-f18` on `codex/f18-flight-prototype`.

## Shadow filtering correction

The final live shadow diagnostic exposed another filtering-order defect in the
shared light cache: kilometre-wide noise filtering happened before the cloud
threshold, removing extinction. The producer now integrates four canonical
quarter-texel subrays and averages transmitted light for direct and ambient
quantities independently. The cache dimensions and memory remain unchanged;
default work is paced at one direct and one ambient slice per frame. This
retains the existing atomic generation publication. Six new actual GPU checks
use thresholded half-space media and an independent curved-shell Beer oracle;
all 353 GPU cases pass. The coarse cache still produces broad shadows (medium
texel footprints around 9.85 km at 3 km altitude and 14.71 km at 20 km), so this
is not a claim of sharp shadows beneath individual small puffs.
