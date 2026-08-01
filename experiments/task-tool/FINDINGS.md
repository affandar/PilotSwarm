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

## Phase 1a: easy A/B eval (eval.mjs)

8 simple codebase questions × {task-off (prod config), task-on (locked
config)}, single-turn fresh sessions, claude-sonnet-5.

| metric | off | on |
|---|---|---|
| correct | 8/8 | 8/8 |
| native task used | 0/8 | **0/8** |
| mean wall ms | 6,053 | 6,941 |
| mean parent final ctx | 24,408 | 26,906 |
| leaks | 0 | 0 |

**Findings:**
- **Zero unprompted adoption on easy questions.** With a neutral system
  prompt ("you may use"), sonnet-5 never dispatched a subagent for 1–2-call
  questions — it just grepped. Correct behavior, actually: delegation would
  have been slower.
- **Standing declaration tax ≈ +2,615 initial context tokens/session**
  (toolDefs 5,120 → 6,958; system 17,881 → 18,658). This is the per-session
  cost of having task + agent roster declared, paid whether or not it's used.
- Conclusion: the tool is not harmful on easy work (model ignores it), but
  it isn't free either. Its value must come from verbose scenarios →
  Phase 1b.

## Phase 1b: hard A/B eval (eval-hard.mjs)

4 scenarios shaped like the supposed niche — broad file sweep (42-tool
roster from a 2,400-line file), noisy 504-line build script, 4-question
fan-out, multi-file reference hunt. ON arm carried shipped-shape
delineation guidance ("prefer delegating broad sweeps and noisy commands").

| metric | off | on |
|---|---|---|
| correct | 4/4 | 4/4 |
| native task used | 0/4 | 1/4 (h2 via swarm-task) |
| mean wall ms | 9,381 | 12,437 |
| mean parent final ctx | 26,079 | 28,594 |

**Findings:**
- **Adoption stayed low (1/4) even with guidance.** The one delegation
  (noisy build) was 3.6× slower than OFF (15.8s vs 4.4s) with *higher*
  parent context (26.4K vs 23.5K) — the declaration tax exceeded the
  isolation savings.
- **The OFF arm gamed h2**: it read the script source and extracted the
  checksum without running it. Fixed in Phase 1c with a runtime-computed
  checksum (noisy-build2.sh).
- **Two structural mitigations already cap single-turn bloat:**
  1. The CLI truncates tool output aggressively — the 504-line build
     output came back as ~933 chars *even inside the subagent*.
  2. sonnet-5 is surgical: the 2,400-line sweep cost 3 targeted calls
     (~9KB of tool results), not a full-file read.
- Conclusion: **single-turn isolation value ≈ zero for a strong model.**
  The real production pathology (chk: 936K-token sessions, 1.5–2M
  input/turn) is *multi-turn accretion* — every tool result is re-sent as
  input on every later call — and chattier models (gpt-5.4 family).
  → Phase 1c tests exactly that.

## Side measurement: dead companion tools (deadtools_a/b)

Today's prod config excludes `task` but still declares its companion
surface: `read_agent`, `list_agents`, `write_agent` (background-task
collection/management). Excluding those three too:

- toolDefinitionsTokens: 5,120 → 3,911 (**−1,209 tokens/session**, every
  session, every turn's cache-write)
- They are useless without `task` — and `read_agent` is the tool observed
  failing at 100% (381 calls) on waldemort-chk.

**Recommendation independent of the task-tool decision:** if `task` stays
excluded, exclude `read_agent`, `list_agents`, `write_agent` as well.

## Phase 1c: multi-turn accretion eval (eval-multi.mjs)

One 8-turn session per (arm × model), models = claude-sonnet-5 (github)
and gpt-5.4 (BYOK azure — the waldemort-chk production model). Measures
the per-turn parent-context curve, cumulative parent input tokens, and
adoption under trigger-based delineation rules. Results appended when
complete.
