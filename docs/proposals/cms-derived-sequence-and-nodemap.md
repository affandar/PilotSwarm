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

Replace log parsing with **CMS events + orchestration customStatus** as the single source of truth for both the sequence diagram and the node map. The SDK already persists all the data needed — it's just not being used.

## Data Sources (Already Exist)

### CMS Events (per session, seq-ordered)

| Event type | Data | Source |
|---|---|---|
| `user.message` | `{ content }` | Recorded in `session-proxy.ts` before `runTurn()` |
| `assistant.message` | `{ content }` | Copilot SDK `on("assistant.message")` → `recordEvents()` |
| `assistant.usage` | `{ promptTokens, completionTokens, totalTokens }` | Copilot SDK |
| `session.usage_info` | `{ currentTokens, tokenLimit }` | Copilot SDK |
| `session.compaction_start` | `{}` | Copilot SDK |
| `session.compaction_complete` | `{ removedMessages }` | Copilot SDK |
| `session.error` | `{ message }` | Copilot SDK |

### Orchestration CustomStatus (live, per session)

```ts
interface SessionStatusSignal {
    status: PilotSwarmSessionStatus;  // idle | running | waiting | completed | failed | error | input_required
    iteration: number;
    responseVersion?: number;
    commandVersion?: number;
    waitReason?: string;
    waitSeconds?: number;
    waitStartedAt?: number;
    cronActive?: boolean;
    cronInterval?: number;
    cronReason?: string;
    error?: string;
    contextUsage?: SessionContextUsage;
}
```

### Management Client Session View (merged CMS + orchestration)

```ts
interface PilotSwarmSessionView {
    sessionId: string;
    title?: string;
    agentId?: string;
    status: PilotSwarmSessionStatus;
    orchestrationStatus?: string;  // Running | Completed | Failed | Terminated
    iterations?: number;
    parentSessionId?: string;
    isSystem?: boolean;
    model?: string;
    waitReason?: string;
    cronActive?: boolean;
    cronInterval?: number;
    statusVersion?: number;        // for change detection
    contextUsage?: SessionContextUsage;
}
```

### What's Missing (Must Be Added)

| Gap | Where to add | Details |
|---|---|---|
| **`workerNodeId` in customStatus** | `session-proxy.ts` activity return value → `orchestration.ts` `publishStatus()` | The orchestration generator does NOT have access to `workerNodeId` — only activities do (via the Runtime's worker config). The `runTurn` activity must return `workerNodeId` alongside the turn result, and the orchestration reads it from the activity return value to include in `publishStatus()`. |
| **Tool call events** | `session-proxy.ts` `onEvent` | The Copilot SDK fires `tool.call` and `tool.result` events but they may be filtered. Need to verify they reach CMS. If not, add them. |
| **Wait/timer events** | `session-proxy.ts` or `orchestration.ts` | Record CMS events for `session.wait_started`, `session.wait_completed`, `session.dehydrated`, `session.hydrated`. Currently these only appear in logs. |
| **Spawn events** | `orchestration.ts` | Record a `session.agent_spawned` CMS event with `{ childSessionId, agentId, task }` when `spawn_agent` fires. Currently only logged. |
| **Worker handoff events** | `orchestration.ts` | Record `session.worker_changed` when the activity runs on a different worker than previous turn. |

## Design

### Phase 1: Enrich CMS Events (SDK changes)

Add new CMS event types that capture the same information currently scraped from logs:

```
session.turn_started      { iteration, workerNodeId }
session.turn_completed    { iteration, workerNodeId, tokenUsage? }
session.wait_started      { seconds, reason, preserveAffinity }
session.wait_completed    { seconds }
session.timer_fired       { seconds }
session.dehydrated        { reason }
session.hydrated          { workerNodeId }
session.agent_spawned     { childSessionId, agentId, task }
session.worker_changed    { fromWorker, toWorker }
session.cron_started      { intervalSeconds, reason }
session.cron_fired        {}
session.cron_cancelled    {}
session.command_received  { cmd, id }
session.command_completed { cmd, id }
```

Plus: add `workerNodeId` to orchestration `customStatus`. Since the orchestration generator doesn't have access to `workerNodeId` (only activities do, via the Runtime's worker config), the `runTurn` activity must return `workerNodeId` in its result. The orchestration then reads it from the activity return value and includes it in `publishStatus()`.

These are fire-and-forget CMS writes — same as existing event recording. No new activities, no yield sequence changes (no orchestration version bump needed for the events — they're recorded inside activities).

### Phase 2: Sequence Diagram from CMS Events (TUI changes)

Replace `parseSeqEvent()` + log scraping with a CMS-backed event model:

#### Data Model

```js
// Replaces seqEventBuffers (Map<orchId, parsedLogEvent[]>)
// Now populated from CMS events, not log parsing.
const seqTimeline = new Map();  // orchId → SeqEvent[]

// SeqEvent — normalized from CMS events
// {
//   seq: number,           // CMS event seq (total ordering)
//   time: string,          // formatted timestamp
//   type: string,          // "turn" | "response" | "wait" | "timer" | "dehydrate" | "hydrate" | "spawn" | "user_msg" | "cmd" | "cron" | "compaction" | "error"
//   workerNodeId?: string, // which worker ran this
//   detail?: string,       // turn number, wait reason, spawn agentId, etc.
// }
```

#### Backfill on Session Switch

When the user switches to a session (or on TUI startup for the active session), load the full CMS event history:

```js
async function loadSeqTimeline(sessionId) {
    const events = await catalog.getEvents(sessionId);
    const timeline = events.map(evt => cmsEventToSeqEvent(evt)).filter(Boolean);
    seqTimeline.set(sessionId, timeline);
    if (logViewMode === "sequence") refreshSeqPane();
}
```

#### Live Updates

Subscribe to new CMS events via the existing `session.on()` mechanism. When a new event arrives, append it to the timeline and render incrementally (same as current `appendSeqEvent`).

#### Rendering

The existing `renderSeqEventLine()` and `seqLine()` helpers stay — they just take the new `SeqEvent` shape instead of the old log-parsed shape. The column layout (worker nodes as columns) uses `workerNodeId` from the event data instead of regex-extracted pod names.

### Phase 3: Node Map from Management Client (TUI changes)

Replace the log-derived `seqLastActivityNode` tracking with management client data:

```js
async function refreshNodeMap() {
    const sessions = await mgmt.listSessions();
    
    // Build node → sessions mapping from customStatus.workerNodeId
    // (available after Phase 1 adds workerNodeId to customStatus)
    const nodeMap = new Map();
    for (const session of sessions) {
        const status = await mgmt.getSessionStatus(session.sessionId);
        const node = status?.customStatus?.workerNodeId || "(unknown)";
        if (!nodeMap.has(node)) nodeMap.set(node, []);
        nodeMap.get(node).push({
            sessionId: session.sessionId,
            title: session.title,
            status: session.status,
            agentId: session.agentId,
            isSystem: session.isSystem,
            iterations: session.iterations,
        });
    }
    
    renderNodeMapColumns(nodeMap);
}
```

This replaces the `seqLastActivityNode` map entirely. No more log-derived worker tracking.

### Phase 4: Remove Log Parsing (Cleanup)

Once Phases 1-3 are working:

1. Delete `parseSeqEvent()` (~100 lines of regex parsing)
2. Delete `appendSeqEvent()` / `injectSeqUserEvent()` log-based injection
3. Delete `seqLastActivityNode`, `seqEventBuffers` maps
4. Remove the `appendLogLine → parseSeqEvent → appendSeqEvent` pipeline from the log processor
5. The sequence/nodemap modes no longer depend on log streaming at all

Log streaming continues for the "Workers" and "Orchestration" log views — those are raw log viewers and should stay log-based.

## Implementation Order

| Phase | Scope | Files | Risk |
|---|---|---|---|
| **1a** | Add `workerNodeId` to activity return → `publishStatus()` | `session-proxy.ts`, `orchestration.ts` | Low — activity returns extra field, orchestration reads it. Adds a field to customStatus, no yield change |
| **1b** | Add new CMS event types | `session-proxy.ts`, `orchestration.ts` | Low — fire-and-forget writes inside existing activities |
| **2** | Sequence diagram from CMS events | `tui.js` (or extract to `tui-sequence.js`) | Medium — rendering refactor |
| **3** | Node map from management client | `tui.js` (or extract to `tui-nodemap.js`) | Low — simpler than sequence |
| **4** | Remove log parsing for seq/nodemap | `tui.js` | Low — deletion only |

Phases 1a and 1b can ship independently. Phases 2-4 are one logical change.

## What Changes for the Portal

Once CMS-derived sequence and node map are working in the TUI, the **portal web experience** can use the exact same data sources (management client `listSessions()`, `getSessionStatus()`, CMS `getEvents()`) to render SVG sequence diagrams and card-based node maps. No log access needed.

---

## Test Plan

### Phase 1: CMS Event Enrichment

#### 1a. `workerNodeId` in customStatus

**Contract test** (static, no LLM):
- Read `orchestration.ts` source
- Assert `publishStatus` includes `workerNodeId` in the signal object
- Assert `SessionStatusSignal` type in `types.ts` includes `workerNodeId?: string`

**Integration test** (1 LLM turn):
- `withClient(env, ...)` → create session → `sendAndWait("What is 1+1?")`
- `mgmt.getSessionStatus(sessionId)` → assert `customStatus.workerNodeId` is a non-empty string
- Assert `customStatus.workerNodeId` matches the worker's configured `workerNodeId`

**Multi-worker test** (2 workers):
- Start worker A (nodeId="alpha") and worker B (nodeId="beta")
- Create session, do a turn → check `workerNodeId` is "alpha" or "beta"
- Stop worker A, do another turn → check `workerNodeId` is "beta"
- Assert `workerNodeId` changed between turns

#### 1b. New CMS event types

**Turn events test**:
- Create session → `sendAndWait("Hello")`
- `catalog.getEvents(sessionId)` → find `session.turn_started` and `session.turn_completed`
- Assert `turn_started.data.iteration === 1`
- Assert `turn_started.data.workerNodeId` is non-empty
- Assert `turn_completed` seq > `turn_started` seq

**Wait events test**:
- Create session with system prompt that instructs calling `wait(seconds=5)`
- `sendAndWait(...)` (or `send` + poll for completion)
- `catalog.getEvents(sessionId)` → find `session.wait_started` and `session.wait_completed`
- Assert `wait_started.data.seconds === 5`
- Assert `wait_started.data.reason` is a string

**Spawn events test**:
- Create session → `send("Spawn a sub-agent with task: 'Say hello'")`
- Poll CMS for child session
- `catalog.getEvents(parentSessionId)` → find `session.agent_spawned`
- Assert `agent_spawned.data.childSessionId === child.sessionId`

**Dehydrate/hydrate events test** (requires blob):
- Create session with `blobEnabled: true, waitThreshold: 0, dehydrateThreshold: 0`
- Trigger a long wait → orchestration dehydrates
- `catalog.getEvents(sessionId)` → find `session.dehydrated` and `session.hydrated`

**Cron events test**:
- Create session that sets up a cron schedule
- Wait for at least one cron fire
- `catalog.getEvents(sessionId)` → find `session.cron_started` and `session.cron_fired`

**Command events test**:
- Create session → do a turn → `mgmt.sendCommand(sessionId, { cmd: "get_info", id })`
- `catalog.getEvents(sessionId)` → find `session.command_received` and `session.command_completed`

**Event ordering contract test** (static):
- Read `session-proxy.ts` source
- Assert all new event types are recorded via `catalog.recordEvents()`
- Assert none of the new types are in `EPHEMERAL_TYPES`

### Phase 2: CMS-Derived Sequence Diagram

**Unit test — `cmsEventToSeqEvent` mapping**:
- For each CMS event type, construct a sample event object
- Call `cmsEventToSeqEvent(event)` → assert the returned `SeqEvent` has correct `type`, `detail`, `workerNodeId`
- Assert unmapped event types return `null`

**Backfill test** (integration):
- Create session → do 3 turns → wait → do another turn
- Create a fresh TUI sequence state (simulated)
- Call `loadSeqTimeline(sessionId)` from CMS
- Assert timeline has ≥ 8 events (3× turn_started + 3× turn_completed + wait_started + wait_completed)
- Assert events are in seq order
- Assert workerNodeId is populated on turn events

**Live update test** (integration):
- Create session, subscribe to events via `session.on()`
- Do a turn
- Assert the sequence timeline was updated incrementally (event appended, not full reload)

**Column layout test** (unit):
- Given a timeline with events from 2 different workerNodeIds
- Assert `seqNodes` contains both worker names
- Assert events render in the correct column

**Rendering regression test** (visual/contract):
- For each `SeqEvent.type` value, call `renderSeqEventLine()` with a mock pane
- Assert the pane received a log line matching expected format (turn number, wait seconds, etc.)

### Phase 3: CMS-Derived Node Map

**Node map from management client test** (integration):
- Create 2 sessions on 1 worker
- Call `refreshNodeMap()`
- Assert both sessions appear under the worker's node column
- Assert session status colors match expected

**Multi-worker node map test** (integration):
- Start 2 workers with different nodeIds
- Create sessions on each
- Assert node map shows 2 columns with correct session assignment

**Unknown worker column test**:
- Create a session that hasn't done any turns (no `workerNodeId` in status)
- Assert it appears in "(unknown)" column

**Session status update test**:
- Create session → do a turn (running → idle)
- Refresh node map
- Assert session shows correct status indicator

### Phase 4: Log Parsing Removal

**Deletion contract test** (static):
- Assert `parseSeqEvent` function does not exist in `tui.js`
- Assert `seqLastActivityNode` Map does not exist
- Assert `seqEventBuffers` Map does not exist
- Assert `injectSeqUserEvent` does not exist

**Sequence diagram still works test** (manual/E2E):
- Start TUI → create session → do turns → switch to sequence view
- Assert diagram populates from CMS (not logs)
- Assert switching sessions loads historical timeline

**Node map still works test** (manual/E2E):
- Start TUI with 2 workers → create sessions → switch to node map
- Assert sessions are assigned to correct worker columns

**Log views unaffected test** (manual/E2E):
- Workers and Orchestration log views still stream and display raw logs
- Verify `m` key cycling still works for all 4 modes

### Cross-Cutting

**No orchestration version bump needed** for Phase 1 events: All new CMS writes happen inside existing activities (`runTurn`, `dehydrateSession`, `hydrateSession`). They don't add yields to the orchestration generator. The only yield-visible change is adding `workerNodeId` to `publishStatus()` — but `setCustomStatus()` is fire-and-forget (no yield), so this doesn't change the yield sequence.

**Exception**: If `workerNodeId` is added to `OrchestrationInput` (carried across `continueAsNew`), that DOES require a version bump because the `continueAsNew` payload shape changes. But we can avoid this by reading `workerNodeId` from the activity context at runtime rather than carrying it in state.
