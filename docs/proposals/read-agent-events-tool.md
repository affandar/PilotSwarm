# `read_agent_events` — Paginated Descendant Transcript Tool

## Summary

Add a single agent-facing tool, `read_agent_events`, that lets a parent (or any
ancestor) read the durable event stream of a descendant session in its spawn
tree. Pagination uses the existing `session_events.seq` cursor. No new
activity, no schema migration, no new orchestration version.

## Motivation

Today a parent agent only sees a descendant's terminal status and final
result string via `check_agents` / `wait_for_agents`, plus whatever the
descendant deliberately published as facts. There is no primitive for
"read what the child actually decided and why."

The portal already renders the full descendant transcript out of band,
because the data is there: `session_events` is keyed by `seq BIGSERIAL` with
an index on `(session_id, seq)`, and the CMS exposes
`cms_get_session_events` and `cms_get_session_events_before`. The data plane
is ready; only the agent-facing tool is missing.

## Design

### Tool

```jsonc
{
  "name": "read_agent_events",
  "description":
    "Read durable events from a descendant agent in your spawn tree, " +
    "paginated by seq cursor. Use cursor=null for the most recent page; " +
    "pass returned prevCursor to walk backwards. " +
    "Use this when check_agents / wait_for_agents / facts are not enough " +
    "to understand what the descendant did.",
  "parameters": {
    "type": "object",
    "properties": {
      "agent_id":   { "type": "string", "description": "Descendant session id (must be in your spawn tree)" },
      "cursor":     { "type": ["integer","null"], "default": null,
                      "description": "Seq cursor. null = most recent page; positive integer = events strictly older than this seq." },
      "limit":      { "type": "integer", "default": 50, "maximum": 200 },
      "event_types":{ "type": "array", "items": {"type":"string"},
                      "description": "Optional filter, e.g. ['assistant.message','tool.invoked','turn completed']" }
    },
    "required": ["agent_id"]
  }
}
```

### Return shape

```jsonc
{
  "agentId": "1c5cf42d-...",
  "events": [
    {
      "seq": 14823,
      "eventType": "assistant.message",
      "createdAt": "2026-04-17T09:12:04.117Z",
      "workerNodeId": "worker-a",
      "data": { /* original JSONB payload, possibly truncated */ }
    }
  ],
  "prevCursor": 14780,
  "nextCursor": 14901,
  "hasMore": true,
  "deletedAt": null
}
```

Semantics:

- Default page is **newest first**, returned in chronological order inside
  the page. Matches the natural "tail" the agent usually wants.
- `prevCursor` walks **older**. `nextCursor` is only populated when the
  caller passed an explicit `cursor`, allowing forward re-scan toward the
  tail.
- `hasMore = true` means older events still exist (independent of forward
  direction).
- If the target session is soft-deleted, events are still returned with
  `deletedAt` set. If hard-pruned, returns `{ events: [], deleted: true }`.

### Access control

- Resolve `descendants = await getDescendantSessionIds(callerSessionId)`.
- Reject with a clear permission error if `agent_id ∉ descendants`. Do not
  silently return empty (that would let agents probe for session existence).
- System agents (`pilotswarm`, `facts-manager`, `sweeper`, `resourcemgr`)
  are excluded as targets — user agents cannot introspect platform internals
  via this tool.
- The `agent-tuner` system agent (proposed separately) bypasses the
  lineage gate and can read any session.

### Token guardrails

- Hard cap `limit ≤ 200`, default `50`.
- Truncate each event's `data` payload to ~4 KB and mark it
  `_truncated: true` plus include the original `seq` for re-fetch.
- Total response capped at ~64 KB; tail dropped and `hasMore` set true.

### Why no separate activity

The handler runs inside the existing `runTurn` activity. It already has
the catalog and the `getDescendantSessionIds` helper. Adding a `readAgentEvents`
activity would be pure indirection — the orchestration layer does not need
to coordinate around a read.

## Implementation

1. **New file** `packages/sdk/src/inspect-tools.ts` exporting
   `createInspectTools({ catalog, getDescendantSessionIds, agentIdentity })`
   returning a tool array. Initially holds just `read_agent_events`; will
   grow as the agent-tuner proposal lands.
2. **Wire into** `worker.ts` worker-level tool registry, alongside
   `facts-tools` and the sub-agent control tools.
3. **No schema migration.** Reuses
   - `cms_get_session_events(session_id, after_seq, limit)`
   - `cms_get_session_events_before(session_id, before_seq, limit)`
4. **Base prompt update.** Add one paragraph to
   [packages/sdk/plugins/system/agents/default.agent.md](../packages/sdk/plugins/system/agents/default.agent.md)
   and the equivalent system-prompt block built in `runTurn`:

   > **Inspecting sub-agents.** Prefer `check_agents` for status and
   > `wait_for_agents` for synchronization. If those do not give you enough
   > to decide — for example you need to see what the child reasoned about,
   > what tools it called, or why it produced its result — call
   > `read_agent_events(agent_id, cursor=null)` and walk backwards via
   > `prevCursor`. Use `event_types` to filter (e.g.
   > `["assistant.message","tool.invoked","turn completed"]`) to keep
   > token cost low.

## Test Plan

New file `packages/sdk/test/local/read-agent-events.test.js`:

- Tail page returns the newest events in chronological order with correct
  `prevCursor` / `hasMore`.
- Walking backward via `prevCursor` covers all events with no duplicates.
- Forward scan via explicit `cursor` returns events strictly newer.
- Grandchild access works (transitive descendant, not just direct child).
- Non-descendant `agent_id` returns a permission error, not empty.
- System-agent target denied.
- `event_types` filter respected; pagination cursors still accurate.
- Soft-deleted descendant returns events with `deletedAt`.
- Hard-pruned descendant returns `{ events: [], deleted: true }`.
- Oversized event payload returned with `_truncated: true`.
- `limit = 10000` clamped to 200.

Add the suite to `scripts/run-tests.sh` and the `test:local` npm script per
the repo's testing rules.

## Risks

- **Audit/PII.** Event payloads can include any data the descendant saw or
  produced. Parents already had authority to spawn, so they had implicit
  access; this proposal makes that explicit. Token redaction lives in the
  handler (deny-list for `permission.requested` payloads carrying
  credentials), not in storage.
- **Token cost.** A naive call can pull 200 events × 4 KB = 800 KB into
  context. The `event_types` filter and the default `limit = 50` mitigate
  it; the prompt note steers usage.
- **No streaming.** Bounded single-call pagination is enough; streaming
  would add complexity without helping the model.

## Non-Goals

- No write-back / injection into the descendant. That is `message_agent`.
- No full-session JSON snapshot. Use the portal or `PilotSwarmManagementClient`
  out of band for that.
- No cross-tree reads. Every read is anchored in the caller's spawn lineage,
  except for the `agent-tuner` system agent (proposed separately).

## Phasing

| Phase | Scope |
|-------|-------|
| 1 | `read_agent_events` tool + base-prompt note + tests |
| 2 | Optional companion `read_agent_event(agent_id, seq)` to fetch a single non-truncated event. Decide based on real usage. |

Phase 1 is shippable on its own and unblocks the "parent reads child" use
case immediately.
