# Troubleshooting

## Live prerequisites

Live runs need `GITHUB_TOKEN`, `DATABASE_URL`, and reachable PostgreSQL.

```bash
set -a; source .env; set +a
```

Exit code `3` means an infrastructure failure.

## Unknown tool

`Scenario <id> references unknown tool "<name>"`

Register the tool in a plugin loaded with `--require=<path>`, or use one of
the bundled test tools referenced by the kept scenarios.

## Unknown reporter

v0 bundles the `console` reporter. Remove unknown reporter names from the run
config or register them in a plugin before discovery.

## Schema error

Exit code `2` means the CLI, run config, manifest, or scenario failed
validation. The error message names the field. See [SCHEMA.md](SCHEMA.md).

If the CLI reports a selector error, remove extra selectors. A command may use
only one of `--run`, `--config`, `--manifest`, or `--scenarios`.

## LLM judge error

When `llmJudge.enabled` is true and `onMissingProvider` is `error`, configure
the requested provider credentials. Bundled runs use the Copilot provider and
therefore need `GITHUB_TOKEN`.

Keep judge checks explicit. If a run starts timing out or exhausting judge
budget, check whether `llmJudge.applyTo` was set to `all`; v0 bundled runs keep
the default `explicit` mode.

## Scenario check fails but the behavior looks correct

Inspect whether the check is stricter than the behavior you care about:

- Use `strict` instead of `exactSequence` when repeated post-hydration tool
  calls are acceptable.
- Use `response-not-contains` and leak checks for safety scenarios instead of
  exact refusal wording.
- Make the prompt name required tools directly when the scenario asserts a tool
  call.

Internal PilotSwarm management tools are filtered from workload tool checks. If
a new internal tool appears in a sequence failure, add it to the internal-tool
filter before weakening scenario assertions.
