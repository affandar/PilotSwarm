# Dynamic Tool Loading (`load_tools`)

**Status:** Draft / RFC
**Date:** 2026-07-18
**Scope:** a model-driven, on-demand tool-loading mechanism so a session
carries a minimal tool set by default and pulls in additional tool groups only
when it actually needs them — reducing per-session tool-definition context.

## Problem

Today every tool a session *might* use is registered up front: the full
resolved tool array is placed in the Copilot session config at assembly, and
every tool's JSON schema sits in the model's context for the entire session.
There is no lazy or need-based loading — `SessionManager._getOrCreateUnlocked`
builds one array (`allTools`) and `ManagedSession` re-registers that same set
every turn (`registerTools(allTools)`).

Measured on the flagship deployment (generic session, `claude-sonnet-5`,
tool-definition tokens only):

| Layer | Tokens |
|---|---:|
| Copilot builtins + 5 locked Base tools | ~6,158 |
| PilotSwarm Default custom tools (facts, sub-agents, messaging, artifacts, session) | ~8,337 |
| **Default session total** | **~14,495** |
| + knowledge graph (if loaded) | +2,162 |

Most sessions use a small fraction of these on any given turn. The capability
**tier** model (see `agent-and-session-capability-profiles.md`) already lets an
operator/agent *statically* trim the set (Extended/System off by default,
opt-in at create or via `configure_session`). Dynamic loading is the
**runtime, model-driven** complement: instead of deciding the toolset ahead of
time, the model asks for a tool group the moment it needs one.

## Non-goals

- Trimming the **Copilot builtins** (view/edit/bash/glob/grep/web_fetch/…) —
  that ~6.2K floor is a separate lever (`excludedTools: ["builtin:*"]`) and is
  out of scope here; this proposal governs PilotSwarm-registered tools and MCP.
- Replacing sub-agent delegation. Delegating a whole domain to a spawned agent
  that carries its own tools remains the right pattern for large, self-contained
  workstreams; `load_tools` is for pulling a group into the *current* session.

## Mechanism

Three pieces, all built on primitives that already exist:

1. **A compact tool index the model can see.** Rather than full schemas, the
   session's system prompt (or a cheap `list_available_tools` tool) carries a
   one-line-per-group index from the deployment capability catalog: group name,
   short description, member count, and current on/off state. Cost is a few
   hundred tokens vs the thousands the full schemas cost.

2. **A `load_tools` meta-tool** (always in the Base set):

   ```jsonc
   load_tools({ groups?: ["graph", "observability"], tools?: ["graph_search_nodes"] })
   // → "Loaded: graph, observability. Available from your next step."
   ```

   Its handler records the requested groups/tools as a **durable capability
   enable-delta** (the same shape as a session capability override:
   `{ tools: { enable: [...] } }`) and returns immediately. Optionally a
   `request_tools({ query })` variant does a semantic match over the catalog
   for models that don't know group names.

3. **Next-turn rebind.** The recorded delta feeds the existing assembly path:
   the next turn resolves `effective = agent profile ⊕ session override ⊕
   dynamic enables`, and `registerTools` includes the newly-enabled groups. The
   tier default-off filter simply stops dropping the now-opted-in tools.

The model calls `load_tools`, ends its step, and on the next step the tools are
present — exactly the round-trip this repo's own harness uses for deferred
tools.

## Why this is mostly plumbing

- **Per-turn re-registration already exists.** `ManagedSession` calls
  `registerTools(allTools)` every turn with the comment "may have changed" — the
  tool set is already allowed to differ turn-to-turn.
- **Durable, replay-safe capability deltas already exist.** The capability
  override is stored durably and applied at assembly without mid-turn reads of
  mutable state; `load_tools` writes the same kind of delta, so replay
  determinism is preserved (the enable enters via durable state, never a live
  read inside orchestration replay).
- **The catalog already enumerates groups and tiers.** The index the model sees
  is a projection of the existing `CapabilityCatalog` (names, groups, tiers) —
  no new inventory.
- **`configure_session` is the operator-driven precedent.** `load_tools` is the
  model-driven sibling: same durable-delta-then-rebind flow, different trigger.

## Durability & replay

`load_tools` must not mutate the live tool set mid-turn (that would be a
non-deterministic read on replay). Instead:

1. The tool handler emits a durable `tools_loaded` delta (a command on the
   orchestration `messages` queue, mirroring `set_capabilities`), scoped to the
   session tree root.
2. The turn ends; the orchestration drains the command between turns, merges the
   enables into the durable session config, and continues-as-new.
3. The next `runTurn` assembles with the enabled groups present.

Because the enable enters only via the durable command (or, for a within-turn
fast path, via a re-register that is itself recorded as a captured event), a
replay reconstructs the identical tool set at each turn.

**Scope of an enable.** Default: the enable persists for the rest of the
session (the model asked for graph once; keep it). Optionally support an
ephemeral form (`load_tools({ groups, once: true })`) that applies for the next
turn only and is dropped afterward, for a truly minimal steady state — at the
cost of re-loading on each use.

## Interaction with the tier model

- Base — always present (includes `load_tools` itself).
- Default — present by default; `load_tools` is unnecessary for these.
- **Extended / System — the primary targets.** These are off by default; a
  model that needs graph calls `load_tools(["graph"])` instead of requiring a
  human to opt in at create time. System-tier groups may still be gated to
  system agents (a normal session's `load_tools("maintenance")` is refused).
- MCP servers can be loaded the same way (`load_tools({ mcpServers: ["jira"] })`
  → enable-delta on the MCP axis), though an MCP enable triggers a session
  rebind (servers are fixed at session build), which is heavier than a tool add.

## Trade-offs

- **Latency:** one extra turn round-trip (ask → next step has it). For a tool
  the model almost always needs, static opt-in (agent profile / create-time
  override) is better; `load_tools` wins for occasional/branch-dependent needs.
- **Discovery:** the model only loads what it knows exists — the compact index
  must be good, and the prompt should tell the model to consult it before
  concluding a capability is unavailable.
- **Index cost:** the index itself consumes some context; keep it group-level
  (a few hundred tokens), not per-tool.
- **Thrash:** ephemeral (`once`) loading minimizes steady-state context but adds
  reload round-trips; session-scoped persistence is the sensible default.

## Alternatives considered

- **Static tier opt-in only** (current): simplest, but the human/agent-author
  must predict the toolset; a session that occasionally needs graph either
  carries it always or never.
- **Sub-agent delegation**: excellent for whole domains, wrong grain for
  "I need one more group in this session."
- **Fully lazy per-tool loading**: maximal savings, but per-tool round-trips and
  a large index; group-level loading is the better balance.

## Phased plan

1. **Index + `load_tools` (session-scoped, next-turn).** Add the meta-tool and
   the compact catalog index; reuse the capability enable-delta + rebind. No new
   durable primitives beyond the existing override command.
2. **`request_tools({ query })`** semantic discovery over the catalog for
   models that don't know group names.
3. **Ephemeral (`once`) loads** and telemetry (which groups get loaded, how
   often) to tune what should be Default vs Extended.
4. **MCP + builtins**: extend to MCP-server loading (with rebind) and, if
   desired, bring the Copilot builtins under the same index via
   `excludedTools: ["builtin:<name>"]`.

## Open questions

1. Within-turn fast path (re-register mid-turn) vs strictly next-turn — is the
   extra round-trip acceptable, or is a captured-event re-register worth the
   replay complexity?
2. Should loaded groups persist across continue-as-new by default, or reset to
   the agent baseline at each fresh turn unless re-loaded?
3. Does `load_tools` belong to every session, or only sessions whose agent
   opts into dynamic loading (some agents want a fixed, audited toolset)?
4. How does an operator audit what a session dynamically loaded — a
   `session.tools_loaded` event stream?
