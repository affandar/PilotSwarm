# Native task tool experiments — findings

Phase 0 (2026-08-01), standalone harness against `@github/copilot` 1.0.73 /
`copilot-sdk` 1.0.7, mirroring the worker's session config
(`packages/sdk/src/session-manager.ts`). Run with `node run.mjs <name>`;
raw event streams under `results/`.

## Context

PilotSwarm has excluded the SDK's native `task` (subagent) tool since v0.1.5
(`298b13c`, 2026-03-18) — `excludedTools: ["task"]` in session-manager.ts —
because it bypassed the durable orchestration layer. These experiments test
whether it can come back as a **complementary ephemeral tier** under the
constraint: *native subagents must never see PilotSwarm durability tools*
(facts, graph, spawn_agent, artifacts…), while the parent session keeps them.

## Results

| # | Experiment | Question | Result |
|---|---|---|---|
| 1 | `control` | Harness sanity, today's config | ✅ `task` absent; marker durability tools visible to parent |
| 2 | `dispatch` | Does dispatch work (GitHub provider)? | ✅ `explore` ran on pinned `claude-haiku-4.5`, answered correctly, 10.6K subagent tokens, parent context untouched |
| 3 | `leak` | Do SDK-registered custom tools leak into built-in subagents? | ❌ **LEAK** — built-in `task` agent (`tools: ["*"]`) called `ps_store_fact`; handler fired |
| 4 | `restricted` | Does a customAgents entry with explicit `tools` allowlist stay clean? | ✅ Saw only bash/view/grep/glob family; no ps_* tools; inherited parent model |
| 5 | `byok` | BYOK provider (azure-openai `gpt-5.4-mini`) with haiku-pinned explore? | ✅ Dispatch works; pin **falls back to session model** (`gpt-5.4-mini` served); model used `mode: "background"` + `read_agent` to collect |
| 6 | `shadow` | Can same-name customAgents override leaky built-ins? | ❌ Built-in `task` wins; leak reproduced |
| 7 | `disabled` | Does `settings.json` `subagents.disabledSubagents` work? | ✅ Disabled types vanish from tool declaration; dispatch fails with clean error |
| 8 | `locked` | Production-shaped config | ✅ Only `explore` + custom `swarm-task` dispatchable; **zero leaks**; both function correctly |

## Key facts learned

- **Leak surface = wildcard built-ins.** `task`, `general-purpose`,
  `code-review`, `rubber-duck`, `security-review` declare `tools: ["*"]`,
  which matches SDK-registered custom tools (our durability tools).
  `explore` and `research` have explicit rosters and are inherently clean
  (verified for `explore`).
- **The fix is `disabledSubagents`, not shadowing.** Same-name customAgents
  do NOT override built-ins. A `settings.json` in `COPILOT_HOME` with
  `{"subagents": {"disabledSubagents": [...]}}` removes built-ins from both
  the tool declaration and dispatch. Note: COPILOT_HOME is worker-global
  (all CopilotClients share it), so this is a worker-level knob — fine for
  our deployment model.
- **Custom agents with explicit `tools` allowlists are airtight** for
  keeping durability tools out, and inherit the parent session model when
  they pin none.
- **Model pins degrade gracefully under BYOK.** `CustomAgentConfig.model`
  is attempt-then-fallback; no dispatch failure when the provider lacks the
  pinned model.
- **Observability is good.** `subagent.started/completed` carry agentName,
  actual model, totalTokens, durationMs; every subagent tool call carries
  `agentId`. `includeSubAgentStreamingEvents: false` (already set) keeps
  deltas out. `session.usage_info.currentTokens` measures parent-context
  accretion directly.
- **Dead companion tools today.** `read_agent` / `list_agents` /
  `write_agent` are the task tool's companion surface (background-mode
  collection). With `task` excluded they are declared but useless — likely
  the source of the 100%-failing `read_agent` calls observed on
  waldemort-chk. Either re-enable `task` or exclude them too.

## Production-shaped config (the `locked` recipe)

1. Drop `"task"` from `excludedTools`.
2. Write `<COPILOT_HOME>/settings.json`:
   `{"subagents": {"disabledSubagents": ["task", "general-purpose", "code-review", "rubber-duck", "security-review", "rem-agent", "research"]}}`
   (everything wildcard, plus built-ins we don't want dispatched).
3. Keep built-in `explore` (clean roster, haiku-pinned with graceful fallback).
4. Add restricted customAgents for command execution (e.g. `swarm-task`
   with `tools: ["bash", "view", "grep", "glob"]`).
5. Delineation guidance in the prompt layer (see below).

## Delineation rubric (draft)

> If losing it silently on a worker restart would be a bug the user notices →
> `spawn_agent`. If it's a smarter way to run a search or command inside the
> current turn → `task`.

- **`task` (ephemeral, in-process)**: read-only exploration fan-out, running
  noisy commands (tests/builds/lints), quick parallel searches. Result
  matters, process doesn't. No follow-up conversation. Dies with the turn —
  and that's fine.
- **`spawn_agent` (durable session)**: work that outlives the turn, needs
  monitoring/messaging (`message_agent`), user visibility in the portal,
  contracts/wake policies, its own facts/artifacts, or must survive worker
  restarts and rollouts.

## Phase 1: A/B eval

`eval.mjs` — 8 codebase questions × {task-off (prod config), task-on
(locked config)}, single-turn fresh sessions, claude-sonnet-5, measuring
correctness, latency, parent-context accretion (`session.usage_info`),
token split by lane (`assistant.usage` by `agentId`), native-task adoption
rate, and the leak canary. Results appended below when complete.
