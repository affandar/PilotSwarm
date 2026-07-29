# Deleting an already-terminal session skips the descendant cascade and orphans its subtree

**Date observed:** 2026-07-28 12:56–14:55 UTC
**Status:** FIXED in source 2026-07-28 (unreleased) — see [Resolution](#resolution)
**Product area:** PilotSwarm SDK — `PilotSwarmClient.deleteSession` / `PilotSwarmManagementClient.deleteSession` (surfaced via the `delete_agent` tool, the portal delete button, and the MCP `delete_session` tool)
**Severity:** Medium — no data loss, but session-tree integrity is corrupted and orphans accumulate on every reap cycle (~2/hour on the affected deployment)
**Environment:** production PilotSwarm deployment, portal `pilotswarm@0.5.28`, Duroxide orchestration `1.0.68`. Root cause verified against repo source and reproduced against a local Postgres CMS.

## Summary

Descendant cleanup ("delete my descendants, then myself") is implemented in exactly one place: the `delete` command handler inside a session's own **running** orchestration. Every delete path therefore branches on whether the target is still live:

- **live target** → a `delete` command is sent into the target's orchestration, which enumerates descendants via `getDescendantSessionIds()` and soft-deletes each before itself. Tree stays consistent.
- **already-terminal target** → there is no orchestration to receive the command, so the caller soft-deletes the target's row directly — a **single-row** update with no descendant handling anywhere below it (no cascade in the client code, no trigger, no foreign key in the CMS schema).

The terminal branch is the one a well-behaved reaper always hits, because it deliberately waits for a worker to finish before closing it out.

What makes the damage permanent is the read side: `cms_get_descendant_session_ids` is a recursive CTE that filters `deleted_at IS NULL` at **every** level of the walk, so a subtree is only reachable *through* its interior nodes. Soft-deleting one node severs everything below it from every ancestor's tree — the children are never marked; they are simply unreachable.

This contradicts the `delete_agent` tool description shipped to the model, which explicitly promises the cascade.

## Impact

On the affected deployment, a top-level watcher session reaped its finished per-cycle workers once per hourly cycle. Each reap orphaned that worker's analyst children:

| Orphaned session | Status | Deleted parent | Cycle |
|---|---|---|---|
| `e15837bd-6b74-40ba-a387-68ebaf53e7f3` | completed | `6e9da291-4e33-4523-a749-451a53cb1882` | c150 |
| `08914980-9698-4120-8b50-0d1ae24b2d00` | completed | `713470eb-a3c4-4fc8-9437-1db923a6d69b` | c151 |
| `88a80bdb-1f06-43e1-8f68-7f42bd7cadc1` | completed | `713470eb-a3c4-4fc8-9437-1db923a6d69b` | c151 |
| `809b5426-2aea-4192-9f8b-24994e938208` | completed | `af734a6e-8016-4aa9-a98c-898e241cbd09` | c152 |

Observable consequences:

- The orphans detach from `get_agent_tree` and render as loose top-level-looking rows in the portal sidebar, mixed in with real roots.
- The immediate parent link is dead: every read path on the parent returns `Session not found`. The **root** is still recoverable, though — `root_session_id` is denormalized onto every row at creation and survives the parent's deletion, so an orphan's tree-of-origin can be answered from its own row. Only parent-hop lineage requires `list_sessions({ include_deleted: true })` reconstruction.
- Terminal orphans remain individually collectable by Sweeper (`scan_completed_sessions` walks the flat session list, and `cleanup_session` cascades properly), so the count does not grow unboundedly where Sweeper runs — but the tree is wrong in the interim, and the earlier `sweeper-root-session-cleanup-20260628` incident argues against leaning on Sweeper for structural repair.
- A **live** orphan (possible, since nothing cancels children when a parent completes) is worse: Sweeper refuses to touch live sessions, so it would run indefinitely with no reachable lineage.

## Evidence

Top-level watcher `46eaff4a-a3d7-4529-89f4-2bcfcf4c2179` (a long-running scheduled monitor, 489 iterations, `idle`). Its event stream shows the reap pattern (`tool.execution_start`, `toolName: delete_agent`):

| Time (UTC) | seq | Target | Outcome |
|---|---|---|---|
| 12:56:09.642 | 3563301 | `session-6e9da291…` (c150) | executed |
| 13:54:38.098 | 3575669 | `session-713470eb…` (c151) | **not executed** (see secondary issue) |
| 13:56:49.502 | 3576129 | `session-713470eb…` (c151) | executed |
| 14:52:53.373 | 3580431 | `session-af734a6e…` (c152) | executed |
| 14:55:09.722 | 3580553 | `session-af734a6e…` (c152) | executed |

Representative call:

```json
{
  "eventType": "tool.execution_start",
  "data": {
    "toolName": "delete_agent",
    "arguments": {
      "agent_id": "session-713470eb-a3c4-4fc8-9437-1db923a6d69b",
      "reason": "c151 detection result already consumed and reported; closing out stale completed worker"
    }
  },
  "createdAt": "2026-07-28T13:56:49.502Z"
}
```

The deleted parent's CMS `updated_at` is `1785247009541` = `2026-07-28T13:56:49.541Z` — 39 ms after that call, confirming it is the delete.

Post-delete probe matrix for `713470eb-a3c4-4fc8-9437-1db923a6d69b`:

| Probe | Result |
|---|---|
| `get_session_detail` | `Session not found` |
| `get_session_metrics` | `Session not found` |
| `get_session_events` | `Session not found` |
| `get_agent_tree(46eaff4a)` | 7 nodes returned; `713470eb` **absent**, and so are its two children |
| `list_sessions({ include_deleted: true })` | **present** — `status: completed`, `parent_session_id: 46eaff4a…` |
| `list_agents({ parent_session_id: 713470eb })` | returns **2 children**, both `completed`, both **not deleted** |

The same matrix reproduces exactly for `af734a6e…` → `809b5426…` and `6e9da291…` → `e15837bd…`.

**Local reproduction** (three CMS rows, no worker needed): create `A → B → C`, all `completed`; call the terminal delete path on `B`:

```text
BEFORE delete — descendants of A: 2 [ B, C ]
AFTER  delete — descendants of A: 0 []
B readable via getSession:       NO (deleted)
C readable via getSession:       YES
C still in listSessions():       YES (live row)
C.parentSessionId:               B            ← dangling
C.rootSessionId:                 A            ← survives
```

## Root-cause analysis

### 1. The `delete_agent` fast path branches on liveness

`src/orchestration/agents.ts`, `case "delete_agent"`:

```ts
if (isSubAgentTerminalStatus(agentEntry.status)) {
    yield runtime.manager.deleteSession(agentEntry.sessionId, deleteReason);   // ← fast path
    state.subAgents = state.subAgents.filter((agent) => agent.orchId !== targetOrchId);
    queueFollowup(runtime, `[SYSTEM: Sub-agent ${targetOrchId} has been deleted....]`);
    return true;
}
const cmdId = `delete-${state.iteration}-${agentEntry.sessionId.slice(0, 8)}`;
yield runtime.manager.sendCommandToSession(agentEntry.sessionId, { type: "cmd", cmd: "delete", ... });
```

Only the command branch cascades. Its follow-up message even says so — *"It will cancel its descendants first and then delete itself"* — while the terminal branch's follow-up says only *"Sub-agent … has been deleted."*

### 2. Where the fast path actually lands: `PilotSwarmClient.deleteSession`

An earlier draft of this report attributed the fast path to `PilotSwarmManagementClient._forceDeleteSession`. That is wrong, and the discrepancy matters for the fix. `runtime.manager.deleteSession` is a session-proxy **activity** (`src/session-proxy.ts`, `registerActivity("deleteSession", ...)`) that constructs a `PilotSwarmClient` and calls its `deleteSession` (`src/client.ts`):

```ts
// CMS: soft-delete (source of truth)
await this._catalog.softDeleteSession(sessionId);
// ...facts cleanup...
// Duroxide: cancel orchestration (best effort)
await this.duroxideClient.cancelInstance(orchestrationId, "Session deleted");
```

One row, no descendant enumeration. The confirming fingerprint: `_forceDeleteSession` writes `state: "failed"` before soft-deleting, yet the deleted parents read `status: completed, error: null` in `list_sessions({ include_deleted: true })`. Only `PilotSwarmClient.deleteSession` — which writes no state at all — leaves that signature. (The earlier draft flagged this as unexplained build drift; it is actually the proof of which code path ran.)

### 3. Two more entry points share the defect

- **Inline control bridge** (`src/session-proxy.ts`, `controlBridge.deleteAgent`): same liveness branch; the terminal arm calls `sdkClient.deleteSession(child.sessionId)` — the same single-row path.
- **`PilotSwarmManagementClient.deleteSession`** (`src/management-client.ts`): the portal's `DELETE /sessions/:sessionId` and the MCP `delete_session` tool both land here. Its terminal predicate (`pending` / `completed` / `failed` / `cancelled` / unknown orchestration status) short-circuits to `_forceDeleteSession` — also a single-row delete. **Deleting any completed parent from the portal orphaned its children the same way.**

### 4. Why the orphaning is permanent

`cms_get_descendant_session_ids` (`src/cms-migrations.ts`):

```sql
WITH RECURSIVE descendants AS (
    SELECT s.session_id FROM sessions s
    WHERE s.parent_session_id = p_session_id AND s.deleted_at IS NULL
    UNION ALL
    SELECT s.session_id FROM sessions s
    INNER JOIN descendants d ON s.parent_session_id = d.session_id
    WHERE s.deleted_at IS NULL
)
```

The `deleted_at IS NULL` filter in both the anchor and the recursive term means the walk can never pass *through* a deleted row. `get_agent_tree` independently reproduces the same severance (flat `listSessions()` — deleted already filtered — then an in-memory parent→child walk). There is no trigger and no foreign key on `parent_session_id` to compensate.

In one sentence: **descendant cleanup lives in the runtime, but the tree lives in the database — and the database's traversal cannot pass through a deleted node.**

## Contract violation

The tool description presented to the model (captured verbatim from the `permission.requested` event, seq 3575670):

> "Gracefully delete a sub-agent entirely. **The sub-agent first follows the cancellation route for any live descendants, then deletes itself when the subtree is terminal.** ONLY works for sub-agents spawned and tracked by THIS current session via `spawn_agent`. Use this only to clean up your own spawned sub-agents you no longer need."

A model reading that description reasonably concludes that deleting a finished worker is safe and self-contained. The runtime silently did something else. Agents that follow the documented "wait for the worker to finish, then clean it up" discipline were precisely the ones that corrupted the tree.

## Secondary issue (still open): `delete_agent` silently no-ops when a control tool already scheduled a suspend

At 13:54:38 the first `delete_agent` for c151 never ran. `tool.execution_complete` seq 3575676:

```text
[SYSTEM: delete_agent was not executed because a previous control tool already scheduled this turn to suspend.
Stop now; the runtime will resume with the control-tool result.]
```

The preceding tool in the same turn was `wait` (seq 3575675). The same double-call pattern appears for c152 (14:52:53 then 14:55:09). This is not the orphaning bug, but it costs a full model round-trip per reap and shows up as a duplicated destructive call in the audit trail. Worth deciding whether the suppression should be a retryable error rather than a "completed" tool result.

## Resolution

Fixed 2026-07-28 by cascading in the two client classes every terminal delete funnels through — enumerating descendants **before** deleting the target row (afterwards the walk returns nothing):

1. **`src/client.ts` — `PilotSwarmClient.deleteSession`**: the old single-row body is extracted into a private `_deleteOneSession` (CMS soft-delete + session-fact cleanup + best-effort duroxide cancel); `deleteSession` now enumerates descendants and runs `_deleteOneSession` on each before the target, with per-descendant try/catch so an undeletable (e.g. system) node doesn't strand its siblings. This fixes both `delete_agent` paths — durable orchestration (via the session-proxy activity) and the inline control bridge — with **no orchestration version bump**, since activity implementations are not part of durable replay.
2. **`src/management-client.ts` — `PilotSwarmManagementClient.deleteSession`**: the terminal fast path enumerates descendants and `_forceDeleteSession`s each before the target, using the same `Ancestor <id> deleted: <reason>` annotation the live path writes. This fixes the portal and MCP delete paths.

A cascade in `cms_soft_delete_session` itself was rejected: a DB-level cascade would flip `deleted_at` on a still-running descendant without cancelling its orchestration (a zombie writing to a deleted session) and would skip the per-session facts/duroxide cleanup. The client layer is the lowest place that knows how to kill a session properly.

Known residual gaps (follow-up, not covered by this fix): the live path's cascade swallows descendant-enumeration failure and proceeds to delete the parent anyway, and a child spawned between enumeration and deletion can still slip through. Both are races on the command path, distinct from the deterministic fast-path bug fixed here.

## Validation

`test/local/delete-cascade.test.js` (Postgres-backed, no worker/LLM required — builds CMS-only trees):

1. `PilotSwarmClient.deleteSession` on a completed mid-tree node cascades through the full `A → B → C → D` chain, leaving `A` intact.
2. Leaf delete behaves exactly as before (regression guard).
3. An undeletable system descendant is skipped without aborting the cascade; normal siblings still cascade.
4. `PilotSwarmManagementClient.deleteSession` cascades on a completed mid-tree node (rows with no orchestration hit the exact terminal-fast-path predicate).
5. Deleting a completed **root** via the management client (the portal case) deletes the whole tree.
6. `failed` and `cancelled` targets cascade too, not just `completed`.

Every test also asserts a global no-orphan invariant: no live row's `parent_session_id` may point at a deleted row. Live-path regression (target still running) is not re-tested here — that code path is untouched — and remains covered by the existing sub-agent lifecycle suites. Backfill note: pre-existing terminal orphans remain individually deletable as leaf sessions, and their `root_session_id` still identifies their tree of origin for optional re-parenting.
