# F/A-18 prototype — independent review

2026-09-10 · `docking-sim-f18` · branch `codex/f18-flight-prototype`, base `153957b`, including the uncommitted prototype.

**Status: all three findings resolved after user-authorized fixes. Recommendation: ready for further isolated user testing.** No blocking sign, unit, or default-trim defect was found. Fixes and focused regressions were implemented in this checkout by the original reviewer; no further agent or integration was involved.

Reviewed [ARCHI](../ARCHI.md), the [handoff](f18-flight-prototype.md), [plan](../1-plans/F_0.13.0_f18-flight-prototype.plan.md), existing test report, new dynamics/tests, flight session/frame/UI, and mode/export changes. Applied the project's TRIP review criteria within the requested scope. Existing full-suite/build/browser results are prior author evidence, not independently rerun results.

## Findings — resolved

1. **Minor, resolved — focused widgets suppressed flight shortcuts.** The new `flightInput.ts` handler, used by `FlightMode.tsx`, allows P/R on range inputs and selects. Other widget keys, including arrows, selection keys and C typeahead, remain native. Text/numeric inputs, textarea, inherited contenteditable editing, modifier combinations, composition and already-handled events are excluded. Repeated keydown cannot toggle pause repeatedly. Seven focused input tests cover pause/resume/reset, editing/navigation preservation and normal flight controls using the production handler without a browser.

2. **Minor, resolved — keyboard and pointer holds shared one ownerless key.** `FlightSession` now keeps keyboard keys and pointer-ID ownership separately; buttons call `session.pointer`. Active owners combine into held commands. Releasing one owner preserves the other, including multiple pointers on the same button. Up/cancel/capture-loss notifications are idempotent. Pause, blur, reset and disposal clear both sources. Seven new session regressions verify both release orders, duplicate releases, multiple pointers and all four cleanup paths. The original reproducer now increases roll from 0.30 to 0.60 while the remaining owner holds it, then returns to zero after the final release.

3. **Minor, resolved — the trim factory could return an unusable public result.** `createTrimmedFlight` and `stepFlight` now share parameter validation. The factory rejects nonfinite force calculations, out-of-range thrust, and nonfinite/unbounded controls. Zero trim authority returns neutral trim for an already balanced pitch coefficient (roundoff tolerance `1e-12`), and explicitly rejects an unbalanced moment. Six new core regressions cover invalid scalar/vector/domain inputs, balanced and unbalanced zero authority, zero-alpha roundoff, overflow, insufficient authority, negative required throttle, and equal dry/max thrust. The formerly NaN balanced case now satisfies force/moment equilibrium and flies for one simulated second; default trim remains unchanged.

## What checked out

- NED/FRD axes, scalar-first N→B quaternion derivative, Euler torque coupling, wind subtraction, lift/drag directions and nondimensional rate scaling are internally consistent. Positive commands increase bank, pitch and heading. HUD conversions correctly use knots, feet and ft/min.
- Default trim balances horizontal/vertical forces including tilted thrust and cancels pitch moment. It produces throttle `0.168330865`, trim `0.038507356`, and alpha `0.024504681 rad`; the existing 90 s equilibrium oracle passed.
- Flight dynamics stay pure TypeScript; web imports use the public sim-core entry point. No flight imports enter orbital FSW. Mode branches and effect cleanup isolate orbital pacing/input/audio from FLIGHT. Fixed-step pacing, pause/reset, frame handedness, determinism and terminal latches passed their focused tests.

## Verification and current limits

Original review: 17/17 existing focused tests passed and small in-memory probes verified the findings. After the fixes, ran:

```text
pnpm --filter @docking/sim-core exec vitest run src/flight.test.ts --no-cache --maxWorkers=1 --minWorkers=1
pnpm --filter @docking/web exec vitest run src/flight/flightFrame.test.ts src/flight/flightSession.test.ts src/flight/flightInput.test.ts --no-cache --maxWorkers=1 --minWorkers=1
pnpm --filter @docking/sim-core exec tsc --noEmit
pnpm --filter @docking/web exec tsc --noEmit
```

**37/37 passed**: 18 core and 19 web tests, comprising the original 17 plus 20 new regressions. Reported Vitest durations: core 0.382 s; web 0.717 s. Both typechecks and `git diff --check` passed. No new dependencies or test-infrastructure changes. A production bundle rebuild was unnecessary for these input/validation changes; prior build evidence remains historical.

Approximate aerodynamic derivatives, stall continuation, thrust lapse, constant mass/inertia, flat local physics and the spherical presentation chart remain acknowledged prototype limits. Retain the 50 km / 20 km / Mach 0.95 envelope and airborne start; contact is a terminal latch, not landing physics. Native widget/pointer event delivery, visuals and renderer performance have not been exercised after these fixes; regression tests run in Node. No full expensive suite, server, browser/tab, asset download, staging, commit, merge or integration was performed. All writes stayed inside this F18 checkout; the parent renderer and game tab were untouched.

## Paths changed by the fixes

- `apps/web/src/flight/FlightMode.tsx`
- `apps/web/src/flight/flightInput.ts` (new)
- `apps/web/src/flight/flightInput.test.ts` (new)
- `apps/web/src/flight/flightSession.ts`
- `apps/web/src/flight/flightSession.test.ts`
- `packages/sim-core/src/flight.ts`
- `packages/sim-core/src/flight.test.ts`
- `docs/6-memo/f18-prototype-independent-review.md`
