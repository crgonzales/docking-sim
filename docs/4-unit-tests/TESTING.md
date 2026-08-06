# Testing Guidelines

## Test Framework

Vitest ^2.1.0 (in `@docking/sim-core`). `apps/web` has no test setup yet — its `test` script is a no-op placeholder.

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
