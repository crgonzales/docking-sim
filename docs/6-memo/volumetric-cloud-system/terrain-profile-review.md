**The selector is already budget-bounded. The captured 140 m worker activity is backlog draining, not sustained residency churn.** The actionable waste is repeated selection and quadratic reconciliation after the desired cover stabilizes.

- [First descent capture](docking-sim-eve-clouds/.evidence.local/timings-clouds-1788838867259.json): below 12 km, selection averages **37.587 ms**, maximum **129.8 ms**. At 140 m, residency increases **167→270** while pending builds decrease **103→0**. From **58.9–64.4 s**, dispatch, worker completion, and geometry-preparation counts are all zero.
- [Second descent capture](docking-sim-eve-clouds/.evidence.local/timings-clouds-1788838964503.json): selection averages **38.367 ms** below 12 km. It likewise settles at **270 resident / 204 displayed / 204 desired**, with zero worker/geometry activity from **159.5 s** onward.

Those counters contradict continuous stable-patch rebuilding. Aggregate captures do not identify duplicate addresses during movement.

**Implicated code and minimum fix:**

1. **Keep the existing best-first selector and residency accounting.**
   [terrainNodeSet.ts:170](docking-sim-eve-clouds/apps/web/src/scene/terrain/terrainNodeSet.ts:170) evaluates six roots, then four children per accepted split. The budget guard at line 222 applies **before** expansion. With budget 300, maximum evaluations/residency are **298**, maximum leaves **225**. `capTerrainNodes` is not on this selection path.

   At latitude 40.5°, longitude −75°, altitude 140 m, maximum level 10, the actual pure function produces **270 evaluations, 66 splits, 204 leaves**—matching the captures exactly.

2. **Memoize selection inputs and reuse static node geometry.**
   [TerrainPatches.tsx:574](docking-sim-eve-clouds/apps/web/src/scene/terrain/TerrainPatches.tsx:574) reruns selection unconditionally every frame. Cache by planet-relative camera XYZ, projection scale, radius, thresholds, maximum level, budget, and horizon policy. Exact equality is sufficient initially; avoid introducing movement quantization.

   For moving-camera performance, compute camera direction/horizon angle once per selection, and retain a bounded address cache containing node center direction and angular radius. [quadtree.ts:253](docking-sim-eve-clouds/apps/web/src/scene/terrain/quadtree.ts:253) currently recomputes spherical geometry repeatedly: the horizon-plus-LOD path can calculate seven spherified directions per node. Reuse the same values without changing inequalities, error priority, or address tie-breaking.

   The timing spans measure elapsed wall time. Controlled Node runs generally took approximately **0.4–0.6 ms per selection**, with occasional large outliers. The captures alone cannot attribute their entire 37–40 ms to arithmetic versus GC/descheduling.

3. **Compile desired ancestry once; make reconciliation conditional on changes.**
   [terrainNodeSet.ts:257](docking-sim-eve-clouds/apps/web/src/scene/terrain/terrainNodeSet.ts:257) and line 308 repeatedly scan `desired`; [TerrainPatches.tsx:593](docking-sim-eve-clouds/apps/web/src/scene/terrain/TerrainPatches.tsx:593) repeats another scan for child requests.

   For the settled 204-leaf cover, the existing logic performs **40,800 desired comparisons during merging plus 41,616 during child-request eligibility**, every frame.

   Compile:
   ```text
   desiredKeys = selected leaf keys
   splitKeys   = all strict ancestors of selected leaves

   request/swap children iff parent ∈ splitKeys
   swap only when ALL FOUR children are ready
   merge iff a desiredKey occurs on the parent's ancestor chain,
              parent is ready, and all four children are displayed
   ```
   Ancestor walking preserves the helpers’ existing behavior for sparse desired inputs too.

   Mark reconciliation dirty when desired keys or available records change; coalesce worker-completion reconciliation. Preserve the existing protection of **displayed ancestry ∪ desired ancestry**, reservation limits, and obsolete-result rejection.

   **Critical:** coarsening can require multiple passes. Continue until stable, or retain the dirty flag for subsequent frames. Selection memoization must also leave tile-readiness retries, hero invalidation, mesh placement, and visibility updates operational.

4. **Fix a separate worker dispatch inefficiency.**
   [terrainWorker.ts:686](docking-sim-eve-clouds/apps/web/src/scene/terrain/terrainWorker.ts:686) limits global outstanding requests but chooses workers round-robin without checking whether each worker is busy.

   A controlled two-worker example dispatches requests 0/1; when worker 1 finishes first, request 2 goes to **still-busy worker 0**, leaving worker 1 idle. Track busy workers and dispatch only to an available worker, freeing its slot on completion/error. This can prolong backlog drain; its contribution to these captures is unquantified.

**Meaningful implementation oracles:**

- Preserve [existing budget/coverage tests](docking-sim-eve-clouds/apps/web/src/scene/terrain/terrainNodeSet.test.ts:34): six-face area exactly covered, no ancestor/descendant overlap, residency ≤ budget, evaluated nodes ≤ budget—even with depth 30.
- Fixed `(40.5, −75, 140 m)`, level 10: **204 leaves / 270 residents**; after convergence, repeated frames submit/build/dispose nothing and skip selection/reconciliation.
- Three ready children retain the parent; the fourth permits an atomic swap. Multi-level coarsening must reach the target without requiring newly built ancestors.
- Stress altitude jumps, seams `(0°,45°)`, cube corners, poles, and return paths; vary completion order and retain obsolete in-flight results. Assert coverage and reserved-plus-resident limits throughout.
- Worker oracle: completion on worker 1 while worker 0 remains busy must dispatch the next request to worker 1.

My read-only simulation exercised eight geographic/altitude targets at depth 30, varied completion order, maintained coverage and at most 298 occupied slots, and converged every time. The indexed reconciliation matched the existing helpers throughout. No edits, builds, browser use, or delegation were performed.
