# Proposal: Exact Copilot SDK Semantics + Session Catalog (CMS)

## Mental Model

The durable-copilot-sdk is a **durable execution layer underneath the Copilot SDK**. It preserves the exact semantics of the SDK while using orchestrations, activities, and duroxide infrastructure to "remote" calls from a `DurableSession` on the client to a real `CopilotSession` running on a worker node. Sessions can be relocated, dehydrated to blob, and rehydrated on any node.

```
┌─────────────────────────────────────────────────────────────────┐
│  Client Process (TUI, API server, tests)                        │
│                                                                 │
│  DurableCopilotClient ──→ DurableSession                        │
│       │ createSession()      │ send() / sendAndWait()           │
│       │ resumeSession()      │ on("assistant.message", ...)     │
│       │ listSessions()       │ abort() / destroy()              │
│       │ deleteSession()      │ getMessages()                    │
│       │ listModels()         │                                  │
│       │                      │                                  │
│       │  ┌───────────────────┘                                  │
│       │  │          event queue (enqueueEvent)                   │
│       ▼  ▼                                                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ duroxide Client                                          │   │
│  │    startOrchestration()                                  │   │
│  │    enqueueEvent("messages", ...)                          │   │
│  │    waitForStatusChange() ← polls for results              │   │
│  └──────────────────────────────────────────────────────────┘   │
│       │                                                         │
│  ┌────┴────────────────────────────────────────────────────┐    │
│  │ copilot_sessions schema (CMS)                           │    │
│  │    sessions, session_events, models_cache               │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────┬───────────────────────────────────────────┘
                      │ PostgreSQL
┌─────────────────────┴───────────────────────────────────────────┐
│  Worker Node (AKS pod)                                          │
│                                                                 │
│  duroxide Runtime                                               │
│    ├── Orchestration: "durable-session"                          │
│    │     dequeueEvent("messages") → dispatch to activities       │
│    │     manages lifecycle: idle → running → waiting → idle      │
│    │     writes CMS updates via activities                       │
│    │                                                             │
│    ├── Activity: "runAgentTurn"                                  │
│    │     SessionManager.getOrCreate(sessionId)                   │
│    │       → CopilotSession.sendAndWait(prompt)                  │
│    │       ← result + events                                     │
│    │     CMS: update session state, store events                 │
│    │                                                             │
│    ├── Activity: "cmsUpdateSession"                              │
│    │     Writes state/metadata to copilot_sessions.sessions      │
│    │                                                             │
│    ├── Activity: "cmsRecordEvents"                               │
│    │     Writes session events to copilot_sessions.session_events│
│    │                                                             │
│    └── Activity: "dehydrateSession" / "hydrateSession"           │
│          Blob storage for session relocation                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Part 1: Exact SDK Semantics

### 1.1 Semantic Gap Analysis

| Copilot SDK | Current Durable SDK | Gap | Fix |
|---|---|---|---|
| `session.send(opts)` returns message ID, fires events | `send(prompt)` returns void, no events | Missing: message ID return, event dispatch, `MessageOptions` support (attachments, mode) | Return message ID, emit events via CMS + polling |
| `session.sendAndWait(opts, timeout?)` returns `AssistantMessageEvent` | `sendAndWait(prompt, timeout?)` returns `string` | Missing: full event object return, intermediate events, `MessageOptions` support | Return `AssistantMessageEvent`, stream events |
| `session.on(eventType, handler)` event subscriptions | Not implemented | Missing entirely | Implement via CMS polling or WebSocket |
| `session.abort()` cancels in-flight message, session stays alive | Calls `cancelInstance()` — kills the orchestration | **Wrong semantics** | Send abort event through message queue, race against activity |
| `session.destroy()` releases resources, session can be resumed | Calls `deleteSession()` — permanent | Close to correct but should not permanently delete | Orchestration cleanup without deleting CMS record |
| `session.getMessages()` returns full conversation history | Returns `[]` (stub) | Missing | Read from CMS `session_events` table |
| `session.registerTools()` at runtime | Not supported — tools fixed at create time | Missing | Send tool registration through message queue |
| `session.registerPermissionHandler()` at runtime | Not supported | Missing | Route permission requests through message queue |
| `session.registerUserInputHandler()` at runtime | Set at create time only | Missing | Route user input through message queue |
| `session.registerHooks()` at runtime | Set at create time only | Missing | Route hooks through message queue |
| `client.listModels()` | Routed as `/models` slash command | Should be a direct client method | Query CMS models cache or call worker activity |
| `client.getLastSessionId()` | Not implemented | Missing | Query CMS `sessions` table |
| `client.getState()` | Not implemented | Missing | Track connection state |
| `client.ping()` | Not implemented | Missing | Duroxide client health check |
| `client.getAuthStatus()` | Not implemented | Missing | Query worker via activity |
| `client.on()` lifecycle events | Not implemented | Missing | CMS polling or PG LISTEN/NOTIFY |
| `SessionMetadata.summary` | Not tracked | Missing | Store in CMS, populated by orchestration |

### 1.2 Fixing `abort()` — Cancel In-Flight Message

Current (wrong):
```
DurableSession.abort() → duroxideClient.cancelInstance(orchId) → orchestration killed
```

Correct:
```
DurableSession.abort()
  → enqueueEvent(orchId, "messages", {type: "abort"})
  → orchestration is racing activity against dequeueEvent
  → dequeueEvent wins the race → activity is cancelled
  → activity catches cancellation → calls copilotSession.abort()
  → activity returns {type: "cancelled"}
  → orchestration sets status "idle", emits abort event to CMS
  → session is alive, ready for next message
```

The orchestration already races `runAgentTurn` against `dequeueEvent("messages")` for interrupt handling. Abort is just a special case of interrupt where we explicitly call `session.abort()` on the underlying Copilot session instead of treating it as a new prompt.

Implementation:
1. Add `{type: "abort"}` message type in the orchestration's race handler
2. When the race selects the abort message, the losing activity gets cancelled
3. The activity's cancellation handler calls `copilotSession.abort()`
4. Orchestration emits `{type: "abort", data: {reason: "user"}}` event to CMS
5. Orchestration returns to idle dequeue loop

### 1.3 Fixing `destroy()` — Release Without Permanent Delete

Current:
```
DurableSession.destroy() → client.deleteSession(id) → destroys session + duroxide state
```

Correct:
```
DurableSession.destroy()
  → stop the orchestration gracefully (complete current work or abort)
  → dehydrate session to blob (preserving conversation history)
  → orchestration terminates
  → CMS record stays (can be resumed later)
  → client.deleteSession() is the permanent delete
```

### 1.4 Event System — `session.on()`

The Copilot SDK emits 35 event types. The durable version needs to relay these from the worker back to the client. Two approaches:

**Option A: CMS Event Log (recommended)**
- `runAgentTurn` activity registers an `on()` handler on the real `CopilotSession`
- All events are captured and written to CMS `session_events` table
- The client polls `session_events` using a cursor (last seen event ID)
- `DurableSession.on()` starts a polling loop that dispatches events to handlers

**Option B: Custom Status Streaming (current approach, limited)**
- Stuff events into `customStatus` — but limited to latest state only, not a log

Option A is correct because events are a **log** (ordered, append-only), not a **state** (latest value). CMS gives us the log.

### 1.5 Fixing `send()` — Return Message ID + Event Dispatch

Current: `send(prompt)` returns void.

Correct:
```
DurableSession.send(options: MessageOptions)
  → generate message ID client-side
  → enqueueEvent(orchId, "messages", {prompt, messageId, attachments, mode})
  → start event polling loop (dispatches to on() handlers)
  → return messageId
```

### 1.6 Fixing `sendAndWait()` — Return Full Event

Current: returns `string | undefined` (just the content).

Correct:
```
DurableSession.sendAndWait(options: MessageOptions, timeout?)
  → send(options)
  → poll CMS session_events until session.idle event appears
  → return the last assistant.message event (full AssistantMessageEvent object)
```

### 1.7 Fixing `getMessages()` — Full Conversation History

Current: stub returning `[]`.

Correct:
```
DurableSession.getMessages()
  → SELECT * FROM copilot_sessions.session_events
    WHERE session_id = $1 AND NOT ephemeral
    ORDER BY sequence ASC
  → return as SessionEvent[]
```

### 1.8 `listModels()` as a Client Method

Move from slash command to proper client method:
```
DurableCopilotClient.listModels()
  → check CMS models_cache (TTL 5 minutes)
  → if stale: scheduleActivity("listModels") or call worker
  → return ModelInfo[]
```

---

## Part 2: Session Catalog (CMS)

### 2.1 Schema Design

Use a separate PG schema `copilot_sessions` in the same database as duroxide:

```sql
-- Schema lives alongside duroxide's schema in the same database
CREATE SCHEMA IF NOT EXISTS copilot_sessions;

-- Migration tracking
CREATE TABLE IF NOT EXISTS copilot_sessions._migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.2 Tables

#### `copilot_sessions.sessions` — Session Catalog

```sql
CREATE TABLE copilot_sessions.sessions (
    session_id              TEXT PRIMARY KEY,
    orchestration_id        TEXT NOT NULL,          -- "session-{session_id}"
    
    -- User-facing metadata
    name                    TEXT,                    -- user-friendly name (nullable)
    summary                 TEXT,                    -- LLM-generated summary
    
    -- State (mirrors DurableSessionStatus)
    state                   TEXT NOT NULL DEFAULT 'pending',
        -- pending | running | idle | waiting | input_required | completed | failed
    
    -- Copilot session config (serialized)
    model                   TEXT,                    -- current model
    system_message          TEXT,                    -- system message content
    tools                   JSONB,                   -- tool definitions (names + schemas, not handlers)
    
    -- Worker affinity
    worker_node_id          TEXT,                    -- current/last worker node
    affinity_key            TEXT,                    -- duroxide affinity key
    
    -- Lifecycle timestamps
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at          TIMESTAMPTZ,             -- last user message
    deleted_at              TIMESTAMPTZ,              -- soft delete
    
    -- Duroxide cross-references
    current_iteration       INTEGER NOT NULL DEFAULT 0,
    is_dehydrated           BOOLEAN NOT NULL DEFAULT false,
    blob_key                TEXT,                     -- blob storage key if dehydrated
    
    -- Metrics
    total_turns             INTEGER NOT NULL DEFAULT 0,
    total_tokens_in         BIGINT NOT NULL DEFAULT 0,
    total_tokens_out        BIGINT NOT NULL DEFAULT 0,
    
    -- Error state
    last_error              TEXT,
    last_error_at           TIMESTAMPTZ
);

CREATE INDEX idx_sessions_state ON copilot_sessions.sessions(state) WHERE deleted_at IS NULL;
CREATE INDEX idx_sessions_updated ON copilot_sessions.sessions(updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_sessions_worker ON copilot_sessions.sessions(worker_node_id) WHERE deleted_at IS NULL;
```

#### `copilot_sessions.session_events` — Event Log

```sql
CREATE TABLE copilot_sessions.session_events (
    id              BIGSERIAL PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES copilot_sessions.sessions(session_id),
    
    -- Event identity (from Copilot SDK SessionEvent)
    event_id        TEXT NOT NULL,                   -- SDK event ID
    parent_id       TEXT,                            -- SDK parent event ID
    event_type      TEXT NOT NULL,                   -- "assistant.message", "tool.execution_start", etc.
    ephemeral       BOOLEAN NOT NULL DEFAULT false,
    
    -- Event data (JSON blob — the SDK's event.data)
    data            JSONB NOT NULL,
    
    -- Metadata
    iteration       INTEGER NOT NULL DEFAULT 0,      -- orchestration iteration
    worker_node_id  TEXT,                             -- which worker produced this
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    UNIQUE(session_id, event_id)
);

CREATE INDEX idx_events_session_seq ON copilot_sessions.session_events(session_id, id);
CREATE INDEX idx_events_session_type ON copilot_sessions.session_events(session_id, event_type);
```

#### `copilot_sessions.models_cache` — Available Models

```sql
CREATE TABLE copilot_sessions.models_cache (
    model_id        TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    capabilities    JSONB NOT NULL,
    policy          JSONB,
    billing         JSONB,
    reasoning       JSONB,                           -- supported/default reasoning efforts
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    worker_node_id  TEXT                              -- which worker fetched this
);
```

### 2.3 CMS Activities (Write Path)

Following toygres' pattern: **orchestrations never write to CMS directly**. All CMS writes go through dedicated activities, which are idempotent and replay-safe.

| Activity | Purpose | When Called |
|---|---|---|
| `cmsCreateSession` | `INSERT INTO copilot_sessions.sessions` | First message to a new session |
| `cmsUpdateSessionState` | `UPDATE sessions SET state = $2, updated_at = now()` | Every state transition (idle→running→idle, etc.) |
| `cmsRecordEvents` | `INSERT INTO session_events` (batch) | After `runAgentTurn` completes — bulk insert all events captured during the turn |
| `cmsUpdateSessionMeta` | `UPDATE sessions SET summary, model, total_turns, total_tokens_*` | After each turn with aggregated metrics |
| `cmsDeleteSession` | `UPDATE sessions SET deleted_at = now(), state = 'deleted'` | On `deleteSession()` |
| `cmsUpdateModelsCache` | `UPSERT INTO models_cache` | After `listModels` activity fetches from Copilot |
| `cmsRecordError` | `UPDATE sessions SET last_error, last_error_at` | On activity failure |

### 2.4 CMS Reads (Query Path)

The client queries CMS **directly via SQL** — no orchestration overhead:

```typescript
// DurableCopilotClient methods that read CMS directly:

listSessions()
  → SELECT * FROM copilot_sessions.sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC

getLastSessionId()
  → SELECT session_id FROM copilot_sessions.sessions WHERE deleted_at IS NULL ORDER BY last_active_at DESC LIMIT 1

listModels()
  → SELECT * FROM copilot_sessions.models_cache WHERE fetched_at > now() - interval '5 minutes'

// DurableSession methods that read CMS directly:

getMessages()
  → SELECT * FROM copilot_sessions.session_events WHERE session_id = $1 AND NOT ephemeral ORDER BY id ASC

getInfo()
  → SELECT * FROM copilot_sessions.sessions WHERE session_id = $1
```

### 2.5 Session Naming

```typescript
// User-friendly session naming
await client.renameSession(sessionId, "HN Tracker Bot");

// Under the hood:
// UPDATE copilot_sessions.sessions SET name = $2 WHERE session_id = $1

// List sessions returns names
const sessions = await client.listSessions();
// → [{sessionId: "abc123", name: "HN Tracker Bot", summary: "Monitors HN...", state: "idle", ...}]
```

### 2.6 TUI Integration

The TUI can now:
1. **Wake up and immediately show all sessions** from CMS (no need to enumerate duroxide orchestrations)
2. **Show session names** in the sidebar instead of UUID prefixes
3. **Show conversation history** from `session_events` without sending a "summarize" interrupt
4. **Track changes while offline** — CMS is updated by workers regardless of whether the TUI is connected
5. **Show model info** from `models_cache` without going through the orchestration

---

## Part 3: Implementation Plan

### Phase 1: CMS Foundation
**Goal: Schema + migration runner + CMS activities**

- [ ] **1.1** Create `migrations/cms/0001_initial_schema.sql` with sessions + session_events + models_cache tables
- [ ] **1.2** Create `src/cms.ts` — CMS client class with:
  - `initialize(pgConnectionString)` — create schema + run migrations
  - Direct read methods: `getSessions()`, `getSession(id)`, `getSessionEvents(id, afterSeq?)`, `getModels()`
  - Write is done through activities only (no direct write methods on client)
- [ ] **1.3** Create CMS activities: `cmsCreateSession`, `cmsUpdateSessionState`, `cmsRecordEvents`, `cmsUpdateSessionMeta`, `cmsDeleteSession`, `cmsUpdateModelsCache`, `cmsRecordError`
- [ ] **1.4** Register CMS activities in `DurableCopilotClient.start()` alongside existing activities
- [ ] **1.5** Update orchestration to call CMS activities at state transitions:
  - `cmsCreateSession` on first execution
  - `cmsUpdateSessionState` on every state change (idle→running→idle, dehydrate, etc.)
  - `cmsRecordEvents` after `runAgentTurn` returns (pass captured events)
  - `cmsUpdateSessionMeta` after each turn with metrics
- [ ] **1.6** Update `runAgentTurn` activity to capture all `CopilotSession` events (register `on()` handler, collect into array, return alongside result)
- [ ] **1.7** CMS init on `DurableCopilotClient.start()` and `startClientOnly()`
- [ ] **1.8** Integration tests: verify CMS tables are created, populated, and queryable

### Phase 2: Exact SDK Semantics — Client Methods
**Goal: DurableCopilotClient matches CopilotClient method-for-method**

- [ ] **2.1** `listSessions()` → query CMS, return `DurableSessionInfo` (enriched with CMS metadata: name, summary, event count)
- [ ] **2.2** `getLastSessionId()` → query CMS `ORDER BY last_active_at DESC LIMIT 1`
- [ ] **2.3** `listModels()` → query CMS `models_cache`; if stale, trigger refresh via activity
- [ ] **2.4** `deleteSession()` → soft delete in CMS + cancel orchestration
- [ ] **2.5** `getState()` → track connection state properly (disconnected/connecting/connected/error)
- [ ] **2.6** `ping()` → duroxide client health check
- [ ] **2.7** `on()` lifecycle events → poll CMS for session state changes or use PG `LISTEN/NOTIFY`
- [ ] **2.8** `renameSession(id, name)` → direct CMS update (new method, not in SDK but useful)

### Phase 3: Exact SDK Semantics — Session Methods
**Goal: DurableSession matches CopilotSession method-for-method**

- [ ] **3.1** `send(options: MessageOptions)` → accept full `MessageOptions` (prompt + attachments), return message ID, start event polling
- [ ] **3.2** `sendAndWait(options, timeout?)` → return `AssistantMessageEvent` (full event object, not just string)
- [ ] **3.3** `on(eventType, handler)` → subscribe to session events, poll CMS `session_events` table for new entries, dispatch to handlers
- [ ] **3.4** `abort()` → send `{type: "abort"}` through message queue, orchestration races and cancels the activity, activity calls `copilotSession.abort()`, session returns to idle
- [ ] **3.5** `destroy()` → graceful orchestration shutdown (abort current work, dehydrate if needed), keep CMS record but mark as destroyed
- [ ] **3.6** `getMessages()` → query CMS `session_events` table, return as `SessionEvent[]`
- [ ] **3.7** Backward compat: keep string-based `send(prompt)` and `sendAndWait(prompt, timeout)` overloads working

### Phase 4: Event Streaming
**Goal: Real-time event delivery from worker to client**

- [ ] **4.1** `runAgentTurn` captures all events from `CopilotSession.on()` and writes them to CMS via `cmsRecordEvents` activity after the turn
- [ ] **4.2** For real-time streaming during a turn: pipe events through `customStatus.events[]` (small batch, latest N events) so `waitForStatusChange` can deliver them incrementally
- [ ] **4.3** `DurableSession.on()` implementation: starts a background polling loop that reads new events from CMS (or from customStatus during active turns) and dispatches to registered handlers
- [ ] **4.4** Ephemeral events (deltas, progress) delivered via customStatus during the turn; non-ephemeral events persisted to CMS

### Phase 5: Advanced Features
**Goal: Full parity with remaining SDK features**

- [ ] **5.1** Permission handling: orchestration relays permission requests through message queue → client handler → response back through queue
- [ ] **5.2** Hooks: orchestration relays hook invocations through message queue → client handler → response back through queue
- [ ] **5.3** Runtime tool registration: `registerTools()` sends tool update through message queue → orchestration updates the `CopilotSession` on next turn
- [ ] **5.4** `MessageOptions.attachments` support: pass file attachments through blob store + event queue
- [ ] **5.5** `InfiniteSessionConfig` support: pass through to underlying `CopilotSession`
- [ ] **5.6** MCP server config passthrough
- [ ] **5.7** Custom agent config passthrough

### Phase 6: TUI Updates
**Goal: TUI uses CMS as its primary data source**

- [ ] **6.1** Session list reads from CMS instead of `listAllInstances()`
- [ ] **6.2** Session names displayed in sidebar (user-set names or LLM-generated summaries)
- [ ] **6.3** On session switch: load conversation history from CMS `session_events` instead of sending "summarize" interrupt
- [ ] **6.4** `/rename <name>` slash command to set session name in CMS
- [ ] **6.5** Model list from CMS `models_cache`
- [ ] **6.6** Session info (`/info`) from CMS instead of command through orchestration

---

## Migration Path

The CMS is additive — existing orchestrations continue to work. The rollout is:

1. **Phase 1**: CMS tables created but optional. Orchestrations start writing to CMS. Reads still use duroxide `getStatus()`/`waitForStatusChange()`.
2. **Phase 2-3**: Client methods start reading from CMS. `waitForStatusChange()` still used for real-time polling during active turns.
3. **Phase 4**: Event streaming via CMS replaces `customStatus`-based polling for historical events. `customStatus` still used for live turn status.
4. **Phase 5-6**: Full parity. CMS is the primary data layer. `customStatus` is only used for the real-time "is the turn still running" signal.

### Backward Compatibility

- String-based `send(prompt)` and `sendAndWait(prompt)` continue to work as overloads
- `customStatus`-based observer in TUI continues to work alongside CMS until Phase 6
- Existing orchestrations that don't write to CMS still show up (listed from duroxide + CMS union)

---

## Open Questions

1. **PG LISTEN/NOTIFY vs polling for real-time events?**
   - LISTEN/NOTIFY gives instant delivery but adds connection complexity
   - Polling with small interval (200ms) is simpler and already used
   - Could start with polling, add LISTEN/NOTIFY in Phase 5+

2. **Ephemeral event delivery during active turns?**
   - `assistant.message_delta` (streaming tokens) is ephemeral and high-frequency
   - Writing every delta to CMS is expensive
   - Better: stream deltas via `customStatus` (batched), only persist final `assistant.message`

3. **Event retention policy?**
   - CMS `session_events` can grow large for long sessions
   - Add `retention_days` config or rely on Copilot SDK's compaction events
   - Soft-deleted sessions' events can be purged after N days
