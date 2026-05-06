# PilotSwarm Eval Harness

Evaluation harness for PilotSwarm agents. The deterministic fixture runner, statistics, reporters, and code graders are shipped; live LLM evaluation, durability validation, multi-turn reasoning measurement, and LLM-as-judge calibration remain experimental unless explicitly noted.

The harness is organized into six capability suites — see [`docs/SUITES.md`](./docs/SUITES.md) for the full catalog and gating matrix.

**How-to docs by topic:**

- [`docs/PROMPT-ITERATION.md`](./docs/PROMPT-ITERATION.md) — iterating on `packages/sdk/plugins/system/agents/default.agent.md` (inner / single-suite-LIVE / full-LIVE)
- [`docs/DRIVERS.md`](./docs/DRIVERS.md) — driver matrix, contracts, custom-driver pattern
- [`docs/PERF.md`](./docs/PERF.md) — latency / cost / DB / connection / durability / concurrency trackers
- [`docs/CI-INTEGRATION.md`](./docs/CI-INTEGRATION.md) — Baseline / RegressionDetector / CIGate / PR comment recipe
- [`docs/JUDGE-CLIENTS.md`](./docs/JUDGE-CLIENTS.md) — OpenAI vs PilotSwarm vs Fake judge selection
- [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) — adding a grader / driver / suite / mutator / reporter
- [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md) — real failure modes (PG saturation, judge crash, parallel pollution, …) and the fix
- [`docs/INVARIANT-COVERAGE.md`](./docs/INVARIANT-COVERAGE.md) — invariant families → enforcement points + regression tests
- [`docs/PROMPT-TESTING-SPEC-DRIFT.md`](./docs/PROMPT-TESTING-SPEC-DRIFT.md) — implementation vs spec drift

| Suite        | File                                      | LIVE tests | Gating                                  |
|--------------|-------------------------------------------|-----------:|-----------------------------------------|
| FUNCTIONAL   | `test/live-driver-live.test.ts`           | 9          | `LIVE=1`                                |
| DURABILITY   | `test/durability-live.test.ts`            | 7          | `LIVE=1` (incl. real worker-handoff)    |
| ABLATIONS    | `test/ablations-live.test.ts`             | 5          | `LIVE=1`                                |
| LLM-JUDGE    | `test/llm-judge-live.test.ts`             | 5          | `LIVE=1 LIVE_JUDGE=1` + `OPENAI_API_KEY` **OR** `GITHUB_TOKEN`+`PS_MODEL_PROVIDERS_PATH` |
| PERFORMANCE — core    | `test/performance-live.test.ts`  | 8          | `LIVE=1` (DB-budget cases also need `PG_STAT_STATEMENTS_ENABLED=1`) |
| PERFORMANCE — cold/warm | `test/perf-cold-warm-live.test.ts` | 1        | `LIVE=1`                                |
| PERFORMANCE — resource | `test/perf-resource-live.test.ts` | 4         | `LIVE=1` (DB-budget cases also need `PG_STAT_STATEMENTS_ENABLED=1`) |
| PERFORMANCE — concurrency | `test/perf-concurrency-live.test.ts` | 1     | `LIVE=1 PERF_HEAVY=1` (optional `PERF_HEAVY_N8=1`, `PERF_HEAVY_MAX_CONNECTIONS=<n>`) |
| PERFORMANCE — durability | `test/perf-durability-live.test.ts` | 3       | `LIVE=1 PERF_DURABILITY=1`              |
| SAFETY       | `test/safety-live.test.ts`                | 14         | `LIVE=1` (+ `LIVE_JUDGE=1` for judge-graded cases) |

> **Gate flags** beyond `LIVE=1` are opt-ins for slow / costly suites:
> - `LIVE_JUDGE=1` — runs LLM-as-judge tests (real model spend per sample).
> - `PERF_HEAVY=1` — runs concurrency profiler (≥7 parallel LiveDriver sessions; ≥15 with `PERF_HEAVY_N8=1`). DB-connection heavy.
> - `PERF_DURABILITY=1` — runs durability perf suite (mostly asserts deferred state until SDK emits `*-start` events).
> - `PG_STAT_STATEMENTS_ENABLED=1` — converts DB-budget skips into real assertions; requires the extension loaded in Postgres.

## Quick Start

```bash
# Run eval suite (uses FakeDriver — no LLM calls, no .env needed)
cd packages/eval-harness
npx vitest run

# Via the repo test runner
./scripts/run-tests.sh --suite=eval

# All LIVE suites — heavy / costly batch + N=8 concurrency + timestamped reports dir
cd packages/eval-harness
bin/run-live.sh --all

# Cheap smoke (LIVE=1 only, no judge, no heavy perf)
bin/run-live.sh --cheap

# A single suite — bare positional args are forwarded as file filters
bin/run-live.sh --judge -- test/llm-judge-live.test.ts

# Or via npm scripts (same behavior)
npm run test:live           # default: LIVE=1, all live tests
npm run test:live:all       # everything: judge + heavy + heavy-n8 + perf-durability + pg-stat
npm run test:live:cheap     # LIVE=1 only
npm run test:live:perf      # heavy + heavy-n8 + perf-durability + pg-stat
npm run test:live:judge     # LIVE_JUDGE=1
```

`bin/run-live.sh` flags:

| Flag | Sets |
|---|---|
| `--live` (default ON) / `--no-live` | `LIVE=1` (or unset) |
| `--judge` | `LIVE_JUDGE=1` |
| `--heavy` | `PERF_HEAVY=1` (≥7 parallel sessions) |
| `--heavy-n8` | `PERF_HEAVY=1 PERF_HEAVY_N8=1` (≥15 sessions) |
| `--durability-perf` | `PERF_DURABILITY=1` |
| `--pg-stat` | `PG_STAT_STATEMENTS_ENABLED=1` |
| `--prompt-testing` | `PROMPT_TESTING=1` |
| `--keep-env` | `KEEP_DURABILITY_ENV=1` (preserve harness env on teardown) |
| `--verbose-teardown` | `EVAL_VERBOSE_TEARDOWN=1` |
| `--reports-dir <path>` | `EVAL_REPORTS_DIR=<path>` (default `.eval-results/<ts>/`) |
| `--no-reports` | disables auto-wired reports dir |
| `--all` | judge + heavy + heavy-n8 + durability-perf + pg-stat |
| `--perf` | heavy + heavy-n8 + durability-perf + pg-stat |
| `--cheap` | LIVE only (clears prior gates) |
| `--dry-run` | print resolved env + vitest invocation; exit 0 |

Anything after `--` is forwarded verbatim to `vitest run`. Bare positional args are
treated as file filters (default `test/*-live.test.ts`).

### Credentials

Vitest auto-loads the monorepo-root `.env` at config time, so you don't need
the `env $(grep -v '^#' .env | xargs) …` shim anymore. `GITHUB_TOKEN` alone is
sufficient: the LLM-judge tests construct a `PilotSwarmJudgeClient` against
the bundled `packages/sdk/test/fixtures/model-providers.test.json` (Copilot
via `env:GITHUB_TOKEN`). See `packages/eval-harness/.env.example` for the
full set of env gates.

> Note: do **not** pass `--` before the path filter when calling vitest directly —
> vitest treats positional args after `--` as forwarded args, not file filters,
> and the run silently expands to the whole workspace. `bin/run-live.sh`
> handles this correctly: bare positional → file filter, post-`--` → vitest passthrough.

Monorepo consumers import `pilotswarm-eval-harness` through the package export
(`dist/index.js`). Run `npm run build` in `packages/eval-harness` before using
that package-root import from another workspace; `npm test` runs the build first
and includes a package-root smoke test to catch stale `dist/` exports.

## Architecture

**Data flow:** JSON fixture → Loader (Zod validates) → Runner → Driver (execute) → Graders (score) → Reporter / CI output.

The harness has four runner paths:

- `EvalRunner` for single-turn fixtures with `FakeDriver` (shipped) or `LiveDriver` (🧪 experimental real PilotSwarm execution).
- `MultiTrialRunner` for repeated stochastic trials, `pass@k`, Wilson intervals, and infra-error-aware pass rates.
- `MatrixRunner` for model/config sweeps across multi-trial cells.
- `TrajectoryRunner` for V4 multi-turn fixtures (🧪 experimental measurement).

Graders include deterministic tool selection, argument matching, ordering, response, CMS state, durability-fixture checks, plus `LLMJudgeGrader` with three pluggable judge clients: `FakeJudgeClient` (deterministic tests), `OpenAIJudgeClient` (direct OpenAI / OpenAI-compatible API), and `PilotSwarmJudgeClient` (routes through PilotSwarm's `ModelProviderRegistry` so the judge inherits every provider PilotSwarm itself supports — GitHub Copilot, OpenAI, Anthropic, Azure OpenAI). See [`docs/JUDGE-CLIENTS.md`](./docs/JUDGE-CLIENTS.md) for selection precedence and cost-rate contract. Output surfaces include `ConsoleReporter`, `JsonlReporter`, `ConsoleAggregateReporter`, `MarkdownReporter`, `PRCommentReporter`, `CIGate`, and `RegressionDetector`. `EvalRunner` auto-appends a `JsonlReporter` when `EVAL_REPORTS_DIR` env var or `reportsDir` constructor option is set, so `.eval-results/` artifacts are written without per-test wiring.

## Package Structure

```
packages/eval-harness/
├── datasets/
│   ├── durability-scenarios.v1.json       # 🧪 illustrative durability fixtures
│   ├── multi-turn-scenarios.v1.json       # 🧪 V4 trajectory fixtures
│   └── tool-call-correctness.v1.json      # Golden single-turn dataset v1
├── src/
│   ├── baseline.ts           # Baseline load/save helpers
│   ├── ci-gate.ts            # CI quality/regression gate
│   ├── index.ts              # Public API exports
│   ├── loader.ts             # JSON fixture loader + validation
│   ├── matrix.ts             # Model/config matrix sweeps
│   ├── multi-trial.ts        # Repeated trials, pass@k, infra-aware rates
│   ├── regression.ts         # Baseline-vs-current regression detection
│   ├── runner.ts             # EvalRunner single-turn lifecycle
│   ├── stats.ts              # Statistical utilities
│   ├── trajectory-runner.ts  # 🧪 V4 multi-turn trajectory lifecycle
│   ├── types.ts              # Zod schemas + TS types
│   ├── drivers/
│   │   ├── fake-driver.ts             # Single-turn scripted traces
│   │   ├── fake-multi-turn-driver.ts  # 🧪 scripted trajectory traces
│   │   ├── live-driver.ts             # 🧪 real PilotSwarm execution
│   │   ├── multi-turn-types.ts        # 🧪 trajectory driver interfaces
│   │   ├── scripted-driver.ts         # Durability fixture driver
│   │   └── types.ts                   # Single-turn driver interfaces
│   ├── fixtures/
│   │   └── eval-tools.ts     # test_add, test_multiply, test_weather
│   ├── graders/
│   │   ├── cms-state.ts      # CMS session state assertion
│   │   ├── durability.ts     # Durability fixture scoring
│   │   ├── fake-judge-client.ts      # Deterministic judge client
│   │   ├── index.ts          # Single-turn composer: gradeEvalCase()
│   │   ├── judge-cache.ts    # Judge response cache
│   │   ├── judge-types.ts    # Judge client/cache contracts
│   │   ├── llm-judge.ts      # 🧪 rubric-based LLM-as-judge grader
│   │   ├── match-args.ts     # Arg matching (exact/subset/fuzzy/setEquals)
│   │   ├── openai-judge-client.ts    # 🧪 OpenAI-compatible judge client
│   │   ├── ordering.ts       # exactSequence/subsequence/unordered grading
│   │   ├── response.ts       # Word-boundary containsAny/All
│   │   ├── tool-selection.ts # Tool name + forbidden + call counts
│   │   └── trajectory.ts     # 🧪 V4 per-turn/cross-turn/holistic scoring
│   ├── observers/
│   │   └── tool-tracker.ts   # EvalToolTracker → ObservedToolCall[]
│   ├── reporters/
│   │   ├── aggregate-types.ts     # Aggregate reporter interface
│   │   ├── console-aggregate.ts   # Multi-trial/matrix console output
│   │   ├── console.ts        # ✅/❌/⚠️ summary table to stdout
│   │   ├── jsonl.ts          # Incremental JSONL + failure artifacts
│   │   ├── markdown.ts       # Aggregate Markdown file output
│   │   ├── pr-comment.ts     # Aggregate PR-comment Markdown output
│   │   ├── types.ts          # Reporter interface (async-ready)
│   │   └── util.ts           # Shared Markdown/formatting helpers
├── test/                     # Vitest coverage for harness behavior
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

## Core Concepts

### Fixture (EvalTask)

A JSON file defining a set of eval scenarios:

```json
{
  "schemaVersion": 1,
  "id": "tool-call-correctness",
  "name": "Tool Call Correctness",
  "description": "Core tool calling scenarios",
  "version": "1.0.0",
  "passRateFloor": 0.8,
  "samples": [...]
}
```

### Sample (EvalSample)

A single eval scenario within a task:

```json
{
  "id": "single.add.basic",
  "description": "Single tool call with integer args",
  "input": {
    "prompt": "What is 17 plus 25? Use the test_add tool."
  },
  "expected": {
    "toolCalls": [
      { "name": "test_add", "args": { "a": 17, "b": 25 }, "match": "subset" }
    ],
    "forbiddenTools": [],
    "response": { "containsAny": ["42"] },
    "cms": { "stateIn": ["idle", "completed"] }
  },
  "tools": ["test_add"],
  "tags": ["single-tool", "arithmetic"],
  "timeoutMs": 120000
}
```

### Score

Every grader returns normalized scores:

```typescript
{
  name: "tool-names",       // which grader
  value: 1.0,               // 0..1 normalized
  pass: true,               // binary verdict
  reason: "all 1 expected tool(s) were called",
  actual: ["test_add"],     // what the LLM did
  expected: ["test_add"]    // what we expected
}
```

A case passes only when **all** applicable scores pass.

### Driver

Drivers execute eval samples and return observed results:

| Driver | Purpose | LLM Calls | Speed |
|--------|---------|-----------|-------|
| `FakeDriver` | TDD, CI, fast iteration | No | <1ms/case |
| `LiveDriver` | Experimental real model smoke/eval path | Yes | 5-30s/case |

### Reporter

Reporters receive events as evals execute:

| Reporter | Output | Use Case |
|----------|--------|----------|
| `ConsoleReporter` | ✅/❌/⚠️ table to stdout | Interactive use |
| `JsonlReporter` | `.eval-results/<runId>.jsonl` + failure artifacts | CI, history |
| `ConsoleAggregateReporter` | Multi-trial / matrix summary to stdout | Interactive V2 runs |
| `MarkdownReporter` | Markdown report to file | CI artifacts, PR comments |

Reporter interface is async-ready (`void | Promise<void>`) for future Langfuse integration.

V2 aggregate reporters implement a separate `AggregateReporter` interface with `onMultiTrialComplete(result)` and `onMatrixComplete(result)` hooks.

## Grading Reference

### Argument Matching Modes

| Mode | Behavior | Default |
|------|----------|---------|
| `exact` | JSON equality after key sorting | |
| `subset` | Every expected key must match exactly; extra actual keys OK. Set `subsetCaseInsensitive: true` to opt into legacy lowercase/trim string matching. | ✅ |
| `fuzzy` | Levenshtein for strings (`fuzzyStringMaxRelativeDistance`, default `0.2`), exact numeric matching unless `numericTolerance` is set, order-insensitive arrays | |
| `setEquals` | Same keys and values in both directions, order-insensitive | |

### Tool Selection Scoring

| Score | What It Checks |
|-------|---------------|
| `tool-names` | Were the right tools called? (multiset counting — handles duplicate calls) |
| `forbidden-tools` | Were forbidden tools avoided? |
| `call-count` | Were `minCalls`/`maxCalls` constraints met? |
| `no-tool-compliance` | If `noToolCall: true`, were zero tools called? |
| `tool-args:<name>` | Per expected tool call, did the arguments match? (uses selected match mode) |

### Ordering

| Mode | Behavior |
|------|----------|
| `exactSequence` | Observed tool names must exactly match the expected sequence; no interleaved calls |
| `subsequence` | Expected tools appear in order as a subsequence of observed calls |
| `strict` | Deprecated alias for `subsequence` |
| `unordered` | All expected tools appear somewhere in observed (any order) |

### Response Matching

Uses **word-boundary matching** (regex `\b...\b`) for `containsAny`/`containsAll` — prevents false positives like `"hi"` matching `"this"`.

### Schema Validation

Zod validates fixtures at load time with cross-field invariants:
- Rejects `noToolCall: true` combined with `toolCalls`
- Rejects `minCalls > maxCalls`
- Requires `schemaVersion: 1`
- Requires at least one sample

## Adding a New Eval Case

### Step 1: Add to the dataset

Edit `datasets/tool-call-correctness.v1.json` and add a sample:

```json
{
  "id": "selection.divide-not-multiply",
  "description": "Should pick divide, not multiply",
  "input": {
    "prompt": "What is 20 divided by 4? Use the appropriate tool."
  },
  "expected": {
    "toolCalls": [{ "name": "test_divide", "args": { "a": 20, "b": 4 }, "match": "subset" }],
    "forbiddenTools": ["test_multiply"]
  },
  "tools": ["test_multiply", "test_divide"],
  "tags": ["selection"]
}
```

### Step 2: Add a fake scenario for CI

In `test/eval-core.test.ts`, add a matching fake response:

```typescript
"selection.divide-not-multiply": {
  toolCalls: [{ name: "test_divide", args: { a: 20, b: 4 }, result: { result: 5 }, order: 0 }],
  finalResponse: "20 ÷ 4 = 5.",
  sessionId: "fake-session-new",
  latencyMs: 100,
  cmsState: "idle",
},
```

### Step 3: Run

```bash
cd packages/eval-harness && npx vitest run
```

### Step 4 (optional): Add new eval tools

If your scenario needs a new tool, add it to `src/fixtures/eval-tools.ts` and register in `createEvalToolTracker()`.

## CMS event capture (system-tool evidence)

`LiveDriver` captures the full persisted CMS event log via the SDK's
`session.getMessages()` API after each turn and attaches it as
`observed.cmsEvents: CmsObservedEvent[]`. This is the canonical evidence
surface for graders / durability tests:

- Each event carries `{ seq, eventType, data?, createdAt, workerNodeId? }`.
- Graders can assert "did `spawn_agent` actually fire and persist?"
  rather than trusting only the LLM's self-reported tool-calls list.
- Distinct `workerNodeId` values across the session's CMS event log
  is the canonical signal of cross-worker handoff
  (see DURABILITY suite's real worker-handoff test).
- Capture is best-effort: failures log to stderr and never abort the run.
- Capped at 1000 events per run to bound report size.

Output flows into the `JsonlReporter` (auto-wired when `EVAL_REPORTS_DIR`
or `reportsDir` is set) so `.eval-results/<runId>.jsonl` carries the
event log alongside scores and observed tool calls.

## Saving eval reports to disk

`EvalRunner` auto-appends a `JsonlReporter` when either the
`EVAL_REPORTS_DIR` env var or the `reportsDir` constructor option is set.
Caller-supplied reporters always win; the auto-reporter is appended only
when no `JsonlReporter` is already present.

```bash
EVAL_REPORTS_DIR="$PWD/.eval-results" \
  LIVE=1 PS_MODEL_PROVIDERS_PATH="$PWD/../sdk/test/fixtures/model-providers.test.json" \
  npx vitest run test/live-driver-live.test.ts
```

```typescript
new EvalRunner({ driver, reportsDir: "./.eval-results" });
```

Layout per run:
- `<dir>/<runId>.jsonl` — header + one JSON line per case (pass/fail,
  scores, observed including `cmsEvents`).
- `<dir>/<runId>/<caseId>.json` — full failure detail (only on fail).

`.eval-results/` is already gitignored via `packages/eval-harness/.gitignore`,
so reports won't leak into commits.

Precedence: explicit `reportsDir` option > `EVAL_REPORTS_DIR` env var
> no auto-wiring. Empty-string env var is treated as unset.

## Running Against a Real Model

The experimental `LiveDriver` executes samples against a real LLM using `PilotSwarmClient`/`PilotSwarmWorker`, but it currently depends on a monorepo-only SDK test helper for environment setup. It is not portable as a standalone package consumer. Use only inside the PilotSwarm monorepo until the SDK exposes a public env helper, or inject equivalent dependencies yourself.

**Prerequisites:**
- PostgreSQL running (`DATABASE_URL` in `.env`)
- `GITHUB_TOKEN` in `.env` (or model provider keys in `.model_providers.json`)

**Example usage in a test:**

```typescript
import {
  LiveDriver,
  EvalRunner,
  loadEvalTask,
  ConsoleReporter,
  JsonlReporter,
} from "pilotswarm-eval-harness";

const task = loadEvalTask("datasets/tool-call-correctness.v1.json");
const runner = new EvalRunner({
  driver: new LiveDriver({ model: "gpt-4o" }),
  reporters: [new ConsoleReporter(), new JsonlReporter(".eval-results")],
});

const result = await runner.runTask(task);
console.log(`Pass rate: ${(result.summary.passRate * 100).toFixed(1)}%`);
```

**Current LiveDriver limitations:**
- Does not support `input.context` (multi-turn priors) — will throw
- Each sample creates an isolated test environment (fresh DB schemas)
- `workerNodeId` is unique per run to avoid collisions
- Timeouts abort the harness wait and trigger session cleanup. Provider-level call cancellation depends on SDK support; in-flight LLM requests may continue billing until they complete naturally.

### Running live evals

The default test suite does **not** exercise real LLM calls. To smoke-test the experimental `LiveDriver` path against a real PilotSwarm session, run:

```bash
cd packages/eval-harness
bin/run-live.sh --cheap -- test/live-driver-live.test.ts
# or, equivalent:
LIVE=1 npx vitest run test/live-driver-live.test.ts
```

See [Quick Start](#quick-start) above for the `bin/run-live.sh` flag table.

## JSONL Output Format

Each run produces `.eval-results/<runId>.jsonl`:

```jsonl
{"type":"run","runId":"abc-123","task":"tool-call-correctness","version":"1.0.0","startedAt":"..."}
{"type":"sample","runId":"abc-123","caseId":"single.add.basic","pass":true,"scores":[...],"observed":{...},"durationMs":102}
{"type":"sample","runId":"abc-123","caseId":"selection.multiply-not-add","pass":false,"scores":[...],"observed":{...},"durationMs":8421}
{"type":"summary","runId":"abc-123","total":6,"passed":5,"failed":1,"errored":0,"passRate":0.833}
```

Failed cases also get a detailed artifact: `.eval-results/<runId>/<caseId>.json`

File paths are sanitized — `runId` and `caseId` are stripped of path separators.

## Extension Points (Phase 2+)

The harness is designed for incremental extension:

| Interface | V1 Implementation | V2-V5 status |
|-----------|-------------------|-----------------|
| `Driver` | FakeDriver shipped; LiveDriver experimental | DurabilityFixtureDriver fixture-only (V3), FakeMultiTurnDriver fixture-only (V4) |
| `Reporter` | Console, JSONL | PRCommentReporter (V5b) |
| Graders | Code-only (deterministic) | gradeDurability (V3), gradeTrajectory (V4), LLMJudgeGrader (V5a) |
| Runners | EvalRunner | MultiTrialRunner (V2), TrajectoryRunner (V4) |
| Datasets | Static JSON | Durability + multi-turn fixtures (V3, V4) |
| Matrix | Single model | Model × context × compaction × reasoning (V2) |
| CI | passRateFloor only | RegressionDetector + CIGate + Baseline (V5b) |

### Writing a Custom Reporter

```typescript
import type { Reporter } from "pilotswarm-eval-harness";

class LangfuseReporter implements Reporter {
  async onRunStart(task, runId) { /* create Langfuse trace */ }
  async onCaseResult(result) { /* log span + scores */ }
  async onRunComplete(result) { /* finalize trace */ }
}
```

### Writing a Custom Driver

```typescript
import type { Driver, DriverOptions } from "pilotswarm-eval-harness";

class RemoteDriver implements Driver {
  async run(sample, options) {
    // Call remote PilotSwarm cluster
    // options.signal for cancellation
    return { toolCalls: [...], finalResponse: "...", sessionId: "...", latencyMs: 0 };
  }
}
```

## V2: Multi-Trial, Matrix, and Statistics

### Multi-Trial Evaluation

Run a task N times to get a statistically meaningful pass rate with confidence intervals and pass@k.

```ts
import { MultiTrialRunner, FakeDriver, ConsoleAggregateReporter } from "pilotswarm-eval-harness";

const runner = new MultiTrialRunner({
  driverFactory: () => new FakeDriver(scenarios),
  trials: 10,
  passAtKValues: [1, 5, 10],
});

const result = await runner.runTask(task);
console.log(result.summary.meanPassRate); // 0.85
new ConsoleAggregateReporter().onMultiTrialComplete(result);
```

`MultiTrialResult` includes per-sample aggregates (`passRate`, `passAtK`, `wilsonCI`, per-score mean/stddev) and a task-level summary (`meanPassRate`, `stddevPassRate`, `pooledPassRateCI`). `pooledPassRateCI` is a Wilson interval over pooled non-infra-error trials across heterogeneous samples; it is **not** a confidence interval for `meanPassRate`. The deprecated `passRateCI` alias is retained for compatibility.

### Parameter Matrix

Compare models × configs for a single task. Each cell runs its own multi-trial evaluation internally.

```ts
import { MatrixRunner, MarkdownReporter, LiveDriver } from "pilotswarm-eval-harness";

const runner = new MatrixRunner({
  driverFactory: () => new LiveDriver(),
  models: ["gpt-4o", "claude-sonnet"],
  configs: [
    { id: "default", label: "Default", overrides: {} },
    { id: "strict", label: "Strict Prompt", overrides: { systemMessage: "Be precise." } },
  ],
  trials: 5,
  maxCells: 1000,
});

const result = await runner.runTask(task);
new MarkdownReporter("/path/to/output.md").onMatrixComplete(result);
```

`MatrixConfigOverrides` currently supports `systemMessage` and `timeoutMs` for explicit prompt experiments. `MatrixRunner` guards cost with `maxCells` (models × configs × trials × samples, default `1000`; set `Infinity` to opt out) and supports `dryRun: true` to return the full matrix plan without creating drivers or making LLM calls. Dry-run matrix cells mark their inner `MultiTrialResult` with `dryRun: true` and no quality signal so they cannot be mistaken for real 0%-quality results by CI gates. `MatrixResult.summary` surfaces `bestPassRate` and `worstPassRate` cells.

### Statistical Utilities

Pure functions exported from `stats.ts` — no eval dependencies, safe to use standalone.

```ts
import {
  passAtK,
  meanStddev,
  wilsonInterval,
  bootstrapCI,
  mcNemarTest,
  mannWhitneyU,
} from "pilotswarm-eval-harness";

// pass@k from Chen et al. (HumanEval) — unbiased estimator
const pk = passAtK([true, false, true, false, true], 3);

// Wilson score interval (binomial CI)
const ci = wilsonInterval(17, 20); // { lower, upper, point, z }

// Bootstrap percentile CI for the mean (default alpha=0.05, reps=10_000)
// Signature: bootstrapCI(values, alpha?, reps?, rng?)
const boot = bootstrapCI([0.7, 0.8, 0.9, 0.85], 0.05, 10_000);
// { lower, upper, point, reps, alpha }

// Regression detection between paired runs (A vs B)
const mc = mcNemarTest([
  [true, false],  // regression
  [false, true],  // improvement
  [true, true],   // concordant
]);
console.log(mc.pValue, mc.method); // p-value, "exact" or "chi2-yates"

// Non-parametric comparison of two independent distributions
const mw = mannWhitneyU([0.8, 0.9, 0.85], [0.6, 0.7, 0.65]);
```

## V3: Crash Recovery & Durability (real + fixture)

V3 ships durability grader plumbing, fixture-based scenario testing for grader logic, AND a real worker-handoff LIVE test that validates actual session migration via CMS evidence.

**Real worker-handoff LIVE test** (`test/durability-live.test.ts`,
`DURABILITY: REAL worker handoff — second turn handled by surviving
worker (CMS evidence)`):
1. Starts worker A only, runs turn 1 — A handles it (only worker active).
2. Stops worker A, starts worker B.
3. Runs turn 2 on the same session — B must handle it (A is dead).
4. Reads persisted CMS event log via `session.getMessages()` and asserts
   distinct `workerNodeId` values include BOTH `eval-handoff-a` AND
   `eval-handoff-b`.
5. Asserts ≥2 `session.turn_completed` events.

This is real product evidence — not a synthetic tag. Gated by `LIVE=1`.
The previous synthetic `afterRunHook` test was removed; its tag was
overwritten by `ChaosDriver` overlay anyway and proved nothing.

**Fixture-based grader scaffolding** (`DurabilityFixtureDriver`) remains
for testing the durability grader's internal logic on scripted
scenarios:

```typescript
import {
  EvalRunner,
  DurabilityFixtureDriver,
  gradeDurability,
  type DurabilityFixtureScenario,
  type EvalTask,
} from "pilotswarm-eval-harness";

const scenarios: DurabilityFixtureScenario[] = [
  {
    sampleId: "crash.recovers",
    steps: [
      { type: "respond", response: /* ObservedResult */ },
      { type: "crash", faultPoint: "during_tool_call", faultMode: "worker_crash" },
      {
        type: "recover",
        recoveryResponse: /* ObservedResult with cmsState: "idle" */,
        durability: { dehydrated: true, hydrated: true, workerHandoff: true },
      },
    ],
  },
];

const runner = new EvalRunner({ driver: new DurabilityFixtureDriver(scenarios) });
const result = await runner.runTask(taskWithDurabilityExpectations);
```

The grader emits `crash-recovery`, `post-recovery-state`, `tool-calls-after-recovery`, `dehydration`, `hydration`, and `worker-handoff` scores. Fault points: `before_turn`, `during_tool_call`, `after_tool_call`, `after_turn`, `after_dehydrate`, `before_hydrate`. Fault modes: `worker_crash`, `tool_timeout`, `tool_throw`, `network_disconnect`. The `datasets/durability-scenarios.v1.json` fixture is marked `runnable: false` because it is illustrative fixture data, not a live-runnable crash test; `loadEvalTask(path, { mode: "live" })` skips non-runnable datasets with a clear warning.

`ChaosDriver` wraps an inner `Driver` and overlays a synthetic `DurabilityObservation` on the returned `ObservedResult`. Its base `run()` does NOT crash workers, force dehydration, or otherwise perturb the inner driver — it executes the inner driver normally and tags the result with `{ scenario, faultPoint, faultMode, injected, recovered, ... }` for grading wrappers. To inject real faults, supply `beforeRunHook` / `afterRunHook` callbacks (e.g. for synthetic in-flight throws) or layer ChaosDriver around a driver that can perform real worker kills. For canonical product-level durability proof — real worker handoff, real dehydrate/hydrate, real cross-worker resumption — see the SDK-direct LIVE tests in `test/durability-live.test.ts` (they bypass ChaosDriver entirely and read CMS event evidence).

## V4: Multi-Turn & Trajectory Evaluation (experimental)

V4 grades fixture trajectories with per-turn, cross-turn, and holistic scoring. The bundled `FakeMultiTurnDriver` is deterministic fixture plumbing; live multi-turn reasoning evaluation is not yet shipped.

```typescript
import {
  TrajectoryRunner,
  FakeMultiTurnDriver,
  type TrajectoryTask,
  type ObservedTrajectory,
} from "pilotswarm-eval-harness";

const task: TrajectoryTask = {
  schemaVersion: 1,
  id: "trajectory-demo",
  // ...
  samples: [
    {
      id: "remember-color",
      tools: ["paint_tool"],
      turns: [
        { input: { prompt: "Remember my favorite color is blue." }, expected: { noToolCall: true } },
        {
          input: { prompt: "Paint a swatch using my favorite color." },
          expected: { toolCalls: [{ name: "paint_tool", args: { color: "blue" } }] },
        },
      ],
      expected: {
        goalCompleted: true,
        maxTotalToolCalls: 1,
        contextRetention: [
          {
            term: "blue",
            mustAppearAfterTurn: 0,
            requireToolArgUse: { toolName: "paint_tool", argPath: "color" },
          },
        ],
      },
    },
  ],
};

const runner = new TrajectoryRunner({
  driver: new FakeMultiTurnDriver([{ sampleId: "remember-color", trajectory: observedTrajectory }]),
});
const result = await runner.runTask(task);
// result.cases[0].trajectoryScore = { turnScores, crossTurnScores, holisticScores }
```

Holistic scores include `turn-count`, `goal-completed`, and `call-budget`. Cross-turn `contextRetention` falls back to lexical response matching, which can pass if an agent merely parrots a term. When a trajectory sample declares `tools`, the default grader first checks whether the retained term appears in any later tool-call argument value and warns if only lexical matching succeeded. Prefer explicit `requireToolArgUse: { toolName, argPath }` to require the retained term to appear as a specific later tool-call argument value (for example `test_weather.city`). The `datasets/multi-turn-scenarios.v1.json` fixture bundles canonical multi-turn flows.

## V5: LLM-as-Judge + CI Gates

V5 has two halves.

### V5a — LLM-as-Judge (experimental)

For subjective dimensions (helpfulness, accuracy, safety, …) `LLMJudgeGrader` runs a `Rubric` of criteria against a prompt+response pair using a pluggable `JudgeClient`. The package includes three pluggable clients (two production-ready live clients plus a deterministic test fake):

- `FakeJudgeClient` — deterministic for unit tests; not for live use.
- `OpenAIJudgeClient` — direct OpenAI / OpenAI-compatible API. Requires `OPENAI_API_KEY`.
- `PilotSwarmJudgeClient` — routes via PilotSwarm's `ModelProviderRegistry`, so the judge inherits every provider PilotSwarm itself supports (GitHub Copilot, OpenAI, Anthropic, Azure OpenAI). The default PilotSwarm dev environment (only `GITHUB_TOKEN` + `PS_MODEL_PROVIDERS_PATH`) can run live judge tests without exporting `OPENAI_API_KEY`.

See [`docs/JUDGE-CLIENTS.md`](./docs/JUDGE-CLIENTS.md) for the full selection matrix, cost-rate contract, and `makeLiveJudgeClient()` helper precedence rules.

Cost capping requires `costRates` configuration; without rates, the client returns unknown cost and the grader emits a judge `infraError` instead of pretending the call cost $0. An optional `JudgeCache` deduplicates by judge ID (`cacheIdentity()`), rubric ID + version, criterion ID, prompt, response, and a hashed `systemMessage` value (`undefined` is distinct from an empty string or any explicit value). `LLMJudgeGraderOptions.systemMessage` lets callers pass judge-specific instructions through to the `JudgeClient` and participates in that cache identity.

```typescript
import {
  LLMJudgeGrader,
  OpenAIJudgeClient,
  InMemoryJudgeCache,
  type Rubric,
} from "pilotswarm-eval-harness";

const rubric: Rubric = {
  id: "quality",
  name: "Quality",
  version: "1.0.0",
  criteria: [
    { id: "helpfulness", description: "Is the response helpful?", scale: { min: 1, max: 5 }, passThreshold: 0.6 },
    { id: "accuracy",    description: "Is the response accurate?", scale: { min: 1, max: 5 }, passThreshold: 0.6 },
  ],
};

const grader = new LLMJudgeGrader({
  client: new OpenAIJudgeClient({
    baseUrl,
    apiKey,
    model,
    costRates: {
      inputUsdPerMillionTokens: 2.50,
      outputUsdPerMillionTokens: 10.00,
    },
  }),
  rubric,
  cache: new InMemoryJudgeCache(),
  budgetUsd: 0.50,
  systemMessage: "Judge strictly against the rubric only.",
});

const { scores, costs, totalCostUsd } = await grader.grade(prompt, response);
```

When the running cost exceeds `budgetUsd` mid-batch, remaining criteria short-circuit with `infraError: true` and a `"Budget exceeded"` reason; these are not counted as quality failures by downstream summaries. If an OpenAI response has token usage but the client lacks `costRates`, the criterion is marked `infraError: true` with `"cost unknown — pass costRates to OpenAIJudgeClient"`. `JudgeResult.normalizedScore` is in `[0,1]` and `pass` is derived from `passThreshold`.

### V5b — Baselines, Regression Detection, CI Gates, PR Comments

V5b closes the loop: persist a `MultiTrialResult` as a `Baseline`, detect statistically significant regressions on the next run, and gate CI on a quality floor (`passRateFloor`) plus optional supplementary and operational gates such as `maxRegressions`, `maxCostUsd`, and infra-error limits. A `PRCommentReporter` emits Markdown for surfacing in PR reviews.

```typescript
import {
  saveBaseline,
  loadBaseline,
  RegressionDetector,
  CIGate,
  PRCommentReporter,
} from "pilotswarm-eval-harness";

// 1. Persist this run as the new baseline
saveBaseline(currentResult, ".eval-results/baseline.json");

// 2. On the next run: load baseline, detect regressions
const baseline = loadBaseline(".eval-results/baseline.json");
const detection = new RegressionDetector({ alpha: 0.05, correction: "bh" }).detect(baseline, nextResult);

// 3. Gate CI on the combined signal
const gate = new CIGate({ passRateFloor: 0.8, maxRegressions: 0, maxCostUsd: 5 });
const verdict = gate.evaluate(nextResult, detection, totalCostUsd);
process.exit(gate.exitCode(verdict));

// 4. Emit a PR-ready Markdown summary
const pr = new PRCommentReporter(".eval-results/pr-comment.md");
pr.onMultiTrialComplete(nextResult);
pr.writeGateResult(verdict, detection.regressions);
```

`RegressionDetector` uses a two-proportion z-test on baseline vs. current pass rates (baselines persist aggregate counts, not per-sample paired outcomes). Multiple-testing correction is opt-in via `correction: "none" | "bonferroni" | "bh"` and defaults to `"none"` for compatibility. `detect()` returns `{ regressions, missingBaselineSamples, newCurrentSamples }`: baseline samples missing from the current run are reported so CI cannot pass by deleting hard eval cases, and current samples missing from the baseline are reported so consumers can catch added easy samples that dilute aggregate pass rate. `CIGate.evaluate()` fails on missing baseline samples by default; set `allowMissingBaselineSamples: true` only for intentional sample removals. `failOnNewSamples` defaults to `true`: by default a baseline comparison that reports added current samples fails the gate with `new samples added vs baseline: ...`. Opt out explicitly with `failOnNewSamples: false` only for intentional sample additions. `direction` is `"regressed" | "improved" | "unchanged"`. `CIGate.evaluate()` returns `{ pass, reasons[], passRate, regressionCount, totalCostUsd }`. McNemar's test is still exported as `mcNemarTest` for callers that have paired per-sample data.

`CIGate` requires `passRateFloor` for quality approval. `passRateFloor` is the only gate that constrains absolute quality — without it, `CIGate` rejects the run with `"CIGate requires passRateFloor for quality approval — cost, infra, regression-only, and operational gates cannot replace a pass-rate floor."` (pinned by `test/ci-gate.test.ts`). `maxRegressions` is **supplementary**: it is a "no regression" gate that complements `passRateFloor` by enforcing that the current run does not regress vs the baseline, but it cannot replace `passRateFloor` even when paired with non-empty regression data. A regression-only gate (`maxRegressions: 0` with no `passRateFloor`) does not constrain absolute quality, so it is rejected. `maxCostUsd`, `maxInfraErrors`, and `requireNoInfraOutage` are operational gates only; they can fail a run, but they cannot approve quality on their own.

`CIGate` recomputes aggregate quality signal from `MultiTrialResult.samples` and rejects inputs where the supplied `summary.meanPassRate` disagrees with the recomputed value. This protects CI from post-processed or tampered result JSON. Set `trustSummary: true` only when a caller deliberately accepts the risk of authoritative precomputed summaries; gate decisions still use the recomputed sample-level signal.

`saveBaseline()` refuses to persist samples with no quality signal (`nonErrorTrials === 0`, usually all trials infra-errored) because such baselines suppress future regression detection for those samples. To override intentionally, call `saveBaseline(result, path, { allowNoQualityBaseline: true })`; the save and subsequent load will warn and name the affected samples. It also refuses low-quality baselines with aggregate pass rate below 50%, because a broken baseline can ratify equally broken current runs in regression-only CI gates. To override intentionally, call `saveBaseline(result, path, { allowLowQualityBaseline: true })`; the save will warn with the same low-quality message.

#### Statistical assumptions and caveats

- The two-proportion z-test assumes IID Bernoulli trials. That may not hold for multi-trial LLM evals because repeated trials of the same prompt against the same model can share seed effects, prompt stickiness, or provider-side correlation.
- P-values can be over-optimistic in practice. Treat them as one signal, not proof.
- Multiple-testing correction is opt-in via `bonferroni` or `bh`. Use `bh` for five or more samples; use `bonferroni` for fewer than five when you want the stricter family-wise error bound.
- `RegressionDetector` works best when samples are de-correlated: different prompts, different fixtures, and distinct behaviors.
- If you cannot make IID assumptions, use the exported `mannWhitneyU` and `bootstrapCI` helpers on caller-owned distributions and gate on effect sizes / confidence intervals instead of z-test p-values alone.

## Roadmap

| Version | Scope | Status |
|---------|-------|--------|
| V1 | Schema, FakeDriver runner, graders, console + JSONL reporters, golden fixture | ✅ Shipped |
| V1 LiveDriver | Real PilotSwarm session path | 🧪 Experimental (`LIVE=1` smoke only) |
| V2 | Multi-trial, matrix, statistical utilities (Wilson, bootstrap, McNemar, Mann-Whitney), pass@k | ✅ Shipped |
| V3 | Fixture-derived durability observations and scoring | 🧪 Fixture/scaffold only — not real crash validation |
| V4 | Multi-turn / trajectory fixture evaluation, per-turn + cross-turn + holistic scoring | 🧪 Experimental — lexical retention default is limited |
| V5a | LLM-as-judge, rubric schema, budget caps, judge cache, OpenAI-compatible adapter | 🧪 Experimental — not calibrated |
| V5b | Baselines, regression detection (two-proportion z-test), CI gates, PR comment reporter | ✅ Shipped |

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Constraint-based matching (not exact) | LLMs add harmless extra args; exact match → false failures |
| `subset` as default match mode | Useful structural default; string values are strict unless `subsetCaseInsensitive` is opted in |
| Word-boundary response matching | Prevents `"hi"` matching `"this"` — substring matching is a footgun |
| Default product prompt in canonical datasets | Canonical datasets avoid per-sample custom system prompts; use matrix overrides only for explicit prompt experiments |
| FakeDriver for CI | Fast (< 1s total), free, deterministic — tests the harness, not the model |
| AbortSignal on Driver | Timeouts abort the harness wait and trigger cleanup; provider-level call cancellation depends on SDK support |
| Async-ready Reporter | `void | Promise<void>` — Langfuse/OTel plug in without interface changes |
| Incremental JSONL writes | Crash mid-run → partial results preserved (not buffered-then-lost) |
| Specificity-ordered arg matching | Most-constrained expectations matched first → avoids greedy mis-pairing |
| Path-sanitized artifacts | `runId`/`caseId` stripped of separators → no path traversal |

## Relationship to Existing Tests

| Existing Tests (`packages/sdk/test/local/`) | Eval Harness (`packages/eval-harness/`) |
|---------------------------------------------|----------------------------------------|
| Assert **system** behavior (events fire, CMS persists, orchestration replays) | Measure **LLM** behavior (tool selection, arg accuracy, sequencing) |
| One run, hard fail | passRateFloor, statistical signal (multi-trial + matrix in V2) |
| vitest `describe`/`it` | Same runner, different semantics |
| Share: PilotSwarm SDK, CMS helpers | Share: tool definitions pattern, test env isolation |
