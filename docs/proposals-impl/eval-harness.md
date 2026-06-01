# Eval Harness

Implemented status: `packages/eval-harness` v0.

This proposal record now matches the minimal live PR scope. The active package
docs live under `packages/eval-harness/`.

## v0 Scope

The v0 surface is intentionally small:

- `live-smoke`
- `live-critical-path`
- `live-all` as the full bundled v0 corpus
- 19 live-compatible JSON scenarios across runtime, durable, multi-turn,
  and safety coverage — every scenario exercises a real PilotSwarm runtime
  feature (CMS event capture, durable waits, worker-restart chaos,
  multi-turn session memory, or provider-backed judge/safety integration)
- console reporting
- provider-backed LLM judge checks where scenarios request them

Out of scope for v0: meta scenarios, prompt variants, ablations, model sweeps,
sample expansion, post-run trajectory summaries, expanded reporters, and broad
platform positioning.

## Model

```text
Run config -> manifest -> scenario config
```

Run config owns driver, isolation, concurrency, timeout,
reporters, output, and judge policy. Manifests select scenario files. Scenario
files own prompt, tools, checks, per-scenario timeout, and chaos injection.

## Kept Live Path

The bundled plans run against managed live PilotSwarm workers and require
`GITHUB_TOKEN`, `DATABASE_URL`, and PostgreSQL. The critical path covers basic
runtime/CMS evidence, durable wait recovery, wait-tool-wait-tool sequencing,
timer recovery after worker restart, multi-turn session memory, and safety
behavior including direct/indirect injection and output-secret refusal.
