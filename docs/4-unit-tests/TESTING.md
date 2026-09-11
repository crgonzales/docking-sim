# Testing Guidelines

## Test Framework

Vitest ^2.1.0 in the workspace packages, including `@docking/web`. Web tests are colocated with their modules; rendering conformance also runs in the browser through the development probe.

## Running Tests

```bash
# All packages
pnpm -r test

# sim-core only
pnpm --filter @docking/sim-core test

# Specific file/pattern
pnpm --filter @docking/sim-core test -- cw

# With coverage
pnpm --filter @docking/sim-core test -- --coverage
```

## Test Organization

Tests are colocated with source: `packages/sim-core/src/<module>.test.ts` next to `<module>.ts`. Reference example: `cw.test.ts` (CW analytic oracle) beside `cw.ts`.

## Writing Tests

The house style is **oracle tests, not vibes** (ARCHI.md testing gate):

- Every math module tests against a closed-form solution or physical invariant — identity at t=0, composition, conserved quantities (see `cw.test.ts`).
- Numeric propagators are checked against `propagateCW` at small separations.
- Quaternion norm drift must stay bounded; torque-free runs conserve momentum.
- Filters are checked for consistency (NEES within chi-square bounds) on seeded runs.
- FSW components are pure functions — test SensorFrame in → commands/telemetry out, never internal wiring.
- All tests are deterministic: seeded RNG, sim-time only.

## Coverage Requirements

Not defined. Risky uncovered paths go in `docs/4-unit-tests/COVERAGE-DEBT.md` (`path | why hard | escape plan`).

## Flight visual quality

The web suite covers graphics precedence/pixel limits, owned aircraft and ground textures, the actual sky-probe coordinate transform, and cloud-uniform adoption/release on already-compiled material maps. Run `pnpm --filter @docking/web test` for these alongside the existing flight/character tests.

GPU checks use the existing development probe in one browser tab:
`?renderer=library&cloudSystem=eve&probe=1&fixture=clouds&quality=medium&dpr=1`, then **Run cloud conformance**. The expected black test background is labelled in the UI. **Capture evidence** saves the report in its samples once the run finishes. The composer-depth fixture uses real effect passes and logarithmic depth; it asserts independent GPU storage, analytical pixels across two offscreen swaps, resize independence and synchronous restoration of the live renderer. Unit tests alone cannot catch attachment feedback loops. Return that same tab to `?mode=flight&flightProbe=1&profile=1` for visual/performance checks.

For Balanced/High comparisons, pause beside the aircraft, capture each preset and switch back. Compare camera/character/time metadata as well as pixels, drawing-buffer dimensions, local shadow size and resource counts. Warm shader variants may add a bounded number of programs; repeated switches must settle rather than grow indefinitely. Performance samples must exclude paused time, shader warmup and asset loading. Inspect near and grazing ground, lit/shaded aircraft faces, noon/sunset/night and a moving flight; a passing GPU fixture does not establish visual quality.

`FlightCloudLightingFixture` renders actual StandardMaterial pixels and the production airfield hook, using synthetic cache inputs with independently measured stock-light contributions as the oracle. It checks directional/sky attenuation, unchanged point lights/emission, pre-load compilation and rebind on the same material, empty-medium fallback, ordinary/instanced rebases, shared ownership release and renderer-state restoration. `CloudDiffuseTransportFixture` checks actual scattering shader outputs against analytical limits and an independently integrated boundary-value solution. The complete development conformance runner contains 759 cases at this checkpoint.
