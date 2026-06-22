# Quickstart

## Build

```bash
npm install
npm run build --workspace=pilotswarm-eval-harness
```

## Run Live Smoke

```bash
set -a; source .env; set +a
packages/eval-harness/bin/run-eval.sh --run=live-smoke
```

Required environment:

- `GITHUB_TOKEN`
- `DATABASE_URL`
- reachable PostgreSQL

## Run The Minimal Gate

```bash
packages/eval-harness/bin/run-eval.sh --run=live-critical-path
```

`live-critical-path` covers runtime, durable waits, worker restart recovery,
multi-turn memory, and safety. `live-all` runs the full bundled v0 corpus
across live, durable, multi-turn, and safety groups.

## Useful CLI Forms

| Command | Effect |
|---|---|
| `run-eval --run=live-smoke` | Bundled one-scenario live smoke. |
| `run-eval --run=live-critical-path` | Bundled live runtime/durability/safety gate. |
| `run-eval --run=live-all` | Full bundled v0 JSON corpus. |
| `run-eval --config=<path>` | Run a config JSON file. |
| `run-eval --manifest=<path>` | Discover scenarios from a JSONL manifest. |
| `run-eval --scenarios=<glob>` | Discover scenario files directly. |
| `run-eval --require=<path>` | Import plugin code before discovery. |
| `run-eval --help` | Print usage. |

Use only one selector per command: `--run`, `--config`, `--manifest`, or
`--scenarios`.

The CLI prints scenario progress to stderr while a run is active. TTY terminals
refresh one progress line in place; non-TTY logs receive one line per progress
event.

## Add One Scenario

1. Create `packages/eval-harness/scenarios/<group>/<name>.scenario.json`.
2. Use one of the v0 kinds: `single-turn`, `multi-turn`,
   `durable-trajectory`, or `safety`.
3. Declare only the tools the prompt should use.
4. Add deterministic checks first: response text, tool calls, CMS events,
   terminal state.
5. Add `llm-judge` only when a rubric is needed.
6. Include the file from `runs/live-all/scenarios.jsonl` or a downstream
   manifest.

Run just that scenario while tuning:

```bash
packages/eval-harness/bin/run-eval.sh --scenarios='packages/eval-harness/scenarios/<group>/<name>.scenario.json'
```

## Exit Codes

- `0`: success
- `1`: scenario check failure
- `2`: config, schema, or CLI error
- `3`: infrastructure error
