# Code Review: v0.15.0 — Under the Hood

**Review Date**: 2026-09-17
**Version**: 0.15.0
**Plan**: `docs/1-plans/F_0.15.0_completed-gnc-release.plan.md`
**Verdict**: APPROVED for the bounded release below.

## Scope and provenance

The candidate contains 144 explicitly selected files: docking corrections,
initial GNC Lab and run files, local Monte Carlo CLI, the native MATLAB plant,
reviewed simulation foundations, tests and public documentation. No new cloud
port, launch guidance/UI, Runpod helper, private extract or personal study
material is included. The production weather implementation remains the base
release. Validation used the single primary checkout with excluded work
preserved and a separate index defining the release.

This combined release has no single feature-loop state file. Existing scoped
independent reviews cover the unchanged completed slices; an independent
manual TRIP audit covers the final GNC corrections and examined dependency
closure. Review was not skipped and this is not a trivial-change fallback.

- Docking: independent implementation/acceptance approval, then integration
  and real docking, collision, corridor-abort, retry and emergency checks.
- GNC: prior independent trace, graph, session, UI, recorder/export and routing
  approvals retained. Sagan independently reviewed the subsequent parent-authored
  outcome/import corrections and release closure; APPROVED, no findings.
  That review explicitly excludes the reviewer's earlier serializer/UI authorship.
- IMU: Noether independently approved mounting/calibration wiring, including
  a 48-case independent rotation oracle, 73 affected tests and preserved legacy
  byte fingerprints. Actual mounts remain on the measurement-production side.
- Vehicle/ascent: independent reviews closed all findings. Final shoulder-contact
  recheck passed 78 tests and 36 independent geometry/contact cases.
- MATLAB: prior independent implementation approval retained; the refreshed
  candidate ran actual native MATLAB and Simulink again. This is execution
  evidence, not an independent self-review by the refresh author.

## Final GNC findings

No actionable Critical, Major or Minor issue remains in the reviewed delta.
The outcome resolver preserves witnessed terminal plant outcomes and otherwise
uses completed telemetry, covering an FSW abort after the last plant record.
It does not invent a truth-transition time. The import reconnect correction
releases a stale read's busy slot without publishing its retired result/error
or admitting a simultaneous read. Imported evidence remains separate from LIVE.

The reviewer checked 336 relative import/export edges across 76 scoped files;
all resolve within the manifest or base tree. The final corrective source
hashes match the tested candidate. Broader unfinished features are not approved
by this scoped verdict.

## Executed release checks

| Check | Result |
| --- | --- |
| sim-core | 314 tests / 27 files pass |
| scenario | 38 tests / 6 files pass |
| web | 890 tests / 108 files pass |
| Workspace type/build | Pass; 925 production modules, lazy GNC entry |
| Real local MC bundle | Built; executable equivalence and module-graph tests pass |
| Native MATLAB/Simulink | All 8 groups pass; no skipped groups; 1,001 samples per case |
| Fixture freshness/determinism | Pass on the isolated candidate |
| Production browser | Mission entry, lazy GNC routing, stepping, plots, retry, narrow layout and publisher teardown/reentry pass; no page errors |
| File/privacy boundary | Explicit manifest, no broad staging; excluded application work preserved separately |

Total: **1,242 tests in 141 files**, with no skipped bundle prerequisite in the
candidate run. The existing Vite large-chunk warning remains.

The first full run exposed ten missing-file failures in a test dedicated to
an excluded future pod helper. Curation was corrected to exclude that test
with its component; all local CLI/worker/bundle tests remain. The final web
suite passes. The failed attempt is retained locally rather than relabeled.

Actual Chromium desktop/narrow screenshots were inspected. The capsule and GNC
controls remain visible and usable. Existing coarse orbital clouds remain a
known visual limitation; this is not weather-port acceptance. Prior complete
nominal/fault export/import runs remain supporting evidence for that unchanged
behavior. Full replay, live MATLAB/SIL/HWIL, sustained performance, remote
campaigns and launch gameplay remain outside this release.

Native MATLAB results verify the simulator's modeled plant, not manufacturer
Crew Dragon data. MC outcomes characterize the declared noise experiment,
not certified vehicle reliability. Publication is authorized by the owner's
release and Cloudflare-update request; deployment identity is checked separately.
