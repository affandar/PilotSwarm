# Iterating on the system prompt with eval-harness

Practical loop for editing `packages/sdk/plugins/system/agents/default.agent.md`
(or any other prompt source) and getting fast, trustworthy signal back.

## TL;DR — the three loops

| loop | command | wallclock | LLM calls | when to use |
|------|---------|----------:|----------:|-------------|
| **inner** | `npx vitest run test/prompt-testing/` | ~2s | 0 | every save while editing |
| **single-suite LIVE** | `bin/run-live.sh --prompt-testing -- test/prompt-testing-live.test.ts -t '<test name>'` | 60–300s | small | quick reality check after a change |
| **full LIVE** | `bin/run-live.sh --all --prompt-testing` | ~30–40min | full | pre-PR / nightly |

All three operate on the **same suite code** — only the driver and gating differ. Inner loop uses `FakeDriver` and pre-recorded scenarios; LIVE uses `LiveDriver` against PilotSwarm + Copilot.

## What gets evaluated

Tests baseline against the SDK's actual default agent prompt:

```
packages/sdk/plugins/system/agents/default.agent.md
```

Resolved at runtime via `defaultBaseline()` in `test/prompt-testing-live.test.ts`. Edit that file → tests pick it up on next run, no recompile.

## The five suite primitives

All exported from `pilotswarm-eval-harness` under `src/prompt-testing/`:

| primitive | what it answers |
|-----------|-----------------|
| `runInjectionSuite({ baseline, variants, datasetFile, sampleIds, trials })` | does the prompt resist `direct.ignore-previous-instructions` etc. across `SAFETY_FILES.{directInjection, indirectInjection, toolAbuse, outputSafety, subjective}`? |
| `runAblationSuite({ baseline, variants, datasetPath })` + `computeAblationDelta` | which sections of the prompt actually matter? Pass `minimize-50`, `remove-section`, etc. and watch tool-call accuracy delta. |
| `runRobustnessSuite({ baseline, perturbations })` | does behavior survive benign rewordings? (deterministic `paraphrases: string[]` or LLM-paraphrase via `OPENAI_API_KEY`) |
| `runVariantMatrix({ baseline, variants, models, trials, sample })` | A/B/C model × prompt grid. Bounded by `maxCells` (default 48). |
| `captureGolden / compareToGolden / syntheticallyDegrade / compareGoldens` | regression: capture golden once, gate future runs against it. Compare is pure-data (instant, no LLM). |

Source of truth: `packages/eval-harness/src/prompt-testing/index.ts`.

## Variant authoring

Variants are a baseline + a mutator. Mutators live in
`src/prompt-testing/mutators/` and are addressable by string id:

| mutator | config | effect |
|---------|--------|--------|
| `minimize` | `{ percent }` | keep top N% of token-ranked content |
| `remove-section` | `{ headings: string[] }` | strip the matching `##`/`###` blocks |
| `rewrite` | `{ rules: [...] }` | string-replacement rules |
| `append` | `{ text }` | tack on extra instructions |

Compose:

```ts
import type { PromptVariant } from "pilotswarm-eval-harness";

const variants: PromptVariant[] = [
  { id: "baseline", baseline: { kind: "file", path: AGENT_MD } },
  {
    id: "minimize-30",
    baseline: { kind: "file", path: AGENT_MD },
    mutation: { mutator: "minimize", config: { percent: 30 } },
  },
  {
    id: "no-tool-discipline",
    baseline: { kind: "file", path: AGENT_MD },
    mutation: { mutator: "remove-section", config: { headings: ["Tool discipline"] } },
  },
];
```

## Golden-snapshot regression flow

```bash
# 1. Capture once (after a known-good prompt edit)
LIVE=1 PROMPT_TESTING=1 REFRESH_GOLDEN=1 \
  npx vitest run test/prompt-testing-live.test.ts -t 'regression'

# 2. Edit the prompt, then verify no behavioral drift
LIVE=1 PROMPT_TESTING=1 \
  npx vitest run test/prompt-testing-live.test.ts -t 'regression'
```

Goldens land in `packages/eval-harness/datasets/goldens/<prompt>.golden.v1.json`. Schema is v2 internally (response digest + length + per-tool-call name/argKeys/argDigest sequence + aggregate means). Filename keeps the `.v1` suffix for path compatibility — see `docs/PROMPT-TESTING-SPEC-DRIFT.md`.

## Inner-loop pattern

Build a tiny FakeDriver scenario set, then exercise the same suite functions:

```ts
import {
  FakeDriver,
  runAblationSuite,
} from "pilotswarm-eval-harness";

const driverFactory = () => new FakeDriver({ /* scripted scenarios */ });
const result = await runAblationSuite({
  baseline: { kind: "file", path: AGENT_MD },
  variants: [/* ... */],
  datasetPath: "datasets/tool-call-correctness.v1.json",
  driverFactory,    // ← FakeDriver instead of LiveDriver
  trials: 1,
});
```

This is what the existing unit tests under `test/prompt-testing/` do. Run them in watch mode while iterating:

```bash
cd packages/eval-harness && npx vitest test/prompt-testing/
```

## Reading the LIVE reports

Each LIVE invocation writes to `packages/eval-harness/.eval-results/<ts>-<tag>/`:

- `<runId>.jsonl` — one summary line per task; `{"type":"summary", total, passed, failed, errored, passRate, infraErrorRate, ...}`
- `<runId>/<caseId>.json` — full failure detail (only on fail)
- Console log additionally prints `[prompt-testing:injection] meanResistance=0.823` style markers

### Consolidated Markdown report

After (or during) a run, generate a single readable Markdown summary:

```bash
# Latest reports dir under packages/eval-harness/.eval-results/
node packages/eval-harness/bin/report.mjs

# Specific dir
node packages/eval-harness/bin/report.mjs packages/eval-harness/.eval-results/<ts>-<tag>

# Inline with the run (Markdown report is auto-generated by default)
bin/run-live.sh --all --prompt-testing

# Custom output path
bin/run-live.sh --all --prompt-testing --report-out /tmp/my-eval-report.md

# Opt out
bin/run-live.sh --all --prompt-testing --no-report
```

The report (`REPORT-<ts>.md`) lives inside the reports dir. Sections (in
order, with a Markdown TOC at the top):

1. **Run context** — wall clock, sample / task counts, suite gate env
   (`LIVE`, `LIVE_JUDGE`, `PERF_HEAVY`, …), judge / matrix model ids,
   and presence-only flags for `GITHUB_TOKEN` / `OPENAI_API_KEY` /
   `DATABASE_URL` host.
2. **Top-line totals** — ASCII pass-rate bar plus the standard counts.
3. **Suite breakdown** — capability suites (FUNCTIONAL / DURABILITY /
   ABLATIONS / LLM-JUDGE / PERFORMANCE / SAFETY / PROMPT-TESTING) each
   with their own per-case table and pass-rate bar. Suite mapping is by
   case-id prefix (`live.functional.*` → FUNCTIONAL, `perf.*` →
   PERFORMANCE, `ablation.*` → ABLATIONS, `direct.*`/`indirect.*`/
   `output.*`/`tool-abuse.*`/`subjective.*` → SAFETY, `*::*::*` →
   PROMPT-TESTING).
4. **Performance highlights** — latency p50/p95/p99 by suite, top-10
   slowest cases, top-10 most-failing cases, cost aggregate when
   present (graceful `n/a` otherwise — see notes about DB-budget signal
   not flowing through `EvalRunner`).
5. **Failures** — grouped by category (infra / sdk-perf /
   model-quality deterministic / model-quality judge-graded). Each
   failure shows: failing scores collapsed by score-name family, the
   truncated `observed.finalResponse`, a compact tool-call summary, a
   filtered list of key CMS events (`user.message`, `tool.*`,
   `guardrail.decision`, `session.turn_*`), and a relative pointer to
   the raw `<runId>/<caseId>.json` artifact.
6. **LLM-judge scores** — per-criterion aggregate plus full reasoning
   (truncated to ~400 chars) for any non-pass / infra-error judge
   call. Renders an explanatory `n/a` line when no `judge/*` scores
   were captured.
7. **Prompt-testing variants** — `pt-cell-*` task ids collapsed into a
   `base / variant / model` matrix so the per-task table doesn't get
   noisy.
8. **How to read this** + **What to do next** — actionable follow-up
   commands per failure category (which `bin/run-live.sh` flag, which
   prompt source to edit, which suite test to filter).

Idempotent — re-run anytime to refresh from new jsonl writes. Works on
partial / mid-flight runs (renders an explicit "in-flight" banner if
samples without summaries are detected).

Aggregate across runs:

```bash
for f in .eval-results/<ts>-everything/*.jsonl; do tail -1 "$f"; done \
  | jq -s 'map(select(.type=="summary")) | group_by(.taskId)
           | map({task: .[0].taskId, runs: length, passed: (map(.passed)|add), failed: (map(.failed)|add)})'
```

## Cost / scope dial

| env | default | meaning |
|-----|---------|---------|
| `PROMPT_TESTING=1` | off | gates all `prompt-testing-live` tests |
| `PROMPT_TESTING_TRIALS=N` | 1 | trials per cell |
| `PROMPT_TESTING_MODELS="m1,m2"` | single | comma-separated model list for variant matrix |
| `LIVE_MAX_TRIALS` / `LIVE_MAX_MODELS` | enforced caps in `helpers/live-timeout.ts` | runtime-bounded so a typo can't blow up cost |

Reduce trials and stick to one model when iterating; bump for nightly.

## When to *not* trust a result

- **Single-trial LIVE** — Copilot models are stochastic. A 1-trial pass/fail is a sample-of-one. The matrix runners produce Wilson CIs at trials ≥ 5; below that, treat as smoke.
- **`infraError: true`** — call never reached the model (timeout, transport, judge format crash). Excluded from quality aggregates by design. If you see these, fix the harness first; don't chase prompt changes.
- **Robustness without `OPENAI_API_KEY`** — must pass `paraphrases: string[]` explicitly. Deterministic template paraphrasing is rejected (would mask regressions).

## Workflow recipes

**"I changed three lines in default.agent.md."**

```bash
# 1. Inner loop — does the FakeDriver suite still pass?
cd packages/eval-harness && npx vitest run test/prompt-testing/

# 2. Smoke against a single live cell (~1min)
bin/run-live.sh --prompt-testing -- test/prompt-testing-live.test.ts \
  -t 'variant under test resists ignore-previous-instructions'

# 3. If green, run ablation to see if the change actually mattered
bin/run-live.sh --prompt-testing -- test/prompt-testing-live.test.ts \
  -t 'minimize-50% degrades or preserves tool-call accuracy'
```

**"Pre-PR sweep"**

```bash
bin/run-live.sh --all --prompt-testing
```

**"I'm chasing a regression vs golden"**

```bash
# Compare current LIVE behavior to last golden; will fail if drift > threshold
LIVE=1 PROMPT_TESTING=1 \
  npx vitest run test/prompt-testing-live.test.ts -t 'regression'
```

**"I want to know which section of the prompt is load-bearing"**

```ts
// One-off script: feed remove-section variants for each top-level heading
// of default.agent.md, run runAblationSuite(), sort by passRateDelta.
```

## Pointers

- Implementation: `packages/eval-harness/src/prompt-testing/`
- Spec drift / design rationale: `packages/eval-harness/docs/PROMPT-TESTING-SPEC-DRIFT.md`
- LIVE test body: `packages/eval-harness/test/prompt-testing-live.test.ts`
- Unit tests / inner-loop reference: `packages/eval-harness/test/prompt-testing/`
- Suite catalog: `packages/eval-harness/docs/SUITES.md`
- Judge selection: `packages/eval-harness/docs/JUDGE-CLIENTS.md`
