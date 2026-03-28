# CMS-Derived Sequence Diagram & Node Map

**Status**: Proposal  
**Date**: 2026-03-27

## Problem

The TUI's sequence diagram and node map currently derive all data by **parsing raw duroxide log lines** (`parseSeqEvent()` in `tui.js`). This approach has serious limitations:

1. **Log-dependent**: Only works when log streams are accessible (kubectl logs / local subprocess stdout). The portal web UI has no access to raw logs.
2. **Fragile parsing**: 30+ regex patterns scrape unstructured log text. Any log format change silently breaks the diagram.
3. **Incomplete on startup**: Events before the TUI connected are lost — no backfill.
4. **No persistence**: Switching sessions clears the diagram. There's no way to view historical sequence data.
5. **Worker node tracking is log-derived**: `seqLastActivityNode` is populated by matching `worker_id=` patterns in logs. If the TUI misses a log line, the node map shows sessions in "(unknown)".

## Solution

Replace log parsing with **CMS events** as the single source of truth for both the sequence diagram and the node map.

### Core Design Decisions

1. **`worker_node_id` column on CMS events table** — every event write carries the worker that produced it. Activities have access to `workerNodeId` via the Runtime config / SessionManager. No orchestration changes needed for basic worker tracking.

2. **New CMS event types for operational lifecycle** — waits, timers, spawns, dehydration, cron, commands. Events inside existing activities (turns, dehydrate, hydrate) are recorded inline with zero yield changes. Events at orchestration level (waits, spawns, cron, commands) use a new lightweight `recordSessionEvent` activity.

3. **Ordering uses `seq`, not `created_at`** — CMS events use a `BIGSERIAL` primary key (`seq`) that is monotonically increasing within a single PostgreSQL instance. This is immune to clock skew between worker nodes. `created_at` is used only for display timestamps in the sequence diagram.

4. **Orchestration version bump required for Phase 1c only** — the new `recordSessionEvent` activity adds yields to the orchestration generator. Phases 1a and 1b don't touch orchestration yields.

## Phase 1: Enrich CMS Events (SDK)

### 1a. Add `worker_node_id` column to CMS events table

**Schema change** in `cms.ts`:

```sql
-- Migration in initialize(), same pattern as existing column additions
ALTER TABLE {eventsTable} ADD COLUMN IF NOT EXISTS worker_node_id TEXT;
```

`recordEvents()` accepts an optional `workerNodeId` parameter and writes it on every insert.

**Activity-side**: `session-proxy.ts` passes `workerNodeId` (from `sessionManager.workerNodeId`) to every `catalog.recordEvents()` call. This covers:
- `user.message` (recorded before `runTurn()`)
- All Copilot SDK events forwarded through `onEvent` callback (`assistant.message`, `assistant.usage`, `session.usage_info`, `session.compaction_*`, `session.error`)

**No orchestration changes. No version bump.**

### 1b. New CMS events inside existing activities

Recorded inline in activities that already exist. **No new yields, no version bump.**

| Event type | Where recorded | Data |
|---|---|---|
| `session.turn_started` | `session-proxy.ts` → `runTurn`, before `managedSession.runTurn()` | `{ iteration }` |
| `session.turn_completed` | `session-proxy.ts` → `runTurn`, after `managedSession.runTurn()` | `{ iteration }` |
| `session.dehydrated` | `session-proxy.ts` → `dehydrateSession` activity | `{ reason }` |
| `session.hydrated` | `session-proxy.ts` → `hydrateSession` activity | `{}` |

All of these get `worker_node_id` automatically from Phase 1a.

### 1c. New `recordSessionEvent` activity + orchestration-level events

Events that happen between yields in the orchestration generator need a new activity to write to CMS.

**New activity** in `session-proxy.ts`:

```ts
runtime.registerActivity("recordSessionEvent", async (actCtx, input) => {
    const { sessionId, events } = input;
    await catalog.recordEvents(sessionId, events, workerNodeId);
});
```

**Orchestration proxy** in `session-proxy.ts`:

```ts
proxy.recordSessionEvent = (sessionId, events) =>
    proxy.callActivity("recordSessionEvent", { sessionId, events });
```

**Orchestration-level events** — each `yield` below is a new activity call:

| Event type | Where in orchestration | Data |
|---|---|---|
| `session.wait_started` | Before `ctx.scheduleTimer()` | `{ seconds, reason, preserveAffinity? }` |
| `session.wait_completed` | After timer yield returns | `{ seconds }` |
| `session.agent_spawned` | After `spawn_agent` processed | `{ childSessionId, agentId?, task }` |
| `session.cron_started` | When cron schedule set | `{ intervalSeconds, reason }` |
| `session.cron_fired` | When cron timer fires | `{}` |
| `session.cron_cancelled` | When cron cancelled | `{}` |
| `session.command_received` | When command dequeued | `{ cmd, id }` |
| `session.command_completed` | After command processed | `{ cmd, id }` |

**Example** (wait):
```ts
yield sessionProxy.recordSessionEvent(sessionId, [
    { eventType: "session.wait_started", data: { seconds, reason } },
]);
yield ctx.scheduleTimer(seconds * 1000);
yield sessionProxy.recordSessionEvent(sessionId, [
    { eventType: "session.wait_completed", data: { seconds } },
]);
```

Events can be batched (array) to minimize yields where multiple events occur at the same point.

### 1d. Orchestration version bump

Phase 1c adds yields → freeze `orchestration.ts` to `orchestration_1_0_30.ts`, register in `orchestration-registry.ts`, bump to `1.0.31`.

## Phase 2: Sequence Diagram from CMS Events (TUI)

### Data Model

```js
// Replaces seqEventBuffers (Map<orchId, parsedLogEvent[]>)
const seqTimeline = new Map();  // sessionId → SeqEvent[]

// SeqEvent — normalized from CMS events
// {
//   seq: number,           // CMS event seq — source of truth for ordering
//   time: string,          // created_at formatted for display (cosmetic only)
//   type: string,          // mapped from eventType
//   workerNodeId?: string, // from worker_node_id column
//   detail?: string,       // iteration number, wait reason, agentId, etc.
// }
```

### Backfill on Session Switch

Load full CMS event history when the user selects a session:

```js
async function loadSeqTimeline(sessionId) {
    const events = await catalog.getEvents(sessionId);
    const timeline = events.map(cmsEventToSeqEvent).filter(Boolean);
    seqTimeline.set(sessionId, timeline);
    if (logViewMode === "sequence") refreshSeqPane();
}
```

This solves "no history before TUI connected."

### Live Updates

New CMS events arrive via `session.on()` → append to timeline, render incrementally.

### Column Layout

Worker columns derived from distinct `workerNodeId` values in the timeline. Handoffs are visible where consecutive events have different `workerNodeId`.

### Rendering

Reuse existing `seqLine()` column-based rendering with new `SeqEvent` shape. Same visual output.

## Phase 3: Node Map from CMS Events (TUI)

**Worker assignment**: last `worker_node_id` from that session's CMS events.  
**Session status**: `mgmt.getSessionStatus()` (already used).

```js
async function refreshNodeMap() {
    const sessions = await mgmt.listSessions();
    const nodeMap = new Map();

    for (const session of sessions) {
        const events = await catalog.getEvents(session.sessionId, { limit: 1, order: "desc" });
        const lastWorker = events[0]?.workerNodeId || "(unknown)";
        if (!nodeMap.has(lastWorker)) nodeMap.set(lastWorker, []);
        nodeMap.get(lastWorker).push({ ...session });
    }
    renderNodeMapColumns(nodeMap);
}
```

Replaces `seqLastActivityNode` map.

## Phase 4: Remove Log Parsing (Cleanup)

1. Delete `parseSeqEvent()` (~100 lines of regex)
2. Delete `appendSeqEvent()` / `injectSeqUserEvent()`
3. Delete `seqLastActivityNode`, `seqEventBuffers` maps
4. Remove `appendLogLine → parseSeqEvent → appendSeqEvent` pipeline
5. Sequence/nodemap modes no longer depend on log streaming

Log streaming stays for "Workers" and "Orchestration" raw log views.

## Implementation Order

| Phase | Scope | Files | Version bump? |
|---|---|---|---|
| **1a** | `worker_node_id` column + write on every event | `cms.ts`, `session-proxy.ts` | No |
| **1b** | Turn/dehydrate/hydrate events (inline in activities) | `session-proxy.ts` | No |
| **1c** | `recordSessionEvent` activity + orch-level events | `session-proxy.ts`, `orchestration.ts` | **Yes** |
| **1d** | Freeze orchestration, register, bump version | `orchestration-registry.ts` | — |
| **2** | Sequence diagram from CMS | `tui.js` or new `tui-sequence.js` | No |
| **3** | Node map from CMS | `tui.js` or new `tui-nodemap.js` | No |
| **4** | Delete log parsing for seq/nodemap | `tui.js` | No |

Phases 1a–1b ship independently. Phase 1c–1d ship together. Phases 2–4 are one logical TUI change.

---

## Test Plan

### Phase 1a: `worker_node_id` column

**Schema migration test** (integration):
- Call `catalog.initialize()` → assert `worker_node_id` column exists on events table
- Call `catalog.initialize()` again → idempotent, no error

**Column written on every event** (integration):
- `withClient(env, ...)` → create session → `sendAndWait("What is 1+1?")`
- `catalog.getEvents(sessionId)` → assert every event has `workerNodeId` as non-empty string
- Assert `workerNodeId` matches the worker's configured `workerNodeId`

**Multi-worker column test** (integration):
- Worker A (nodeId="alpha"), create session, do a turn
- Stop A, start worker B (nodeId="beta"), resume session, do a turn
- Turn-1 events have `workerNodeId === "alpha"`, turn-2 events have `workerNodeId === "beta"`

**Contract test** (static):
- Read `cms.ts` → assert `worker_node_id` in schema DDL
- Read `cms.ts` → assert `recordEvents()` writes `workerNodeId`
- Read `session-proxy.ts` → assert all `recordEvents()` calls pass `workerNodeId`

### Phase 1b: Events inside activities

**Turn events** (integration):
- Create session → `sendAndWait("Hello")`
- `catalog.getEvents(sessionId)` → find `session.turn_started` and `session.turn_completed`
- Assert `turn_started.data.iteration === 1`
- Assert `turn_completed.seq > turn_started.seq`

**Dehydrate/hydrate events** (integration, requires blob):
- Session with blob enabled, trigger long wait → dehydration
- Find `session.dehydrated` and `session.hydrated` in events
- Assert `dehydrated.data.reason` is a string

**Event ordering** (integration):
- One turn → events in order: `turn_started` → `user.message` → `assistant.message` → `turn_completed`
- Assert `seq` values strictly increasing

### Phase 1c: `recordSessionEvent` activity + orch-level events

**Wait events** (integration):
- System prompt instructs `wait(seconds=5)` → `send()` + poll
- Find `session.wait_started` and `session.wait_completed`
- Assert `wait_started.data.seconds === 5`, `wait_started.data.reason` is a string
- Assert `wait_completed.seq > wait_started.seq`

**Spawn events** (integration):
- `send("Spawn a sub-agent with task: 'Say hello'")` → poll for child
- Find `session.agent_spawned` on parent
- Assert `agent_spawned.data.childSessionId === child.sessionId`

**Cron events** (integration):
- Session sets up cron, wait for one fire
- Find `session.cron_started` and `session.cron_fired`
- Assert `cron_started.data.intervalSeconds > 0`

**Command events** (integration):
- Session at idle → `mgmt.sendCommand(sessionId, { cmd: "get_info", id })`
- Find `session.command_received` and `session.command_completed`

**Activity contract test** (static):
- Read `session-proxy.ts` → assert `recordSessionEvent` activity registered
- Assert it calls `catalog.recordEvents()`

### Phase 1d: Version bump

**Registry test** (static):
- Previous version frozen in `orchestration_1_0_30.ts`
- Registry includes `{ version: "1.0.30", handler: ... }`
- `CURRENT_ORCHESTRATION_VERSION === "1.0.31"`

### Phase 2: Sequence diagram from CMS

**`cmsEventToSeqEvent` mapping** (unit):
- Sample event per type → assert correct `SeqEvent.type`, `detail`, `workerNodeId`
- Unknown event types → `null`

**Backfill** (integration):
- 3 turns → `loadSeqTimeline()` → timeline ≥ 6 entries
- Events in `seq` order
- `workerNodeId` populated

**Column layout** (unit):
- Events from 2 workers → 2 columns rendered, events in correct column

### Phase 3: Node map from CMS

**Single-worker** (integration):
- 2 sessions on 1 worker → both in same column

**Multi-worker** (integration):
- 2 workers → correct column assignment

**No events yet** → "(unknown)" column

### Phase 4: Deletion

**Contract test** (static):
- `parseSeqEvent`, `seqLastActivityNode`, `seqEventBuffers`, `injectSeqUserEvent` do not exist in `tui.js`

**Manual E2E**:
- Sequence diagram backfills on session switch
- Node map shows correct workers
- Workers/Orchestration log views unaffected
- `m` key cycling works

### Cross-Cutting: Clock Skew

**Ordering immunity** (integration):
- Multi-worker → events from different workers → assert `seq` strictly monotonic regardless of `created_at` order
- Diagram renders in `seq` order
