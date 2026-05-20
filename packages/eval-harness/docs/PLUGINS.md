# Eval-Harness Plugins

Plugins are JavaScript modules loaded before scenario discovery:

```bash
npm exec run-eval -- --config=eval/runs/smoke/config.json --require=eval/eval-plugins.js
```

Use plugins when a downstream app needs app-specific tools, checks, drivers,
reporters, or scenario kinds without forking the harness.

## Plugin Rules

- Plugins are normal ESM modules.
- Relative `--require` paths resolve from the current working directory.
- Load plugins before scenarios that reference their tools, checks, drivers, reporters, or custom scenario kinds.
- Keep scenario files JSON-only; put executable logic in plugins.
- Registration is process-local for one CLI invocation.
- Plugins extend behavior, but they do not change the hierarchy: Run config -> manifest -> scenario config.

## Register A Tool

```js
import { z } from "zod";
import { registerTool } from "pilotswarm-eval-harness";

registerTool({
  name: "incident_lookup",
  description: "Look up an incident by id.",
  schema: z.object({
    id: z.string()
  }),
  handler: async ({ id }) => ({ id, severity: "sev2", owner: "checkout" })
});
```

Scenarios reference tools by name:

```json
{
  "tools": ["incident_lookup"],
  "checks": [
    { "type": "tool-call", "name": "incident_lookup", "args": { "id": "INC-123" }, "match": "subset" }
  ]
}
```

Tool selection is scenario-owned. Do not select tools from run configs or
manifest behavior overrides.

## Register A Check

```js
import { z } from "zod";
import { registerCheckType } from "pilotswarm-eval-harness";

registerCheckType("incident-owner-present", {
  schema: z.object({
    type: z.literal("incident-owner-present")
  }),
  evaluate: ({ observed }) => ({
    pass: /owner|checkout/i.test(observed.finalResponse),
    message: "final response should mention an owning team"
  })
});
```

The evaluator receives:

| Field | Meaning |
|---|---|
| `scenario` | Parsed scenario object. |
| `observed` | Driver output: final response, tool calls, CMS events, tokens, cost, latency. |
| `config` | Parsed check config for this check. |
| `runConfig` | Effective run config after CLI run-level overrides. |

Thrown check errors are converted into errored failed check results, so bad
check code is visible in `REPORT.md` and `result.json`.

## Register A Driver

Drivers produce the observed result that checks evaluate. The driver is selected
by run config or a CLI run-level override, never by scenario config or manifest
behavior overrides.

```js
import { registerDriver } from "pilotswarm-eval-harness";

registerDriver("fixture", {
  factory: () => ({
    async run(scenario) {
      return {
        scenarioId: scenario.id,
        finalResponse: "Complete. Owner: checkout.",
        toolCalls: [
          { name: "incident_lookup", args: { id: "INC-123" }, result: { owner: "checkout" } }
        ],
        cmsEvents: [
          { type: "session.turn_started" },
          { type: "session.turn_completed" }
        ],
        latencyMs: 1,
        costUsd: 0,
        tokensIn: 1,
        tokensOut: 4,
        terminalState: "completed",
        errored: false,
        metadata: { driver: "fixture" }
      };
    }
  })
});
```

Run it:

```bash
npm exec run-eval -- --config=eval/runs/smoke/config.json --driver=fixture --require=eval/eval-plugins.js
```

`--driver=fixture` is a run-level override. It is recorded in
`run-config.json` with the effective config after CLI run-level overrides.

## Register A Reporter

Reporters consume the full run result.

```js
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerReporter } from "pilotswarm-eval-harness";

registerReporter("summary-json", {
  async emit(result, options) {
    const runDir = options.runOutputDir ?? options.reportsDir ?? ".eval-results";
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "custom-summary.json"), JSON.stringify({
      runId: result.runId,
      passed: result.passed,
      failed: result.failed,
      infraErrors: result.infraErrors,
      discoveredScenarioDefinitions: result.configuration.discoveredScenarioCount,
      executionCells: result.configuration.executionCellCount
    }, null, 2));
  }
});
```

Reporter names in config are validated before scenarios run. `options.reportsDir`
is the configured base directory; `options.runOutputDir` is the timestamped
directory shared by file reporters for the current run.

## Register A Scenario Kind

Most apps should use the built-in scenario kinds. Register a scenario kind only
when the app has a stable custom eval shape.

```js
import { z } from "zod";
import { registerScenarioKind } from "pilotswarm-eval-harness";

registerScenarioKind("incident-table", {
  requiresSchemaVersion: 1,
  schema: z.object({
    schemaVersion: z.literal(1),
    kind: z.literal("incident-table"),
    id: z.string(),
    description: z.string(),
    cases: z.array(z.object({ id: z.string(), prompt: z.string() }))
  })
});
```

Custom scenario kinds still need a driver/check strategy that knows how to
interpret them. Keep run-level defaults in run configs and behavior semantics
inside the scenario kind.

## Manifest And Path Rules

| Path | Resolves from |
|---|---|
| `--require=eval/eval-plugins.js` | Current working directory. |
| `--config=eval/runs/smoke/config.json` | Current working directory. |
| `config.scenarios` | Directory containing the config file. |
| Manifest `include`, `exclude`, `path`, `include-manifest` | Directory containing the manifest file. |
| `output.reportsDir` | Current working directory unless overridden by `--reports-dir`. |

Manifest overrides may only add tags:

```jsonl
{"path":"../../scenarios/incident-triage.scenario.json","overrides":{"tags":["smoke"]}}
```

Non-tag behavior overrides are rejected. Put driver, models, reporters,
budgets, and LLMJudge provider/model/run prompt/default coverage in run config.
Put prompts, tools, turns, checks, requirements, prompt overrides, and scenario
judge rubrics in scenario config.

## Agents

Agents are PilotSwarm primitives. In schema version 1, `promptOverrides` target
app-creatable agents. Built-in default/system prompt override support is
deferred.
