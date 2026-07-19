# Delegation-Scoped Tools

**Status:** Draft / RFC
**Date:** 2026-07-18
**Branch baseline:** `feat/per-agent-mcp-servers` (per-agent MCP; no capability
tiers/catalog/overrides — this proposal needs none of that).

## Premise: tool *results* are the bloat, not tool *definitions*

Measured on the flagship deployment (generic session, `claude-sonnet-5`):

| | Cost | Shape |
|---|---:|---|
| Tool **definitions** | ~14,495 tokens (17,175 with graph/observability) | **fixed**, paid once at session build |
| Tool **results** | unbounded | **cumulative**, grows every call |

A single `graph_neighbourhood`, `read_facts`, `read_wiki_contents`, or `view` of
a large file can exceed the *entire* definition budget, and a working session
makes dozens of calls. Past the first few turns, results dominate by an order of
magnitude.

So the value of delegation is **absorbing result noise in a context you throw
away** — not hiding schemas from the parent.

**Corollary that drives this whole design: a sub-agent's context is disposable.**
It is discarded the moment the helper returns its distillate. Trimming a
helper's tool definitions therefore saves nothing that survives — it is pure
maintenance burden whose only effect is a helper occasionally missing a tool it
needed. **Do not curate sub-agent tool lists.**

## Design

### 1. Sub-agent tool policy: everything minus the Never list

An in-process helper (a `task` target) gets **every tool the session has,
minus** a small correctness-driven exclusion list. No per-agent curation, no
allowlist maintenance, no drift as new tools are added. Side-effecting tools
(`store_fact`, `write_artifact`, `graph_upsert_*`) are **included** — a helper
that must return "please write this fact" for the parent to execute wastes a
round trip *and* parent context, defeating the purpose.

### 2. The Never list — a correctness boundary, not a preference

These route through the durable orchestration: they suspend the parent turn or
mutate session/orchestration state. Inside an in-process helper they break or
corrupt turn semantics. This is the **only** filter:

`wait`, `wait_on_worker`, `ask_user`, `cron`, `cron_at`, `report_cycle`,
`spawn_agent`, `check_agents`, `wait_for_agents`, `message_agent`,
`complete_agent`, `cancel_agent`, `delete_agent`, `set_session_model`,
`update_session_summary`, `list_sessions`.

Everything else — knowledge reads/writes, graph, artifacts, MCP tools, web
fetch, CLI builtins — is fair game.

### 3. `defaultAgent.excludedTools` — enforcement, not token savings

The CLI provides exactly the needed primitive (verbatim from `DefaultAgentConfig`):

> "List of tool names to exclude from the default agent. **These tools remain
> available to custom sub-agents that reference them in their `tools` array.
> Use this to register tools that should only be accessed via delegation to
> sub-agents, keeping the default agent's context clean.**"

Its purpose here is **behavioral**: if the parent physically cannot call
`graph_search_nodes`, it cannot pull a 10K result into its own window, so
delegation becomes the only path for result-heavy families. The ~2K of schema
saved is a rounding-error bonus.

Candidates for parent exclusion (result-heavy, delegation-friendly):
graph reads/traversals, bulk fact search, large document/wiki reads. Keep cheap,
frequently-needed tools (`read_facts` for a single key, `write_artifact`) on the
parent.

### 4. Cheap model for helpers

`CustomAgentConfig.model` sets a per-agent model. Run miners on a cheap model
(the SDK's own example is `claude-haiku-4.5`): burn cheap tokens sifting a
mountain of graph data, return the distillate to the expensive parent model.
This compounds with the context win — the expensive model never sees the raw
data at all.

### 5. Helper agents

Either purpose-built (`graph-miner`, `researcher`) or existing named agents
reused as delegation targets. Because PilotSwarm already publishes its loaded
agents as `customAgents` — with per-agent `tools`, `skills`, and (since Phase 1)
`mcpServers` — an existing agent like `deepwiki` becomes task-delegable for
free: `task(agentName: "deepwiki", …)` runs an in-process helper holding the
DeepWiki MCP, and generic sessions never load those tools at all.

## Why not curate helper tools

- **The context saved is thrown away anyway** (disposable window).
- **Maintenance burden**: every new tool needs a decision in N agent files.
- **Silent capability loss**: an over-trimmed helper does a worse job or fails,
  and the failure looks like model incompetence, not misconfiguration.
- The only curation with real stakes is the Never list, which is about
  correctness and is small and stable.

## What PilotSwarm must add

1. **Enable `task`** (remove it from the `excludedTools` floor).
2. **Compute helper tool lists**: when building `customAgents`, set each entry's
   effective `tools` to *(its declared frontmatter `tools`, or all session
   tools)* **minus the Never list**. Author intent wins on inclusion; the Never
   subtraction is unconditional.
3. **Set `defaultAgent.excludedTools`** — currently unused; this is the main new
   wiring — from a deployment-configurable list of delegation-only tools.
4. **`infer: false`** on system agents so they don't appear in the task roster.
5. **Routing guidance** in the base agent (see the `task` vs `spawn_agent`
   guidance: `spawn_agent` default, `task` for bounded/read-mostly/consumed-now).
6. **UX + telemetry** for `task` calls (see below).

## Caveats

- **Attribution and audit.** Writes performed by an in-process helper have no
  session of their own — a fact or artifact appears with no visible actor. This
  is the real cost of giving helpers side-effecting tools. Mitigate by stamping
  helper origin on writes and surfacing the `task` call in the transcript (the
  CLI emits `subagent.started/completed/failed`, which PilotSwarm currently
  ignores entirely).
- **Ephemerality.** Helpers die with the process; nothing durable. Fine for
  retrieval/distillation, wrong for workstreams — hence the routing rules.
- **Retry double-writes.** A `runTurn` activity retry reruns the helper and its
  writes. The same exposure exists for parent tool calls today, so it is not new,
  but side-effecting helpers widen it — prefer idempotent writes (keyed facts
  over appends).
- **Routing risk remains.** Models are biased toward the builtin `task`; the
  guidance narrows but does not eliminate misrouting. Named helper agents help,
  because the choice becomes concrete ("delegate retrieval to `graph-miner`")
  rather than an abstract durability judgment.

## Relationship to the other proposals

This **supersedes `dynamic-tool-loading.md` as the primary context-reduction
strategy.** Lazy/skill-triggered loading only ever addressed tool *definitions*
(the fixed, smaller term) and left result bloat untouched — once a tool is
lazily loaded into the parent, its results still land in the parent's window.
Delegation-scoped tools solve both terms at once.

Skill-triggered loading remains useful as a complement for capabilities the
parent genuinely needs *itself*, and the durable-`task`-facade idea remains the
alternative for teams unwilling to accept in-process ephemerality.

## Implementation checklist

| # | Change | File |
|---|---|---|
| 1 | `NEVER_FOR_SUBAGENTS` constant | `packages/sdk/src/tool-groups.ts` (new) |
| 2 | Subtract Never list when composing `customAgents` entries | `packages/sdk/src/worker.ts` |
| 3 | Remove `"task"` from the excluded floor | `packages/sdk/src/session-manager.ts` |
| 4 | Pass `defaultAgent: { excludedTools }` from deployment config | `session-manager.ts`, `session-policy.json` |
| 5 | `infer: false` for system agents | `worker.ts` |
| 6 | Base-agent routing guidance (`task` vs `spawn_agent`) | `system/agents/default.agent.md` |
| 7 | Handle `subagent.*` events → transcript card + telemetry counter | `managed-session.ts`, `ui/core/src/selectors.js` |
| 8 | A `graph-miner` helper agent (cheap model) as the reference example | `packages/app/tui/plugins/agents/` |
| 9 | Tests: Never list subtracted from every customAgent; excluded tools absent from the default agent but present for helpers | `packages/sdk/test/unit/` |

## Open questions

1. Should `defaultAgent.excludedTools` be deployment-wide, or per-agent (an
   agent declaring which tools it delegates rather than calls)?
2. Do helper writes need an explicit origin stamp, or is the transcript card
   enough for audit?
3. Should helpers inherit the parent's MCP servers by default, or only those of
   the agent they run as? (Per-agent MCP says the latter — confirm it's right
   for in-process helpers too.)
4. Is there a cheap-model default for helpers, or per-agent opt-in only?
