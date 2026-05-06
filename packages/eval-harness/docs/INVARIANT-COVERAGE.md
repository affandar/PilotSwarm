# Invariant Coverage Matrix — eval-harness

This matrix is the canonical map from the seven recurring invariant families
surfaced by the iter11–iter16 blind-review loop to (a) the central
enforcement point in `src/`, and (b) the regression tests that lock the
invariant in. Iter17 introduced this matrix as the strategic replacement
for unbounded blind-adversarial review: every family-level invariant is
test-backed and a future fixer that breaks one will fail loudly.

If a new HIGH/BLOCKER finding lands inside one of these families, add the
specific case as a test inside the corresponding `describe` block in
`test/invariant-coverage.test.ts`. If the finding represents a NEW family,
add an eighth row here AND a new `describe` block to the matrix file.

Primary matrix file:
[`packages/eval-harness/test/invariant-coverage.test.ts`](../test/invariant-coverage.test.ts)

## Matrix

| # | Family | Central enforcement point(s) | Matrix `describe` block | Covered invariants |
|---|--------|------------------------------|-------------------------|--------------------|
| 1 | Schema strictness / semantic coherence | `src/types.ts` (`.strict()` on every public schema; cross-field `.superRefine` invariants on `RunResult`, `MultiTrialResult`, `Baseline*`, `WilsonCI`, `SampleTrialResult`); strict + lenient Baseline split (`BaselineSchema` vs `BaselineSchemaAllowEmpty`) | `Family 1 — Schema strictness ...` | Every strict-by-design exported schema rejects unknown keys; numeric refinements reject `Infinity` / `NaN` / `-0` / negative / non-integer; tool-name arrays reject empty strings; cross-field invariants reject contradictory totals, duplicate IDs, missing `nonErrorTrials`/`infraErrorCount`, fabricated `meanPassRate`, mismatched `passRate` vs `passCount/(trials-errorCount)`; `BaselineSchema` (strict) rejects empty samples; `BaselineSchemaAllowEmpty` accepts; `WilsonCI` lower>upper rejected. |
| 2 | CIGate trust-boundary snapshot + regression coherence | `src/ci-gate.ts` (`MultiTrialResultBaseSchema.safeParse` then `Object.freeze(structuredClone(parsed.data))` then ALL reads via `safe`; `CIGateTaskHintSchema` strict + `(0,1]` finite for `passRateFloor`; regression coherence checks: ghost IDs, disjointness, direction/significance/passRate consistency) | `Family 2 — CIGate trust-boundary` | TOCTOU getter mutating per-call cannot flip verdict within an `evaluate()` (snapshot determinism); task-hint `passRateFloor` rejects `Infinity` / `NaN` / `0` / negatives / `-0` / `>1`; same-id-in-regressions-AND-`newCurrentSamples` → fail; forged direction/significance vs rate comparison → fail; `failOnNewSamples` true (default) + missing `regressionInput` → fail-closed; `maxRegressions` set + missing `regressionInput` → fail-closed; `trustSummary` false (default) + fabricated `meanPassRate` → fail. |
| 3 | Baseline / no-quality-signal correctness | `src/baseline.ts` + `BaselineSampleSchema`/`BaselineSchema`/`BaselineSchemaAllowEmpty` in `src/types.ts` | `Family 3 — Baseline / no-quality-signal` | `saveBaseline`: empty samples refused unless `allowEmptyBaseline:true`; `loadBaseline`: empty refused unless `allowEmptyBaseline:true`; no-quality samples refused unless `allowNoQualityBaseline:true`; `BaselineSampleSchema` rejects `passRate ≠ passCount/(trials-errorCount)`. |
| 4 | Unicode / hollow-output detection | `src/runner.ts` `isVisuallyEmpty` (single source; `\p{Default_Ignorable_Code_Point}` + `\uFFFC` + `\s`); `src/trajectory-runner.ts` imports the SAME helper | `Family 4 — Unicode invisibility / isVisuallyEmpty` | `isVisuallyEmpty` returns `true` for `U+115F`, `U+1160`, `U+200B`–`U+200D`, `U+2060`, `U+202E`, `U+3164`, `U+FEFF`, `U+FFA0`, `U+FFFC`, `U+00AD`, `U+180E`, `U+FE00`, `U+FE0F`; `false` for `"hello"` / mixed visible / emoji base; `true` for `undefined`/`null`/`""`/whitespace; trajectory-runner imports the SAME `isVisuallyEmpty` (no fork: source-text assertion). |
| 5 | Judge cache / budget / cost validation | `src/graders/llm-judge.ts` (`canonicalJSON` + `criterionContentHash` over `{id,description,scale,passThreshold,version,anchors}`); `src/graders/openai-judge-client.ts` `validateCostRates` (called in constructor AND in `estimateCost`); `LLMJudgeGrader.budgetUsd:0` deny-all path | `Family 5 — Judge cache / budget / cost` | `OpenAIJudgeClient`: negative / `NaN` rates throw at construction; `estimateCost` defensively re-validates after post-construction mutation; `LLMJudgeGrader`: cache key changes when description / passThreshold / anchors change; `{a,b}` vs `{b,a}` anchor insertion-order yields IDENTICAL cache key (canonical sort); `budgetUsd:0` denies the call without invoking the client. |
| 6 | Reporter provenance / finite formatting | `src/reporters/util.ts` `formatPValue` + `escapeMarkdownCell`; `src/reporters/format.ts` (canonical `formatPValue`/`formatRate`/`formatCount`/`formatProvenance` — iter18 single-source delegate); `src/reporters/markdown.ts` provenance section; `src/reporters/pr-comment.ts` uses `formatPValue`; `src/reporters/console.ts` uses `formatRate` | `Family 6 — Reporter provenance / finite formatting` | `formatPValue` returns `"—"` for `undefined` / `NaN` / `±Infinity` and `n.toFixed(4)` for finite; `escapeMarkdownCell` strips zero-width / bidi / control / lone CR; `PRCommentReporter` renders `NaN` p-values as em-dash (no `"NaN"` token); `MarkdownReporter` emits `Run ID`, `Git SHA`, `Model`, `Started`, `Finished`, `Harness Version` lines with structured labels; omits `Git SHA` / `Model` when undefined; `util.ts` formatters delegate to canonical `format.ts` so a single fixer breaks all reporters uniformly. |
| 7 | Package / public API readiness | `package.json` `files`, `.npmignore`, `dist/` build output, `src/index.ts` public exports | `Family 7 — Package / public API readiness` | `npm pack --dry-run` includes `dist/index.{js,d.ts}` + `datasets/` + `README.md` + `LICENSE`; excludes `src/` + `test/` + `*.map` + `*.tsbuildinfo`; unpacked size <1MB; `BaselineSchema` (strict) is the public default export; `BaselineSchemaAllowEmpty` is exported for explicit opt-in; `dist/index.js` exists and is non-empty. |
| 8 | Runtime boundary contract (iter18) | `src/validation/trust-boundary.ts` `parseAtBoundary` (pre-Zod symbol-key check → zod parse → walk parsed.data for forbidden Symbol/Function/BigInt → structuredClone → freeze); `src/validation/registry.ts` `STRICT_SCHEMA_REGISTRY` + `assertRegistryComplete`; per-stage normalizers in `src/validation/normalize-result.ts`; constructor input validation in `src/runner.ts`, `src/multi-trial.ts`, `src/matrix.ts`, `src/regression.ts`, `src/ci-gate.ts`, `src/baseline.ts` | `Family 8 — Runtime boundary contract` | CIGate rejects symbol-keyed root inputs (Zod silently strips, breaks integrity); RegressionDetector rejects function-typed values inside `Baseline` payloads; `MultiTrialRunner` rejects non-function `driverFactory`; `normalizeBaseline` rejects empty samples; `normalizeMultiTrialResult` returns frozen output; `parseAtBoundary` is TOCTOU-neutral on root symbol check (does not invoke value getters); `assertRegistryComplete` enforces the registry stays in lock-step with `src/index.ts` strict-schema exports — adding a new strict schema without registering it fails the matrix. |
| 9 | Statistical kernel guards (iter18) | `src/stats.ts` `wilsonInterval` explicit `Number.isFinite` and `Number.isInteger` rejection; `src/ci-gate.ts` `validateRegressionEntryConsistency` `pValue=0`-with-`significant=false` incoherence rule | `Family 9 — Statistical kernel` | `wilsonInterval` throws on `NaN` / `±Infinity` / fractional `passes` / fractional `total` / `passes>total` (no NaN propagation through Wilson CIs); CIGate fails an evaluation when a regression entry has `pValue=0` AND `significant=false` (mathematically incoherent — observed under iter17 attack-A). |
| 10 | External judge transport (iter18) | `src/graders/openai-judge-client.ts` Retry-After parsing + `prompt_tokens_details.cached_tokens` accounting | `Family 10 — External judge transport` | `OpenAIJudgeClient` is exported and instantiable; existing iter15/iter16 tests in `test/openai-judge-client.test.ts` already cover Retry-After parsing and cached-token accounting — Family 10 holds the smoke backstop so a future regression that drops the export or changes the public shape fails the matrix loudly. |

## Family-discipline patches landed in iter17

In addition to the matrix tests above, iter17 closed the family-discipline
gaps the iter16 fix-reviewer surfaced:

- **F28 (cleanup-family asymmetry, gap 1)** — `src/drivers/live-driver.ts`
  `client.stop()` now mirrors `worker.stop()` and `env.cleanup()`: when the
  primary try-body succeeded, a `client.stop()` failure is surfaced as the
  primary error; when the primary already errored, the `client.stop()`
  failure is logged and the primary error is preserved. Covered by
  `test/live-driver-iter17.test.ts`.

- **F27 (provenance test weakness, gap 2)** —
  `test/reporters-iter16.test.ts` MarkdownReporter provenance assertions
  upgraded from 1-character `toContain("m")` style to anchored
  `toMatch(/^- \*\*Model:\*\* m$/m)` patterns over each provenance label
  (`Run ID`, `Git SHA`, `Model`, `Started`, `Finished`, `Harness Version`).
  These now fail loudly if any single field is omitted from the rendered
  section.

## Documented carve-outs

- `DurabilityExpectedSchema` is intentionally lenient (no `.strict()`).
  Adding strictness here is a separate API decision and is OUT of the
  Family-1 invariant. If the team decides to make it strict, register it
  in the `STRICT_SCHEMA_REGISTRY` in the matrix file at the same time.

- "First-snapshot wins" is the documented CIGate TOCTOU semantic. Within
  a single `evaluate()` call the verdict is consistent with the snapshot;
  CIGate does NOT promise to detect malicious cross-call mutation by
  itself.

## How to extend the matrix

1. New strict schema → add an entry to `STRICT_SCHEMA_REGISTRY` in
   `test/invariant-coverage.test.ts`. The strictness + valid-fixture round
   trip is auto-generated for every entry.
2. New cross-field invariant → add a test case to the appropriate Family
   `describe` block (Family 1 for schema-level, Family 2 for CIGate).
3. New invariant family → add a row above AND a new `describe` block in
   the matrix file.

## Iter18 architectural-consolidation patches

Iter18 closed the verified iter17 findings (1 BLOCKER + 14 HIGH + 11 MEDIUM)
by introducing a central validation layer at `src/validation/`:

- **`src/validation/trust-boundary.ts`** — `parseAtBoundary` and
  `parseAtBoundaryOrInfraError` are the single choke point for every
  external-input validation. Final ordering: pre-Zod root symbol-key
  check (`Object.getOwnPropertySymbols`, TOCTOU-neutral) → zod
  `safeParse` → walk `parsed.data` for forbidden Symbol/Function/BigInt
  → `structuredClone` → `Object.freeze`.

- **`src/validation/registry.ts`** — 44-entry `STRICT_SCHEMA_REGISTRY`
  plus `assertRegistryComplete()` which is invoked as the FIRST test in
  Family 1. Adding a new strict schema to `src/index.ts` without
  registering it fails the matrix loudly. Also exports
  `REGISTRY_CARVE_OUTS` for documented exceptions.

- **`src/validation/normalize-result.ts`** — six per-stage normalizers
  (`normalizeObservedResult`, `normalizeRunResult`,
  `normalizeMultiTrialResult`, `normalizeMatrixConfig`,
  `normalizeMatrixResult`, `normalizeBaseline`). Driver output uses the
  infra-error variant (returns `infraScore` so a buggy driver records an
  outage instead of fail-closing); all other stages throw structured
  errors loudly.

- **`src/validation/numbers.ts`** — centralized numeric refinement
  helpers (`safeIntCount`, `safePosInt`, `safeIntCap`, `finiteRate`,
  `finiteCost`, `finitePValue`, `nonblankString`). All reject negative
  zero, all integer helpers enforce `Number.isSafeInteger` to block
  `2 ** 53` rounding bugs.

- **`src/reporters/format.ts`** — canonical reporter formatters
  (`formatPValue`, `formatRate`, `formatCount`, `formatProvenance`,
  `MISSING_VALUE_GLYPH`). `src/reporters/util.ts` `formatPValue`/`pct`
  and `src/reporters/console.ts` now delegate here so a fixer that
  breaks finite-formatting in one place breaks them uniformly (and is
  caught by the Family 6 matrix).

Constructor-input validation was strengthened in `src/runner.ts`,
`src/multi-trial.ts`, `src/matrix.ts`, `src/regression.ts`,
`src/ci-gate.ts`, `src/baseline.ts` — every public boundary now routes
through `parseAtBoundary`. The runner gained
`failOnReporterError?: boolean` (default `false`); when `true`, a
thrown reporter rethrows out of the run instead of being swallowed by
`console.warn`.

The matrix grew three new families (8/9/10) covering runtime boundary
contracts, statistical kernel guards, and external-judge transport
smoke. Total invariant test count: 1243 passing / 1 skipped (up from
1146 baseline pre-iter18).

## Eval-platform expansion addendum (2026-Q2)

Two new product surfaces landed without growing the family matrix:

- **`src/drivers/chaos-driver.ts`** — `ChaosDriver` now provides a real
  fault-injection wrapper around `Driver`. Every `ObservedResult` carries
  a `DurabilityObservation` schema-validated through Family 1's
  `DurabilityObservationSchema`. Family 1 covers the shape; behavior is
  test-locked in `test/durability.test.ts` (10 unit tests) and exercised
  end-to-end in `test/durability-live.test.ts` (LIVE-gated).

- **`src/perf/latency-tracker.ts`** — `LatencyTracker` / `CostTracker`
  pure-function trackers. Both reject `NaN` / `±Infinity` / negative
  inputs, mirroring the Family 9 statistical-kernel discipline. Locked
  in by `test/perf-latency-tracker.test.ts` (8 default-run tests).

Adding either to the central enforcement surface (e.g. a `Family 11 —
Durability driver discipline`) is deferred until a HIGH/BLOCKER finding
in either surface justifies a dedicated row.
