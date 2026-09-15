# Code Review: v0.14.3 — open the bare URL on the first-docking mission

**Review Date**: 2026-09-15
**Version**: 0.14.3
**Files Reviewed**:

- `apps/web/src/appModeStore.ts`, `apps/web/src/appModeStore.test.ts` (new)
- `README.md`, `docs/ARCHI.md`, `docs/2-changelog/changelog_table.md`, `docs/2-changelog/w7_v0.14.3.md`, root `package.json`

**Plan**: no plan — owner request ("the live game needs to open on the mission").

---

## Executive Summary

The live site opened on the autopilot SANDBOX. `resolveAppMode` now maps a missing, empty or unknown `?mode=` value to MISSION, so the bare URL lands on the first-docking briefing, while `sandbox`, `analysis` and `flight` stay explicit selections. The existing mode effect in `App.tsx` already starts and stops the scenario publisher for MISSION, so runtime switching is unchanged. Independent review found no issues.

APPROVED

---

## Changes Overview

One exported, unit-tested resolver replaces the inline ternary in the mode store; the store initialises from it. Documentation states the new default. The portfolio site keeps its blurred ambient background on `?mode=sandbox` and loads the simulator root (the mission) into the same frame when Play is pressed.

---

## Findings

Independent review reported no findings.

### Critical Issues

None.

### Major Issues

None.

### Minor Issues

None.

### Suggestions

None.

---

## Checklist

- [x] 1. Functional Requirements — passed: resolver behaviour matches intent; first docking is the default; runtime switching retains publisher cleanup and start-up
- [x] 2. Code Quality — passed
- [x] 3. Architectural Compliance — passed
- [x] 4. Package Boundary & FSW Purity — passed; unaffected
- [x] 5. GNC Conventions & Determinism — passed; unaffected
- [x] 6. Error Handling — passed: invalid mode values fall back to MISSION
- [x] 7. Security — passed; not applicable
- [x] 8. Performance — passed; constant-time initialisation only

---

## Verdict

**APPROVED**

Independent automated reviewer, one round, target `default-mission-entry-2026-09-15`, no findings; tests that need a specific mode select it explicitly, and HUD/audio branch on the current mode. Gate: `tsc --noEmit` passed; web suite 668 tests in 77 files passed; production build passed. Headless sweep of the built site: bare `/` shows the first-docking briefing, `?mode=sandbox` the autopilot approach, `?mode=mission` starts and thrusts, the sandbox `flyto` framings at 400 km, 100 km and 3 km render, and `?mode=flight` opens on foot at the airfield — no console errors or exceptions apart from the missing favicon. The same bare-URL and site checks are repeated against the live deployment after publication.
