# Eval-Harness Schema

Schema version: `1`.

v0 documents the minimal live path used by the bundled JSON scenarios.
`live-all` runs the full bundled v0 corpus. Meta scenarios, prompt variants,
ablations, model sweeps, sample expansion, post-run trajectory summaries, and
expanded reporters are deferred.

## Ownership

```text
Run config -> manifest -> scenario config
```

| Layer | Owns |
|---|---|
| Run config | Driver, isolation, concurrency, timeout, reporters, output, and judge policy. |
| Manifest | Scenario file selection. |
| Scenario config | Prompt, tools, checks, scenario timeout, and chaos injection. |

CLI flags override run config fields. They do not rewrite scenarios. Choose one
scenario selector per CLI invocation: `--run`, `--config`, `--manifest`, or
`--scenarios`.

## Run Config

```json
{
  "schemaVersion": 1,
  "id": "live-smoke",
  "description": "Minimal opt-in live PilotSwarm worker/client smoke.",
  "scenarios": "./scenarios.jsonl",
  "defaults": {
    "driver": "live",
    "isolation": "fresh-worker",
    "concurrent": 1,
    "timeoutMs": 180000
  },
  "reporters": ["console"],
  "output": {
    "reportsDir": ".eval-results/live-smoke"
  }
}
```

Important fields:

| Field | Meaning |
|---|---|
| `id` | Run id shown in output. |
| `scenarios` | Manifest path relative to the config file. |
| `defaults.driver` | Bundled v0 runs use `live`. |
| `defaults.isolation` | `shared-worker` or `fresh-worker`. |
| `defaults.concurrent` | Max concurrent live scenarios. |
| `defaults.timeoutMs` | Default scenario timeout. |
| `reporters` | v0 bundles `console`. |
| `llmJudge` | Optional provider-backed judge settings. |
| `output.reportsDir` | Directory passed to reporters that write files. The bundled `console` reporter does not write files. |

## Manifest

Every manifest starts with:

```jsonl
{"schemaVersion":1}
```

Then include explicit files or globs:

```jsonl
{"include":"../../scenarios/live/e2e-runtime-basic.scenario.json"}
{"include":"../../scenarios/durable/wait-then-act.scenario.json"}
{"include":"../../scenarios/safety/*.scenario.json"}
```

## Scenario

```json
{
  "schemaVersion": 1,
  "kind": "durable-trajectory",
  "id": "wait.then-act",
  "description": "Wait durably, then act.",
  "agent": "default",
  "tools": ["test_add"],
  "tags": ["durable", "critical-path"],
  "input": {
    "prompt": "Wait 2 seconds, then use test_add to combine 6 and 8."
  },
  "checks": [
    { "type": "tool-sequence", "order": "strict", "calls": ["wait", "test_add"] },
    { "type": "response-contains", "any": ["14"] }
  ],
  "runs": { "timeoutMs": 240000 }
}
```

Bundled v0 scenario kinds:

| Kind | Use |
|---|---|
| `single-turn` | One prompt and scenario-level checks. |
| `multi-turn` | Multiple client turns in one session, with turn-local checks allowed. |
| `durable-trajectory` | Waits, dehydration/hydration evidence, or worker restart recovery. |
| `safety` | Concise safety probe. |

For `multi-turn`, use `turns` instead of `input`:

```json
{
  "schemaVersion": 1,
  "kind": "multi-turn",
  "id": "multi-turn.context-retention",
  "description": "Remember a region, then persist it as a durable fact.",
  "tools": [],
  "turns": [
    {
      "input": { "prompt": "Remember that the checkout region is Osaka." },
      "checks": [{ "type": "response-contains", "any": ["Osaka"] }]
    },
    {
      "input": { "prompt": "Call store_fact with key incident-region and the remembered region." },
      "checks": [{ "type": "tool-call", "name": "store_fact", "args": { "key": "incident-region" }, "match": "subset" }]
    }
  ],
  "checks": [{ "type": "cms-state-in", "states": ["idle", "completed"] }]
}
```

## Checks Used By The Bundled Corpus

| Check | Purpose |
|---|---|
| `response-contains` | Assert required text in the final response. |
| `response-not-contains` | Assert forbidden text is absent. |
| `tool-call` | Assert a named tool was called, optionally with matching args. |
| `tool-sequence` | Assert ordered tool calls. |
| `tool-call-count` | Assert total or per-tool call counts. |
| `forbidden-tools` | Assert unsafe tools were not used. |
| `cms-events-contain` | Assert required CMS events were recorded. |
| `cms-events-order` | Assert relative CMS event order. |
| `cms-event-count` | Assert an event count range. |
| `cms-state-in` | Assert terminal CMS state. |
| `no-secret-leak` | Assert the response did not expose secrets. |
| `no-pii-leak` | Assert the response did not expose PII-like strings. |
| `llm-judge` | Ask a provider-backed judge for evidence-first grading. |
| `latency-under` | Assert observed scenario latency stayed under a threshold. |

`tool-sequence` orders:

| Order | Meaning |
|---|---|
| `exactSequence` | Scenario-relevant tool calls must exactly match. |
| `strict` | The first scenario-relevant calls must match; later repeated calls are allowed. |
| `subsequence` | Calls must appear in order, with unrelated scenario-relevant calls allowed between. |
| `unordered` | All named calls must appear, including duplicates, order does not matter. |

The live driver filters internal PilotSwarm management tools such as
`report_intent`, `store_fact`, `read_facts`, and `update_session_summary` out of
scenario tool checks. Scenario checks should focus on workload tools.

## Fixture Tools

The bundled corpus registers deterministic test tools:

| Tool | Parameters | Result |
|---|---|---|
| `test_add` | `{ "a": number, "b": number }` | `a + b` |
| `test_untrusted_status` | `{ "city": string }` | Status plus an untrusted instruction-like note. |

Downstream apps should register app-specific tools in a plugin and load it with
`--require`.

## LLM Judge

Set `llmJudge.enabled` in the run config and add an explicit scenario check:

```json
{
  "type": "llm-judge",
  "rubric": "Pass only when the tool result and final response satisfy the incident task.",
  "budgetUsd": 0.05,
  "judgeModel": "gpt-5.4",
  "maxOutputTokens": 512
}
```

The default `llmJudge.applyTo` is `explicit`. Keep it that way for v0. Applying
judge checks to every scenario is slower, more expensive, and easier to make
noisy than deterministic checks.

Provider-backed judge prompts include the observed response, tool calls, CMS
events, and run metadata after secret-shaped values are redacted and large text
or arrays are bounded.

## Authoring Conventions

- Use one scenario per `.scenario.json` file.
- Keep scenario ids stable and descriptive: `<group>.<behavior>.<case>`.
- Start with deterministic checks; add LLM judge only for qualitative evidence.
- For durable waits, assert `session.wait_started`, `session.dehydrated`,
  `session.hydrated`, and `session.wait_completed`.
- For safety probes, assert forbidden output and leak checks, not exact refusal
  wording.
- Keep prompts explicit about required tool usage when the check expects a tool.
- Do not add new schema features for a scenario that can be expressed with
  existing JSON fields.
- Add new complexity only behind a documented need, tests, and a narrow PR.

## Chaos

The kept worker-restart scenario uses:

```json
"chaos": {
  "injectAt": "during-wait",
  "type": "worker-restart",
  "onTargetMissing": "error"
}
```

v0 keeps this only for the live critical path. Broader chaos matrices are
deferred.
