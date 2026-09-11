# Ground and volumetric weather code review

## Round 1 — independent review (verbatim)

The implementation is close, but the approval gate remains open. I found two verified Minor defects and incomplete verification.

## Findings

- **[Major] Verification gate is incomplete.** GPU motion conformance, fixture/orbital regressions, preview-speed checks, and a complete build remain pending; the memo also records an initially failing new advection test. Finish these runs and update the memo with final green results. [ground-weather-validation.md:27](/Users/carlosgonzales/dev/docking-sim-flight-integrated/docs/6-memo/f18-integration/ground-weather-validation.md:27) [ground-weather-validation.md:31](/Users/carlosgonzales/dev/docking-sim-flight-integrated/docs/6-memo/f18-integration/ground-weather-validation.md:31) [ground-weather-validation.md:32](/Users/carlosgonzales/dev/docking-sim-flight-integrated/docs/6-memo/f18-integration/ground-weather-validation.md:32)

- **[Minor] Starting a DEV exercise can reset the aircraft without resetting environment time.** In a character-enabled airborne route, `FlightMode` subscribes only to `character.onReset`, while the exercise panel calls `session.startExercise()`, which directly invokes `session.reset()`. Subscribe to both reset sources with deduplication, or route exercise starts through the common reset coordinator. [FlightMode.tsx:249](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/flight/FlightMode.tsx:249) [FlightExercisePanel.tsx:25](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/flight/FlightExercisePanel.tsx:25) [flightSession.ts:70](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/flight/flightSession.ts:70)

- **[Minor] Light-cache diagnostics retain stale `ready` state after invalidation.** `invalidate()` clears validity and generation but not `status.state`; because `update()` changes state only when a published cache exists, seeks/context restoration can report `ready` while rendering fallback and rebuilding. Set the state to `invalidated` or `building` when clearing a nonterminal cache. [CloudLightVolume.ts:225](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/scene/clouds/CloudLightVolume.ts:225) [CloudLightVolume.ts:248](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/scene/clouds/CloudLightVolume.ts:248)

## Checklist

- Functional requirements: broadly conformant; reset defect above.
- Code quality: no additional actionable issues.
- Architectural compliance: optional flight-owned environment, static fixture defaults, one canvas/composer, canonical atlas, and bounded local shadow conform.
- Package boundary / FSW purity: changes remain in `apps/web`; no sim-core or scenario boundary violations.
- GNC / determinism: simulation-time-driven, seeded, SI/ECEF conversions remain under established frame authority.
- Error handling: rendering fallback is safe; diagnostic transition defect above.
- Security: no relevant security regression found.
- Performance: bounded atlas/light/shadow resources and the recorded sample meet the stated floor; final regression runs remain pending.
- Approval gate: not met. I did not rerun lint, type-check, or tests, as requested.

REQUEST_CHANGES

## Response

- Verification has completed: 591 web tests, 649 GPU cases, full workspace build, airborne/orbital regression and 60x UI preview. Updated validation memo with actual evidence.
- Reset subscription now uses the flight reset event for airborne routes (including character resets, which call flight.reset), and the character event for ground routes. A behavioral regression verifies keyboard, HUD, exercise start and unsubscribe paths, with exactly one discontinuity per reset.
- Light-cache invalidation now clears the diagnostic state to invalidated while preserving terminal failed/unsupported/disposed states.



## Round 2 — independent review (verbatim)

All three round-one findings are addressed. No new issues found.

## Prior findings

1. “Verification gate is incomplete.” — **Addressed.** The saved evidence records 591 web tests, 649 GPU cases, full workspace and post-fix web builds, fixture/orbital regressions, 60x preview, and full-day visual checks. [ground-weather-validation.md:27](/Users/carlosgonzales/dev/docking-sim-flight-integrated/docs/6-memo/f18-integration/ground-weather-validation.md:27) [ground-weather-validation.md:32](/Users/carlosgonzales/dev/docking-sim-flight-integrated/docs/6-memo/f18-integration/ground-weather-validation.md:32) [ground-weather-validation.md:37](/Users/carlosgonzales/dev/docking-sim-flight-integrated/docs/6-memo/f18-integration/ground-weather-validation.md:37)

2. “Starting a DEV exercise can reset the aircraft without resetting environment time.” — **Addressed.** Airborne routes now subscribe to `FlightSession`; ground routes use `CharacterSession`, preventing both bypasses and duplicate discontinuities. Production-helper tests cover keyboard, direct, exercise, and unsubscribe paths. [flightEnvironment.ts:286](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/flight/flightEnvironment.ts:286) [FlightMode.tsx:249](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/flight/FlightMode.tsx:249) [flightEnvironment.test.ts:69](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/flight/flightEnvironment.test.ts:69)

3. “Light-cache diagnostics retain stale `ready` state after invalidation.” — **Addressed.** Invalidation now publishes `invalidated` while preserving terminal `failed`, `unsupported`, and `disposed` states. [CloudLightVolume.ts:248](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/scene/clouds/CloudLightVolume.ts:248) [CloudLightVolume.ts:256](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/scene/clouds/CloudLightVolume.ts:256)

## Incremental checklist

- Functional requirements: pass; reset and verification gaps are closed.
- Code quality: pass; reset ownership is centralized and documented.
- Architectural compliance: pass; flight-owned environment and renderer boundaries remain intact.
- Package boundary / FSW purity: pass; changes remain web-side.
- GNC / determinism: pass; no wall-clock simulation or frame-convention regression.
- Error handling: pass; cache fallback and terminal diagnostics remain graceful.
- Security: no applicable regression.
- Performance: pass; no new render-loop work from the fixes, and saved measurements satisfy the established floor.
- Approval gate: met based on the saved test, GPU, build, documentation, and visual-validation evidence. I did not rerun tests or browser checks, as requested.

APPROVED

## Additional captured pause defect

After round 2, the requester inspected the 60x preview capture and found a completed but 99.66-second-old light cache while paused. The active-time refresh timer cannot advance during pause. EveCloudSystem now queues the final stopped weather time once; it leaves canonical atlas generation and temporal history intact. Browser verification passed; a repeat paused capture retained the same time, light generation 16, valid age zero, complete atlas and no history reset.

## Round 3 — independent review (verbatim)

All prior findings remain addressed. The paused-cache scheduling correction introduces no new issue.

## Prior findings

1. “Verification gate is incomplete.” — **Addressed.** The 591 web tests, 649 GPU cases, workspace build, regressions, and visual checks remain recorded; the final scheduling change also has a green post-change web build. [ground-weather-validation.md:31](/Users/carlosgonzales/dev/docking-sim-flight-integrated/docs/6-memo/f18-integration/ground-weather-validation.md:31) [ground-weather-validation.md:34](/Users/carlosgonzales/dev/docking-sim-flight-integrated/docs/6-memo/f18-integration/ground-weather-validation.md:34) [ground-weather-validation.md:41](/Users/carlosgonzales/dev/docking-sim-flight-integrated/docs/6-memo/f18-integration/ground-weather-validation.md:41) [ground-weather-paused-cache-build.log:22](/private/tmp/ground-weather-paused-cache-build.log:22)

2. “Starting a DEV exercise can reset the aircraft without resetting environment time.” — **Addressed.** Airborne routes still subscribe to flight resets, while ground routes subscribe to character resets, producing one environment discontinuity. [flightEnvironment.ts:286](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/flight/flightEnvironment.ts:286) [FlightMode.tsx:249](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/flight/FlightMode.tsx:249) [flightEnvironment.test.ts:69](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/flight/flightEnvironment.test.ts:69)

3. “Light-cache diagnostics retain stale `ready` state after invalidation.” — **Addressed.** Invalidation still reports `invalidated` while preserving terminal states. [CloudLightVolume.ts:248](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/scene/clouds/CloudLightVolume.ts:248) [CloudLightVolume.ts:256](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/scene/clouds/CloudLightVolume.ts:256)

## Final scheduling correction

The stopped-weather check requests exactly one snapshot at the final paused timestamp: after assignment, `lightInputs.visualTimeSeconds` equals `weatherTimeSeconds`, preventing repeated generations. It is dynamic-weather-only, does not invalidate history, and does not touch the canonical atlas. [EveCloudSystem.ts:212](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/scene/clouds/EveCloudSystem.ts:212) [EveCloudSystem.ts:217](/Users/carlosgonzales/dev/docking-sim-flight-integrated/apps/web/src/scene/clouds/EveCloudSystem.ts:217)

The saved reproduction reports paused lighting generation 16 as ready and valid, age zero, no pending slices, atlas complete, and no history reset. [flight-base-1789100547143.json:1030](/Users/carlosgonzales/dev/docking-sim-flight-integrated/.evidence.local/flight-base-1789100547143.json:1030)

## Incremental checklist

- Functional requirements: pass; paused caches now converge to stopped weather.
- Code quality: pass; bounded condition with a clear ownership comment.
- Architectural compliance: pass; scheduling remains inside the renderer-owned cloud system.
- Package boundary / FSW purity: pass; web-rendering change only.
- GNC / determinism: pass; uses environment time, with no CPU/GPU math or wall-clock change.
- Error handling: pass; bounded fallback remains active until atomic publication.
- Security: no applicable regression.
- Performance: pass; one additional generation only when required, with no atlas rebuild or history reset.
- Approval gate: met. The hard-to-automate lifecycle check is documented in the accepted coverage-debt ledger. [COVERAGE-DEBT.md:10](/Users/carlosgonzales/dev/docking-sim-flight-integrated/docs/4-unit-tests/COVERAGE-DEBT.md:10)

No tests, builds, browser actions, or code changes were performed during this review.

APPROVED
