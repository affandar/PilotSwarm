# Downstream Guide

This guide shows how to add app-local evals to a repository that consumes
PilotSwarm.

Default bundled runs are live. App run configs should also default to live when
they are meant to gate production behavior. `--fake` is the explicit preflight
path for validating scenario shape, manifests, plugins, checks, reporters, and
result-bundle generation without runtime services.

## Install

```bash
npm install pilotswarm-eval-harness
```

## Recommended Layout

```text
eval/
  eval-plugins.js
  scenarios/
    incident-triage.scenario.json
  runs/
    smoke/
      config.json
      scenarios.jsonl
```

Keep eval files close to the app they verify. Run commands from the app root so
relative paths and `.eval-results` are predictable.

## Ownership Rules

The implemented hierarchy is:

```text
Run config -> manifest -> scenario config
```

- Run config owns driver/live-vs-fake, models, trials, concurrency, default isolation, reporters/output, budgets, LLMJudge provider/model/run prompt/default coverage, and `requirements.onUnsupported`.
- Manifest entries select scenario files and may add tags. Non-tag behavior overrides are rejected.
- Scenario config owns prompts, turns, tools, checks, `requirements.live`, `requirements.isolation`, `promptOverrides`, `runs.timeoutMs`, `runs.maxCells`, and scenario-specific judge rubrics/checks.

CLI flags override run config only. Keep run-level concerns out of scenario
files and keep behavior semantics out of manifests.

## Plugin

`eval/eval-plugins.js` registers app-specific tools and checks:

```js
import { z } from "zod";
import { registerCheckType, registerTool } from "pilotswarm-eval-harness";

registerTool({
  name: "incident_lookup",
  description: "Look up an incident by id.",
  handler: async ({ id }) => ({ id, severity: "sev2", owner: "checkout" })
});

registerCheckType("incident-owner-present", {
  schema: z.object({
    type: z.literal("incident-owner-present")
  }),
  evaluate: ({ observed }) => ({
    pass: /checkout|owner/i.test(observed.finalResponse),
    message: "final response should identify the owning team"
  })
});
```

Use plugins for app-specific executable behavior. Keep scenario files JSON-only.

## Scenario

`eval/scenarios/incident-triage.scenario.json`:

```json
{
  "schemaVersion": 1,
  "kind": "durable-trajectory",
  "id": "incident.triage.drain-window",
  "description": "Incident runbook waits durably for the drain window before assigning checkout ownership.",
  "agent": "incident-conductor",
  "tools": ["incident_lookup"],
  "tags": ["smoke", "critical-path"],
  "input": {
    "prompt": "Incident INC-123 has checkout errors. Wait 2 seconds for the drain checkpoint, look up the incident, and identify the owning team."
  },
  "requirements": {
    "live": true,
    "isolation": "fresh-worker"
  },
  "runs": {
    "timeoutMs": 240000
  },
  "checks": [
    { "type": "tool-sequence", "order": "subsequence", "calls": ["wait", "incident_lookup"] },
    { "type": "tool-call", "name": "incident_lookup", "args": { "id": "INC-123" }, "match": "subset" },
    { "type": "cms-events-contain", "events": ["session.wait_started", "session.hydrated", "session.wait_completed"] },
    { "type": "incident-owner-present" },
    {
      "type": "llm-judge",
      "rubric": "Pass only if the trace shows durable wait evidence and the final response names checkout as the owner.",
      "budgetUsd": 0.05
    }
  ],
  "metadata": {
    "fake": {
      "toolCalls": [
        { "name": "wait", "args": { "seconds": 2 }, "result": "completed" },
        { "name": "incident_lookup", "args": { "id": "INC-123" }, "result": { "owner": "checkout" } }
      ],
      "cmsEvents": [
        { "type": "session.wait_started" },
        { "type": "session.hydrated" },
        { "type": "session.wait_completed" }
      ],
      "finalResponse": "Complete. Drain checkpoint passed. Owner: checkout."
    }
  }
}
```

`metadata.fake` makes local and CI shape checks deterministic. Without it, the
fake driver uses simple prompt/tool inference.

## Run Plan

`eval/runs/smoke/config.json`:

```json
{
  "schemaVersion": 1,
  "id": "smoke",
  "description": "App-local live smoke run.",
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
    "includeTags": ["smoke"]
  },
  "requirements": {
    "onUnsupported": "error"
  },
  "reporters": ["console", "markdown", "jsonl"],
  "llmJudge": {
    "enabled": true,
    "provider": "copilot",
    "judgeModel": "gpt-5.4",
    "prompt": "Use CMS/session event evidence before trusting final-response claims.",
    "applyTo": "all",
    "defaultCheck": {
      "rubric": "Evaluate whether the observed PilotSwarm execution satisfies the scenario description, deterministic checks, tool calls, CMS/session evidence, and terminal state.",
      "budgetUsd": 0.02
    },
    "totalBudgetUsd": 0.5,
    "onMissingProvider": "error"
  },
  "output": { "reportsDir": ".eval-results/smoke" }
}
```

`eval/runs/smoke/scenarios.jsonl`:

```jsonl
{"schemaVersion":1}
{"include":"../../scenarios/**/*.scenario.json"}
{"include":"../../scenarios/**/*.scenarios.json"}
```

Manifest paths are relative to the manifest file. The `scenarios` path in
`config.json` is relative to the config file. Manifest `overrides` may add tags
only:

```jsonl
{"path":"../../scenarios/incident-triage.scenario.json","overrides":{"tags":["smoke"]}}
```

Do not put run-level behavior in the manifest. Overrides such as `driver`,
`models`, `runs`, `requirements`, `checks`, or `promptOverrides` are rejected.

## Run

From the app root:

```bash
npm exec run-eval -- --config=eval/runs/smoke/config.json --fake --require=eval/eval-plugins.js
npm exec run-eval -- --config=eval/runs/smoke/config.json --require=eval/eval-plugins.js
```

Expected console shape:

```text
schema validation passed: 1 discovered scenario definition(s)
- incident.triage.drain-window
execution cells: 1
result: 1 passed, 0 failed, 0 infra errors, 0 skipped
```

Open:

```text
.eval-results/smoke/<timestamp-smoke>/REPORT.md
```

For judge-backed scenarios, open the per-scenario `README.md` linked from the
report. Its `LLM Judge` section shows reason, evidence, issues, verdict, and
confidence. No numeric score or pass threshold is used.

## Result Bundle

The file reporters write:

```text
.eval-results/smoke/<timestamp-smoke>/
  REPORT.md
  summary.json
  run-config.json
  machine/results.jsonl
  scenarios/<scenario-id>/README.md
  scenarios/<scenario-id>/result.json
```

`run-config.json` records the redacted effective config after CLI run-level
overrides, plus discovered scenario definitions and execution cells counts.
Use it when reviewing exactly what the CLI ran.

## CI Gate

Use the live driver for production CI. Use `--fake` for the fast preflight job:

```bash
npm exec run-eval -- --config=eval/runs/smoke/config.json --fake --require=eval/eval-plugins.js
npm exec run-eval -- --config=eval/runs/smoke/config.json --require=eval/eval-plugins.js
```

Exit codes are CI-friendly:

| Code | Meaning |
|---:|---|
| 0 | All checks passed. |
| 1 | Quality failure. Scenarios ran, but checks failed. |
| 2 | Config/schema/plugin/CLI error. |
| 3 | Infrastructure error. |

## Growing The Suite

Recommended progression:

1. Start with `single-turn` or `durable-trajectory` scenarios and fake observations.
2. Add `multi-turn` scenarios for conversation memory and sequencing.
3. Add `safety` scenarios for prompt injection, forbidden tools, and output safety.
4. Add app-specific checks once built-in checks become too generic.
5. Add prompt-variant and ablation scenarios after the base suite is stable.
6. Split run plans by cost and confidence: `smoke`, `critical-path`, `nightly`.

## Common Failures

- Unknown tool: register it in `eval-plugins.js` or remove it from `tools`.
- Unknown check type: register it with `registerCheckType`.
- Unknown reporter: use `console`, `markdown`, `jsonl`, or register a reporter.
- Empty scenario discovery: check manifest include paths relative to `scenarios.jsonl`.
- Manifest behavior override rejected: keep only `overrides.tags` in manifests.
- Failing fake smoke: add or fix `metadata.fake`.
- No report files: include `markdown` or `jsonl` in `reporters`.

See `TROUBLESHOOTING.md` for the longer failure guide.
