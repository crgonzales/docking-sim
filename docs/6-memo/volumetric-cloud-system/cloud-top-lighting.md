# Sunlit cloud-top brightness — 2026-09-11

The full-globe view at 20°N, 30°W, 20,000 km showed muted gray cloud tops.
A matched 120 km comparison of forced volume and normal column rendering
showed the low brightness in both paths. This pass adjusts their shared
multiple-scattering response; it does not establish a defect in the opacity
atlas or replace the cloud transport solver.

## Change

Both paths now separate the original direct single-scattering phase term from
the finite-octave higher-order term. The latter receives up to 2× weight when
the sun and observer are above the cloud. Smooth cosine ramps from 0 to 0.35
return to the original response near the local terminator and grazing view;
an observer below the cloud receives the original response exactly.

This is an empirical brightness calibration of an existing approximate
lighting model, not a radiometrically calibrated or energy-conserving new
multiple-scattering solution. It retains solar irradiance, self-shadow optical
depth, the original direct phase lobe, ambient lighting, cloud density/opacity,
and atmosphere composition. No textures, render passes, primary samples or
cache allocations were added. Terrain and global exposure were not adjusted.

## Validation

- Web production build passed, including TypeScript. The existing bundle-size
  advisory remains.
- All 122 cloud tests passed.
- A fresh browser context passed all 789 production GPU fixture checks. Eight
  new checks cover top lighting, underside, grazing view, night side, terminator,
  continuous fade, unchanged single scattering and zero-light response.
- The first GPU attempt exposed a missing phase-function stub in the motion
  fixture. That stub was added. A retry retained its old graphics error; the
  final fresh-context run was clean. The geometry fixtures continue to exercise
  the real distant shader with synthetic light inputs.
- One game tab was reused for the full globe, 400 km, a continuous 400 km–ground
  descent, a 70 km transition view, 20 km, a 1 km upward view and night side.
  Screenshots/sample data were inspected, not a frame-by-frame flicker audit.
  Some later camera pitches and the viewport changed during inspection; only
  the original full-globe before/after pair below is a matched framing.
- The matched orbital images show brighter cloud tops with the dark planet
  edge retained. The 1 km upward view retains shaded undersides. The night view
  remains dark. Existing cloud softness/grain and terrain blur remain visible
  and are outside this brightness change.
- A settled 400 km sample reported 60 FPS at medium/DPR 1 on the M3. This is a
  spot observation, not a controlled before/after performance benchmark.

## Local evidence

Files are in the integrated checkout's ignored `.evidence.local/` directory:

- Before full globe: `capture-eve-medium-full-1789122859845.png` and `.json`.
- After, same framing: `capture-eve-medium-full-1789123057268.png` and `.json`.
- Before at 120 km, column: `capture-eve-medium-full-1789122920761.png`.
- Before at 120 km, volume: `capture-eve-medium-full-1789122964261.png`.
- After at 400 km: `capture-eve-medium-full-1789123226395.png`.
- Clean GPU report: `cloud-top-lighting-gpu-2026-09-11.json`, also embedded in
  `capture-eve-medium-full-1789123251529.json`.
- Descent samples: `capture-eve-medium-full-1789123279499.json`.
- Transition at 70 km: `capture-eve-medium-full-1789123310250.png`.

The unchanged `checkpoint/flight-2026-09-11` tag at `77ec02c` remains the
pre-adjustment checkpoint.
