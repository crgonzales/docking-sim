# Coverage Debt Ledger

| path | why hard | escape plan |
| --- | --- | --- |
| `apps/web/src/scene/Earth.tsx` (surface + atmosphere GLSL) | Shader raymarch/lighting runs on the GPU; correctness is judged by rendered output, not unit-testable JS. The analytic core is already extracted and tested (`EarthMath.ts`, `sky/atmosphereMath.ts`). | Keep extracting pure math into `sky/atmosphereMath.ts` as it stabilizes; visual regressions are caught by the release screenshot checklist. |
| `apps/web/src/scene/VolumetricClouds.tsx` (billboard GLSL) | Instanced vertex/fragment shaders (fades, FBM shaping, silver lining) have no CPU seam; placement logic IS tested via `sky/cloudPlacement.ts`. | If shaping bugs recur, mirror the fade/size formulas into a pure TS helper with tests, as done for cloud placement. |
| `apps/web/src/scene/Clouds.tsx` (deck GLSL) | Same shader-only limitation; the shared coverage transfer function is tested through `sky/cloudCoverage` consumers. | Covered indirectly by `cloudCoverage` tests; extend those if the deck transfer function grows branches. |
