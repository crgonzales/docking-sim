# Foreground cloud edges — 2026-09-11

The capsule had a jagged/cloud-colored fringe against Earth. Cloud reconstruction
interpolated the sparse 4×4 ray lattice across opaque silhouettes; stationary
history assumed a stationary camera also meant stationary objects. The spacecraft
composer also omitted the final SMAA pass already available in flight mode.

The resolve now borrows the native scene depth, filters spatial/variance taps by
opaque surface, rejects stale same-pixel object occlusion, and clips reconstructed
cloud fronts against the current surface. Paired history depth is RG16F: cloud
front and opaque surface, both positive view metres × 1e-4. The two additional
channels cost four bytes per resolved pixel across both history targets (6 MB at
the medium 1.5-million-pixel cap), within the existing conservative reservation.

The aerial compositor uses the paired depth to resample the capped cloud image
without blending near-object and background taps. Log depth is decoded directly
to eye-space metres; converting it through ordinary normalized perspective depth
reintroduced precision bands at orbital distances and was removed during QA.
SMAA runs last in the spacecraft view (see the follow-up below for the corrected default). Flight's existing setting and
the diagnostic `sceneAA=off` override still work.

Verification:

- 806 production GPU fixture cases passed, including all 16 Bayer phases,
  foreground entry/disocclusion with a stationary camera, native sampling, and
  both ordinary and logarithmic depth. Five final-composition cases test a 2×2
  cloud buffer against a 9×9 scene at distances from 10 m to 1,000 km.
- Visual checks in the running game at DPR 1 and 1.5: capsule/trunk/nose-cover
  silhouettes against orbital clouds, plus camera changes during nozzle checks.
- GPU report: `.evidence.local/capture-eve-medium-full-1789128147916.json`.
- Native game capture: `.evidence.local/rcs-J1-1789127906102.png`.

This is an occlusion/reconstruction correction, not a new cloud density model.
Very thin features with no current compatible sparse ray still rely on the next
fresh sample; this is not full-scene temporal antialiasing.

## Follow-up after the reported visible jaggies

The previous 806 cases covered cloud reconstruction, not the SMAA detector.
A live review found the installed detector sampled linear RGB with a perceptual
contrast threshold. Its dark spacecraft/ocean edge had only 0.061 linear contrast
but 0.239 display contrast, so it was missed. `librarySmaa` now encodes only the
detector taps; neighborhood blending remains linear and display encoding occurs
once. Spacecraft defaults to High SMAA (diagonal/corner detection), while explicit
flight/user medium and off remain available.

The normal and lighting-mask passes now respect each source material side,
including DoubleSide GLB hulls and mixed material arrays. Transparent decals and
exhaust stay excluded; caches release only owned materials and restore state even
when rendering fails.

Actual GPU check at DPR 1 in the existing game tab: four cases at 32x32 and
45x35 passed. Stock SMAA detected/changed zero pixels for the dark diagonal. The
corrected detector found 42/46 edge pixels and changed 28/31 pixels. Maximum
linear-blend error was 0.0000669 and flat-color error was zero. Evidence:
`.evidence.local/capture-eve-medium-full-1789132108984.json` (`context.sceneAa`).
These are deliberately small detector/blend cases, not a claim that every moving
silhouette is perfect. Live docking screenshots also inspected the hull and station
in front of orbital clouds.
