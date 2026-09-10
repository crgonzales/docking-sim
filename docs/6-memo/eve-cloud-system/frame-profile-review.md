**Added opt-in measurements for the R3F callback chain, CameraRig, GPU-query polling, and the docking PiP. No new performance capture was run.**

The supplied baseline is settled near-ground flight at approximately 140 m: 11–13 FPS on M3, composer CPU wall mean about 8 ms, GPU pass total about 24 ms, and zero settled selection/reconciliation/worker activity after the terrain changes. A previous profile-off descent was also slow. These figures do not establish how much of the 77–91 ms frame interval is occupied by the main thread; CPU submission and GPU elapsed time overlap.

Implementation is limited to CameraRig.tsx, DockingCameraPiP.tsx, renderTimings.ts, the new RenderFrameTiming.tsx, and importing/mounting that component in SceneRoot.tsx, plus this memo. There are no simulation, terrain-cache, vendor, LibraryEffects, RenderProbe, or probe-control changes.

| Snapshot metric | Boundary and meaning |
| --- | --- |
| `cpu['frame.callbacksCpuWall']` | Starts at `Number.MIN_SAFE_INTEGER` callback priority; ends at `Number.MAX_SAFE_INTEGER`. Includes this root's intervening callbacks, manual composer rendering/fallback, PiP, and RenderProbe's synchronous snapshot/serialization work. Does not measure the RAF interval, asynchronous React commits, timer callbacks between frames, browser painting/compositing, or GPU completion. |
| `cpu['cameraRig.frameCpuWall']` | Entire CameraRig callback in every camera mode, including early returns. |
| `cpu['cameraRig.groundCpuWall']` | Entire `cameraGround()` call, including no-source/no-data returns. Nested inside the camera callback; sampling/collision behavior is unchanged. |
| `cpu['profiling.gpuPollCpuWall']` | Supported GPU polling, including disjoint checks, availability/result reads, recycling, and error returns. Includes polls from both `beginFrame()` and `snapshot()`. Unsupported/disabled polling records no sample. |
| `cpu['pip.render']` | Visible, ready PiP pass: camera/setup work, both draws, renderer-state restoration, query begin/end overhead. No sample when hidden or missing render state/rectangle. |
| `gpu.timings['pip.render']` | One GPU query around the visible PiP pass, after the composer's queries have closed. Uses the existing availability/disjoint handling and bounded query pool. |

These use the existing scalar count/total/average/max/last aggregates and cumulative equivalents. No new per-frame sample arrays, logging, or React updates were added. All recording uses the existing `profile=1` opt-in. Without profiling, the new frame component installs no subscribers, timing methods return without reading the clock, and PiP metadata updates are no-ops. Existing nonprofile probe controls remain available.

`snapshot.pip` reports:

- `visible`: the visibility value observed by the PiP callback, even if required render inputs are absent.
- `renderedLastFrame`: whether both PiP draws and renderer-state restoration completed in the most recent callback.
- `renderCount`: completed PiP passes since the preceding snapshot; resets when a snapshot is taken.
- `renderCountCumulative`: completed PiP passes since collector creation. Unmount clears current visibility/rendered state, retaining counts like the other cumulative metrics.

These counts remain usable when GPU queries are unavailable or the pool is full. Compare actual PiP render counts with GPU timing counts; missing GPU samples are not zero-cost renders. An exceptional PiP attempt can contribute a CPU timing without incrementing the completed-render count.

**Rendering ownership and cleanup.** The installed R3F implementation increments `internal.priority` for positive `subscribe()` arguments and skips automatic rendering while that count is nonzero. A conventional late positive `useFrame()` timer would therefore change fallback behavior. RenderFrameTiming registers the end observer at zero, then changes only its subscriber ordering field to the late positive priority and re-sorts the list. R3F's unsubscribe closure captures the original zero argument; neither registration nor cleanup changes manual-render ownership. The start observer is negative. Both subscriptions are removed on cleanup, and the local pending timestamp is cleared. This is a deliberate, narrow dependency on the installed R3F subscription implementation and must be reviewed on an R3F upgrade.

The observer never calls `gl.render()`, changes `frameloop`, invalidates a frame, or opens a GPU query. Composer priority 1 and PiP priority 2 remain unchanged. LibraryEffects' explicit pre-readiness fallback is inside the measured callback chain. R3F's own automatic fallback, when eligible, still runs after the callback chain and is outside this metric. A callback exception that prevents the end observer from running leaves no completed frame sample; the next start overwrites the pending timestamp rather than spanning frames.

Camera/ground/polling timers close through `finally`, including early returns. PiP closes its GPU query and CPU timer through `finally`; renderer target, viewport, scissor, scissor-test, and auto-clear state are restored through an inner `finally`. The existing `beginGpu()` active-slot guard refuses nested queries. No enclosing whole-frame GPU query was introduced; the later PiP reuses a free slot without overlapping a composer query. Pool exhaustion skips GPU measurement rather than blocking rendering.

**Nested timestamps must not be added.**

- `frame.callbacksCpuWall` contains CameraRig, composer CPU rendering, PiP CPU rendering, cloud scheduling, supported polling performed in frame callbacks, and synchronous probe work. Do not add those child durations to the frame total.
- `cameraRig.frameCpuWall` contains `cameraRig.groundCpuWall`. Do not add them together.
- Existing `composer.renderCpuWall` contains the composer pass CPU timings and overlaps `composer.firstUseCpuWall` on first use. The existing mask scheduling metric is outside `composer.renderCpuWall`, but inside the frame callback span.
- PiP CPU work follows the composer and is separate from composer CPU work; both are children of the frame span. The PiP GPU query is sequential with composer GPU queries, but CPU and GPU durations are different timelines and must not be added to infer wall-frame duration.
- Polling has one sample per supported poll, potentially more than one per frame. Its mean is per poll, not per frame. Prefer totals and counts over adding means from differently sampled metrics.

RenderProbe takes its snapshot at priority 3, before the late frame observer. Therefore a snapshot contains only previously completed whole-frame samples, while camera/composer/PiP children already include that snapshot frame. The current frame total, including synchronous snapshot/serialization overhead, is recorded afterward and appears in the next snapshot. Exact subtraction of parent and child totals within a single one-second snapshot is consequently invalid; allow for the frame-boundary offset and compare longer settled intervals/cumulative changes. GPU results also arrive asynchronously and can fall in later snapshot windows than their CPU submissions.

The next capture should first compare whole-chain mean/max with the supplied 77–91 ms frame interval, then inspect ground, polling, and PiP totals/counts. A small callback-chain duration would leave simulation/publication, asynchronous UI work, and browser/driver scheduling unresolved; simulation is intentionally not instrumented in this patch. No bottleneck or speedup is claimed from static inspection.

Validation for this change is source/diff review only, including the installed R3F subscribe/unsubscribe and automatic-render guard. No tests, build, browser session, vendor integration, or runtime profiling was launched.
