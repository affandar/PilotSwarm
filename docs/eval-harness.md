# Eval Harness

The PilotSwarm Eval Harness lives in [`packages/eval-harness/`](../packages/eval-harness/). It measures LLM behavior — tool selection, argument accuracy, sequencing quality, response shape, durability under fault injection, prompt-testing variants, and subjective rubric grades — through deterministic code graders plus optional LLM-as-judge.

## Source of truth

The package README is canonical:
[`packages/eval-harness/README.md`](../packages/eval-harness/README.md)

Status of every surface (which paths are shipped vs experimental), the full API reference, schemas, examples, and roadmap live there. This file is intentionally short to keep the two from drifting.

For the test-suite catalog and gating matrix, see
[`packages/eval-harness/docs/SUITES.md`](../packages/eval-harness/docs/SUITES.md).

For the judge-client selection precedence and cost-rate contract, see
[`packages/eval-harness/docs/JUDGE-CLIENTS.md`](../packages/eval-harness/docs/JUDGE-CLIENTS.md).

## Scope (one-liner)

- **In scope:** LLM behavior — tool calls, args, ordering, response shape, durability, prompt variants, subjective rubrics.
- **Out of scope:** PilotSwarm runtime correctness — that lives in [`packages/sdk/test/local/`](../packages/sdk/test/local/) integration tests (CMS persistence, orchestration replay, worker handoff plumbing). The eval harness consumes those primitives; it does not duplicate them.

## Status — at a glance

The harness ships a deterministic-fixture core that is production-ready, plus several LIVE / experimental surfaces. Per the package README:

> The deterministic fixture runner, statistics, reporters, and code graders are shipped; live LLM evaluation, durability validation, multi-turn reasoning measurement, and LLM-as-judge calibration remain experimental unless explicitly noted.

Specifically:

- ✅ **Shipped, production-grade:** schema, fixture runner (`FakeDriver`), single-turn and multi-trial code graders, statistical utilities (Wilson, bootstrap, McNemar, Mann-Whitney), pass@k, baselines, regression detection, CI gate, console / JSONL / markdown / PR-comment reporters.
- ✅ **Shipped, real product evidence:** CMS event capture (`session.getMessages()` → `ObservedResult.cmsEvents`), real cross-worker handoff durability test (sequential workers, asserts distinct `workerNodeId` values in CMS), local report auto-wiring via `EVAL_REPORTS_DIR` / `reportsDir`, Copilot-routed judge (`PilotSwarmJudgeClient`).
- 🧪 **Experimental:** `LiveDriver` (monorepo-only test-helper coupling), V3 fixture-derived durability scoring (the synthetic `DurabilityFixtureDriver` path — not the real worker-handoff test, which IS shipped), V4 multi-turn / trajectory measurement, LLM-as-judge calibration against human ratings.

The package README has the full status matrix in its Roadmap section; this file does not duplicate it to avoid drift.
