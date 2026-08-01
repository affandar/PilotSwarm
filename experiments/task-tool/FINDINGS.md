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

## Phase 1c: multi-turn accretion eval (eval-multi.mjs) — THE decisive result

One 8-turn session per (arm × model), models = claude-sonnet-5 (github)
and gpt-5.4 (BYOK azure — the waldemort-chk production model).
Trigger-based delineation rules in the ON arm. All arms 8/8 correct.

| model | arm | adoption | parent ctx t1→t8 | cum. parent input | cost units* | wall |
|---|---|---|---|---|---|---|
| gpt-5.4 | off | — | 22.1K → 56.1K | 2,297K | 1,307K | 92s |
| gpt-5.4 | on | **8/8** | **21.8K → 26.5K (flat)** | **718K (−69%)** | **747K (−43%)** | 125s (+36%) |
| sonnet-5 | off | — | 28.4K → 46.2K | 2,018K | 1,195K | 68s |
| sonnet-5 | on | 1/8 | 31.2K → 50.5K | 2,095K | 1,931K (+62%) | 183s |

\* cache-aware: fresh×1 + cacheWrite×1.25 + cacheRead×0.1 + output×5,
parent+subagent lanes combined.

**Findings:**
1. **For gpt-5.4 — the actual production model — this is a massive win.**
   It followed the delegation rules on every turn; the parent context curve
   went *flat* (26.5K after 8 verbose turns vs 56.1K without), cutting
   total cache-aware cost 43% despite paying for subagents. This is the
   exact accretion pathology measured on chk (31K/request baseline,
   1.5–2M input/turn sessions), and the task tool fixes it at the source.
2. **For sonnet-5 it is net negative.** It correctly judges that its own
   surgical grep is cheaper and ignores the delegation guidance (1/8) —
   and its single delegation exposed the haiku trap (below). Do not ship
   the delegation guidance to strong-explorer models.
3. **The haiku trap: never pin subagents weaker than the parent.** The
   built-in explore pins claude-haiku-4.5; on a one-function question it
   spiraled — 25 tool calls, 26 model calls, 559K tokens, 112s. Meanwhile
   the gpt arm's subagents ran gpt-5.4 (the haiku pin FELL BACK because
   azure doesn't serve it) and averaged ~42K cost units per delegation.
   The accidental fallback is the correct design: **disable ALL built-ins
   (explore included) and ship custom agents with no model pin** so they
   inherit the parent session model. Phase 1d (on2 arm) validates this.

## Phase 1d: on2 arm — custom-only roster, no model pins

Same 8-turn protocol; ALL built-ins disabled (explore included), custom
`swarm-explore` + `swarm-task` (no model pins → inherit parent model).

| model | off | on (built-ins) | on2 (custom-only) |
|---|---|---|---|
| gpt-5.4 cost units | 1,307K | 747K (−43%) | **627K (−52%)** |
| gpt-5.4 final ctx | 56.1K | 26.5K | **25.7K** |
| gpt-5.4 adoption | — | 8/8 | 8/8 |
| sonnet-5 cost units | 1,195K | 1,931K (+62%) | 1,377K (+15%) |
| sonnet-5 final ctx | 46.2K | 50.5K | 44.5K |
| sonnet-5 adoption | — | 1/8 | 3/8 |

- **Custom-only strictly dominates built-ins for both models.** No spirals:
  sonnet's subagents ran at sonnet and stayed surgical (6/3/10 tool calls).
- gpt-5.4 improves to **−52% total cost**, context curve flat.
- sonnet still nets +15% cost and 2.6× wall clock — its own direct
  exploration is simply cheaper than delegation on this workload.

## Phase 1e: on3 arm — cheap-pinned subagents (the pricing question)

Identical to on2 except both custom agents pin one tier down on the same
provider (haiku-4.5 under github, gpt-5.4-mini under azure). Same prompts,
same ~6-call budget — isolates the pin variable.

| | on2 sub-lane (inherit) | on3 sub-lane (cheap pin) | token inflation | price gap needed to break even |
|---|---|---|---|---|
| gpt: gpt-5.4 → mini | 221,848 units | 490,143 units | 2.21× | mini must be >2.21× cheaper (it is, typically 4–6×) |
| sonnet → haiku | 365,111 units | 559,391 units | 1.53× | haiku must be >1.53× cheaper (it is, ~3×) |

- **With a call budget in the prompt, cheap models did NOT spiral.** The
  earlier 559K-token haiku disaster was the *built-in* explore (different
  prompt, no budget). Our budgeted swarm agents stayed bounded.
- **Cheap pins are dollar-rational**: ~2× cheaper subagent lane for both
  providers after price adjustment. Since the subagent lane is ~35% of
  total spend, that's roughly a further 15–18% off the total.
- **Costs of cheap pins**: gpt-5.4-mini dropped one answer (7/8, a
  file-count task via swarm-task); wall clock is the slowest of all arms
  (sonnet/haiku 212s). Quality wobble is real but small.
- Parent-lane costs and the flat context curve are unchanged by pinning —
  the big win never depended on subagent pricing.

**Pinning recommendation:** registry-driven policy per agent —
`cheap-tier same provider` as the default for `swarm-task`, deployment
choice between `cheap-tier` (dollars) and `inherit` (latency/quality) for
`swarm-explore`; always ship the call-budget line in agent prompts; rely
on CustomAgentConfig's verified fallback-to-parent when a provider lacks
the pinned model.

## Leak guarantee

Across all 40 experiment/eval sessions, the only subagent-lane `ps_*`
invocations are the two deliberate pre-mitigation probes (`leak`,
`shadow`). Under the locked/on2 recipe: **zero leaks**, while the parent
kept full access to the durability tools throughout.

## Final recommendation

1. **Enable the native task tool per-model, not fleet-wide.** Gate on the
   session's effective model family: ON + delineation guidance for
   gpt-5.4-class models (this is chk's fleet — the measured win is −52%
   cost and a flat context curve); OFF (or present-but-unguided) for
   sonnet/opus-class models, which self-serve more cheaply.
2. **Ship the locked recipe**: drop `task` from `excludedTools`; write
   worker-global `settings.json` disabling ALL built-in subagents; add
   `swarm-explore` + `swarm-task` customAgents with explicit tool
   allowlists (`bash`/`view`/`grep`/`glob` family) and **no model pin**.
3. **Where task stays off, also exclude** `read_agent`, `list_agents`,
   `write_agent` (−1,209 tokens/session, kills chk's 100%-failing
   read_agent pattern).
4. **Delineation** (prompt layer, only where task is ON): durable work →
   `spawn_agent` (survives restarts, portal-visible, messageable);
   intra-turn search/command noise → `task` subagents (die with the turn).
   Trigger-rule phrasing measurably outperforms "you may use" phrasing
   for gpt-family adoption (8/8 vs the soft phrasing's partial uptake).
