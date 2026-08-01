# Proposal: Re-enable the native Copilot `task` tool as an ephemeral subagent tier

**Status**: proposed — experiments complete, integration not started
**Date**: 2026-08-01
**Experiments**: branch [`task-tool-evals`](https://github.com/affandar/PilotSwarm/tree/task-tool-evals/experiments/task-tool) — full writeup in [`experiments/task-tool/FINDINGS.md`](https://github.com/affandar/PilotSwarm/blob/task-tool-evals/experiments/task-tool/FINDINGS.md), raw event streams in `experiments/task-tool/results/`, harness (`harness.mjs`) mirrors the worker's session config so findings transfer.

## Summary

PilotSwarm has excluded the Copilot SDK's built-in `task` (subagent) tool since
v0.1.5 (`298b13c`, 2026-03-18) because its in-process subagents bypassed the
durable orchestration layer. Forty experiment/eval sessions against
`@github/copilot` 1.0.73 show that re-enabling it — under a specific locked
configuration — is a **large efficiency win for gpt-5.4-class sessions** (the
production fleet model on chk) and can be made **provably leak-proof** with
respect to PilotSwarm durability tools. It is **net-negative for
sonnet/opus-class sessions**, so the rollout must be gated per model family.

## Headline results (8-turn exploration/command sessions, cache-aware cost)

| model | task off | task on (locked recipe) |
|---|---|---|
| gpt-5.4 | 1,307K units; parent ctx 22K → 56K | **627K units (−52%); ctx 22K → 26K (flat)** |
| claude-sonnet-5 | 1,195K units; ctx 28K → 46K | 1,377K (+15%), 2.6× wall clock |

- gpt-5.4 followed trigger-based delegation guidance 8/8 turns; the flat
  parent-context curve attacks the measured chk accretion pathology
  (1.5–2M input tokens/turn on long sessions) at the source.
- sonnet-5 correctly prefers its own surgical grep; delegation guidance
  only added cost and latency. Correctness was 8/8 in every arm.

## The two hard-won constraints

1. **Leak-proofing (the deal-breaker requirement).** Built-in subagents with
   `tools: ["*"]` (`task`, `general-purpose`, `code-review`, `rubber-duck`,
   `security-review`) can see and call SDK-registered custom tools —
   verified with a marker durability tool that fired from inside a
   subagent. Same-name custom agents do NOT shadow built-ins. The only
   working fix: disable ALL built-ins via worker-global
   `COPILOT_HOME/settings.json` → `subagents.disabledSubagents`, and ship
   custom replacement agents (`swarm-explore`, `swarm-task`) whose
   `tools:` allowlists simply omit the durability tools. Zero leaks across
   all 40 sessions under this recipe; the parent keeps full tool access.
2. **Model pinning.** The built-in explore's `claude-haiku-4.5` pin
   spiraled (25 tool calls / 559K tokens on a one-function question).
   With a ~6-call budget line in the agent prompt, cheap pins behave:
   token inflation 2.21× (gpt-5.4-mini) / 1.53× (haiku) — below their
   price gaps, so ~2× cheaper subagent-lane dollars. Policy: registry-
   driven cheap-tier pin for `swarm-task`; cheap-vs-inherit deployment
   knob for `swarm-explore`; `CustomAgentConfig.model` falls back to the
   parent model when the provider lacks the pin (verified under BYOK).

## Delineation: `task` vs `spawn_agent`

> If losing it silently on a worker restart would be a bug the user
> notices → `spawn_agent`. If it's a smarter way to run a search or
> command inside the current turn → `task`.

- `task` (ephemeral, in-process, dies with the turn): read-only
  exploration fan-out, noisy command execution, parallel searches.
- `spawn_agent` (durable session): work that outlives the turn — portal
  visibility, `message_agent` follow-ups, contracts/wake policies,
  facts/artifacts, restart survival.

## Proposed integration (not yet built)

1. Worker-config flag with **per-model-family gating** (ON + delineation
   prompt layer for gpt-family; OFF for sonnet/opus-family).
2. Worker writes the `settings.json` built-in kill list at startup; adds
   `swarm-explore`/`swarm-task` to `customAgents` with allowlisted tools.
3. Independent quick win, shippable immediately: where `task` stays
   excluded, also exclude its dead companions `read_agent`,
   `list_agents`, `write_agent` — **−1,209 tokens/session** and removes
   chk's observed 381-call/100%-fail `read_agent` pattern.

## Experiment inventory (branch `task-tool-evals`)

| artifact | what it is |
|---|---|
| `experiments/task-tool/FINDINGS.md` | full phase-by-phase writeup (Phases 0, 1a–1e) |
| `experiments/task-tool/harness.mjs` | standalone SDK rig mirroring session-manager's config |
| `experiments/task-tool/run.mjs` | 10 targeted probes (dispatch, leak, shadow, disabled, locked, BYOK, deadtools) |
| `experiments/task-tool/eval*.mjs` | easy / hard / multi-turn A/B suites (off, on, on2, on3 arms) |
| `experiments/task-tool/results/` | per-session event streams + graded summaries for every number above |

Branch base: forked from `agent-packages-impl` @ `03bead4` on 2026-08-01.
