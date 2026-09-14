The next batch should expose two named shader hooks and run the existing camera, secondary and shadow marchers against controlled inputs. No replacement renderer is needed. I inspected the approved documents, vendored source and current adapters; I made no edits and used no browser or delegation.

**Smallest extension API**

Pass one immutable `shaderHooks` object through the effect/pass constructors to both materials:

```ts
{
  mediaGLSL,       // implements sampleCloudMedia
  lightingGLSL,    // implements sampleCloudLighting
  uniforms        // same Uniform instances in participating materials
}
```

Resolve named includes when constructing shaders. Keep the stock implementation as the default; avoid additional shader-text replacements.

```glsl
MediaSample sampleCloudMedia(
  vec3 positionECEFM,
  float footprintM,
  float weatherLod,
  float jitter
);

CloudLightingSample sampleCloudLighting(
  vec3 positionECEFM,
  float footprintM,
  float sunStartM
);
```

The contracts should specify:

- `MediaSample`: extinction and scattering in m⁻¹, finite mixture weights, and phase parameters. Initialize every field, including the existing unused `density`. Empty media returns zero coefficients and zero weights.
- Position uses the backend’s declared ECEF frame. Remove Takram’s intersection-only `altitudeCorrection` before sampling geographically anchored media; apply it consistently when computing spherical bounds.
- Footprint is physical metres. Equal positions and sampling inputs produce equal media in camera, secondary and shadow consumers. The custom path must not inherit the stock `SHADOW`-only layer mask.
- `CloudLightingSample`: direct cloud transmittance over **[sunStartM, cloud-support exit]**, full cloud-occluded sky irradiance at the query position, and validity. Generation belongs to the shared binding/snapshot.
- Camera lighting multiplies the secondary march’s near transmittance by this remainder exactly once. `sunStartM=0` requests the complete path. Invalid lighting uses bounded integration through the same media evaluator.
- View-dependent phase stays in the camera marcher. Supplied sky irradiance replaces the stock height-gradient ambient term. Supplied transport replaces the equivalent Beer-map term.

The shadow **producer** only evaluates media; making it query its own lighting would introduce a dependency cycle. Shadow-length/shaft **consumers** use the lighting hook with `sunStartM=0`.

**Exact shader changes**

| File | Functions and bounded change |
|---|---|
| [clouds.glsl](docking-sim-eve-clouds/apps/web/src/scene/clouds/vendor/takram/src/shaders/clouds.glsl) | Keep `sampleWeather` and `sampleMedia` behind the stock implementation of `sampleCloudMedia`. Guard zero-density normalization. Custom media must bypass stock weather and interval rejection unless those bounds are explicitly conservative. |
| [clouds.frag](docking-sim-eve-clouds/apps/web/src/scene/clouds/vendor/takram/src/shaders/clouds.frag) | Change both `marchOpticalDepth` overloads, `marchClouds`, `phaseFunction`, and `marchShadowLength`. Route all media evaluation through the hook; replace lighting assembly inside `marchClouds`; give secondary integration an explicit endpoint and return the **integrated endpoint**, not its last sample position. |
| Same file | Change `getRayDistanceToScene` and `main` to incorporate the existing direct log-depth decode and spherical camera-height fixes. Change the `marchClouds` return to preserve physical transmittance. Retain `applyAerialPerspective` with the convention below. |
| [shadow.frag](docking-sim-eve-clouds/apps/web/src/scene/clouds/vendor/takram/src/shaders/shadow.frag) | Change `marchClouds` to call the identical media hook and integrate bounded segments. In `cascade`, retain the paired shadow-storage encoding and finite motion-depth handling. |
| [types.glsl](docking-sim-eve-clouds/apps/web/src/scene/clouds/vendor/takram/src/shaders/types.glsl), [parameters.glsl](docking-sim-eve-clouds/apps/web/src/scene/clouds/vendor/takram/src/shaders/parameters.glsl) | Declare hook results, shared uniforms and the reference-sampling control. |

For supplied lighting, disable the equivalent stock ground-bounce approximation until its transport is explicitly connected. Keep stock behavior available on the reference library path.

**Output convention**

Preserve the existing texture/compositor ABI:

```text
RGBA = (premultiplied cloud contribution, 1 − Tcloud)
```

Here `Tcloud` is the actual accumulated Beer transmittance. The current `remapClamped(T, 1, minTransmittance)` does **not** satisfy this contract.

For Phase 1, retain Takram’s existing representative-depth atmosphere approximation:

```text
Loverlay = Tair(drep) · Lcloud + (1 − Tcloud) · Lair(drep)
Lfinal   = Loverlay + Tcloud · LclearScene
```

Declare the returned radiance as **already carrying this clear-air treatment**. `LibraryEffects` remains the single compositor, with `skipRendering=true`; nobody applies cloud aerial perspective again. This is a representative-depth approximation, not distributed atmosphere/cloud integration.

Keep representative distance in metres logically; preserve the existing `1e-4` motion-depth storage scale. Empty media is valid, with `L=0`, `T=1`, and no cloud hit.

**Concrete GPU fixture**

Add one probe-owned `CloudConformanceFixture.ts` beside the backend. Invoke it from a “Run cloud conformance” button in [RenderProbe.tsx](docking-sim-eve-clouds/apps/web/src/scene/RenderProbe.tsx), gated by `probe=1&cloudSystem=eve`. Append results to the existing measurement/evidence payload.

Use actual `CloudsMaterial` and `ShadowMaterial` draws:

- Render small 9×9 targets; inspect the centre pixel. Use RGBA32F where supported, with an explicit unsupported result otherwise.
- Draw the current materials directly through `ShaderPass`. For a one-cascade shadow fixture, the same shadow shader can write ordinary 2D MRT attachments; an array/history pipeline is unnecessary.
- Fix frame, matrices, sun, weather offsets and noise. Bind valid constant textures for every active sampler. Use atmosphere transmittance LUT = one and scattering LUT = zero, so the actual aerial function executes with identity transport.
- Add one reference-sampling setting: fixed 10 m midpoint segments, clipped to the interval endpoint, with sufficient iteration budget. Implement sample placement inside the **existing three marchers**, sharing their normal media and integration bodies. This is also a useful native-reference setting.
- Disable haze, powder, ground bounce and temporal resolve; use one scattering octave and isotropic phase. Set extinction thresholds below fixture coefficients and early termination below all expected transmittances.
- Read attachment zero asynchronously after each draw. Diagnostic output modes in the same shader can expose secondary optical depth and composed lighting transport; they must call the real integration functions.

Geometry and inputs:

- `R = EARTH_RADIUS_M`; atmosphere and intersection radii agree.
- Camera at ECEF `(R + 3000, 0, 0)`, looking radially inward, represented with a camera-relative world origin.
- Cloud bounds: altitude 1000–2000 m. Centre-ray length is exactly 1000 m.
- Fixture A: `σt=0.001`, `σs=0.0005` m⁻¹ within those bounds.
- Fixture B, when enabled: same bounds, `σt=0.002`, `σs=0.0005` m⁻¹.
- Constant supplied sky irradiance `4π` in each channel, zero direct illumination. Thus the source term is `σs`, and the analytical result is:

```text
T = exp(−Σσt · length)
L = (Σσs / Σσt) · (1 − T)
```

| Case | Expected centre-ray result |
|---|---|
| Empty | `T=1`, `L=0`; finite outputs |
| Slab A | `T=0.36787944`, each radiance channel `0.31606028` |
| A+B overlap | `T=0.04978707`, each channel `0.31673764`; swapping input records changes nothing |
| Terrain before clouds | Plane 500 m from camera: `T=1`, `L=0` |
| Terrain within clouds | Plane 1500 m from camera: traversed length 500 m; `T=0.60653066`, `L=0.19673467` |
| Terrain behind clouds | Plane 2500 m from camera: full slab result |

Render the terrain planes using ordinary Three geometry into a real depth attachment under the existing logarithmic-depth renderer. Include one non-step-aligned plane, such as distance 1437.5 m, and evaluate the formula with length 437.5 m. That exposes endpoint overshoot.

For agreement between consumers:

- March the same 1000 m slab with `marchOpticalDepth`; expect optical depth `1`.
- Run `shadow.frag`; decode its stored total optical-depth channel and expect `1`.
- Exercise a 250 m near march plus a supplied remainder transmittance `exp(-0.75)`; expect combined transmittance `exp(-1)`. Repeat with an invalid supplied value to exercise direct fallback.
- Composite the actual camera result over a known background using the existing overlay consumer; expect `L + T·background`.

Use analytical formulas only on the CPU—no CPU raymarch. Start with approximately `1e-3` absolute tolerance for radiance/transmittance, accounting for Earth-scale float arithmetic; record actual errors.

**Real obstructions and compatibility requirements**

There is no missing kernel preventing deterministic execution. There are concrete reasons stock settings alone cannot pass these contracts:

- `temporalUpscale=false` still executes TAA in `CloudsPass.update`.
- Secondary zero-iteration sampling returns invented optical depth `0.5`; its reported distance is not the integration endpoint.
- Current stepping does not consistently clip integration weights at ray/terrain endpoints.
- Stock shadow lookup is intrinsically approximate: it reconstructs depth from mean extinction and a transmittance-weighted “front” distance. Even a homogeneous slab’s partial-path lookup is not guaranteed to equal Beer transport. Validate its generated total optical depth separately; use the shared direct fallback for exact Phase-1 transport.

Move the relevant existing adapter behavior into the fork: log-depth and spherical height, boundary-start sampling, geographic UV/seam handling, physical noise footprint, shadow storage and motion-depth scaling. The footprint adapter currently patches only the camera material, which is insufficient for shared-media agreement. Preserve the paired aerial shadow decoder.

The remaining bounded host edits are constructor/options plumbing in [CloudsEffect.ts](docking-sim-eve-clouds/apps/web/src/scene/clouds/vendor/takram/src/CloudsEffect.ts), [CloudsPass.ts](docking-sim-eve-clouds/apps/web/src/scene/clouds/vendor/takram/src/CloudsPass.ts), [ShadowPass.ts](docking-sim-eve-clouds/apps/web/src/scene/clouds/vendor/takram/src/ShadowPass.ts), [CloudsMaterial.ts](docking-sim-eve-clouds/apps/web/src/scene/clouds/vendor/takram/src/CloudsMaterial.ts) and [ShadowMaterial.ts](docking-sim-eve-clouds/apps/web/src/scene/clouds/vendor/takram/src/ShadowMaterial.ts); the planned backend/contracts and two hook modules; probe wiring; and the vendor diff manifest. No lighting volume, far-cloud pass or additional test runner is required for this batch.
