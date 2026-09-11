# Cloud-base grain repair

Scope: a85d669 follow-up, medium EVE clouds / DPR 1. The reported flight pose is preserved as the explicit development fixture `?mode=flight&flightProbe=1&flightFixture=cloud-base`. It starts paused at 91.92 s / 2830.046 m. Ordinary flight and the separate character checkout are unaffected.

The primary marcher forced every step to cover at least an equal share of the entire remaining cloud-layer chord. A long grazing ray therefore began with kilometre-size steps through nearby clouds. Stochastic misses produced the speckled underside; midpoint-only sampling exposed horizontal bands. The new geometric reserve floor spends more of the existing iteration budget nearby while retaining complete path coverage. The reference midpoint integrator, distant uniform schedule, density, lighting, history clear/depth guards and ray-count caps remain intact.

The 16-frame Bayer reconstruction also sampled only four of the 64 STBN layers at any fixed output pixel. Primary upscale noise now addresses the actual final pixel and advances its temporal index once per Bayer cycle. Native and shadow noise sequences retain their prior behavior. Paused flight restarts its existing finite rendering warmup when canvas dimensions change.

Evidence under `.evidence.local/`:

- Baseline: `flight-cloud-base-1789088224638.png` / JSON (history reset reasons empty).
- Corrected, same physical pose and 981 × 1043 buffer: `flight-cloud-base-1789089298924.png` / JSON.
- Comparison: `cloud-grain-before-after.png`, metrics `cloud-grain-comparison.json`. High-frequency grayscale RMS in the reported underside region fell from 13.381 to 1.560 (88.3%). This measures this crop, not overall image quality or a universal noise reduction.
- GPU report: `cloud-grain-gpu-conformance.json`, all 376 cases pass, including six new sampling checks. The thin-near-cloud opacity error is 0.00203 RMS; the old equal-share negative control exceeds 0.1. The noise-address test observes 64 distinct layers versus four with the old stride, and verifies spatial/temporal wrapping. Existing depth, clear-gap, disocclusion, transport and shoreline checks pass.
- Orbital check at 400 km: `capture-eve-medium-full-1789089241477.png` / JSON. Separate below-cloud view at 1.5 km inspected. Paused resize retains the physical pose and reconverges.

Build: `pnpm -r build` passes. Affected tests: 72 pass across six files, including three new fixture behavior tests. Build/test logs are `/private/tmp/cloud-grain-build.log` and `/private/tmp/cloud-grain-tests.log`.

No additional cloud rays, render targets, higher resolution or spatial blur were introduced. Changing step placement can change how many iterations run before early termination, so unchanged caps do not imply identical GPU time. Fine stochastic noise remains on some thin cloud silhouettes; this pass repairs the severe reported cloud-base band and the sampling defects, not every source of volumetric noise. Sustained-flight measurements and independent review are recorded below.

The final 75-second physical cloud-climb exercise completed from 1500 m to 3238.263 m; moving chase and settled nose-camera screenshots were inspected. It paused at exactly 75 s, and changing cameras did not move the aircraft. `flight-cloud-base-1789089430673.json` / PNG captures the completed climb. Its profiled interval includes resize/settling and the climb, with 1067 sampled cloud passes averaging 18.03 ms and zero disjoint GPU events; this is not an isolated before/after performance benchmark. The 981 × 1115 view uses 22,974,444 cloud-view bytes. The temporary comparison viewport override was reset to the user's window size.

Independent review: APPROVED with no findings; verbatim report in `cloud-grain-review.md`. The original source checkout index remained unchanged. The final tab is paused at the captured cloud-base pose, profiling disabled, with only one game tab open.
