# PilotSwarm Eval Harness

Scenario-driven evals for PilotSwarm agents and durable runtime behavior.

Use this package when you want repeatable checks for agent behavior, tool use,
durable waits, session recovery, safety prompts, prompt variants, and
model/run regressions.

## Fastest Path

From the repository root:

```bash
npm install
npm run build --workspace=pilotswarm-eval-harness
set -a; source .env; set +a
packages/eval-harness/bin/run-eval.sh --run=smoke --fake
packages/eval-harness/bin/run-eval.sh --run=smoke
packages/eval-harness/bin/run-eval.sh --run=all
```

From an installed downstream app:

```bash
npm install pilotswarm-eval-harness
npm exec run-eval -- --config=eval/runs/smoke/config.json
```

Default bundled runs are live. `--fake` is the explicit preflight path for
schema, manifest, plugin, check, and reporter validation without PostgreSQL, a
worker, or model credentials.

## Mental Model

The implemented hierarchy is:

```text
Run config -> manifest -> scenario config
```

- Run config owns driver/live-vs-fake, models, trials, concurrency, default isolation, reporters/output, budgets, LLMJudge provider/model/run prompt/default coverage, and `requirements.onUnsupported`.
- Manifest only selects scenario files and additively tags them. Non-tag behavior overrides are rejected.
- Scenario config owns prompts, turns, tools, checks, scenario requirements, prompt overrides, scenario timeouts, and scenario-specific judge rubrics/checks.

CLI flags override run config only. They never rewrite scenario config.

## What You Get

Each checked-in run writes a timestamped bundle under its configured
`output.reportsDir`, for example:

```text
.eval-results/smoke/20260518-143422-smoke/
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

Open `REPORT.md` first. It contains top-line totals, failure triage, the full
scenario index, budget summary, links to per-scenario drill-downs, and a short
reading guide. `run-config.json` contains the redacted effective config after
CLI run-level overrides, the CLI override summary, and counts for discovered
scenario definitions and execution cells.

Per-scenario `README.md` files include a dedicated `LLM Judge` section when a
judge check ran. The judge output is evidence-first: reason, evidence, issues,
categorical verdict, and confidence. No numeric score or pass threshold is used.
Bundled live configs set `llmJudge.applyTo: "all"`, so every scenario gets
judge coverage by default; explicit scenario `llm-judge` checks provide sharper
rubrics and are not duplicated.

## Common Commands

```bash
# Discover command options from this repo
packages/eval-harness/bin/run-eval.sh --help

# List registered agent names
packages/eval-harness/bin/run-eval.sh --list-agents

# Fast fake preflight over the bundled smoke run
packages/eval-harness/bin/run-eval.sh --run=smoke --fake

# Production live smoke run
set -a; source .env; set +a
packages/eval-harness/bin/run-eval.sh --run=smoke

# Production live sweep of every bundled scenario
packages/eval-harness/bin/run-eval.sh --run=all

# Run a downstream app config
npm exec run-eval -- --config=eval/runs/smoke/config.json

# Run a downstream app config with plugins
npm exec run-eval -- --config=eval/runs/smoke/config.json --require=eval/eval-plugins.js

# Override run-level reporters for a quick console-only preflight
packages/eval-harness/bin/run-eval.sh --run=smoke --fake --reporters=console

# Override the run-level report destination
packages/eval-harness/bin/run-eval.sh --run=smoke --fake --reports-dir=/tmp/pilotswarm-evals
```

`--run=<name>` resolves `runs/<name>/config.json` from the current directory
first. If it is not present, the CLI falls back to the bundled package runs.
Run names must be passed with `--run=<name>`; bare positional arguments are
rejected as CLI errors.

## Built-In Run Plans

| Run | Purpose | Default driver | Report path |
|---|---|---|---|
| `smoke` | Live smoke over representative scenarios. | `live` | `.eval-results/smoke` |
| `critical-path` | Live durable, safety, multi-turn, and agent-behavior gate. | `live` | `.eval-results/critical-path` |
| `all` | Every checked-in scenario through managed live PilotSwarm. | `live` | `.eval-results/all` |
| `nightly` | Larger live diagnostic run with meta scenarios. | `live` | `.eval-results/nightly` |
| `durable-cross-model` | Live durable model-classification plan. | `live` | `.eval-results/durable-cross-model` |
| `live-smoke` | Backward-compatible live smoke run. Prefer `smoke`. | `live` | `.eval-results/live-smoke` |
| `live-critical-path` | Managed live E2E gate over workload tools, CMS evidence, multi-turn memory, durable wait, safety, and LLMJudge. | `live` | `.eval-results/live-critical-path` |
| `live-all` | Compatibility live sweep over every checked-in scenario. Prefer `all`. | `live` | `.eval-results/live-all` |
| `live-e2e` | Backward-compatible alias for the managed live critical-path suite. Prefer `live-critical-path`. | `live` | `.eval-results/live-e2e` |
| `attach-live` | Diagnostic run against an already-running worker. Not the canonical CI/E2E gate. | `attach` | `.eval-results/attach-live` |

All bundled production plans emit `console`, `markdown`, and `jsonl` reporters
by default.

## Drivers

| Driver | Use it for | Notes |
|---|---|---|
| `live` | Managed PilotSwarm E2E execution. | The harness owns the worker pool, creates sessions, records CMS/tool evidence, and requires `DATABASE_URL`, `GITHUB_TOKEN`, and PostgreSQL. |
| `fake` | Explicit local validation via `--fake` or `--driver=fake`. | Deterministic, no infra or credentials required. |
| `scripted` | Plugin-defined deterministic observations. | Useful for app-specific test fixtures. |
| `chaos` | Reserved diagnostic driver. | Production chaos scenarios run through managed `live` so the harness can restart workers and collect CMS evidence. |
| `attach` | Client-driven diagnostic run against an already-running worker. | Useful for forensics against a manually started worker; not the canonical production E2E path. |
| `pilotswarm` | Legacy alias for `attach`. | Kept for old configs; prefer `attach`. |

## Add Your First Scenario

Create `eval/scenarios/incident-drain.scenario.json`:

```json
{
  "schemaVersion": 1,
  "kind": "durable-trajectory",
  "id": "incident.drain.wait-then-calculate",
  "description": "Incident runbook waits durably for the drain window before calculating affected checkout requests.",
  "tools": ["test_add"],
  "tags": ["smoke"],
  "input": {
    "prompt": "Follow the incident drain runbook: wait 2 seconds for the durable drain checkpoint, then use test_add to combine 6 checkout retries and 8 payment retries. Report the total affected requests."
  },
  "checks": [
    { "type": "tool-sequence", "order": "exactSequence", "calls": ["wait", "test_add"] },
    { "type": "cms-events-contain", "events": ["session.wait_started", "session.dehydrated", "session.hydrated", "session.wait_completed"] },
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

Create `eval/runs/smoke/scenarios.jsonl`:

```jsonl
{"schemaVersion":1}
{"include":"../../scenarios/**/*.scenario.json"}
```

Create `eval/runs/smoke/config.json`:

```json
{
  "schemaVersion": 1,
  "id": "smoke",
  "scenarios": "./scenarios.jsonl",
  "defaults": {
    "driver": "live",
    "models": ["gpt-5.4"],
    "trials": 1,
    "isolation": "shared-worker",
    "concurrent": 2,
    "timeoutMs": 900000
  },
  "reporters": ["console", "markdown", "jsonl"],
  "output": { "reportsDir": ".eval-results/smoke" }
}
```

Run it:

```bash
npm exec run-eval -- --config=eval/runs/smoke/config.json --fake
npm exec run-eval -- --config=eval/runs/smoke/config.json
```

## Docs Map

- [Quickstart](docs/QUICKSTART.md): first run, output layout, command matrix.
- [Schema](docs/SCHEMA.md): run configs, manifests, scenarios, checks, and result bundles.
- [Plugins](docs/PLUGINS.md): app tools, custom checks, drivers, reporters.
- [Downstream guide](docs/DOWNSTREAM-GUIDE.md): how to add evals to another app.
- [Troubleshooting](docs/TROUBLESHOOTING.md): common errors and fixes.

## Public API

The public API is exported from `pilotswarm-eval-harness`:

- `discoverScenarios`
- `runScenario`
- `runManifest`
- `evaluateCheck`
- `evaluateChecks`
- `runChecks`
- `registerScenarioKind`
- `registerCheckType`
- `registerTool`
- `registerDriver`
- `registerReporter`
