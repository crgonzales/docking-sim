# Ground/weather plan review

## Round 1 — verbatim

- [P1] `F_0.10.0_ground-weather-cycle.plan.md:17,28,48` — Weather reprojection is specified, but the existing stationary-history fast path remains camera-only (`CloudsPass.ts:203-220`) and would preserve stale unsampled cloud/clear tuples for moving weather. Add an explicit media-motion gate that disables stationary-history reuse whenever the weather transform changes—without invalidating all history—plus a stationary-camera GPU test verifying cloud-hit advection and unchanged no-cloud velocity.

REQUEST_CHANGES

Response: explicitly added the pass, gate semantics and GPU acceptance checks to the plan. Continuous motion disables the stationary optimization without discarding otherwise valid history.

## Round 2 — verbatim

Prior finding: “Weather motion did not disable the camera-only stationary-history fast path.”

Addressed — lines 28 and 47 now explicitly gate stationary tuple reuse on an unchanged weather transform, preserve motion-aware history, keep no-cloud velocity camera-only, and require GPU coverage.

New issues introduced: none.

APPROVED
