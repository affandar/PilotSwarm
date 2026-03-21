---
name: pilotswarm-perf
description: Run and analyze PilotSwarm performance workflows, starting with SDK sub-agent spawn perf. Use when collecting fresh perf baselines, comparing runs, generating stable perf reports, or updating perf memory and next steps.
---

# PilotSwarm Perf

Use this skill when the user wants performance numbers or follow-up analysis for this repository.

Keep the workflow deterministic. Fresh numbers should come from repo-owned runners, and conclusions should be written back into repo memory.

## Canonical Files

- Perf agent memory: `perf/memory/perf-agent-memory.md`
- Spawn perf runner: `scripts/perf/run-sdk-spawn-perf.mjs`
- Spawn perf command: `npm run perf:spawn`
- Raw spawn perf test: `packages/sdk/test/perf/spawn.perf.test.js`
- Perf Vitest config: `packages/sdk/vitest.perf.config.js`
- Latest generated report: `perf/reports/spawn/latest.md`
- Latest generated metrics: `perf/reports/spawn/latest.json`
- Historical run index: `perf/reports/spawn/history/index.json`

## Workflow

1. Read `perf/memory/perf-agent-memory.md`.
2. If the user wants fresh numbers, run `npm run perf:spawn` from repo root.
3. Treat `npm run perf:spawn` as the source of truth: it must generate `latest.*`, append history, and update `perf/memory/perf-agent-memory.md` automatically.
4. Base the analysis on `perf/reports/spawn/latest.json` and `perf/reports/spawn/latest.md`, not on terminal snippets alone.
5. Compare the latest run against the prior latest run if the generated report includes a comparison section.
6. If you add deeper interpretation beyond the generated memory, refine `perf/memory/perf-agent-memory.md` so the next run starts from the updated hypotheses and next steps.
7. In the user-facing summary, include exact measurements, notable comparisons, and the next recommended experiment or optimization.

## Rules

- Prefer repo scripts over ad hoc shell pipelines.
- Do not change perf assertions just to make results look better.
- Treat `latest.*` files as generated outputs.
- Keep memory concise and cumulative. Replace stale hypotheses with confirmed findings when possible.
- If worktree changes may affect perf validity, call that out explicitly in both the response and the memory file.

## Extending Perf Coverage

If you add another perf surface later, give it all of the following:

- a dedicated perf test under `packages/*/test/perf/`
- a deterministic runner under `scripts/perf/`
- generated outputs under `perf/reports/<surface>/`
- a memory update in `perf/memory/perf-agent-memory.md`
