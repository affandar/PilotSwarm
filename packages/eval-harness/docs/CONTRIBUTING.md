# Contributing to eval-harness

How to add a new grader, driver, suite, mutator, or reporter without breaking the existing surface. This is the hands-on companion to `docs/INVARIANT-COVERAGE.md` — that doc says what mustn't break; this one says how to add things in a way that won't.

## Repository layout (high level)

```
packages/eval-harness/
├── src/
│   ├── index.ts                # public API surface — every export goes here
│   ├── runner.ts               # EvalRunner (single-turn lifecycle)
│   ├── multi-trial.ts          # MultiTrialRunner (N trials, pass@k)
│   ├── matrix.ts               # MatrixRunner (model × config × trials)
│   ├── trajectory-runner.ts    # V4 TrajectoryRunner
│   ├── loader.ts               # JSON fixture → validated EvalTask
│   ├── types.ts                # Zod schemas + TS types (single source of truth)
│   ├── stats.ts                # passAtK, wilsonInterval, bootstrapCI, mcNemar, mannWhitneyU
│   ├── baseline.ts             # save/load/projection
│   ├── regression.ts           # RegressionDetector
│   ├── ci-gate.ts              # CIGate verdict + exit codes
│   ├── drivers/                # FakeDriver, LiveDriver, ChaosDriver, ScriptedDriver, ...
│   ├── graders/                # tool-selection, ordering, response, cms-state, durability, llm-judge, trajectory
│   ├── observers/              # EvalToolTracker (LiveDriver tool-call capture)
│   ├── reporters/              # console, jsonl, console-aggregate, markdown, pr-comment
│   ├── perf/                   # latency / cost / db / activity / durability / concurrency trackers
│   ├── prompt-testing/         # variant matrix, mutators, suites (injection / ablation / robustness / regression)
│   ├── fixtures/eval-tools.ts  # test_add / test_multiply / test_weather (LiveDriver tool registry)
│   └── validation/             # parseAtBoundary, normalize-result
├── datasets/                   # canonical fixtures
├── test/                       # Vitest tests (mirrors src/ layout)
└── docs/                       # this directory
```

## The contract surface

Every public export is in `src/index.ts`. Adding a feature means:

1. Implement under `src/<area>/`.
2. Add tests under `test/<area>/` (FakeDriver-driven; no LIVE for unit coverage).
3. Re-export from `src/index.ts`.
4. Update relevant doc(s) (this file + the area-specific one).
5. Run `npm test` — full local suite must stay green, `tsc --noEmit` strict clean.

## Adding a grader

Graders score `ObservedResult` against `EvalExpected` and return one or more `Score`s. Existing graders compose via `gradeEvalCase()` in `src/graders/index.ts`.

**Steps:**

1. Create `src/graders/<your-grader>.ts`. Pure function, no side effects:

   ```ts
   import type { ObservedResult, EvalExpected, Score } from "../types.js";

   export function gradeYour(
     observed: ObservedResult,
     expected: EvalExpected,
   ): Score[] {
     // ...
     return [{
       name: "your-dimension",
       value: 0..1,
       pass: boolean,
       reason: "...",
       actual,
       expected,
     }];
   }
   ```

2. Wire into the composer (`src/graders/index.ts`) so `gradeEvalCase` calls it when the relevant `expected.<field>` is set. Match the existing pattern — early-return absent expectations.

3. Add Zod schema additions to `types.ts` if your grader reads new `EvalExpected` fields. Keep `schemaVersion: 1` literal — don't bump silently. If you need a v2, that's a separate commit with a migration path.

4. Tests under `test/graders/<your-grader>.test.ts`. Cover: pass case, fail case, missing-expectation skip, malformed observed.

5. Export from `src/index.ts`.

6. Update README "Grading Reference" table.

**Don't:**

- Throw from a grader. Return a failing `Score` with a useful `reason`.
- Mutate `observed` or `expected`. They're shared across graders.
- Read from disk / network. Graders are pure.

Reference: `src/graders/tool-selection.ts` is the simplest non-trivial grader; `src/graders/llm-judge.ts` is the most complex (cache, retry, budget, cross-process singleflight).

## Adding a driver

See `docs/DRIVERS.md` for the contract. Steps:

1. Create `src/drivers/<your-driver>.ts` implementing `Driver`:

   ```ts
   import type { Driver, ObservedResult } from "./types.js";
   export class YourDriver implements Driver {
     async run(sample, options): Promise<ObservedResult> { /* ... */ }
   }
   ```

2. Honor `options.signal`. Throwing on signal abort is fine; the runner tags it as infra error.

3. If you provide cmsEvents, set them on `observed.cmsEvents` so durability graders can read them.

4. Tests under `test/drivers/<your-driver>.test.ts` — cover happy path, abort path, malformed scenario (if applicable).

5. Export from `src/index.ts`.

6. Update `docs/DRIVERS.md` matrix.

Reference: `src/drivers/fake-driver.ts` for the simplest impl; `src/drivers/live-driver.ts` for production patterns (timeout, AbortSignal, teardown discipline).

## Adding a suite

A "suite" is a category of tests gated by env (e.g. SAFETY, PERFORMANCE — see `docs/SUITES.md`).

1. Create `test/<suite>-live.test.ts` (or non-LIVE if it's deterministic).

2. Gate with the existing pattern:

   ```ts
   const live = process.env.LIVE === "1";
   const run = live ? it : it.skip;
   ```

3. Use `LiveDriver` (or `FakeDriver` for non-LIVE).

4. Wire reports via `EVAL_REPORTS_DIR` (auto-loaded by EvalRunner) — no per-test plumbing.

5. Update the suite matrix in `docs/SUITES.md` and `README.md`.

6. Add the suite's gates to `bin/run-live.sh` if you introduce a new env var.

Reference: `test/safety-live.test.ts` for a multi-category suite with mixed code/judge graders.

## Adding a mutator (prompt-testing)

Mutators transform a baseline `PromptUnderTest` per `PromptVariant.mutation`. Register-once + use-everywhere.

1. Create `src/prompt-testing/mutators/<your-mutator>.ts`:

   ```ts
   import type { Mutator } from "./mutator.js";

   export const yourMutator: Mutator = {
     id: "your-id",
     async apply(text: string, config: YourConfig, ctx: MutatorContext): Promise<string> {
       // Pure transformation; no I/O outside of paths exposed via ctx.
     },
   };
   ```

2. Register in `src/prompt-testing/mutators/index.ts` `MUTATORS` map.

3. Tests in `test/prompt-testing/mutators/<your-mutator>.test.ts`.

4. Update `docs/PROMPT-ITERATION.md` mutator catalog.

Reference: `src/prompt-testing/mutators/minimize.ts` for percent-based shrinkage; `src/prompt-testing/mutators/remove-section.ts` for heading-based stripping.

## Adding a reporter

`Reporter` and `AggregateReporter` interfaces live in `src/reporters/types.ts` + `src/reporters/aggregate-types.ts`.

1. Create `src/reporters/<your-reporter>.ts`:

   ```ts
   import type { Reporter, RunResult } from "./types.js";

   export class YourReporter implements Reporter {
     async onRunStart(task, runId) { /* ... */ }
     async onCaseResult(result) { /* ... */ }
     async onRunComplete(result: RunResult) { /* ... */ }
   }
   ```

2. Async-ready by contract — every method returns `void | Promise<void>`. Don't block the runner; if you need async I/O, do it in `onRunComplete` after results are final.

3. Reporters MUST NOT mutate the result. The `JsonlReporter` is incremental (writes per-case) so process crashes don't lose data — preserve that pattern if you need similar guarantees.

4. Register-time vs runner-time wiring: `EvalRunner({ reporters: [...] })` accepts user reporters; `EVAL_REPORTS_DIR` env auto-appends `JsonlReporter` only if no JsonlReporter is already in the list. Don't break that contract.

5. Tests under `test/reporters/<your-reporter>.test.ts`.

6. Export from `src/index.ts`.

7. Update README "Reporter" table.

Reference: `src/reporters/jsonl.ts` — incremental writes, path-sanitized fail artifacts, run/sample/summary line types.

## Test discipline

| layer | driver | LIVE? |
|-------|--------|-------|
| schema / loader / type tests | none — pure data | no |
| grader tests | `FakeDriver` with scripted scenarios | no |
| runner / matrix / multi-trial | `FakeDriver` | no |
| reporter tests | mock results — no driver | no |
| `*-live.test.ts` | `LiveDriver` (or chaos overlay) | yes, gated |

**Always add a non-LIVE test path.** LIVE is signal but slow, costly, and stochastic — never the only coverage for a unit.

**Never skip-gate a unit test.** `it.skip` belongs in LIVE. A `it.todo` for upcoming work is fine.

**Match invariants in `docs/INVARIANT-COVERAGE.md`.** If you touch one of the seven invariant families, add a regression test that locks the invariant alongside your change. The doc names the regression test paths.

## Schema evolution

`schemaVersion: 1` is `z.literal(1)` in `types.ts`. Don't change it casually. If you need v2:

1. Add `z.union([z.literal(1), z.literal(2)])`.
2. Write a `migrateV1ToV2(task)` function with explicit field defaults.
3. Update `loadEvalTask` to detect v1 and pipe through migration.
4. Add fixtures for both versions to verify backwards compat.
5. Document in `docs/PROMPT-TESTING-SPEC-DRIFT.md` (or a new `SCHEMA-MIGRATION.md`).

The single-version literal is intentional — we want forced-acknowledgement when the shape changes, not silent breakage.

## Build / verify checklist

Before opening a PR:

```bash
cd packages/eval-harness
npm run build              # tsc strict; no errors
npx vitest run             # full suite (includes package-root smoke against dist/)
```

Then for any LIVE-relevant change, the smoke targeting:

```bash
bin/run-live.sh --cheap                       # LIVE on, cheap
bin/run-live.sh --judge -- test/llm-judge-live.test.ts   # if you touched judge code
```

## Things to avoid

- **Adding new `*Schema` exports** without need. Existing audit (`docs/reviews/devils-advocate-review-2026-05-01.md`) flags the schema-export surface as too large; don't grow it. Prefer exposing validators as functions.
- **Coupling graders to a specific driver.** Graders take `ObservedResult`; that's the contract.
- **Reading process.env inside graders / runners.** Env reads happen at runner construction or test setup. Pure cores, configurable shells.
- **Bypassing `parseAtBoundary`** when accepting external data. It's the boundary against malformed JSON / missing fields and gives consistent error messages.
- **Logging via `console.log`** in production code paths. Use `console.error` for diagnostic output (so it doesn't get tangled with stdout reporters) and gate noisy output behind `EVAL_VERBOSE_TEARDOWN` style env knobs.

## Pointers

- `docs/INVARIANT-COVERAGE.md` — what mustn't break, where it's locked
- `docs/DRIVERS.md` — driver contract
- `docs/PERF.md` — perf tracker contracts
- `docs/CI-INTEGRATION.md` — Baseline/Regression/CIGate wiring
- `docs/JUDGE-CLIENTS.md` — judge selection precedence
- `docs/PROMPT-ITERATION.md` — prompt-iteration workflow
- `docs/SUITES.md` — suite catalog
- `docs/PROMPT-TESTING-SPEC-DRIFT.md` — implementation-vs-spec deltas
- `docs/reviews/devils-advocate-review-2026-05-01.md` — open audit findings (still relevant; address before exporting beyond v0.x)
