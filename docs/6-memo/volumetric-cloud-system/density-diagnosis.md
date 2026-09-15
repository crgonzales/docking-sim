# Volumetric authored cloud density investigation — 2026-09-09

**The parent's coverage hypothesis is supported by the raw assets and canonical CPU evaluator.** For fixed type, height, and noise, positive coverage only scales density; it cannot change the nonzero support. The current field fills most of its nominal volume with weak extinction. Noise/threshold calibration and low authored extinction coefficients reinforce that behavior. This is sufficient to explain a fog-like medium before considering any image reconstruction or lighting issues.

Repository: `docking-sim-eve-clouds`, branch `eve-cloud-system`. All investigation writes are in `/private/tmp`. No production edits, commits, browser, GPU shader review, temporal/lifecycle review, or builds.

## Reproduce and method

```sh
node /private/tmp/eve-cloud-diagnostic-20260909.mjs > /private/tmp/eve-cloud-diagnostic-20260909-run.json
```

Outputs:

- `measurements.json`: results, source/asset SHA-256 values, centre profiles and height samples, occupancy, ablations, convergence, deterministic coverage sweep.
- `zone-columns.json`: every measured zone column, including candidate results.
- `cloudConfig.mjs`, `cloudWeather.mjs`: temporary TypeScript-transpiled copies of the actual canonical source, not a rewritten baseline density implementation.

Read `docs/ARCHI.md`: SI metres, engine ECEF north +Z, longitude -180 at U=0, north at V=1. Use planet radius 6,371,000 m. Verify all four raw asset hashes against `EVE_WEATHER_ASSETS`; independently compare all 8,192 south-first reference texels against the canonical authored field. Sample RG8 bilinearly. Sample real RGBA8 noise trilinearly, X fastest, periodic wrapping, with the fixture's float32 ECEF/scale convention. Blend the two **fixed authored scale** samples according to type, as in `CloudWeatherFixture.ts:73` and its fixed-scale continuity oracle; do not divide ECEF by an interpolated scale.

Columns are radial vertical cloud-only integrals, `tau = integral rho * (sigma_s + sigma_a) ds`, `opacity = 1-exp(-tau)`. At 20 km the observer is above all support. These are not the exact rays of the -20 degree screenshot and do not predict its final colour. Centres use <=25 m midpoint steps, repeated at <=12.5 m; maximum centre tau change is 0.0000143. Zone grids use <=50 m, with 349 columns per circular zone and 619 broken-field columns excluding the named circular zones. They sample the interior reference patch, without its global blend rim. Volume occupancy weights samples by depth and uses rho > 1e-6; rho > 0.25 is an additional explicit dense-body diagnostic, not a physical threshold.

## Current column measurements

| Location (latitude, longitude) | Raw coverage | Resolved base–top km | Mean rho across support | Peak rho | Tau | Opacity |
|---|---:|---:|---:|---:|---:|---:|
| Isolated centre (40.88, -75.42) | 0.723 | 1.409–6.230 | 0.0651 | 0.1700 | 0.1748 | 16.04% |
| Covered broken cell (40.7625, -76.075) | 0.620 | 1.454–6.885 | 0.0830 | 0.1799 | 0.2663 | 23.38% |
| Deep centre (40.34, -74.58) | 0.974 | 3.288–8.750 | 0.1496 | 0.4574 | 0.4699 | 37.49% |
| Clear centre (40.08, -75.18) | 0 | 1.200–3.200 | 0 | 0 | 0 | 0% |

The broken sample is a covered cell, not the broken-zone median. The three cloudy centre columns have nonzero density at every sampled support height. At **3 km inside the isolated centre**, rho is **0.07931**, extinction is **0.00004415/m**, and the local extinction length is **22.65 km**. This is locally very weak extinction; the length is the reciprocal of local extinction, not an integrated visibility prediction through the variable field.

| Whole zone | Median tau | P95 tau | Nonzero columns | Nonzero volume | Volume with rho > 0.25 |
|---|---:|---:|---:|---:|---:|
| Isolated | 0.03281 | 0.16634 | 100% | 94.11% | 0.042% |
| Broken | 0.04306 | 0.22974 | 81.91% | 84.89% | 0.146% |
| Deep | 0.46583 | 0.71145 | 100% | 99.23% | 6.800% |
| Clear | 0 | 0.02146 | 18.62% | 20.96% | 0% |

None of the **1,317 sampled isolated/broken/deep columns reaches tau=1**. Thus the isolated formation is mostly nearly transparent despite nearly full volume occupancy.

## Defects versus authored tuning

1. **Coverage controls amplitude rather than support.** `cloudWeather.ts:302` multiplies `coverage * coverageCurve * densityCurve * shapedNoise * taper`. For a fixed type, noise and interior height, any positive coverage leaves the exact positive-density set unchanged. Height coverage also attenuates the same body instead of reshaping its support. This is the main density-model defect relative to the intended empty gaps and solid formations.

2. **The authored thresholds/softness do not match the asset distribution.** Across all 32,768 raw texels, Perlin R has mean 0.499994, SD 0.048074, range 0.341176–0.643137. The actual base signal `0.85R+0.15A` has mean 0.485046, SD 0.045009, P05–P95 0.411176–0.559020. Broken's transition spans 0.38–0.74; most samples live in the broad transition, rarely in a full body. At the isolated centre, fixed-domain interpolation narrows the sampled base-signal SD to 0.02023: mean base shape 0.31850, mean erosion mask 0.48126, final mean shaped noise 0.16995. Multiplication by coverage and height terms reduces support-mean rho to 0.0651.

3. **Erosion/detail channels are not independent noise.** `setupEveCloudAssets.mjs` authors B = 0.55R+0.45G and A = 0.5R+0.5(1-G). Actual bytes match these relations within 0.003726 / 0.001961. G/A correlation is -0.89994. There are two underlying scalar fields, not four independent shape/detail bands. This limits independently adjustable erosion/detail; it is not evidence of corrupt textures. It need not block the smallest initial fix using the existing asset.

4. **Extinction tuning remains too weak even if shape is improved.** At the isolated centre, removing erosion alone gives tau 0.32075; forcing shaped noise to one gives 0.97165. For a pure broken profile with coverage=1, shapedNoise=1, the two height curves/taper and current coefficients allow only tau **0.38552**. Pure deep gives 2.68568. A shape fix cannot by itself make every authored profile optically thick. Simply increasing coefficients preserves the current fog support.

5. **Reference authoring and resolution reinforce flattening.** The 128x64 reference covers 6.4x4.8 degrees: a texel spans about **4.23x8.34 km** at 40.5 degrees. The isolated diameter is only 9.6x6.4 texels. Its centre coverage is 0.723 versus analytic 0.780. The type increases with its coverage, coupling cloud height to the same broad 2D envelope. The deep centre's type 0.43753 is already **31.26% stratus**, raising its base to 3.288 km and shortening the pure deep 7.4 km span to 5.462 km. That is an authoring choice to reconsider if the dense centre is meant to be deep-convective, not an evaluator interpolation bug.

6. **Constant fixture samples obscure asset weakness.** The default sample `[0.75,0.5,0.5,0.5]` puts R above the real asset maximum. It gives isolated/deep-centre tau 0.89590/1.57350 instead of 0.17479/0.46987: **5.13x / 3.35x**. Such fixtures establish evaluator arithmetic, not formation density or occupancy. Add byte-backed morphology/optical-depth checks.

## Candidate tested against the same samples

Keep profiles, coefficients, fixed-scale noise sampling, density curve and erosion. Replace amplitude coverage with a sharpened support threshold on an empirically expanded base signal:

```text
N = clamp((0.85*R + 0.15*A - 0.40) / 0.17, 0, 1)
C = coverage * coverageCurve(h)
occupied = C > 0 ? smoothstep(1-C-0.08, 1-C+0.08, N) : 0
rho = densityCurve(h) * taper * clamp(occupied - erosionDepth*erosionMask, 0, 1)
```

The [0.40,0.57] bracket follows the measured distribution; it is an exploratory contrast calibration, **not a calibrated percentile/area-coverage mapping**. The script also records a wider [0.35,0.65] ablation.

Controlled sweep: same 4,096 seeded ECEF sample positions, type=0.18, normalized height=0.5; only coverage changes:

| Coverage | Current nonzero occupancy | Candidate nonzero occupancy | Current mean rho within occupied samples | Candidate mean rho within occupied samples |
|---|---:|---:|---:|---:|
| 0.10 | 97.97% | 1.98% | 0.0183 | 0.3406 |
| 0.25 | 97.97% | 11.60% | 0.0458 | 0.4887 |
| 0.50 | 97.97% | 58.40% | 0.0915 | 0.6398 |
| 0.75 | 97.97% | 94.75% | 0.1373 | 0.7612 |

This directly demonstrates empty space plus materially denser bodies instead of a low-density veil.

| Centre | Current tau | Candidate tau, unchanged coefficients | Candidate peak rho | Candidate nonzero depth | Candidate tau if coefficients x4 |
|---|---:|---:|---:|---:|---:|
| Isolated | 0.1748 | 1.0149 | 0.8551 | 62.69% | 4.0596 |
| Covered broken cell | 0.2663 | 1.3091 | 0.8881 | 69.72% | 5.2364 |
| Deep | 0.4699 | 1.6180 | 0.8661 | 83.11% | 6.4722 |
| Clear | 0 | 0 | 0 | 0% | 0 |

Whole-zone candidate nonzero volume becomes isolated/broken/deep **12.91% / 21.89% / 62.14%**, while rho>0.25 volume becomes **10.09% / 17.32% / 54.92%**. The deep median tau rises to 1.6881. The isolated footprint shrinks to **50.14% nonzero columns** and its median tau falls to 0.000123 while its P95 rises to 0.78354: the candidate concentrates matter into bodies, but it is not a finished coverage calibration. At 3 km in the isolated centre the candidate rho is 0.6960 and local extinction length 2.58 km with coefficients unchanged.

**Clear-gap boundary limitation for the parent:** bilinear reference sampling makes 65/349 analytically clear positions nonzero, although the centre is exactly clear. The candidate reduces nonzero columns to 22/349 but concentrates leakage: maximum boundary tau rises from 0.1912 to 0.7219. Do not ship this particular tuning as a clear-gap fix. The analytic exclusion should remain empty in the sampled field, e.g. an explicit spatial exclusion/support mask or an asset/filter footprint that preserves the intended boundary. Parent owns integration/clear-gap assessment.

## Smallest coherent fix recommendation

1. Change the canonical density design so coverage and its height curve control noise support/threshold, using the real asset distribution to calibrate contrast and transition width. Keep the existing noise asset initially and preserve the fixed authored sampling domains. The above candidate proves the direction but needs coverage-percentile/footprint calibration, especially for the isolated rim.
2. Then tune per-profile sigma_s and sigma_a against dense-core column targets, retaining intentional albedo/phase choices. Tau>=3 corresponds to >=95% cloud-only opacity and is a useful chosen solid-core target. A 4x coefficient ablation after the candidate gives 98.27% / 99.47% / 99.85% at these isolated/broken/deep samples; **this is not a recommendation to multiply cirrus or every profile blindly**. Coefficients alone would require about 17.16x at the current isolated centre to reach tau=3 and would retain the filled fog volume.
3. Preserve authored clear support as part of that same change and validate raw-asset occupancy, thick-core tau, and zero-gap columns together. Reconsider the deep-centre type toward 1/3 and improve reference resolution only as needed by those measurements. Independent detail channels and richer multi-scale/detiled formations can follow; rewriting all noise generation is not required to resolve the demonstrated support/opacity problem first.

Measured source SHA-256 values (rechecked unchanged at completion):

- cloudConfig.ts: `80e8ff908b3a21e510c614989402af8fccfd99c679837c46e516cdcd346f6a67`
- cloudWeather.ts: `15d55f3515bd97bcfd8268b294271c214bad6c52de4b0b2bd4bc22d409821485`
- setupEveCloudAssets.mjs: `cfcbf17d49047eb8bea83f6528d95a0371f8fc077082a556711c390a5f04bc9a`

Full asset hashes and raw height samples are retained in `measurements.json`.
