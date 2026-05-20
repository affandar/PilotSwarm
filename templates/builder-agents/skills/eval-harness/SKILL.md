---
name: eval-harness
description: Add PilotSwarm eval-harness scenarios and run plans to downstream apps.
---

# PilotSwarm Eval Harness Builder Skill

Use this when adding app-specific evals to a PilotSwarm downstream app.

## Contract

The implemented hierarchy is:

```text
Run config -> manifest -> scenario config
```

- Run config owns driver/live-vs-fake, models, trials, concurrency, default isolation, reporters/output, budgets, LLMJudge provider/model/run prompt, and `requirements.onUnsupported`.
- Manifest files select scenario files and may add tags. Non-tag behavior overrides are rejected.
- Scenario config owns prompts, turns, tools, checks, `requirements.live`, `requirements.isolation`, `promptOverrides`, `runs.timeoutMs`, `runs.maxCells`, and scenario-specific judge rubrics/checks.

CLI flags override run config only. Do not put run defaults in scenarios, and
do not put behavior overrides in manifests.

Default bundled runs are live. `--fake` is the explicit preflight path.

## Copy Into The App

Copy this folder's example shape into an app-local eval directory:

```text
eval/
  eval-plugins.js
  scenarios/incident-triage.scenario.json
  runs/smoke/config.json
  runs/smoke/scenarios.jsonl
```

## Adapt

- Replace `incident_lookup` with real app tools.
- Replace `incident-owner-present` with checks that reflect the app outcome.
- Keep scenarios JSON-only.
- Use `metadata.fake` for deterministic local shape tests.
- Keep the live driver in run config for production gates.
- Use manifest `overrides.tags` only for additive selection tags.
- Put LLMJudge global instructions in run config `llmJudge.prompt`.
- Use `llmJudge.applyTo: "all"` plus `llmJudge.defaultCheck` when the run should judge every scenario without copying a generic `llm-judge` check into each scenario file.
- Put scenario judge criteria in `llm-judge.rubric`.

## Run

Preflight:

```bash
npm exec run-eval -- --config=eval/runs/smoke/config.json --fake --require=eval/eval-plugins.js
```

Live:

```bash
npm exec run-eval -- --config=eval/runs/smoke/config.json --require=eval/eval-plugins.js
```

Open the newest `.eval-results/smoke/<timestamp-smoke>/REPORT.md` first. It
links to per-scenario `README.md` drill-downs and machine-readable JSON/JSONL
files. `run-config.json` records the redacted effective config after CLI
run-level overrides, plus discovered scenario definitions and execution cells
counts.
