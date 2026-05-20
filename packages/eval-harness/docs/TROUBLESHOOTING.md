# Eval Harness Troubleshooting

Start with the exit code and the first error line. The harness fails early for
config/schema problems and reports quality failures separately from infra
failures.

## Exit Code 2: Config, Schema, Or CLI Error

### Unknown option

Run:

```bash
packages/eval-harness/bin/run-eval.sh --help
```

The CLI only accepts `--key=value` flags for path-like options:

```bash
packages/eval-harness/bin/run-eval.sh --config=packages/eval-harness/runs/smoke/config.json
```

### No configPath, manifestPath, or scenariosPath provided

Use one of:

```bash
packages/eval-harness/bin/run-eval.sh --run=smoke
packages/eval-harness/bin/run-eval.sh --config=packages/eval-harness/runs/smoke/config.json
packages/eval-harness/bin/run-eval.sh --manifest=packages/eval-harness/runs/smoke/scenarios.jsonl
packages/eval-harness/bin/run-eval.sh --scenarios='packages/eval-harness/scenarios/**/*.scenario.json'
```

### Config does not declare scenarios

Add a `scenarios` field to the run config:

```json
{
  "schemaVersion": 1,
  "id": "smoke",
  "scenarios": "./scenarios.jsonl"
}
```

Paths inside a config are resolved relative to the config file. Paths inside a
manifest are resolved relative to the manifest file.

### Manifest first line is wrong

Every `.scenarios.jsonl` manifest must begin with:

```jsonl
{"schemaVersion":1}
```

Then add one directive per line:

```jsonl
{"include":"../../scenarios/**/*.scenario.json"}
{"include":"../../scenarios/**/*.scenarios.json"}
```

### Manifest overrides may only set tags

Manifests select scenario files and add selection tags only:

```jsonl
{"path":"../../scenarios/incident-triage.scenario.json","overrides":{"tags":["smoke"]}}
```

Non-tag behavior overrides are rejected. Move driver/live-vs-fake, models,
trials, concurrency, reporters, output, budgets, and LLMJudge provider/model/run
prompt/default coverage into the run config. Move prompts, turns, tools,
checks, requirements, prompt overrides, timeouts, max cells, and scenario judge
rubrics into scenario config.

### Unknown reporter

Built-in reporters are:

- `console`
- `markdown`
- `jsonl`

Custom reporters must be registered by a plugin loaded with `--require`.

### Unknown tool

Either remove the tool name from the scenario or register it in a plugin:

```js
import { registerTool } from "pilotswarm-eval-harness";

registerTool({
  name: "incident_lookup",
  handler: async ({ id }) => ({ id, status: "open" })
});
```

Run with:

```bash
npm exec run-eval -- --config=eval/runs/smoke/config.json --require=eval/eval-plugins.js
```

### Live-required scenario skipped or rejected under fake

Scenario `requirements.live` says the scenario needs a live driver. `--fake`
sets the run-level driver to `fake`; the result follows
`requirements.onUnsupported` from run config:

- `error`: fail the scenario as unsupported.
- `skip`: mark the scenario skipped.

`--fake` is the explicit preflight path. Use it for shape and report checks, not
as a replacement for live durable behavior.

## Exit Code 1: Quality Failure

The run executed, but one or more checks failed. Open the newest `REPORT.md`,
then read the Failure Triage section.

For one scenario, open:

```text
.eval-results/<run>/<timestamp-run>/scenarios/<scenario-id>/README.md
```

That page shows:

- pass/fail status
- first failure message
- all check messages
- final response
- tool call count
- CMS event count
- LLM Judge reason, evidence, issues, verdict, and confidence when present
- link to `result.json`

Common fixes:

- Check expects the wrong phrase: update `response-contains` or the scenario prompt.
- Tool args do not match: use `match: "subset"` unless exact deep equality is needed.
- Fake driver inferred the wrong observation: add `metadata.fake` to the scenario.
- The scenario should not be in this run: adjust scenario tags, manifest includes, or manifest additive tags.
- Durable evidence is missing: inspect `timeline.md`, `cms-events.json`, and `agent-sessions.json`.

## Exit Code 3: Infrastructure Error

Infra errors mean the driver or environment failed independently of check
quality.

Default bundled runs are live. The `live` driver starts a managed PilotSwarm
worker pool and needs the same environment as PilotSwarm integration tests:
`DATABASE_URL`, `GITHUB_TOKEN`, and a reachable PostgreSQL database. Use
`--run=smoke` for the smallest live bundle and `--run=all` to sweep every
checked-in scenario instance live.

The explicit frictionless path is `--fake`:

```bash
packages/eval-harness/bin/run-eval.sh --run=smoke --fake
```

The `attach` driver does not start a worker. It creates client sessions against
the database and expects a real worker to already be polling. This is for
diagnostics, not the canonical E2E gate:

```bash
node --env-file=.env packages/sdk/examples/worker.js
packages/eval-harness/bin/run-eval.sh --run=attach-live
```

Chaos scenarios should also run through managed `live`, not the standalone
`chaos` driver. The managed runner supports worker restart injection at
`after-tool-call-<n>` and `during-wait`, then starts a replacement worker on the
same store/schema so CMS evidence can show dehydration/hydration or recovery.
If a scenario uses a reserved chaos type such as `worker-crash`,
`dehydrate-now`, `child-crash`, or `tool-timeout`, the managed runner fails
clearly instead of pretending that hard crash recovery was exercised.

If a live run hangs, inspect the active session in CMS. The per-scenario
`result.json` includes CMS event types, tool calls derived from
`tool.execution_start`, and structured LLMJudge output. The per-scenario
`README.md` renders the judge output as a separate `LLM Judge` section with
reason, evidence, issues, verdict, and confidence.

## Stale Dist During Development

`bin/run-eval.sh` uses compiled `dist/bin/run-eval.js` when it is present and
fresh. If `bin/run-eval.ts` is newer, the wrapper falls back to TypeScript
directly. To force a clean compiled run:

```bash
npm run build --workspace=pilotswarm-eval-harness
```

## No Report Files Were Written

Check the configured reporters. `console` prints only to stdout. File output
requires `markdown` or `jsonl`:

```json
{
  "reporters": ["console", "markdown", "jsonl"],
  "output": { "reportsDir": ".eval-results/smoke" }
}
```

`--reporters=console` intentionally suppresses file reporters.

## Report Path Is Not Where You Expected

`output.reportsDir` is resolved from the current working directory. For
downstream apps, run from the app root so `.eval-results/...` lands beside your
app eval directory.

For an explicit destination:

```bash
npm exec run-eval -- --config=eval/runs/smoke/config.json --reports-dir=/tmp/eval-results
```

## What Was Actually Run?

Open `run-config.json` in the timestamped bundle. It contains the redacted
effective config after CLI run-level overrides, the CLI override summary, and
the discovered scenario definitions versus execution cells counts.

Use it to answer:

- Did `--fake`, `--driver`, `--reporters`, or `--reports-dir` apply?
- Which run config path was used?
- How many scenario definitions were discovered?
- How many execution cells were produced after prompt-variant or ablation expansion?
