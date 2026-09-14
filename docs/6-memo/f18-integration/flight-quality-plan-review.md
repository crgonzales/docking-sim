# Flight visual quality plan review

## Round 1 (verbatim)

- **P1 — [Lines 13–16](<docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:13>):** 4× composer MSAA is incompatible with the current single-sampled normal/lighting-mask pipeline: resolved scene pixels have fractional coverage while auxiliary buffers remain binary, producing silhouette halos or partial double-lighting before SMAA. Fix: drop composer MSAA in favor of DPR+SMAA, or explicitly design coverage-consistent auxiliary buffers and test mixed-coverage edges.

- **P1 — [Lines 13 and 22](<docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:13>):** “Clamp sample count to hardware” is underspecified for HDR. Three r170 only clamps against global `maxSamples`; it does not verify the exact RGBA16F-plus-depth framebuffer combination. Fix: probe 4/2/0 samples using the production attachment formats and `checkFramebufferStatus`, then record the actually complete configuration.

- **P1 — [Lines 16, 24, and 31](<docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:16>):** Local PBR cloud fallback will duplicate expensive work: the existing aerial shader calculates cloud lighting before applying its PBR exclusion mask, while the proposed material hook performs the same 24-step direct plus 2×12-step ambient fallback per covered fragment. Airfield pixels can dominate the screen while the cache builds. Fix: make the aerial path skip irradiance/cloud integration for masked PBR pixels while retaining aerial transmittance/inscatter, and benchmark cache-invalid startup/switching separately from steady state.

- **P2 — [Lines 14 and 22](<docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:14>):** State that SMAA is a separate final `EffectPass`. In installed postprocessing 6.36, `SMAAEffect.update()` detects edges from its pass input, so appending it to the existing atmosphere/tone-mapping pass would analyze the pre-atmosphere HDR buffer despite effect ordering.

- **P2 — [Lines 13–14 and 35](<docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:13>):** Preset, storage, diagnostic-query, and frozen-fixture precedence is undefined. Fix: name the graphics query/key and specify, for example, explicit query → stored preset → Balanced, with the cloud-base fixture ignoring storage unless the graphics query is present; apply existing `dpr`, `quality`, and `exposure` overrides last.

The orthonormal SkyLightProbe requirement and borrowed-resource ownership/cleanup are adequately addressed.

REQUEST_CHANGES

Resolution: retained single-sample composer coverage and selected DPR + separate final SMAA; specified graphics precedence; added the masked-PBR aerial early-out and separate invalid-cache profiling.

## Round 2 (verbatim)

## Prior findings

- “MSAA color buffer conflicts with single-sampled masks” — **Addressed.** The plan fixes all composer attachments at one sample and uses DPR plus SMAA instead ([plan:13](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:13), [plan:48](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:48)).
- “HDR/MSAA support cannot be inferred from `maxSamples`” — **Addressed.** HDR sample probing is unnecessary now that multisampling is fixed at zero ([plan:13](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:13)).
- “Masked PBR fallback duplicates aerial cloud lighting” — **Addressed.** Masked PBR now skips irradiance/cloud integration while retaining atmosphere and pre-branch derivative work; invalid-cache and warm-state profiling are separated ([plan:16](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:16)).
- “SMAA must be a separate final `EffectPass`” — **Addressed.** The ordering and input image are explicit ([plan:14](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:14), [plan:22](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:22)).
- “Preset/storage/query/fixture precedence is undefined” — **Addressed.** Precedence, diagnostic overrides, invalid-value rejection, and fixture behavior are specified ([plan:13](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:13), [plan:35](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:35)).

## New issue

- **P2** — MSAA removal is not fully actionable: the plan identifies the existing Canvas antialiasing and requires single-sampled rendering, but never explicitly sets the Canvas context to `antialias: false`; it also retains “sample resolution helpers/options,” leaving conflicting implementation direction ([plan:9](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:9), [plan:13](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:13), [plan:21](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:21), [plan:22](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:22)). **Fix:** explicitly require `Canvas gl.antialias = false` and remove sample-count helpers/options, retaining only DPR and SMAA configuration.

REQUEST_CHANGES

Resolution: explicitly disable Canvas context antialiasing and remove remaining sample-option language.

## Round 3 (verbatim)

- “MSAA conflicts with single-sampled masks” — **Addressed**; composer, color, normal, and mask coverage remain single-sampled ([line 13](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:13), [line 48](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:48)).
- “HDR/MSAA support requires probing” — **Addressed**; probing is unnecessary because composer multisampling is fixed at zero ([line 13](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:13)).
- “Masked PBR duplicates aerial cloud lighting” — **Addressed** by the masked-PBR early-out and separate invalid-cache profiling ([line 16](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:16)).
- “SMAA must be a separate final `EffectPass`” — **Addressed** with explicit ordering after tone mapping ([line 14](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:14), [line 22](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:22)).
- “Preset/storage/query/fixture precedence is undefined” — **Addressed** with complete precedence and override rules ([line 13](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:13), [line 35](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:35)).
- “MSAA removal is not fully actionable” — **Addressed**. FLIGHT now explicitly requests `Canvas antialias:false`, retains composer multisampling at zero, and exposes only DPR/SMAA—not sample-count—configuration ([line 13](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:13), [line 21](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:21), [line 22](docking-sim-flight-integrated/docs/1-plans/F_0.11.0_flight-visual-quality.plan.md:22)).

No new issues were introduced by this delta.

APPROVED