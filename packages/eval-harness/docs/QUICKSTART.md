# Eval Harness Quickstart

This page is the fastest path from clone to a readable eval report.

## 1. Install And Build

From the PilotSwarm repo root:

```bash
npm install
npm run build --workspace=pilotswarm-eval-harness
```

The wrapper can run directly from TypeScript during development, but building
once verifies the package surface and keeps `dist/` current.

## 2. Run The Smoke Evals

Run the fake preflight first:

```bash
packages/eval-harness/bin/run-eval.sh --run=smoke --fake
```

Then run the live smoke plan:

```bash
set -a; source .env; set +a
packages/eval-harness/bin/run-eval.sh --run=smoke
```

For the full bundled suite:

```bash
packages/eval-harness/bin/run-eval.sh --run=all
```

Default bundled runs are live. `--fake` is the explicit preflight path for
schema, manifest, plugin, check, and reporter validation without runtime
services.

Expected console shape:

```text
schema validation passed: 13 discovered scenario definition(s)
- wait.then-act
execution cells: 13
result: 13 passed, 0 failed, 0 infra errors, 0 skipped
```

Exit codes:

| Code | Meaning |
|---:|---|
| 0 | Success. |
| 1 | Quality failures, meaning scenarios ran but checks failed. |
| 2 | Config, schema, manifest, plugin, or CLI usage error. |
| 3 | Infrastructure error. |

## 3. Open The Report

The smoke config writes under `.eval-results/smoke` relative to the directory
where you run the command.

```bash
find .eval-results/smoke -maxdepth 2 -name REPORT.md | sort | tail -1
```

Open the newest `REPORT.md`. It is organized for a human reader:

1. Top-Line Summary: decide if the run is healthy.
2. Failure Triage: only scenarios that need attention.
3. Scenario Index: every case with status, checks, latency, cost, and links.
4. Budget: known LLM judge reservations and deterministic trajectory summary cost.
5. File Layout: where raw and machine-readable data lives.
6. How To Read This: what to inspect next.

Open a scenario `README.md` when you need trace-level detail. If an
`llm-judge` check ran, it includes a dedicated `LLM Judge` section with
evidence, issues, categorical verdict (`PASSED`, `PARTIAL`, or `FAILED`), and
confidence. `PARTIAL` is distinct in the report but still fails the production
gate.

## 4. Understand The Result Folder

Each file reporter writes into one timestamped bundle:

```text
.eval-results/smoke/
  20260518-143422-smoke/
    REPORT.md
    README.md
    summary.json
    run-config.json
    machine/results.jsonl
    scenarios/
      wait-then-act/
        README.md
        result.json
        timeline.md
        transcript.md
        cms-events.json
        tool-calls.json
        agent-sessions.json
```

Use the files this way:

| File | Audience | Purpose |
|---|---|---|
| `REPORT.md` | Humans | Run summary, triage, and navigation. |
| `summary.json` | Scripts | Compact run summary with totals and per-scenario metadata. |
| `run-config.json` | Scripts and reviewers | Redacted effective config after CLI run-level overrides, plus discovered scenario definitions and execution cells counts. |
| `machine/results.jsonl` | Dashboards | One JSON object per execution cell. |
| `scenarios/<id>/README.md` | Humans | One-scenario drill-down with checks and final response. |
| `scenarios/<id>/result.json` | Debugging | Redacted scenario result with observed activity. |
| `scenarios/<id>/timeline.md` | Debugging | CMS event timeline for durable execution review. |
| `scenarios/<id>/transcript.md` | Debugging | Reconstructed session transcript. |

## 5. Ownership Rules

The implemented hierarchy is:

```text
Run config -> manifest -> scenario config
```

Run config owns driver/live-vs-fake, models, trials, concurrency, default
isolation, reporters/output, budgets, LLMJudge provider/model/run prompt/default
coverage, and `requirements.onUnsupported`. Manifest entries only select
scenario files and add tags. Scenario config owns prompts, turns, checks, tools,
`requirements.live`, `requirements.isolation`, `promptOverrides`,
`runs.timeoutMs`, `runs.maxCells`, and scenario-specific judge rubrics/checks.

Bundled live configs use `llmJudge.applyTo: "all"` so every execution cell gets
judge coverage unless the run is explicitly invoked with `--fake`.

CLI flags override run config only. They never change scenario semantics.

## 6. Run Plans

```bash
# Fast fake preflight. This is the explicit non-runtime path.
packages/eval-harness/bin/run-eval.sh --run=smoke --fake

# Production defaults are live. The harness starts its own managed
# PilotSwarm worker pool.
set -a; source .env; set +a
packages/eval-harness/bin/run-eval.sh --run=smoke
packages/eval-harness/bin/run-eval.sh --run=all

# Managed live E2E gate with a harness-owned worker pool.
packages/eval-harness/bin/run-eval.sh --run=live-critical-path

# Diagnostic attach mode for an already-running worker.
node --env-file=.env packages/sdk/examples/worker.js
packages/eval-harness/bin/run-eval.sh --run=attach-live
```

`--run=<name>` uses `runs/<name>/config.json` from your current directory when
that file exists. Otherwise it falls back to the bundled package run.
Run names are flags, not positionals; use `--run=smoke`, not `run-eval smoke`.

## 7. Useful Overrides

```bash
# Discover options
packages/eval-harness/bin/run-eval.sh --help

# Print registered agents
packages/eval-harness/bin/run-eval.sh --list-agents

# Console-only fake preflight
packages/eval-harness/bin/run-eval.sh --run=smoke --fake --reporters=console

# Custom report destination
packages/eval-harness/bin/run-eval.sh --run=smoke --fake --reports-dir=/tmp/eval-results

# Direct scenario glob
packages/eval-harness/bin/run-eval.sh --scenarios='packages/eval-harness/scenarios/**/*.scenario.json' --fake

# Explicit config
packages/eval-harness/bin/run-eval.sh --config=packages/eval-harness/runs/smoke/config.json --fake
```

These are run-level overrides. They affect the effective run config recorded in
`run-config.json`; they do not rewrite manifests or scenario configs.

## 8. Add One App Scenario

In a downstream app, use this layout:

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

Run:

```bash
npm exec run-eval -- --config=eval/runs/smoke/config.json --fake --require=eval/eval-plugins.js
npm exec run-eval -- --config=eval/runs/smoke/config.json --require=eval/eval-plugins.js
```

Use `docs/DOWNSTREAM-GUIDE.md` for the full app-local setup.
