# Eval-Harness Schema

Schema version: `1`.

The implemented hierarchy is:

```text
Run config -> manifest -> scenario config
```

That order is about ownership, not override precedence:

| Layer | File | Owns |
|---|---|---|
| Run config | `runs/<plan>/config.json` | Run shape, cost, output, global model and judge policy. |
| Manifest | `*.scenarios.jsonl` | Which scenario files are included, excluded, or included through another manifest. |
| Scenario config | `*.scenario.json` or `*.scenarios.json` | The behavior being evaluated: prompts, turns, tools, checks, and scenario-only requirements. |

CLI flags override run config fields only; they never rewrite scenario config.
Manifest overrides may only add tags. Non-tag behavior overrides are rejected.

Run config owns driver/live-vs-fake, models, trials, concurrency, default isolation, reporters/output, budgets, LLMJudge provider/model/run prompt/default coverage, and requirements.onUnsupported.
Scenario config owns prompt, turn, check, and tool semantics, requirements.live, requirements.isolation, promptOverrides, runs.timeoutMs, runs.maxCells, and scenario-specific judge rubrics/checks.

Default bundled runs are live. `--fake` is the explicit preflight path for schema, manifest, plugin, check, and reporter validation without runtime services.

## Run Config

Run configs are JSON files, usually under `runs/<name>/config.json`.

```json
{
  "schemaVersion": 1,
  "id": "smoke",
  "description": "Production live smoke run over representative scenarios.",
  "scenarios": "./scenarios.jsonl",
  "defaults": {
    "driver": "live",
    "models": ["gpt-5.4"],
    "trials": 1,
    "isolation": "shared-worker",
    "concurrent": 2,
    "timeoutMs": 900000,
    "maxCells": 200
  },
  "filters": {
    "includeTags": ["smoke"],
    "excludeTags": []
  },
  "reporters": ["console", "markdown", "jsonl"],
  "requirements": {
    "onUnsupported": "error"
  },
  "llmJudge": {
    "enabled": true,
    "provider": "copilot",
    "judgeModel": "gpt-5.4",
    "prompt": "Prefer CMS/session evidence over final-response claims.",
    "applyTo": "all",
    "defaultCheck": {
      "rubric": "Evaluate whether the observed PilotSwarm execution satisfies the scenario description, deterministic checks, tool calls, CMS/session evidence, and terminal state.",
      "budgetUsd": 0.02
    },
    "totalBudgetUsd": 0.5,
    "onMissingProvider": "error"
  },
  "output": {
    "reportsDir": ".eval-results/smoke"
  }
}
```

Important fields:

| Field | Meaning |
|---|---|
| `id` | Run id, used in console output and timestamped result directory names. |
| `scenarios` | Manifest path relative to the config file. |
| `defaults.driver` | Run driver. Built-in production configs use `live`; `--fake` forces the run-level driver to `fake` for preflight. |
| `defaults.models` | Run-level model list. Managed live execution uses the first configured model unless an expanded meta-scenario cell supplies a model axis. If omitted, the harness does not pass a model override and PilotSwarm uses its configured default. |
| `defaults.trials` | Run-level trial count. Prompt-variant and ablation scenarios can define scenario-specific trial expansion. |
| `defaults.isolation` | Run default isolation: `shared-worker` or `fresh-worker`. Scenario `requirements.isolation` may require `fresh-worker`. |
| `defaults.concurrent` | Managed live worker count and max concurrent scenario execution for run-level live plans. |
| `defaults.timeoutMs` | Default per-turn wait timeout. Scenario `runs.timeoutMs` can raise or lower it for a specific scenario. |
| `defaults.maxCells` | Run guardrail for expanded prompt-variant and ablation cells. Scenario `runs.maxCells` can narrow or raise it for one meta scenario. |
| `filters.includeTags` | Run only scenarios with at least one matching tag. |
| `filters.excludeTags` | Drop scenarios with any matching tag. |
| `reporters` | Built-ins: `console`, `markdown`, `jsonl`. |
| `requirements.onUnsupported` | `error` or `skip` when a scenario requirement is unsupported by the chosen run driver. |
| `llmJudge.enabled` | Enables provider-backed LLM judging. When false, `llm-judge` checks use the deterministic local judge. |
| `llmJudge.provider` | Optional provider override: `copilot`, `github`, `github-copilot`, or `openai`. Bundled live configs use `copilot` so `gpt-5.x` judge models do not accidentally route to OpenAI when both credentials exist. |
| `llmJudge.judgeModel` | Run-level judge model. Keep model choice here for new scenarios. |
| `llmJudge.prompt` | Optional run-level judge instructions appended to the fixed harness context. |
| `llmJudge.applyTo` | `explicit` runs only scenario-authored `llm-judge` checks. `all` synthesizes a run-level judge check for every scenario that does not already define one. Bundled live configs use `all`. |
| `llmJudge.defaultCheck` | Rubric/budget/max-output defaults for synthesized run-level judge checks. Scenario-authored `llm-judge` checks still own scenario-specific rubrics. |
| `llmJudge.onMissingProvider` | `skip-with-warning` or `error` when no judge provider is configured. |
| `budgets.maxUsd` | Optional run-level budget guardrail. |
| `output.reportsDir` | Base directory for timestamped report bundles. |
| `worker` | Managed live worker options such as plugin directories, custom agents, skill directories, and management-agent disabling. |

The CLI run-level overrides are `--run`, `--driver`, `--fake`, `--reporters`,
and `--reports-dir`. They change the effective run config recorded in
`run-config.json`; they do not mutate scenario files or manifest entries.
The CLI does not accept positional run names; `run-eval smoke` exits with a CLI
error instead of defaulting to another bundled run.

`--fake` is a run-level preflight shortcut. It sets the effective driver to
`fake`, sets unsupported live requirements to skip, and disables provider-backed
LLM judge and post-run trajectory summaries for that invocation. Scenarios with
`llmJudgeRequired: true` still fail closed instead of using deterministic local
fallback.

## Manifest Directives

Every manifest starts with:

```jsonl
{"schemaVersion":1}
```

Then add one directive per line:

```jsonl
{"include":"../../scenarios/**/*.scenario.json"}
{"include":"../../scenarios/**/*.scenarios.json"}
{"path":"../../scenarios/durable/wait-then-act.scenario.json","overrides":{"tags":["smoke","critical-path"]}}
{"exclude":"../../scenarios/experimental/**/*.scenario.json"}
{"include-manifest":"../shared/scenarios.jsonl"}
```

Directives:

| Directive | Meaning |
|---|---|
| `path` | Include one scenario file. |
| `include` | Include all files matching a glob. |
| `exclude` | Remove files matching a glob from the current manifest result. |
| `include-manifest` | Recursively include another manifest. Include cycles are rejected. |
| `overrides.tags` | Add selection tags to a `path` scenario. Existing scenario tags are preserved. |

Manifest overrides may only set `tags`, and those tags are additive. Attempts
to set `driver`, `models`, `checks`, `runs`, `requirements`, `promptOverrides`,
or any other behavior field fail with `Manifest overrides may only set tags.`

## Scenario Kinds

| Kind | Use it for |
|---|---|
| `single-turn` | One user prompt plus scenario-level checks. |
| `multi-turn` | Ordered turns, each with input and optional checks. |
| `durable-trajectory` | Wait, worker restart, recovery evidence, dehydration/hydration, or long-running behavior. |
| `safety` | Prompt injection, forbidden tool use, secret/PII, and unsafe-output probes. |
| `prompt-variant` | Expand referenced scenarios across prompt overrides. In v1 this is diagnostic only. |
| `ablation` | Expand a base scenario across model and tool-set axes. In v1 this is diagnostic only. |

Batch files use a normal scenario kind plus `samples`. Each sample inherits
top-level `tools`, `tags`, `checks`, and `runs`, then extends or narrows the
sample-specific values.

Meta-scenario `gate` values other than `diagnostic` are reserved in v1, and
meta-scenario top-level `checks` are rejected. Put executable checks on the
base scenarios that the meta scenario expands.

## Production-Grade Scenario Example

```json
{
  "schemaVersion": 1,
  "kind": "durable-trajectory",
  "id": "incident.drain.wait-then-calculate",
  "description": "Incident runbook waits durably for the drain window before calculating affected checkout requests.",
  "agent": "default",
  "tools": ["test_add"],
  "tags": ["durable", "critical-path", "smoke"],
  "input": {
    "prompt": "Follow the incident drain runbook: wait 2 seconds for the durable drain checkpoint, then use test_add to combine 6 checkout retries and 8 payment retries. Report the total affected requests."
  },
  "requirements": {
    "live": true,
    "isolation": "fresh-worker"
  },
  "runs": {
    "timeoutMs": 240000
  },
  "checks": [
    { "type": "tool-sequence", "order": "exactSequence", "calls": ["wait", "test_add"] },
    { "type": "tool-call", "name": "test_add", "args": { "a": 6, "b": 8 }, "match": "subset" },
    { "type": "cms-events-contain", "events": ["session.wait_started", "session.dehydrated", "session.hydrated", "session.wait_completed"] },
    { "type": "cms-events-order", "before": "session.wait_started", "after": "session.wait_completed" },
    { "type": "response-contains", "any": ["14"] }
  ],
  "metadata": {
    "fake": {
      "finalResponse": "Completed. Drain checkpoint passed; total affected requests: 14.",
      "toolCalls": [
        { "name": "wait", "args": { "seconds": 2 }, "result": "completed" },
        { "name": "test_add", "args": { "a": 6, "b": 8 }, "result": 14 }
      ],
      "cmsEvents": [
        { "type": "session.wait_started" },
        { "type": "session.dehydrated" },
        { "type": "session.hydrated" },
        { "type": "session.wait_completed" }
      ]
    }
  }
}
```

## Common Scenario Fields

| Field | Required | Meaning |
|---|---:|---|
| `schemaVersion` | yes | Must be `1`. |
| `kind` | yes | Scenario kind. |
| `id` | yes | Stable id used in reports and result files. |
| `description` | yes | Human-readable purpose. |
| `agent` | no | Agent name. Defaults to `default`. |
| `tools` | no | App/eval tool names registered with the harness. Do not list native PilotSwarm tools such as `wait`, `spawn_agent`, `ask_user`, `check_agents`, or `delete_agent`; use checks to observe those calls. |
| `tags` | no | Scenario-owned tags used by run filters. Manifest tags are additive. |
| `input.prompt` | kind-specific | Prompt for `single-turn`, `durable-trajectory`, and `safety`. |
| `turns` | kind-specific | Ordered prompts and turn-local checks for `multi-turn`. |
| `checks` | no | Scenario-level checks. |
| `runs.timeoutMs` | no | Scenario-specific timeout. |
| `runs.maxCells` | no | Scenario-specific meta-scenario cell guardrail. |
| `requirements.live` | no | Requires a live driver. With `--fake`, the run either errors or skips according to `requirements.onUnsupported`. |
| `requirements.isolation` | no | `fresh-worker` when shared worker reuse is not acceptable. |
| `promptOverrides` | no | Scenario-level app-agent prompt overrides used by managed live execution and prompt-variant expansion. |
| `llmJudgeRequired` | no | Requires provider-backed `llm-judge` execution. The scenario fails if `llmJudge.enabled` is false or no judge provider is configured. |
| `metadata.fake` | no | Deterministic observation used by the fake driver. |

Scenario config never owns driver selection, default model list, global trial
count, reporters, output directory, or run budgets. Prompt-variant and ablation
scenario fields such as `models`, `trials`, and axes describe the scenario's
execution-cell expansion, not global run defaults.

## Managed Live Chaos

`chaos` is scenario-owned because it describes the behavior under evaluation,
but it executes through the managed `live` driver. The harness owns the worker
pool, injects the supported restart, starts a replacement worker on the same
store/schema, and records the chaos metadata in each scenario result.

Supported v1 live chaos:

- `type: "worker-restart"` with `injectAt: "after-tool-call-<n>"`.
- `type: "worker-restart"` with `injectAt: "during-wait"`.

`worker-crash`, `dehydrate-now`, `child-crash`, and `tool-timeout` remain
schema-reserved for future execution controllers. Do not include them in shipped
live gates until a real hard-crash/dehydration controller exists for the target
behavior. The standalone `chaos` driver is diagnostic only; production chaos
coverage should use run config `defaults.driver: "live"`.

## Prompt Overrides

`promptOverrides` is a map from app-creatable agent name to a prompt source,
inline prompt, or mutation:

```json
{
  "promptOverrides": {
    "incident-conductor": {
      "source": "./agents/incident-conductor.agent.md",
      "frontmatter": {
        "description": "Incident triage conductor"
      }
    },
    "resource-analyst": {
      "inline": "Focus on durable wait and CMS evidence before recommending action."
    }
  }
}
```

Exactly one of `source` or `inline` is required per entry. `mutation` can use
the built-in `minimize` or `remove-section` mutators. `frontmatter.tools` is
warning-only in schema version 1; use scenario `tools` or ablation `axes.toolSet`
for executable tool selection.

## Fake Metadata

Use `metadata.fake` when the fake driver's simple inference is not enough:

```json
{
  "metadata": {
    "fake": {
      "finalResponse": "Completed. Drain checkpoint passed; total affected requests: 14.",
      "toolCalls": [
        { "name": "wait", "args": { "seconds": 2 }, "result": "completed" },
        { "name": "test_add", "args": { "a": 6, "b": 8 }, "result": 14 }
      ],
      "cmsEvents": [
        { "type": "session.wait_started" },
        { "type": "session.dehydrated" },
        { "type": "session.hydrated" },
        { "type": "session.wait_completed" }
      ],
      "latencyMs": 25,
      "costUsd": 0,
      "terminalState": "completed"
    }
  }
}
```

## Check Types

| Family | Checks |
|---|---|
| Tool | `tool-call`, `tool-sequence`, `tool-call-count`, `forbidden-tools` |
| Response | `response-contains`, `response-not-contains`, `goal-completed` |
| CMS | `cms-state-in`, `cms-events-contain`, `cms-events-order`, `cms-event-count` |
| Safety | `no-secret-leak`, `no-pii-leak` |
| Performance | `latency-under`, `cost-under`, `tokens-under` |
| Judge | `llm-judge` |

Examples:

```json
{ "type": "tool-call", "name": "test_add", "args": { "a": 6, "b": 8 }, "match": "subset" }
```

```json
{ "type": "tool-sequence", "calls": ["wait", "test_add"], "order": "exactSequence" }
```

```json
{ "type": "response-contains", "all": ["Completed"], "any": ["14", "fourteen"] }
```

```json
{ "type": "cms-events-order", "before": "session.wait_started", "after": "session.wait_completed" }
```

## LLM Judge

`llm-judge` is a categorical quality check. In short: fixed PilotSwarm harness prefix/system context remains stable; run config can add global judge instructions and default coverage; scenario checks can add rubric/check-specific guidance.

Bundled production configs set `llmJudge.applyTo: "all"`, so every execution
cell gets provider-backed LLMJudge coverage by default. Scenarios with their own
`llm-judge` check keep that explicit rubric and are not double-judged. Set
`llmJudge.applyTo: "explicit"` for a cheaper run that only judges scenarios
with explicit judge checks. `--fake` disables provider-backed judge coverage for
that invocation.

The judge is prompted to write reason, evidence, and issues before verdict and confidence:

```json
{
  "reason": "Two to five concise sentences based on the observed trace.",
  "evidence": ["Concrete observed fact supporting the verdict."],
  "issues": ["Concrete missing, ambiguous, or incorrect behavior."],
  "verdict": "PASSED",
  "confidence": "HIGH"
}
```

No numeric score or pass threshold exists. `PASSED` is the only passing verdict.
`PARTIAL` and `FAILED` both fail the production gate, but `PARTIAL` is reported
distinctly in the per-scenario `LLM Judge` section. Check-level `budgetUsd` is
an optional cost guardrail/reservation, not a grading score. When run-level
budget guardrails are configured for provider-backed judging, each `llm-judge`
check must declare `budgetUsd`; synthesized checks use
`llmJudge.defaultCheck.budgetUsd`.

When a scenario sets `llmJudgeRequired: true`, deterministic local fallback and
missing-provider skips are disabled. That scenario must run with provider-backed
judging or fail loudly.

Custom checks can be registered by plugin files with
`registerCheckType(name, { schema, evaluate })`.

## Discovery Versus Execution Cells

`discoverScenarios()` returns discovered scenario definitions. Most scenario
definitions execute as one result cell. `prompt-variant` and `ablation`
definitions expand into execution cells after discovery.

The result configuration records both discovered scenario definitions and
execution cells so reports can explain why a single meta scenario produced
multiple results. Example cell ids look like:

```text
meta.model-sweep::model=gpt-5.4::trial=1
```

## Report Layout

`output.reportsDir` is the base directory. File reporters write one timestamped
bundle below it:

```text
.eval-results/smoke/
  20260518-143422-smoke/
    REPORT.md
    README.md
    summary.json
    run-config.json
    machine/results.jsonl
    scenarios/<scenario-id>/README.md
    scenarios/<scenario-id>/result.json
    scenarios/<scenario-id>/timeline.md
    scenarios/<scenario-id>/transcript.md
    scenarios/<scenario-id>/cms-events.json
    scenarios/<scenario-id>/tool-calls.json
    scenarios/<scenario-id>/agent-sessions.json
```

`run-config.json` contains the redacted effective config after CLI run-level
overrides, the CLI override summary, and counts for discovered scenario
definitions and execution cells. `summary.json` is the compact run summary.
`machine/results.jsonl` has one redacted row per result cell. Per-scenario
files preserve observed CMS events, tool calls, transcript data, and LLM judge
metadata with provider payloads and credential-like fields redacted.

## Path Rules

| Path | Resolves from |
|---|---|
| CLI `--config` | Current working directory. |
| CLI `--manifest` | Current working directory. |
| CLI `--scenarios` | Current working directory. |
| CLI `--require` | Current working directory. |
| `config.scenarios` | Directory containing the config file. |
| `config.worker.pluginDirs` | Directory containing the config file. |
| `config.worker.skillDirectories` | Directory containing the config file. |
| Manifest directives | Directory containing the manifest file. |
| `output.reportsDir` | Current working directory unless overridden by `--reports-dir`. |

## Semantic Validation Notes

The schema accepts the JSON shape first, then semantic validation catches
currently unsupported combinations:

- `systemMessage.mode=replace` is reserved for a later version.
- `chaos` is only valid with `durable-trajectory`.
- `safety` scenarios cannot include `chaos`.
- Native PilotSwarm tools are not scenario-owned `tools`; register app/eval tools through plugins.
- `promptOverrides.<agent>.frontmatter.tools` is warning-only in v1; use `axes.toolSet` ablation or scenario `tools`.
- Meta-scenario top-level `checks` are reserved in v1.
- Meta-scenario gates other than `diagnostic` are reserved in v1.
- Prompt-variant baselines must reference a declared variant id.
- Prompt-variant `appliesTo` and ablation `baseScenario` cannot target another meta scenario.
- Ablation prompt axes use `<prompt-variant-id>.<variant-id>` format, but prompt-axis execution is not supported yet.
