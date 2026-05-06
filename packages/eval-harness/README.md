# PilotSwarm Eval Harness

Production-grade evaluation harness for PilotSwarm agents. Measures tool-call correctness, argument accuracy, sequencing, and session state through deterministic code graders with constraint-based matching.

## Quick Start

```bash
# Run eval suite (uses FakeDriver — no LLM calls, no .env needed)
cd packages/eval-harness
npx vitest run

# Via the repo test runner
./scripts/run-tests.sh --suite=eval
```

## Architecture

```
                    ┌─────────────────────┐
                    │     EvalRunner       │
                    │  load → drive →      │
                    │  grade → report      │
                    └──────┬──────────────┘
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
   ┌─────────────┐  ┌───────────┐   ┌───────────┐
   │   Driver     │  │  Graders  │   │ Reporters │
   │             │  │           │   │           │
   │ FakeDriver  │  │ tool-sel  │   │ Console   │
   │ LiveDriver  │  │ match-arg │   │ JSONL     │
   └─────────────┘  │ ordering  │   └───────────┘
                     │ response  │
                     │ cms-state │
                     └───────────┘
```

**Data flow:** JSON fixture → Loader (Zod validates) → Runner → Driver (execute) → Graders (score) → Reporter (output)

## Package Structure

```
packages/eval-harness/
├── src/
│   ├── index.ts              # Public API exports
│   ├── types.ts              # Zod schemas + TS types
│   ├── loader.ts             # JSON fixture loader + validation
│   ├── runner.ts             # EvalRunner: orchestrates eval lifecycle
│   ├── graders/
│   │   ├── index.ts          # Composer: gradeEvalCase()
│   │   ├── match-args.ts     # Arg matching (exact/subset/fuzzy/setEquals)
│   │   ├── tool-selection.ts # Tool name + forbidden + call counts
│   │   ├── ordering.ts       # Strict/unordered sequence grading
│   │   ├── response.ts       # Word-boundary containsAny/All
│   │   └── cms-state.ts      # CMS session state assertion
│   ├── drivers/
│   │   ├── types.ts          # Driver + DriverOptions interfaces
│   │   ├── fake-driver.ts    # Scripted traces (TDD, CI, fast)
│   │   └── live-driver.ts    # Real LLM via PilotSwarm withClient()
│   ├── observers/
│   │   └── tool-tracker.ts   # EvalToolTracker → ObservedToolCall[]
│   ├── reporters/
│   │   ├── types.ts          # Reporter interface (async-ready)
│   │   ├── console.ts        # ✅/❌/⚠️ summary table to stdout
│   │   └── jsonl.ts          # Incremental JSONL + failure artifacts
│   └── fixtures/
│       └── eval-tools.ts     # test_add, test_multiply, test_weather
├── test/                     # 15 test files, 196 tests
├── datasets/
│   └── tool-call-correctness.v1.json   # Golden dataset v1 (6 cases)
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
    "prompt": "What is 17 plus 25? Use the test_add tool.",
    "systemMessage": "You have tools available. Use them when asked. Be brief."
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
| `LiveDriver` | Real model evaluation | Yes | 5-30s/case |

### Reporter

Reporters receive events as evals execute:

| Reporter | Output | Use Case |
|----------|--------|----------|
| `ConsoleReporter` | ✅/❌/⚠️ table to stdout | Interactive use |
| `JsonlReporter` | `.eval-results/<runId>.jsonl` + failure artifacts | CI, history |

Reporter interface is async-ready (`void | Promise<void>`) for future Langfuse integration.

## Grading Reference

### Argument Matching Modes

| Mode | Behavior | Default |
|------|----------|---------|
| `exact` | JSON equality after key sorting | |
| `subset` | Every expected key must match; extra actual keys OK. Strings case-insensitive + trimmed. | ✅ |
| `fuzzy` | Levenshtein for strings (≤20% distance), numeric tolerance (±0.01), order-insensitive arrays | |
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
| `strict` | Expected tools appear in order as a subsequence of observed calls |
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
    "prompt": "What is 20 divided by 4? Use the appropriate tool.",
    "systemMessage": "You have math tools. Use the correct one."
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

## Running Against a Real Model

The `LiveDriver` executes samples against a real LLM via PilotSwarm's `withClient()` pattern.

**Prerequisites:**
- PostgreSQL running (`DATABASE_URL` in `.env`)
- `GITHUB_TOKEN` in `.env` (or model provider keys in `.model_providers.json`)

**Example usage in a test:**

```typescript
import { LiveDriver } from "../src/drivers/live-driver.js";
import { EvalRunner } from "../src/runner.js";
import { loadEvalTask } from "../src/loader.js";
import { ConsoleReporter } from "../src/reporters/console.js";
import { JsonlReporter } from "../src/reporters/jsonl.js";

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

| Interface | V1 Implementation | Future |
|-----------|-------------------|--------|
| `Driver` | FakeDriver, LiveDriver | MCP driver, remote AKS driver |
| `Reporter` | Console, JSONL | Langfuse reporter, OTel exporter |
| Graders | Code-only (deterministic) | LLM-as-judge, trajectory scoring |
| Datasets | Static JSON | Synthetic generation, trace-to-dataset |
| Matrix | Single model | Model × context × compaction × reasoning |

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

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Constraint-based matching (not exact) | LLMs add harmless extra args; exact match → false failures |
| `subset` as default match mode | Most lenient useful mode; tighten per-case with `exact`/`setEquals` |
| Word-boundary response matching | Prevents `"hi"` matching `"this"` — substring matching is a footgun |
| Eval-owned system prompts | Each fixture controls its own prompt; not "compensating for product behavior" |
| FakeDriver for CI | Fast (< 1s total), free, deterministic — tests the harness, not the model |
| AbortSignal on Driver | Timeouts actually cancel work — no leaked LLM calls or orphaned resources |
| Async-ready Reporter | `void | Promise<void>` — Langfuse/OTel plug in without interface changes |
| Incremental JSONL writes | Crash mid-run → partial results preserved (not buffered-then-lost) |
| Specificity-ordered arg matching | Most-constrained expectations matched first → avoids greedy mis-pairing |
| Path-sanitized artifacts | `runId`/`caseId` stripped of separators → no path traversal |

## Relationship to Existing Tests

| Existing Tests (`packages/sdk/test/local/`) | Eval Harness (`packages/eval-harness/`) |
|---------------------------------------------|----------------------------------------|
| Assert **system** behavior (events fire, CMS persists, orchestration replays) | Measure **LLM** behavior (tool selection, arg accuracy, sequencing) |
| One run, hard fail | passRateFloor, statistical signal (multi-trial in V2) |
| vitest `describe`/`it` | Same runner, different semantics |
| Share: `withClient()`, PilotSwarm SDK, CMS helpers | Share: tool definitions pattern, test env isolation |
