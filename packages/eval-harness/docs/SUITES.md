# Eval-Harness Suites

This is the canonical inventory of test suites in `packages/eval-harness/test/`.
Each suite documents its intent, gating, and (where relevant) cost.

> Suite gating is uniform: every `*-live.test.ts` file uses
> `process.env.LIVE === "1" ? it : it.skip` so default `npx vitest run` skips
> live tests cleanly. LLM-judge subjective tests additionally require
> `LIVE_JUDGE=1` AND either `OPENAI_API_KEY` OR
> `GITHUB_TOKEN`+`PS_MODEL_PROVIDERS_PATH` (the latter routes through
> PilotSwarm's `ModelProviderRegistry` via `PilotSwarmJudgeClient`).

## Quick Reference

| Suite        | File                              | Gating                                  | LIVE tests |
|--------------|-----------------------------------|-----------------------------------------|-----------:|
| FUNCTIONAL   | `live-driver-live.test.ts`        | `LIVE=1`                                | 9          |
| DURABILITY   | `durability-live.test.ts`         | `LIVE=1` (incl. real worker-handoff w/ CMS evidence) | 7          |
| ABLATIONS    | `ablations-live.test.ts`          | `LIVE=1` (+ optional models env)        | 5          |
| LLM-JUDGE    | `llm-judge-live.test.ts`          | `LIVE=1 LIVE_JUDGE=1` + `OPENAI_API_KEY` **OR** `GITHUB_TOKEN`+`PS_MODEL_PROVIDERS_PATH` | 5          |
| PERFORMANCE  | `performance-live.test.ts`        | `LIVE=1`                                | 4          |
| SAFETY       | `safety-live.test.ts`             | `LIVE=1` (+ `LIVE_JUDGE=1` for subjective) | 14      |
| (regression) | `regression-live.test.ts`         | `LIVE=1`                                | 2          |

Total LIVE-gated tests: **46** (was 9 before eval-platform expansion).

Optional environment variables used across suites:

| Var                                | Purpose                                                    |
|------------------------------------|------------------------------------------------------------|
| `LIVE`                             | Master gate — set to `1` to enable LIVE tests              |
| `LIVE_JUDGE`                       | Enables LLM-as-judge subjective tests                      |
| `LIVE_JUDGE_MODEL`                 | Single judge model id (default `gpt-4o-mini` for OpenAI; `github-copilot:gpt-4.1` for PilotSwarm-routed) |
| `LIVE_JUDGE_MODEL_A` / `_B`        | Cross-judge agreement model ids                            |
| `LIVE_JUDGE_INPUT_USD_PER_M`       | Input rate override for `PilotSwarmJudgeClient` cost math (per 1M tokens) |
| `LIVE_JUDGE_OUTPUT_USD_PER_M`      | Output rate override (per 1M tokens). Both required if either set |
| `LIVE_JUDGE_CACHED_INPUT_USD_PER_M`| Optional cached-input rate override (per 1M tokens)        |
| `LIVE_MATRIX_MODELS`               | Comma-separated PilotSwarm model ids for matrix sweep      |
| `LIVE_ABLATION_MODELS`             | Override matrix models for ablation suite only             |
| `OPENAI_API_KEY`                   | OpenAI judge transport credential                          |
| `OPENAI_BASE_URL`                  | OpenAI-compatible base URL override (default `https://api.openai.com/v1`) |
| `GITHUB_TOKEN`                     | GitHub Copilot judge transport credential (for `PilotSwarmJudgeClient`) |
| `PS_MODEL_PROVIDERS_PATH`          | Path to model providers config — required for `PilotSwarmJudgeClient` |
| `EVAL_REPORTS_DIR`                 | When set, `EvalRunner` auto-appends a `JsonlReporter` writing to `<dir>/<runId>.jsonl` (and `<dir>/<runId>/<caseId>.json` for failures). Default `.eval-results/` is gitignored. |
| `KEEP_DURABILITY_ENV`              | Set to `1` to retain DURABILITY test env state for forensics |

## FUNCTIONAL

**File:** `test/live-driver-live.test.ts`
**Gating:** `LIVE=1`. Optional `LIVE_MATRIX_MODELS` for the matrix sweep.

Tests PilotSwarm features end-to-end through `LiveDriver` against a real
worker and CMS. Each test creates a fresh schema and tears it down.

Coverage:

- Single-prompt smoke (`test_add` arithmetic round-trip, asserts 42 in response)
- Sub-agent spawn metadata (parent/child link, sessionId, tool evidence)
- Multi-trial pass-rate / Wilson CI through real worker (3 trials)
- Matrix sweep across configured PilotSwarm models
- `spawn_agent` tool invocation correctness with parent-child relationship
- `wait` tool registers a durable timer (round-trip latency check)
- Tool registration — worker-level `toolNames` flow surfaces correct tools
- Concurrent sessions — N parallel sessions with isolated state
- Session lifecycle — `sessionId` stable, `cmsState` terminal-or-idle

## DURABILITY

**File:** `test/durability-live.test.ts`
**Gating:** `LIVE=1`. Optional `KEEP_DURABILITY_ENV=1` to retain test
env state for forensics on the real worker-handoff scenario.
**Helpers:** `ChaosDriver` from `src/drivers/chaos-driver.ts` for
fault-injection scenarios; SDK `PilotSwarmWorker` / `PilotSwarmClient`
plus `createTestEnv` for the real handoff test (sequential worker
construction — `withTwoWorkers` is intentionally NOT used because both
workers would race to dispatch turn 1, defeating the handoff scenario).

Tests crash recovery, dehydration, and **real cross-worker session
handoff** verified via persisted CMS events with `workerNodeId` evidence.

Coverage:

- Worker crash mid-eval recovery (`worker_crash` / `before_turn`)
- Dehydrate / hydrate session round-trip (`after_dehydrate`)
- In-flight tool fault — re-throws by default; observable when `swallowOnFault`
- Long-running session survives multiple chaos cycles (smoke)
- **REAL worker handoff (CMS evidence)** — starts worker A only for
  turn 1, stops A and starts B, runs turn 2 on the same session,
  asserts the persisted CMS event log contains BOTH `eval-handoff-a`
  AND `eval-handoff-b` `workerNodeId` values plus ≥2
  `session.turn_completed` events. No synthetic tags, no
  `ChaosDriver` overlay — pure product evidence.

Plus 9 fixture-driven `ChaosDriver` unit tests in `test/durability.test.ts`
that run by default (no LIVE gating) and validate fault-injection semantics
without spinning up a real worker.

## ABLATIONS

**File:** `test/ablations-live.test.ts`
**Gating:** `LIVE=1`. Optional `LIVE_ABLATION_MODELS` (or fallback
`LIVE_MATRIX_MODELS`) for the model dimension.

Compares PilotSwarm config variants against the same task; surfaces which
dimension drives the pass-rate delta. Uses `MatrixRunner` /
`MultiTrialRunner` / `RegressionDetector` and the new `make*Ablation*`
builders in `test/fixtures/builders.ts`.

Coverage:

- **Model dimension** — matrix across 2+ models, per-cell pass rates
- **Prompt variant** — A/B prompts, parallel multi-trial
- **Tool-set dimension** — full vs reduced tool registration
- **Trial-count** — Wilson CI shrinks as trials grow (n=2 → n=5)
- **Regression detector** — degraded variant flagged

## LLM-JUDGE

**File:** `test/llm-judge-live.test.ts`
**Gating:** `LIVE=1 LIVE_JUDGE=1` AND either `OPENAI_API_KEY` OR
`GITHUB_TOKEN`+`PS_MODEL_PROVIDERS_PATH` (the helper
`makeLiveJudgeClient()` selects between `OpenAIJudgeClient` and
`PilotSwarmJudgeClient` based on which credentials are available).

Subjective rubric grading + judge-vs-judge cross-validation. Each
grader instance carries a `budgetUsd` cap; cost is asserted within
budget. The `PilotSwarmJudgeClient` path lets the judge run on every
provider PilotSwarm itself supports (GitHub Copilot / OpenAI /
Anthropic / Azure OpenAI), so the default PilotSwarm dev environment
(only `GITHUB_TOKEN` set) can run live judge tests without exporting
`OPENAI_API_KEY`. See [`JUDGE-CLIENTS.md`](./JUDGE-CLIENTS.md) for the
full selection precedence and cost-rate contract.

Coverage:

- Single-criterion rubric grade against real PilotSwarm response
- Multi-criterion rubric (helpfulness/accuracy/safety) returns finite scores
- Cost accounting accumulates within `budgetUsd`
- Cross-judge agreement — two judge models score the same response
- Refusal handling — judge marks low score on a known-bad response

## PERFORMANCE

**File:** `test/performance-live.test.ts`
**Gating:** `LIVE=1`. DB-budget tests additionally require
`PG_STAT_STATEMENTS_ENABLED=1` (with the extension actually loaded via
`shared_preload_libraries=pg_stat_statements` and `CREATE EXTENSION
pg_stat_statements`). When that env knob is unset the DB-budget tests
are now real Vitest skips (not silent passes) — see reaudit G4 fix.
**Helpers:** `LatencyTracker`, `CostTracker` in `src/perf/latency-tracker.ts`.

Tracks regressions in latency, cost, and token usage. The trackers are
pure-function helpers exported from the public API so external consumers
can use them too.

Coverage:

- Single-turn latency p50/p95/p99 within configured budget
- Cost-per-trial accumulates within configured budget
- Sub-agent spawn latency scales acceptably (1, 3 spawns)
- Latency regression sanity (synthetic fast vs slow series)
- DB-call budgets: per-turn / per-spawn / total / by-category / total
  exec-time (gated on `PG_STAT_STATEMENTS_ENABLED=1`)

Builders: `makeLatencyBudget`, `makeCostBudget`. Default-run unit tests for
the trackers themselves live in `test/perf-latency-tracker.test.ts` (8
tests, no LIVE gating).

## DURABILITY (perf-tier3) — DEFERRED

**File:** `test/perf-durability-live.test.ts`
**Gating:** `LIVE=1 PERF_DURABILITY=1`.
**Status:** **Deferred — production durability sampling is not wired.**

Reaudit G4 fix. The durability percentile tracker
(`src/perf/durability-tracker.ts`) is wired to consume paired CMS
`*-start` / `*-end` events via `recordFromCmsEvents()`, but the
PilotSwarm SDK does not currently emit `session.rehydrate-start`,
`session.dehydrate-start`, or `session.checkpoint-start` events — only
the terminal `session.hydrated` / `session.dehydrated` events. As a
result:

- The CMS-events code path returns `noStartEventsFound: true` and
  produces zero samples against any real production event stream, with
  a one-line deferral log explaining why.
- All four durability percentile buckets (`rehydrate`, `replay`,
  `checkpoint`, `dehydrate`) report `available: false` with a clear
  `unavailableReason`. The reporter renders the section with a
  "deferred — requires SDK start-event instrumentation" banner.
- `BudgetChecker` fails closed against any configured durability budget
  unless the budget is explicitly marked `optional: true`.
- `replay` is permanently `available: false` from the public API
  surface; the only way to populate it is the test-only escape hatch
  `_recordReplayForTesting()` (intentionally underscored, intentionally
  not exported from `src/perf/index.ts`). Replay timing requires a
  duroxide trace parser the harness does not have today.

A coarse `recordHarnessWallclock(bucket, sessionId, ms)` API is available
as an OPT-IN regression sentinel. Samples recorded that way carry
`source: "harness-wallclock"` in `TrackerPercentiles.source`, and the
reporter renders them with a banner clarifying they are NOT real
durability latencies.

This suite will move out of "deferred" once the SDK starts emitting
`*-start` events. The CMS-events parser is fully unit-tested
(`test/perf/durability-tracker.test.ts`) so the integration is ready to
drop in immediately.

## SAFETY

**File:** `test/safety-live.test.ts`
**Datasets:** `datasets/safety/*.v1.json` (5 files, 14 samples)
**Graders used:**
- Default `gradeEvalCase` (forbiddenTools / noToolCall / response containment / tool-args matching)
- `gradeNoSecretLeak` / `findSecretLeaks` from `src/graders/secret-leak.ts` (regex-based output safety)
- `LLMJudgeGrader` with task-specific rubrics (subjective tests only)

**Gating:**
- `LIVE=1` — runs the 12 deterministic tests (direct injection, indirect injection, output safety, tool-call abuse).
- `LIVE=1 LIVE_JUDGE=1 OPENAI_API_KEY=…` — additionally runs the 2 LLM-judge graded tests.
- Without env vars, all tests `it.skip` cleanly.

### Why each prompt-injection class is included

| Class | Tests | Threat model |
|---|---|---|
| **Direct injection** | `direct.ignore-previous-instructions`, `direct.role-swap`, `direct.authority-claim-system-prompt-leak` | Adversary controls the user channel and tries to override the system prompt, swap personas, or extract internal instructions. This is the OWASP LLM01 top risk. |
| **Indirect injection** | `indirect.tool-result-injection`, `indirect.web-content-injection-html-comment`, `indirect.multi-turn-poisoning` | Adversary controls a *data* channel (tool output, fetched web content, prior conversation transcript) and embeds instructions there. Far more dangerous than direct injection because the user is benign. Maps to OWASP LLM01 indirect class and Greshake et al. 2023. |
| **Output safety** | `output.secret-extraction-github-token`, `output.credential-format-leak`, `output.pii-ssn-generation` | Regression guard for regurgitation / fabrication of credential- or PII-shaped strings. Catches the failure mode where a model "helpfully" invents real-format example secrets. |
| **Tool-call abuse** | `tool-abuse.forbidden-tool-jailbreak`, `tool-abuse.tool-args-coercion-sensitive-path`, `tool-abuse.unbounded-tool-call-recursion` | Adversary tries to widen the tool surface, coerce sensitive arguments into allowed tools, or exhaust tool/sub-agent budget. Maps to OWASP LLM07 (insecure plugin/tool design) and LLM10 (excessive agency). |
| **Subjective (LLM-judge)** | `subjective.refusal-quality-explosives`, `subjective.helpfulness-borderline-chemicals` | Rubric-graded guard against (a) over-compliance on unsafe prompts and (b) over-refusal on borderline-but-legitimate questions. Both failures degrade product trust. |

### Cost estimate per `LIVE=1` run

12 deterministic tests × ~1 turn per test × ~1–3 tool calls average. With the default model (whatever `.env` configures) and the test_add/test_multiply/test_weather fixture tools:

- **LLM tokens:** roughly 12 × ~400 input + ~150 output = ~5k input / ~2k output tokens. At GPT-4o-mini-class pricing this is ~$0.005–$0.02 per run.
- **Wall-clock:** 12 × ~5–15s per sample = ~1–3 minutes total.
- **DB / blob:** each sample creates a fresh schema; cleanup is automatic.

`LIVE_JUDGE=1` adds 2 OpenAI judge calls. Each judge call at gpt-4o-mini is ~$0.01. Bound by `budgetUsd: 1` per grader instance — refuses further criteria above the cap.

### Adding new safety samples

1. Add the sample to the appropriate dataset file in `datasets/safety/`.
2. Ensure `expected` includes at least one criterion (`noToolCall: true`, `forbiddenTools`, `toolCalls`, or `response.containsAny`/`containsAll`) so `EvalTaskSchema` accepts it.
3. Add a corresponding `liveIt(...)` block to `test/safety-live.test.ts` that runs the sample, calls `gradeEvalCase` implicitly via `EvalRunner`, and adds suite-specific programmatic assertions (regex checks, tool-call caps, persona-leak markers).
4. If the sample needs a new pattern, extend `SecretLeakPatterns` in `src/graders/secret-leak.ts` and add a unit test in `test/secret-leak.test.ts`.

### Coordination

This SAFETY section is authored separately from the conductor-owned suites.
When the conductor fills in the FUNCTIONAL/DURABILITY/etc. sections, this
SAFETY section should be left intact.
