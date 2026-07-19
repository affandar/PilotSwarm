# Skill-Triggered Tool Loading

**Status:** Draft / RFC
**Date:** 2026-07-18
**Branch baseline:** `feat/per-agent-mcp-servers` (per-agent MCP only — **no**
capability tiers, catalog, session overrides, or `configure_session`; this
proposal depends on none of that).

## Problem

Every tool a session might use is registered up front. `SessionManager`
assembles one tool array at session build and `ManagedSession` re-registers it
every turn (`registerTools(allTools)`), so every tool's JSON schema sits in
context for the whole session. The per-session **factory tools** load
unconditionally (`createGraphTools` on every session when a graph store is
configured, `createInspectTools`, etc.). Measured on the flagship deployment, a
generic session carries ~17.5K tool-definition tokens, much of it unused.

The obvious fix — load tools only when needed — has one hard problem:
**discovery.** If a tool group is off by default, the model can't call it *and
won't know it exists*, so it says "I can't do that" instead of loading it. A raw
`load_tools` meta-tool only half-solves this: the model has to notice the
meta-tool, read a hand-maintained index, and map the task to a group name — the
same prompt-adherence gamble that made the `wait` tool narrate a fake result.

## Key insight: skills are already the lazy-discovery surface

The Copilot CLI already gives the model a lazy, discoverable capability surface —
**skills** — and it already ties tools to them:

- Skills are listed cheaply (name + description); the model **invokes** a skill
  when a task matches, and the CLI injects the skill's `content` (body) into the
  conversation on demand. That is native lazy loading the model already uses.
- The CLI emits a native **`skill.invoked`** event (`SkillInvokedData`) carrying
  the skill `name`, its `content`, and **`allowedTools`** ("tool names that
  should be auto-approved when this skill is active"), plus a `trigger`
  (`user-invoked` / `agent-invoked` / `context-load`).

So instead of a synthetic `load_tools` tool + a hand-rolled index, make **skill
invocation the trigger for tool loading.** The model discovers capability the
way it already does (pick the skill that fits the task); the tools come with the
skill; and the skill body *teaches* their use — something raw tool schemas never
do.

### What's native vs. what we build

Native (CLI): the skill list, lazy `content` injection on invocation, the
`skill.invoked` event, and `allowedTools` as an **auto-approval** list.

Not native — what this proposal adds: `allowedTools` waives the *permission*
prompt for tools that are **already registered**; the CLI does **not** add new
tools to the session when a skill is invoked. PilotSwarm builds that coupling:
start with skill-owned tools **gated off**, and **load them when their skill is
invoked**.

## What this branch already gives us

- **Per-turn re-registration** — `registerTools(allTools)` runs every turn
  ("may have changed"); the set is already allowed to change turn-to-turn.
- **Assembly runs in the `runTurn` activity**, not orchestration replay — so a
  durable read at assembly (and a side-effecting write when a skill is invoked)
  is replay-safe **without an orchestration version bump.**
- **A single factory-tool assembly point** (`_getOrCreateUnlocked`) to gate.
- **`Skill.toolNames`** already parsed from each skill's `tools.json`
  (`skills.ts`), giving a skill→tools mapping independent of the CLI event.
- **PilotSwarm captures the CLI event stream** (`onEvent` → `CapturedEvent`), so
  `skill.invoked` is observable in-flight.
- **A durable session store** for one additive column.

## Design

Four pieces:

### 1. Skill-owned tools are gated OFF by default

A tool is assembled if it is a **base** tool (session/sub-agents/messaging/
facts/artifacts + the durable floor) **or** it belongs to a skill that this
session has invoked. Tools owned by an un-invoked skill are dropped from
`allTools`, so their schemas never load. "Owned by a skill" = present in that
skill's `tools.json` / `allowedTools`.

Deployments express which heavy tools are skill-gated by declaring them in a
skill (e.g. a `knowledge-graph` skill whose `tools.json` lists the `graph_*`
tools). Tools no skill declares keep today's behavior.

### 2. Trigger: `skill.invoked`

While a turn runs, PilotSwarm watches captured events for `skill.invoked`. On
one, it records the invoked **skill name** into the session's durable
`loaded_skills` set (union-append; idempotent on activity retry).

### 3. Mapping: `allowedTools` ∪ `tools.json`

The tools a skill loads = its event `allowedTools` unioned with its parsed
`Skill.toolNames`. Storing the *skill name* (not the tool list) means the
mapping is re-derived from the current skill definition at each assembly, so a
skill's tool set can change without rewriting stored state.

### 4. Assembly gate + read

In `_getOrCreateUnlocked` (already the assembly point):

```ts
const invoked = new Set(await this.sessionCatalog?.getLoadedSkills(sessionId) ?? []);
const enabledSkillTools = new Set(
  [...this.workerDefaults.skills]              // name → Skill
    .filter(([name]) => invoked.has(name))
    .flatMap(([, s]) => s.toolNames));
const skillOwned = /* union of every skill's toolNames */;
const keep = (t) => !skillOwned.has(t.name)   // not skill-gated → today's behavior
  || enabledSkillTools.has(t.name);           // gated but its skill was invoked
allTools = allTools.filter(keep);
```

Read **fail-open**: loading is additive/opt-in, not a restriction, so a read
error just means the extra tools aren't loaded this turn — no security concern,
no reason to fail the turn.

## Flow

1. Session starts lean: base tools + Copilot builtins. `graph_*` schemas are
   **not** in context; the `knowledge-graph` **skill** is listed (cheap).
2. User asks a graph question → the model, scanning skills, invokes
   `skill("knowledge-graph")`. The CLI injects the skill body **this turn**
   (how-to), and PilotSwarm records the skill in `loaded_skills`.
3. **Next step:** assembly sees `knowledge-graph` invoked, includes its `graph_*`
   tools, `registerTools` picks them up, the model uses them — guided by the body
   it already has.

Discovery is native (the model picked a skill, which it does well); the tools and
their instructions arrive together.

## Why no orchestration version bump

The only durable state is one CMS column, written as a side effect when
`skill.invoked` is observed (in the `runTurn` activity) and read by the next
turn's assembly (also an activity). The orchestration generator's replayed logic
is untouched — nothing to version.

## Caveats (honest)

- **One-turn lag.** The skill body loads the turn it's invoked; its tools appear
  the *next* step (per-turn `registerTools`). The skill body should say so
  ("these tools become available on your next step"). Removing the lag needs
  mid-turn re-registration — out of the MVP.
- **We own the coupling.** The CLI's `allowedTools` is auto-approval only; the
  load is PilotSwarm's, keyed off the observed event.
- **Tools must be gated off** to get any context savings — this reuses the
  assembly gate, so it's not a zero-change feature.
- **Adherence is far better but not free.** The model still has to pick the right
  skill — but that's the discovery task it's already good at (skill descriptions
  worded by intent), not a synthetic meta-tool it has to remember. Right-sizing
  the base set so skills are for the *occasional* heavy group keeps the trigger
  rare.

## Composes with sub-agents

A specialist agent can **preload** its skill (context-load trigger) so its tools
are present from turn one; a generalist session **invokes** the same skill on
demand. Same skill, same tool mapping, both paths — no divergence.

## `load_tools` — optional fallback only

For tool groups genuinely not tied to any skill, a minimal explicit
`load_tools({ groups })` can remain as a fallback using the same loaded-set +
gate. It is **not** the primary mechanism and can be omitted from the MVP; skill
invocation is the intended path.

## MVP scope

- **Tools only** (MCP is fixed at session build on this branch — dynamic MCP is
  out of scope).
- **Skill-triggered**; `load_tools` deferred/optional.
- **Skill-scoped persistence** (an invoked skill's tools stay for the session).
- **No per-user / no auth surface** — loading is behavioral.

## Implementation checklist

| # | Change | File |
|---|---|---|
| 1 | Migration: `loaded_skills TEXT[]` column + `cms_add_/get_loaded_skills` (probe-guarded) | `cms-migrations.ts`, `cms.ts` |
| 2 | `getLoadedSkills` / `addLoadedSkills` on `SessionCatalog` | `cms.ts` |
| 3 | Observe `skill.invoked` in the turn's captured events → `addLoadedSkills` | `managed-session.ts` |
| 4 | Assembly gate: drop skill-owned tools unless their skill is in `loaded_skills` | `session-manager.ts` |
| 5 | Base-agent prompt: "capabilities may live behind skills; invoke the matching skill, then use its tools next step" | `system/agents/default.agent.md` |
| 6 | A fixture skill that owns a heavy group (e.g. `knowledge-graph` → `graph_*`) for testing | `packages/app/tui/plugins/skills/` |
| 7 | Tests: gate drops un-invoked skill tools / includes invoked ones; `skill.invoked` observation unions & is idempotent; non-skill tools unaffected | `packages/sdk/test/unit/` |

No orchestration, protocol, portal, or MCP-server changes for the MVP.

## Open questions

1. Do invoked skills' tools persist across continue-as-new (default here) or
   reset to lean each hydration?
2. Should a skill's tools unload when its content ages out of the context window,
   or stay for the session? (MVP: stay.)
3. Emit a `session.tools_loaded` / rely on the native `skill.invoked` event for
   auditing which tools a session pulled in?
4. Is the one-turn lag acceptable, or is mid-turn re-registration worth the
   added complexity for hot paths?
