# Coverage Debt Ledger

`path | why hard | escape plan`

- `apps/web/src/telemetry/stubEmitter.ts` | apps/web has no test runner (no-op test script) | add Vitest to apps/web when the first FSW-adjacent web logic lands (Phase 2 sim loop swap), then test the frame generator's determinism and approach profile
- `apps/web/src/hud/TelemetryStrip.tsx` (closing-rate baseline+EMA estimator) | apps/web has no test runner; estimator is display smoothing, not safety-critical | extract to a pure module and unit-test alongside the emitter when apps/web gains Vitest
