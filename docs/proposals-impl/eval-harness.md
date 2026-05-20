# Eval Harness

Implemented status: landed as `packages/eval-harness`.

This proposal records the implemented PilotSwarm eval harness design. The
active package docs live under `packages/eval-harness/`; this file is the
historical implemented-proposal record.

## Scope

The eval harness provides:

- bundled run plans for smoke, critical-path, all, nightly, live compatibility, and attach diagnostics
- schema-validated run configs, manifests, scenarios, checks, and plugins
- managed live PilotSwarm execution with CMS/tool evidence capture
- explicit fake preflight for shape, plugin, check, and report validation
- file reporters for human triage and machine ingestion
- downstream builder-agent guidance for app-local eval suites

## Hierarchy

The implemented hierarchy is:

```text
Run config -> manifest -> scenario config
```

Run config owns driver/live-vs-fake, models, trials, concurrency, default
isolation, reporters/output, budgets, LLMJudge provider/model/run prompt, and
`requirements.onUnsupported`.

Manifest files only select scenario files and add tags. Non-tag behavior
overrides are rejected.

Scenario config owns prompt, turn, check, and tool semantics,
`requirements.live`, `requirements.isolation`, `promptOverrides`,
`runs.timeoutMs`, `runs.maxCells`, and scenario-specific judge rubrics/checks.

CLI flags override run config fields only. They never rewrite scenario config.

## Runs

Default bundled runs are live. `--fake` is the explicit preflight path.

Common commands:

```bash
npm exec run-eval -- --run=smoke --fake
npm exec run-eval -- --run=smoke
npm exec run-eval -- --run=all
npm exec run-eval -- --config=eval/runs/smoke/config.json
```

`--fake` forces the run-level driver to `fake`, sets unsupported live
requirements to skip, and disables provider-backed LLM judge and post-run
trajectory summaries for that invocation.

## Result Bundles

File reporters write timestamped bundles containing:

- `REPORT.md`
- `summary.json`
- `run-config.json`
- `machine/results.jsonl`
- per-scenario `README.md`, `result.json`, timeline, transcript, CMS events, tool calls, and agent-session summaries

`run-config.json` records the redacted effective config after CLI run-level
overrides, the CLI override summary, and discovered scenario definitions versus
execution cells counts.

## LLMJudge

The fixed PilotSwarm harness prefix/system context remains stable. Run config
can add global judge instructions. Scenario checks can add
rubric/check-specific guidance.

Judge output is evidence-first: reason, evidence, and issues before verdict and
confidence. No numeric score is the primary outcome.

## Compatibility Notes

Old untracked v2 proposal docs remain historical planning material. The
implemented behavior is the package code plus the docs in:

- `packages/eval-harness/README.md`
- `packages/eval-harness/docs/QUICKSTART.md`
- `packages/eval-harness/docs/SCHEMA.md`
- `packages/eval-harness/docs/DOWNSTREAM-GUIDE.md`
- `packages/eval-harness/docs/PLUGINS.md`
- `packages/eval-harness/docs/TROUBLESHOOTING.md`
