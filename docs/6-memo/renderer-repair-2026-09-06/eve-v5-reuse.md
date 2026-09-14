# Modern EVE reuse decision — 2026-09-07

The user chose modern EVE's complete cloud-system organization as the target. The [implementation plan](../../1-plans/F_0.12.0_volumetric-cloud-system.plan.md) replaces the earlier optional-experiment recommendation. This is a source audit and architecture decision, not a renderer implementation or visual acceptance report. Pass 06 remains the running prototype and rollback source tree `22e78a9563b6dce7172d928785478cfd55acbc9f`.

## Source boundary

Two independent audits checked the public source and the installed web implementation. The newer public **release-5** branch adds useful host source beyond the earlier dissection:

| Source | Inspected revision | Role |
| --- | --- | --- |
| [EVE release-5](https://github.com/LGhassen/EnvironmentalVisualEnhancements/tree/9a7786ac05cb4ee15ceb44f0e5151c784fa630d3) | `9a7786ac05cb4ee15ceb44f0e5151c784fa630d3` | Primary modern type/configuration and scheduling reference |
| EVE raymarched-volumetrics | `ce731021357e2fa3283b1c92a389e4e42a23fada` | Earlier modern-host audit |
| EVE master | `4ac5793a55dec05d6dba70237dde8a2f0d68f855` | Classic shell/particle implementation; not modern volume parity |
| [Scatterer master](https://github.com/LGhassen/Scatterer/tree/c2d0b0f2a8798381040d3a4e735a00cad957eb47) | `c2d0b0f2a8798381040d3a4e735a00cad957eb47` | Atmosphere integration reference; README excludes shader source newer than 0.0772 |
| EVE wiki | `598e8ab280894ae5a49293b216ce68fad1683841` | Author's documented behavior, including August 2026 updates |

V5 exposes CloudType, CloudPhaseFunctions, RaymarchingSettings, CloudsRaymarchedVolume, deferred raymarch scheduling, light-volume positioning/updates, and noise-generation orchestration. These are useful translation material. The complete recursive tree lacks implementations for the hosts' requested RaymarchCloud, ReconstructRaymarchedClouds, CompositeRaymarchedClouds, PlaceCloudRays, UnpackRays, CloudNoiseGen, ReprojectLightVolume and LightVolumeShadow kernels. Available CloudDepthOcclusion.shader itself includes missing RaymarchedCloudUtils.cginc. This prevents a complete verbatim modern renderer port from the inspected source. [Pinned tree inventory](https://api.github.com/repos/LGhassen/EnvironmentalVisualEnhancements/git/trees/9a7786ac05cb4ee15ceb44f0e5151c784fa630d3?recursive=1).

Exact host paths at that v5 revision:

| Responsibility | Repository-relative file |
| --- | --- |
| Type definitions | `Atmosphere/RaymarchedClouds/CloudType.cs` |
| Phase parameters | `Atmosphere/RaymarchedClouds/CloudPhaseFunctions.cs` |
| Step/quality settings | `Atmosphere/RaymarchedClouds/RaymarchingSettings.cs` |
| Deferred scheduling | `Atmosphere/RaymarchedClouds/DeferredRaymarchedVolumetricCloudsRenderer.cs` |
| Lighting update host | `Atmosphere/RaymarchedClouds/LightVolume/LightVolume.cs` |
| Volume/scaled fade host | `Atmosphere/RaymarchedClouds/CloudsRaymarchedVolume.cs`, including `VolumetricLayerScaledFade` |

The parent also inspected LightVolume.cs directly. It packs direct/ambient slices into one scalar half-float volume, supports sequential slice updates, accumulates ambient history and derives its camera-oriented extent from the horizon. The plan now follows that compact organization. Its GPU warp and cache-generating equations remain absent, so the browser's documented projection/factor definitions and initial atomic publication still require their own oracles.

V5 source samples use the repository MIT default without overriding headers found by the audit. Keep file-specific notices when translating. Exclude the unnecessary DDSToTexture Unity loader: its README exception and function header differ. FastMath/EVEUtils fragments contain external-source attributions. Scatterer has mixed file notices, including GPL headers in AtmoPreprocessor/OceanBRDF and an INRIA notice in CommonAtmosphere. Do not apply one repository label to every copied file. No EVE or Scatterer source or art was incorporated during this decision.

Classic BoulderCo ships its own MIT notice but describes old layer2D/particle content. V5's tree contains sampling/art assets whose individual provenance was not established by this audit; no complete modern weather preset was found. Start with existing pinned NASA sources and authored assets, not an assumed bundled modern visual pack.

## What the current browser library provides

The inspected prototype pins Three 0.170.0, Takram clouds 0.7.6 and Takram atmosphere 0.19.1.

| Required system responsibility | Reusable part | Required work |
| --- | --- | --- |
| Weather/type-driven cloud bodies | CloudLayer, DensityProfile, density sampling helpers | Actual type map, per-type height/coverage/density curves and noise; shared conservative bounds |
| Shared direct and ambient lighting | Existing sun/sky LUT access and surface composition | New light-volume producer and all consumer adapters; stock cascaded Beer maps are a different encoding |
| Distant representation | Existing spherical geometry as reference | Common weather/lighting and one near/far radiance/transmittance composite; old shell cannot simply be enabled |
| Temporal reconstruction | CloudsPass, motion/rebase repairs, ping-pong resolve | Depth disocclusion, weather motion and explicit history compatibility |
| Texture-array slice rendering | Three WebGLArrayRenderTarget and framebufferTextureLayer | Sequential slice schedule, explicit interpolation between layers, capability checks and bounded memory |

CloudsEffect currently schedules its stock shadows before cloud marching. Replacing lighting requires owned orchestration so the old producer stops. Its shader also applies aerial perspective and opacity remapping internally; the new output contract must replace those deliberately. Reuse the coherent cloud source through one maintained fork/adapter, preserving notices and an upstream diff. Keep Takram atmosphere's clear-air LUT solver and the repaired surface/depth/normal/orientation pipeline.

## Fidelity and browser adaptations

Follow v5's authored types, richer base noise, shared lighting, temporal reconstruction and coordinated volume/scaled layer. V5 removed its older separate detail-noise stage. Its [overlap documentation](https://github.com/LGhassen/EnvironmentalVisualEnhancements/wiki/Overlapping-layers(Release-5)) explicitly uses approximate density-ordered passes for speed, with inter-layer shadows through the lighting volume. Any more exact combined-medium reference is our oracle, not evidence of EVE's missing shader implementation.

Browser slice layouts, update budgets, history validity and composition adapters must be explicit implementation choices. Keep volumetric reference views through orbit and cloud entry; the far layer passes only when its transition preserves their appearance. Neither similar architecture nor a source translation proves equal visuals or faster performance. Terrain's coarse coast/imagery and the measured cold-start stall retain separate acceptance items.
