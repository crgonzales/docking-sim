# Code Review: Flight Feel

**Review Date**: 2026-08-15  
**Version**: 0.7.0  
**Files Reviewed**:

- `README.md`
- `apps/web/src/App.tsx`
- `apps/web/src/hud/ModeBar.tsx`
- `apps/web/src/hud/SwitchPanel.tsx`
- `apps/web/src/hud/audioContext.ts`
- `apps/web/src/hud/flightAudio.ts`
- `apps/web/src/hud/hud.css`
- `apps/web/src/hud/panelAudio.ts`
- `apps/web/src/input/bindings.ts`
- `apps/web/src/input/manualControls.ts`
- `apps/web/src/scene/Spacecraft.tsx`
- `apps/web/src/scene/ThrusterPlumes.tsx`
- `apps/web/src/telemetry/scenarioEmitter.ts`
- `apps/web/src/telemetry/simEmitter.ts`
- `docs/1-plans/F_0.7.0_flight-feel.plan.md`
- `docs/scenario-mode-spec.md`
- `packages/scenario/src/director.test.ts`
- `packages/scenario/src/scenarioToSimConfig.ts`
- `packages/sim-core/src/control.test.ts`
- `packages/sim-core/src/control.ts`
- `packages/sim-core/src/fsw.test.ts`
- `packages/sim-core/src/fsw.ts`
- `packages/sim-core/src/manual-rate.test.ts`
- `packages/sim-core/src/sim.test.ts`
- `packages/sim-core/src/sim.ts`
- `packages/sim-core/src/thrusters.ts`
- `packages/sim-core/src/types.ts`

**Plan**: `docs/1-plans/F_0.7.0_flight-feel.plan.md`

---

## Executive Summary

The change adds selectable manual-flight authority, truth-driven per-jet plumes, procedural flight audio, and the associated HUD and command plumbing while preserving AUTO and scenario behavior. The requester reports a clean build/typecheck and 125 passing tests; no critical or major defects remain.

APPROVED with observations

---

## Changes Overview

Manual control limits and gains now resolve through LOW/HIGH authority presets exposed through the deterministic FSW and `SimLoop` command surfaces. Truth-side thruster activity is accumulated into render duty, while the web layer renders plumes and drives pooled WebAudio voices through a shared master gain. Scenario runs remain pinned to LOW by default, and the new authority switch is exposed through the mission panel, HUD, keyboard bindings, and both telemetry emitters.

---

## Findings

### Critical Issues

None.

### Major Issues

None.

### Minor Issues

1. **Release documentation was incomplete** — `README.md:3`, `README.md:50`, `docs/1-plans/F_0.7.0_flight-feel.plan.md:417`. The initial review found that the README still advertised v0.6.0 and omitted the new authority keybind. The `G` binding is now documented at `README.md:50`. The version/feature update at `README.md:3` and the v0.7.0 changelog remain deferred to the TRIP-3 release ceremony. **Disposition: partially addressed; remaining release-owned work accepted with override.**

2. **Hardware-in-the-loop validation remains pending** — `docs/1-plans/F_0.7.0_flight-feel.plan.md:457`, `docs/1-plans/F_0.7.0_flight-feel.plan.md:477`. The all-plumes 60-fps benchmark and integrated LOW/HIGH flight, plume, and audio check require a real GPU, browser, display, and audio output; SwiftShader results are not valid performance evidence. **Disposition: open observation; accepted with override and deferred to the repo owner.**

### Suggestions

None.

---

## Checklist

- [ ] 1. Functional Requirements — passed with caveat; automated behavior is covered, but the integrated browser/audio check remains pending.
- [x] 2. Code Quality — passed.
- [x] 3. Architectural Compliance — passed.
- [x] 4. Package Boundary & FSW Purity — passed.
- [x] 5. GNC Conventions & Determinism — passed.
- [x] 6. Error Handling — passed.
- [x] 7. Security — not applicable; no security-sensitive surface was introduced.
- [ ] 8. Performance — passed by static review with caveat; the real-GPU 60-fps benchmark remains pending.

---

## Verdict

**APPROVED with observations**

The implementation gate is met: no critical or major findings remain, the requester reports a clean build/typecheck and 125 passing tests, and implementation-owned documentation is updated. The README version/feature summary and changelog are intentionally reserved for TRIP-3 release, while the two human sensory/performance checks remain explicit owner follow-ups.

**Post-approval addendum.** After this verdict was issued, the repo owner flew the
build and reported that the plumes read as flat triangles. A visual pass followed,
confined to `apps/web/src/scene/ThrusterPlumes.tsx`: `MeshBasicMaterial` was
replaced with a `ShaderMaterial` providing radial and longitudinal smoothstep
falloff and a hot axial core, cone radial segments were raised from 6 to 24,
uniform `setScalar` was replaced with duty-driven length scaling at near-constant
radius, and a per-jet phase flicker was added. The change is presentation-only —
no sim-core, scenario, audio, or control-path code was touched, and the
allocation-free `useFrame` and additive/HDR constraints were preserved. **This
pass was not itself submitted to the Codex review loop**; it was verified by build
and by direct inspection of the render loop for per-frame allocation.
