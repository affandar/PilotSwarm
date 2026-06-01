# PilotSwarm Eval Harness

Minimal live eval harness for PilotSwarm durable-runtime checks.

v0 is intentionally small. It keeps one obvious live path and a JSON scenario
corpus that proves the harness can run against a managed PilotSwarm worker,
capture CMS/tool evidence, exercise durable waits, restart a worker during a
timer, cover multi-turn memory, run safety probes, and invoke explicit LLM
judge checks.

## Run It

From the repo root:

```bash
npm install
npm run build --workspace=pilotswarm-eval-harness
set -a; source .env; set +a
packages/eval-harness/bin/run-eval.sh --run=live-smoke
```

Live runs require `GITHUB_TOKEN`, `DATABASE_URL`, and a reachable PostgreSQL
instance.

## Bundled Runs

| Run | Scope |
|---|---|
| `live-smoke` | One live runtime smoke scenario. |
| `live-critical-path` | Runtime, durable, multi-turn, and safety scenarios. |
| `live-all` | Full bundled v0 corpus across live, durable, multi-turn, and safety groups. |

Model sweeps, ablations, prompt variants, sample expansion, meta example apps,
post-run trajectory summaries, and expanded reporters are out of scope for v0.

## Bundled Scenarios

The package ships 19 live-compatible JSON scenarios exercising real PilotSwarm
runtime features (CMS event capture, durable waits, worker-restart chaos,
multi-turn session memory, and provider-backed safety/judge integration):

| Group | Purpose |
|---|---|
| `live/` | Runtime smoke, durable wait, multi-turn memory, safety, and explicit LLM judge coverage. |
| `durable/` | Durable wait, wait-tool-wait-tool, and worker restart during a timer. |
| `multi-turn/` | Session memory and cross-turn tool usage. |
| `safety/` | Direct injection, indirect injection, output safety, and tool-abuse probes. |

## Model

```text
Run config -> manifest -> scenario config
```

Run configs choose driver, concurrency, timeout, reporters, output, and
judge policy. Manifests select scenario files. Scenario files own prompts,
tools, checks, per-scenario timeouts, and chaos injection.

## Adding Scenarios

Add one `.scenario.json` file under the closest `scenarios/<group>/` directory,
then include it through a run manifest. Keep v0 scenarios JSON-only. If a
scenario needs app-specific behavior, register that behavior as a tool in a
plugin loaded with `--require`.

Good v0 scenarios are narrow, deterministic, and cheap to run. Prefer explicit
tool names, concrete expected arguments, CMS lifecycle checks for durable
behavior, and LLM judge checks only when deterministic checks cannot express the
quality bar.

## Docs

- [Quickstart](docs/QUICKSTART.md)
- [Schema](docs/SCHEMA.md)
- [Downstream guide](docs/DOWNSTREAM-GUIDE.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
