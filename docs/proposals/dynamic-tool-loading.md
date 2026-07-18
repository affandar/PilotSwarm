# Dynamic Tool Loading (`load_tools`) — Minimal MVP

**Status:** Draft / RFC
**Date:** 2026-07-18
**Branch baseline:** `feat/per-agent-mcp-servers` (per-agent MCP only — **no**
capability tiers, catalog, session overrides, or `configure_session`; this
proposal does not depend on any of that).

## Problem

Every tool a session might use is registered up front. `SessionManager`
assembles one tool array at session build and `ManagedSession` re-registers
that same set every turn (`registerTools(allTools)`), so every tool's JSON
schema sits in context for the whole session. In particular the per-session
**factory tools** load unconditionally: `createGraphTools` (all sessions when a
graph store is configured), `createInspectTools` (observability), etc. Measured
on the flagship deployment, a generic session carries ~17.5K tool-definition
tokens, much of which a given session never uses.

We want a session to start with a **lean default set** and let the model pull in
an extra tool group **only when it needs it**.

## What this branch already gives us (the whole substrate)

- **Per-turn re-registration.** `ManagedSession._runTurnInner` calls
  `registerTools(allTools)` every turn (comment: "may have changed"). The tool
  set is already allowed to differ turn-to-turn — no new mechanism needed to
  change it.
- **The assembly runs in an activity, not orchestration replay.**
  `SessionManager.getOrCreate` / `_getOrCreateUnlocked` runs inside the
  `runTurn` **activity**. Activities may do IO and read mutable state — so
  reading a durable "what's loaded" record at assembly is replay-safe **without
  touching the orchestration or bumping its version**.
- **A single assembly join point.** `allTools` is built in one place from the
  factory tools + the inherited tool names. Gating a factory group there is a
  small, contained change.
- **A durable session store already exists** (CMS `sessions` + `cms_*`
  functions, the same place per-agent MCP and session columns live). One
  additive column carries the loaded set.

That's everything. No catalog service, no tier model, no new orchestration
version.

## Design (MVP)

Four small pieces:

### 1. A static tool-group manifest (SDK constant)

A plain map in the SDK — `tool-groups.ts` — no catalog infrastructure:

```ts
export const BASE_TOOL_GROUPS = ["session", "sub-agents", "messaging", "facts", "artifacts"]; // always on
export const LOADABLE_TOOL_GROUPS: Record<string, string[]> = {
  graph:         ["graph_search_nodes", "graph_search_edges", "graph_neighbourhood", /* … */],
  observability: ["read_fleet_stats", "read_session_info", /* … */],
  maintenance:   ["compact_database", "scale_workers", /* … */],
};
```

`BASE_TOOL_GROUPS` are always assembled; `LOADABLE_TOOL_GROUPS` are off unless
loaded. (The names must match the factory `defineTool` names; a tiny unit test
pins that, so a renamed tool can't silently drift.)

### 2. A durable per-session `loaded_tool_groups`

One additive migration — a nullable column plus two functions, the same
probe-guarded shape the codebase already uses:

```sql
ALTER TABLE ${s}.sessions ADD COLUMN loaded_tool_groups TEXT[];
-- cms_add_loaded_tool_groups(session_id, groups[])  → union-append, returns the new set
-- cms_get_loaded_tool_groups(session_id)            → the set (or empty)
```

Group-scoped and additive — a set of group names, not a general override. Stored
on the session's own row (no tree/root semantics needed for the MVP).

### 3. The `load_tools` tool (always in the base set)

```jsonc
load_tools({ groups: ["graph"] })
// → "Loaded: graph. Available from your next step."
```

Handler: validate the names against `LOADABLE_TOOL_GROUPS`, union-append them to
the session's `loaded_tool_groups` via the CMS function, and return. It runs in
the turn (the activity), so it writes CMS directly — no durable command, no
orchestration change. Idempotent on activity retry (it's a set union).

The tool's **description carries the compact index** — one line per loadable
group (`graph — knowledge-graph search/traversal; observability — fleet/session
metrics; …`) — so the model knows what it can ask for without a separate
discovery call or extra context.

### 4. Assembly gate + read

In `_getOrCreateUnlocked` (already the assembly point):

```ts
const loaded = new Set(await this.sessionCatalog?.getLoadedToolGroups(sessionId) ?? []);
// keep a factory group's tools only if it is a base group or has been loaded
const keep = (t) => groupOf(t) === undefined /* ungrouped/base tools */
  || BASE_TOOL_GROUPS.includes(groupOf(t))
  || loaded.has(groupOf(t));
allTools = allTools.filter(keep);
```

The read is **fail-open**: `load_tools` is additive/opt-in, not a restriction,
so a read error simply means the extra groups aren't loaded this turn — no
security concern, no need to fail the turn (unlike a capability *restriction*,
which would fail closed).

## Flow

1. Session starts lean: base groups + Copilot builtins only. Graph/observability
   tool schemas are **not** in context.
2. Model needs the graph → calls `load_tools(["graph"])`, ends its step.
3. Next step: assembly reads `loaded_tool_groups`, includes the graph factory
   tools, `registerTools` picks them up, the model uses them.

One extra turn of latency the first time a group is needed; free thereafter (the
set persists on the session row for the session's life).

## Why no orchestration version bump

The only durable state is the CMS column, written by a tool during the activity
and read by the next turn's assembly — also in an activity. The orchestration
generator's replayed logic (commands, continue-as-new, KV) is untouched, so
there is nothing to version. This is the key simplification versus a
command-based design.

## MVP scope (deliberately small)

- **Tools only.** MCP servers are fixed at session build on this branch
  (per-agent resolution happens at assembly and a change needs a rebind), so
  dynamic MCP loading is **out of scope** for the MVP.
- **Group-level**, not per-tool. Smaller index, simpler manifest.
- **Session-scoped persistence.** A loaded group stays for the session; no
  ephemeral/once semantics.
- **Group names only**, no semantic `request_tools({query})` search.
- **No per-user / no auth surface** — loading is behavioral, not a permission.

## Implementation checklist

| # | Change | File |
|---|---|---|
| 1 | `BASE_TOOL_GROUPS` + `LOADABLE_TOOL_GROUPS` + `groupOf()` | `packages/sdk/src/tool-groups.ts` (new) |
| 2 | Migration: `loaded_tool_groups` column + `cms_add_/get_loaded_tool_groups` (probe-guarded) | `packages/sdk/src/cms-migrations.ts`, `cms.ts` |
| 3 | `getLoadedToolGroups` / `addLoadedToolGroups` on `SessionCatalog` | `packages/sdk/src/cms.ts` |
| 4 | `load_tools` tool (validate → union-append → return; index in description) | `packages/sdk/src/managed-session.ts` |
| 5 | Assembly gate: filter factory tools by base ∪ loaded | `packages/sdk/src/session-manager.ts` |
| 6 | Mention `load_tools` in the base agent prompt | `packages/sdk/plugins/system/agents/default.agent.md` |
| 7 | Tests: manifest-vs-`defineTool` drift guard; gate keeps base, drops unloaded, includes loaded; `load_tools` unions & is idempotent | `packages/sdk/test/unit/` |

No orchestration, protocol, portal, or MCP-server changes required for the MVP.

## Open questions

1. Should loaded groups reset at continue-as-new (fresh minimal each hydration)
   or persist for the session's life (default here)?
2. Do we expose which groups a session loaded (a `session.tools_loaded` event)
   for auditing, or keep the MVP silent?
3. Is group-level the right grain, or do a couple of large groups (observability)
   want sub-splitting later?

## Later (explicitly not in the MVP)

Per-tool loading, semantic discovery, ephemeral loads, dynamic MCP-server
loading (needs a session rebind), and an operator-facing catalog. Each is
additive on top of the MVP and none is required to ship it.
