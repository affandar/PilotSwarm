# Durable Copilot Runtime — Architecture

## 1. Design Philosophy

The durable-copilot-runtime is a **transparent durability layer underneath the GitHub Copilot SDK**. A developer using the Copilot SDK should be able to switch to the durable version with minimal code changes and gain:

- **Crash resilience** — sessions survive process restarts
- **Durable timers** — agents can wait hours/days without holding a process
- **Multi-node scaling** — sessions run on worker pods, relocatable across nodes
- **Offline continuity** — disconnect, reconnect, pick up where you left off

The API surface mirrors the Copilot SDK exactly. Internally, each SDK call is "remoted" through a duroxide orchestration to a worker node where a real `CopilotSession` runs. The developer never sees orchestrations, activities, event queues, or blob stores.

### Core Principles

1. **Close SDK semantics with durable additions** — Core chat flow mirrors Copilot SDK (`createSession`, `send`, `sendAndWait`, `on`, `abort`), with durability-oriented behavior differences (`destroy` maps to client delete flow, orchestration-backed state, CMS-backed event replay).

2. **Orchestration as mediator** — The duroxide orchestration is the sole coordinator between user intent (client) and LLM execution (worker). It makes all durable decisions: timers, dehydration, abort handling. Neither the activity nor the client makes durable decisions.

3. **CMS as the session catalog** — A PostgreSQL schema (`copilot_sessions`) holds session metadata (state, title, model, timestamps) and persisted events. The client writes lifecycle metadata (create/update/delete), while the worker records non-ephemeral runtime events. Duroxide state is eventually consistent with CMS.

4. **Activities as thin API calls** — Activities are the durable boundary between orchestration and session. They dispatch to the `ManagedSession` interface, not implement business logic. The `ManagedSession` owns the real `CopilotSession` and its lifecycle.

5. **Session affinity without session destruction** — When an activity yields (wait, input_required, completed), the `CopilotSession` stays alive in the `SessionManager` on the worker node. The next activity invocation finds it there. Dehydration to blob is a scale-to-zero / relocation mechanism, not a per-yield tax.

6. **`send()` + `on()` over `sendAndWait()`** — Internally, we never call `sendAndWait()`. We call `send()` and subscribe to events via `on()`. This gives us granular control: intercept tool calls before they execute, stream deltas, detect wait/input requests as they happen, and abort precisely.

---

## 2. Value Propositions

| Capability | Copilot SDK (vanilla) | Durable Copilot Runtime |
|---|---|---|
| **Crash recovery** | Session lost if process dies | Orchestration survives, session rehydrates from blob |
| **Long waits** | `setTimeout` — process must stay alive | Durable timer — process can die, wake on any node |
| **Scaling** | Single process, single machine | N worker pods, session affinity + relocation |
| **Offline reconnect** | Must re-create session, history lost | CMS has full event log, cursor-based catch-up |
| **Observability** | Events visible only in-process | All events persisted to CMS, traceable across nodes |
| **Session naming** | UUID only | User-friendly names stored in CMS |
| **Multi-client** | One client per session | Multiple clients can read the same session's events from CMS |

---

## 3. Architecture

### 3.1 Logical View — The Orchestration as Coordination Layer

The system has two endpoints — the **client** (user intent) and the **CopilotSession** (LLM execution). Between them sits the **orchestration**, which is the coordination and async layer. It does not add business logic; it adds durable infrastructure:

| Capability | What the orchestration adds |
|---|---|
| **Crash resilience** | Orchestration state survives process restarts. If a worker dies mid-turn, the orchestration retries on another node. |
| **Durable timers** | `scheduleTimer()` persists in PG. Process can die, pod can scale to zero, timer still fires. |
| **Scale-out / relocation** | Affinity keys pin sessions to a node; resetting the key after dehydration allows any node to pick up the session. |
| **Async mediation** | The orchestration races user messages against running turns and timers — coordinating two async streams (user + LLM) durably. |

```
+----------+
|          |  control (enq)
|  Client  |-------------------------------+
|          |                               |
+----+-----+                               v
     |                       +-----------------------------+
     |                       | Copilot Instance            |
     |                       | Orchestration (coordinator) |
     |                       |                             |
     |                       | Adds:                       |
     |                       |  - crash resilience         |
     |                       |  - durable timers           |
     |                       |  - scale-out / relocation   |
     |                       |  - async mediation          |
     |                       +----+-----------------+------+
     |                            |                 |
     |                            v                 +-------------------+
     |                  +----------+--+             |                   |
     |                  |             |  manages    | +--SessionProxy----+
     |                  | Session     |------------>| | +--SessionProxy----+
     |                  | Manager     |             | | |  SessionProxy    |
     |                  |             |             +-| |                  |
     |                  +--+------+---+               +-| Copilot SDK/     |
     |                     |      |                     | CLI Session      |
     |                     |      | dehydrate/          +--+---------------+
     |  reads              |      | hydrate                |
     |  (events,           |      |                        | writes
     |   messages,         |      v                        | (events,
     |   sessions)         |  +----------------+           |  metadata)
     |                     |  |  Blob Store    |           |
     |                     |  | (session tars) |           |
     |                     |  +----------------+           |
     v                     v                               v
  +--+---------------------+-------------------------------+--+
  |                          CMS                              |
  +-----------------------------------------------------------+
```

Five components, three data stores:

- **Client** owns session lifecycle in **CMS** — it writes to CMS first (create, update state, soft-delete), then makes the corresponding duroxide call (startOrchestration, enqueueEvent, cancelInstance). Reads session lists and metadata from CMS directly. Sends prompts and control messages to the orchestration via `enqueueEvent`.
- **Copilot Instance Orchestration** is the durable coordinator. It makes all durable decisions (timers, dehydration, abort routing) and calls into the **SessionManager** and **SessionProxy** on the worker. It never touches CMS.
- **SessionManager** owns in-memory session lifecycle on the worker (create, resume, destroy, dehydrate). Writes session state tars to **Blob Store** during dehydration/hydration.
- **SessionProxy** (one per active session) wraps a real **Copilot SDK/CLI Session**. Executes LLM turns and returns results to the orchestration.
- **CMS** (PostgreSQL) holds the session catalog — metadata, state, titles, timestamps, and session events. The **client** writes lifecycle metadata and the **worker** writes runtime events. Duroxide orchestration state is eventually consistent with CMS. CMS is accessed through the `SessionCatalogProvider` interface, allowing alternative backends (e.g. CosmosDB) in the future.

### 3.1.1 Activities as the SessionProxy

Activities are **not** a logic layer. They exist solely as the mechanism for the orchestration (which runs in the duroxide replay engine) to call methods on the `SessionManager` and `ManagedSession` (which run in normal async code on the worker).

To make this transparent, we define two proxies that replicate the worker-side interfaces using `scheduleActivity` calls. The orchestration code uses these proxies instead of raw activity names, so it reads like direct method calls.

#### SessionManagerProxy

The `SessionManagerProxy` represents the orchestration's view of the `SessionManager` singleton on the worker. In the current implementation it exposes only global operations that do not require session affinity:

```typescript
/**
 * SessionManagerProxy — orchestration's view of the SessionManager.
 * Operations that manage the session catalog or don't require session affinity.
 */
function createSessionManagerProxy(ctx: any) {
    return {
        listModels() {
            return ctx.scheduleActivity("listModels", {});
        },
    };
}
```

#### SessionProxy

The `SessionProxy` represents the orchestration's view of a specific `ManagedSession` on a specific worker node (via affinity key). It wraps the session-scoped activity calls used by the orchestration:

```typescript
/**
 * SessionProxy — orchestration's view of a specific ManagedSession.
 * Each method maps 1:1 to an activity dispatched to the session's worker node.
 */
function createSessionProxy(ctx: any, sessionId: string, affinityKey: string, config: SessionConfig) {
    return {
        runTurn(prompt: string) {
            return ctx.scheduleActivityOnSession(
                "runTurn", { sessionId, prompt, config }, affinityKey
            );
        },
        dehydrate(reason: string) {
            return ctx.scheduleActivityOnSession(
                "dehydrateSession", { sessionId, reason }, affinityKey
            );
        },
        hydrate() {
            return ctx.scheduleActivityOnSession(
                "hydrateSession", { sessionId }, affinityKey
            );
        },
        destroy() {
            return ctx.scheduleActivityOnSession(
                "destroySession", { sessionId }, affinityKey
            );
        },
    };
}
```

The orchestration then reads naturally:

```typescript
const manager = createSessionManagerProxy(ctx);
let session = createSessionProxy(ctx, input.sessionId, affinityKey, input.config);

// Reads like a normal API
const result = yield session.runTurn(prompt);
yield session.dehydrate("idle-timeout");

// After affinity reset, get a new proxy pointing to the (potentially different) node
affinityKey = yield ctx.newGuid();
session = createSessionProxy(ctx, input.sessionId, affinityKey, input.config);
yield session.hydrate();

// Manager-level operation (no affinity needed)
const models = yield manager.listModels();
```

#### Activity-to-Interface Mapping

**SessionProxy (session-scoped, affinity-pinned):**

| SessionProxy method | Activity | Worker-side call |
|---|---|---|
| `session.runTurn(prompt)` | `"runTurn"` | `sessionManager.getOrCreate(id, cfg).runTurn(prompt)` |
| `session.dehydrate(reason)` | `"dehydrateSession"` | `sessionManager.dehydrate(id, reason)` |
| `session.hydrate()` | `"hydrateSession"` | `blobStore.hydrate(id)` |
| `session.destroy()` | `"destroySession"` | `sessionManager.destroySession(id)` |

**SessionManagerProxy (global, no affinity):**

| SessionManagerProxy method | Activity | Worker-side call |
|---|---|---|
| `manager.listModels()` | `"listModels"` | `copilotClient.listModels()` |

All activity bodies are one-liners. All logic lives in `ManagedSession` (turn execution, event handling) and the orchestration (state machine, timers, dehydration decisions). The activities and proxies are pure plumbing.

> **Convention for the rest of this document:** Since the activity layer is mechanical — each activity is a one-liner that calls the corresponding `SessionManager` or `ManagedSession` method — we omit it from further discussion. When the orchestration calls `session.runTurn(prompt)`, understand that this goes through the `SessionProxy` → activity → `SessionManager.getOrCreate(id).runTurn(prompt)` on the worker. We talk only about the **orchestration** and the **SessionManager / ManagedSession** from here on.

### 3.2 Physical View

```
+----------------------+           +------------------------------+
|  Laptop / CI         |           |  PostgreSQL                  |
|                      |           |                              |
|  TUI / API client    |<-------->|  duroxide_copilot schema      |
|  (DurableSession)    |   SQL    |    (orchestration history,    |
|                      |          |     work items, timers)       |
|  Reads CMS ----------+--------->|                               |
|                      |          |  copilot_sessions schema      |
+----------------------+          |    (sessions, events, models) |
                                  |                               |
                                  +----------+--------------------+
                                             |
                    +------------------------+------------------------+
                    |                        |                        |
           +--------+--------+     +--------+--------+     +---------+-------+
           |  Worker Pod 1   |     |  Worker Pod 2   |     |  Worker Pod N   |
           |                 |     |                 |     |                 |
           |  duroxide       |     |  duroxide       |     |  duroxide       |
           |  Runtime        |     |  Runtime        |     |  Runtime        |
           |                 |     |                 |     |                 |
           |  SessionManager |     |  SessionManager |     |  SessionManager |
           |   +- session A  |     |   +- session C  |     |   +- session E  |
           |   +- session B  |     |   +- session D  |     |                 |
           |                 |     |                 |     |                 |
           |  Copilot CLI    |     |  Copilot CLI    |     |  Copilot CLI    |
           |  subprocess     |     |  subprocess     |     |  subprocess     |
           +--------+--------+     +--------+--------+     +--------+--------+
                    |                        |                        |
                    +------------------------+------------------------+
                                             |
                                  +----------+--------+
                                  |  Azure Blob       |
                                  |  (dehydrated      |
                                  |   session tars)   |
                                  +-------------------+
```

### 3.3 Data Flow Summary

| Flow | Path | Mechanism | Durable? |
|---|---|---|---|
| **Prompt** (client → LLM) | Client → CMS update (state=running) → duroxide event queue → orchestration → ManagedSession → CopilotSession | CMS write + `enqueueEvent("messages")` | Yes — queued in PG |
| **Response** (LLM → client) | CopilotSession → ManagedSession → orchestration `customStatus` → client `waitForStatusChange()` | duroxide custom status | Ephemeral (CMS event log is Phase 2) |
| **Session lifecycle** | Client → CMS (create/update/delete) → duroxide (start/cancel orchestration) | CMS write-first, duroxide eventually consistent | Yes — CMS is source of truth |
| **Real-time status** | Orchestration → `customStatus` → client `waitForStatusChange()` | duroxide custom status | No — ephemeral per execution |
| **Abort** (client → LLM) | Client → event queue → orchestration → cancels running turn → `copilotSession.abort()` | `enqueueEvent({type: "abort"})` | Yes — through orchestration |
| **Dehydration** | Orchestration → `session.dehydrate()` → SessionManager → blob | Azure Blob | Yes |

### 3.4 Session Catalog (CMS)

The CMS is a PostgreSQL schema that stores session metadata. It is the **source of truth** for session lifecycle — the client writes to CMS before making duroxide calls, and reads from CMS for session listings and info.

#### 3.4.1 Provider Model

CMS access is abstracted behind the `SessionCatalogProvider` interface so different backends can be plugged in:

```typescript
interface SessionCatalogProvider {
    initialize(): Promise<void>;

    // Writes (from client, before duroxide calls)
    createSession(sessionId: string, opts: { model?: string }): Promise<void>;
    updateSession(sessionId: string, updates: Partial<SessionRow>): Promise<void>;
    softDeleteSession(sessionId: string): Promise<void>;

    // Reads (from client)
    listSessions(): Promise<SessionRow[]>;
    getSession(sessionId: string): Promise<SessionRow | null>;
    getLastSessionId(): Promise<string | null>;
}
```

The initial implementation is `PgSessionCatalogProvider` (PostgreSQL via `pg`). A CosmosDB provider can be added later with the same interface.

#### 3.4.2 Schema

```sql
CREATE SCHEMA IF NOT EXISTS copilot_sessions;

CREATE TABLE IF NOT EXISTS copilot_sessions.sessions (
    session_id        TEXT PRIMARY KEY,
    orchestration_id  TEXT,              -- null until first turn starts
    title             TEXT,              -- LLM-generated 3-5 word summary
    state             TEXT NOT NULL DEFAULT 'pending',
    model             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at    TIMESTAMPTZ,
    deleted_at        TIMESTAMPTZ,       -- soft delete
    current_iteration INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_state
    ON copilot_sessions.sessions(state) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_updated
    ON copilot_sessions.sessions(updated_at DESC) WHERE deleted_at IS NULL;
```

#### 3.4.3 Write Path (Client → CMS → Duroxide)

All session lifecycle commands follow the same pattern: **write to CMS first, then make the duroxide call**. If the duroxide call fails, CMS is still correct — the reconciler (Phase 3) will detect and fix the inconsistency.

| Client method | CMS write | Then duroxide call |
|---|---|---|
| `createSession()` | `INSERT INTO sessions (session_id, state='pending', orchestration_id=NULL)` | — (orchestration starts lazily on first send) |
| `_startAndWait()` / `_startTurn()` | `UPDATE sessions SET orchestration_id=$1, state='running', last_active_at=now()` | `startOrchestration()` + `enqueueEvent()` |
| `deleteSession()` | `UPDATE sessions SET deleted_at=now()` | `cancelInstance()` |
| `resumeSession()` | — (session already exists in CMS) | — |

#### 3.4.4 Read Path (CMS → Client)

| Client method | CMS query |
|---|---|
| `listSessions()` | `SELECT * FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC` |
| `_getSessionInfo()` | `SELECT * FROM sessions WHERE session_id = $1` — merged with duroxide `customStatus` for live fields (pendingQuestion, waitingUntil) |
| `getLastSessionId()` | `SELECT session_id FROM sessions ORDER BY last_active_at DESC LIMIT 1` |

#### 3.4.5 Fallback

When no `SessionCatalogProvider` is configured (e.g. SQLite mode for local dev/tests), all methods fall back to the existing duroxide-status-based approach (`listAllInstances()`, `getStatus()` → `customStatus`). CMS is additive — nothing breaks without it.

#### 3.4.6 Consistency Model

CMS → duroxide is **write-first, eventually consistent**:

```
client.createSession()
  1. CMS:     INSERT session (state=pending, orchestration_id=null)  ✓ committed
  2. duroxide: (nothing yet — orchestration starts on first send)

client.sendAndWait(prompt)
  1. CMS:     UPDATE session (state=running, orchestration_id=X)     ✓ committed
  2. duroxide: startOrchestration(X) + enqueueEvent(prompt)          ✓ committed
  3. (poll customStatus for real-time turn result)

client.deleteSession()
  1. CMS:     UPDATE session (deleted_at=now())                      ✓ committed
  2. duroxide: cancelInstance(orchestrationId)                       ✓ best effort
```

If step 2 fails in any of these, CMS is still correct. A future **reconciler orchestration** (always-on, periodic) will scan CMS for sessions in inconsistent states (e.g. `state=pending` with no orchestration, or `deleted_at` set but orchestration still running) and fix them.

---

## 4. Lifecycle

### 4.1 Orchestration Instance Lifecycle

One orchestration instance per session. Long-lived, uses `continueAsNew` to bound history.

```
                    +---------------------------------------------+
                    |              ORCHESTRATION                   |
                    |                                             |
        start ----->|  DEQUEUE --> RUNNING --> HANDLE RESULT      |
                    |    ^                        |               |
                    |    |    +-------------------+               |
                    |    |    |                   |               |
                    |    |    v                   v               |
                    |  IDLE <--- completed    TIMER/WAIT          |
                    |    |                        |               |
                    |    |                        v               |
                    |    |                  [dehydrate?]           |
                    |    |                        |               |
                    |    |                  continueAsNew          |
                    |    |                        |               |
                    |    +------------------------+               |
                    |                                             |
                    |  On continueAsNew: new execution, same      |
                    |  instance ID. Session stays alive on node.  |
                    +---------------------------------------------+
```

States:
- **idle** — dequeue loop, waiting for next user message
- **running** — `session.runTurn()` executing on worker
- **waiting** — durable timer active (wait tool)
- **input_required** — waiting for user to answer a question
- **completed** — orchestration terminated normally (rare — sessions are long-lived)
- **failed** — unrecoverable error

### 4.2 CopilotSession Lifecycle (on Worker)

```
    create/resume
         |
         v
    +---------+   runTurn()    +---------+   turn done   +---------+
    | CREATED |--------------->| ACTIVE  |--------------->|  IDLE   |
    +---------+                +---------+                +----+----+
                                    |                          |
                                    | abort()                  | runTurn()
                                    v                          |
                               +---------+                     |
                               |CANCELLED|                     |
                               +----+----+                     |
                                    |                          |
                                    +-------------->>>>--------+
                                    (back to idle)
                                                               |
                                                     idle timeout or
                                                     SIGTERM
                                                               |
                                                               v
                                                        +------------+
                                                        | DEHYDRATED |
                                                        | (blob)     |
                                                        +------------+
                                                               |
                                                        hydrate on
                                                        any node
                                                               |
                                                               v
                                                        +---------+
                                                        | RESUMED |--> IDLE
                                                        +---------+
```

Key: the session stays alive across orchestration turns. Multiple `runTurn()` calls hit the same `CopilotSession` instance. Dehydration only happens on explicit orchestration decision (idle timeout, long timer, graceful shutdown).

### 4.3 Relocatability

A session can move between worker nodes:

```
Worker A: session active (in SessionManager memory)
  |
  +-- idle timeout / long timer / SIGTERM
  |
  +-- 1. ManagedSession.destroy() --> CopilotSession.destroy()
  |      +-- CLI flushes conversation state to ~/.copilot/session-state/{id}/
  +-- 2. tar + upload to Azure Blob
  +-- 3. Remove local files
  +-- 4. Orchestration resets affinityKey (newGuid)
  |
  v
  Session is now "dehydrated" -- no worker owns it

Worker B: next orchestration turn (any worker, affinity key is new)
  |
  +-- 1. session.hydrate(): download tar from blob, extract to local disk
  +-- 2. session.runTurn(): SessionManager.getOrCreate(id)
  |      +-- detects local files --> CopilotClient.resumeSession(id)
  |      +-- full conversation history restored
  +-- 3. ManagedSession wraps the new CopilotSession
  |      +-- session is now live on this node
  +-- Session is now active on Worker B
```

---

## 5. API Mapping — Copilot SDK → Durable Copilot Runtime

### 5.1 Client Methods

| Copilot SDK | Durable Copilot Runtime | Implementation | Differences |
|---|---|---|---|
| `new CopilotClient(opts?)` | `new DurableCopilotClient(opts)` | Constructor. `opts.store` required. | Adds durable options (`store`, dehydration thresholds, blobEnabled). |
| `client.start()` | `client.start()` | Creates duroxide `Client`; initializes CMS for PostgreSQL stores. | Worker runtime is separate (`DurableCopilotWorker.start()`). |
| `client.stop()` | `client.stop()` | Disposes client handle; leaves worker/runtime independent. | Lightweight client stop. |
| `client.createSession(config?)` | `client.createSession(config?)` | Creates CMS session row; orchestration starts lazily on first send. | Supports serializable config + in-memory tool references. |
| `client.resumeSession(id, config?)` | `client.resumeSession(id, config?)` | Returns `DurableSession` handle for existing session ID. | No immediate worker call. |
| `client.listSessions()` | `client.listSessions()` | Reads from CMS `sessions` table. | Returns `DurableSessionInfo[]`. |
| `client.deleteSession(id)` | `client.deleteSession(id)` | Soft-delete in CMS + best-effort orchestration cancel. | Durable delete behavior (not SDK disk semantics). |

### 5.2 Session Methods

| Copilot SDK | Durable Copilot Runtime | Implementation | Differences |
|---|---|---|---|
| `session.sessionId` | `session.sessionId` | Same — `readonly string`. | — |
| `session.send(opts)` | `session.send(prompt)` | Enqueues a prompt to orchestration and returns immediately. | Durable async send semantics. |
| `session.sendAndWait(opts, timeout?)` | `session.sendAndWait(prompt, timeout?)` | Sends prompt and waits for orchestration turn completion via status polling. | Returns assistant content string. |
| `session.on(type, handler)` | `session.on(type, handler)` | Polls CMS `session_events` with a sequence cursor and dispatches callbacks. | Durable cross-process subscriptions. |
| `session.abort()` | `session.abort()` | Cancels orchestration instance (best-effort current turn cancellation). | Session remains reusable. |
| `session.destroy()` | `session.destroy()` | Calls client delete flow for this session. | Durable delete path through CMS + orchestration cancel. |
| `session.getMessages()` | `session.getMessages()` | Reads persisted events from CMS. | Returns `SessionEvent[]`. |
| *N/A* | `session.getInfo()` | Merges CMS metadata + orchestration custom status. | Durable status/iteration visibility. |

### 5.3 Prompt API Shape

`DurableSession` currently uses string-based prompt methods:

```typescript
await session.send("hello");
await session.sendAndWait("hello", 60000);
```

This keeps the orchestration payloads minimal and serializable.

---

## 6. Hello World Example

### 6.1 Copilot SDK (Non-Durable)

```typescript
import { CopilotClient, defineTool } from "@github/copilot-sdk";

const getWeather = defineTool("get_weather", {
    description: "Get current weather for a city",
    parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
    },
    handler: async ({ city }) => {
        return { temp: 72, conditions: "sunny", city };
    },
});

const client = new CopilotClient({
    githubToken: process.env.GITHUB_TOKEN,
});

const session = await client.createSession({
    model: "claude-sonnet-4",
    tools: [getWeather],
    systemMessage: "You are a helpful weather assistant.",
});

session.on("assistant.message", (event) => {
    console.log("Assistant:", event.data.content);
});

session.on("tool.execution_start", (event) => {
    console.log(`Calling tool: ${event.data.toolName}`);
});

const response = await session.sendAndWait({ prompt: "What's the weather in NYC?" });
console.log("Final:", response?.data.content);

await session.destroy();
await client.stop();
```

### 6.2 Durable Copilot Runtime

```typescript
import { DurableCopilotClient, defineTool } from "durable-copilot-runtime";

const getWeather = defineTool("get_weather", {
    description: "Get current weather for a city",
    parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
    },
    handler: async ({ city }) => {
        return { temp: 72, conditions: "sunny", city };
    },
});

const client = new DurableCopilotClient({
    githubToken: process.env.GITHUB_TOKEN,
    store: process.env.DATABASE_URL,        // ← the only new required option
});

await client.start();

const session = await client.createSession({
    model: "claude-sonnet-4",
    tools: [getWeather],
    systemMessage: "You are a helpful weather assistant.",
});

session.on("assistant.message", (event) => {
    console.log("Assistant:", event.data.content);
});

session.on("tool.execution_start", (event) => {
    console.log(`Calling tool: ${event.data.toolName}`);
});

const response = await session.sendAndWait({ prompt: "What's the weather in NYC?" });
console.log("Final:", response?.data.content);

await session.destroy();
await client.stop();
```

**Differences: 3 lines.**
1. Import from `durable-copilot-runtime` instead of `@github/copilot-sdk`
2. Add `store: process.env.DATABASE_URL` to constructor
3. Add `await client.start()` (duroxide runtime needs explicit start)

Everything else is identical. The `on()` handlers fire the same events. The `sendAndWait()` returns the same `AssistantMessageEvent`. The tools work the same way.

### 6.3 Durable-Only Features

Once durable, you get additional capabilities for free:

```typescript
// Session survives restarts — resume by ID
const session = await client.resumeSession("my-session-id");

// Catch up on events you missed while offline
session.on("assistant.message", handler, { after: savedCursor });

// Name your sessions
await client.renameSession(session.sessionId, "Weather Bot");

// Agent can use durable waits (the wait tool is injected automatically)
await session.send({ prompt: "Check the weather every hour and alert me if it rains" });
// The agent calls wait(3600) → durable timer → process can die → wakes up an hour later

// List all sessions with names and status
const sessions = await client.listSessions();
// → [{sessionId: "abc", name: "Weather Bot", state: "waiting", ...}]

// Scale to multiple workers
const client = new DurableCopilotClient({
    store: process.env.DATABASE_URL,
    githubToken: process.env.GITHUB_TOKEN,
    blobConnectionString: process.env.BLOB_CONN,  // enables relocation
    maxSessionsPerRuntime: 50,
});
```

---

## 7. Implementation Detail

### 7.0 SessionManager and ManagedSession Interfaces

These are the core interfaces that live on the worker node. The orchestration calls into these via the `SessionProxy` (see §3.1.1).

```typescript
// ═══════════════════════════════════════════════════════
// SessionManager — singleton per worker node
// Owns session lifecycle, wraps CopilotClient.
// ═══════════════════════════════════════════════════════

interface SessionManager {
    // ─── Session access ──────────────────────────────

    /** Get existing session or create/resume one. */
    getOrCreate(sessionId: string, config: SessionConfig): Promise<ManagedSession>;

    /** Get session by ID (null if not in memory on this node). */
    get(sessionId: string): ManagedSession | null;

    // ─── Lifecycle ───────────────────────────────────

    /** Dehydrate: destroy in memory → tar → upload to blob → update CMS. */
    dehydrate(sessionId: string, reason: string): Promise<void>;

    /** Shutdown: destroy all sessions, stop CopilotClient. */
    shutdown(): Promise<void>;

    /** List all in-memory session IDs on this node. */
    activeSessionIds(): string[];
}

// ═══════════════════════════════════════════════════════
// ManagedSession — one per Copilot session
// Wraps CopilotSession, owns event handling and CMS writes.
// ═══════════════════════════════════════════════════════

interface ManagedSession {
    /** Session identity. */
    readonly sessionId: string;

    // ─── Turn execution ──────────────────────────────

    /**
     * Run one LLM turn.
     * Uses send() + on() internally — never sendAndWait().
     * Blocks until a yield-worthy event:
     *   - session.idle       → {type: "completed"}
     *   - wait tool fires    → {type: "wait"}
     *   - ask_user fires     → {type: "input_required"}
     *   - abort received     → {type: "cancelled"}
     *   - error              → {type: "error"}
     */
    runTurn(prompt: string, opts?: TurnOptions): Promise<TurnResult>;

    /**
     * Abort the current in-flight message.
     * Session remains alive for future runTurn() calls.
     */
    abort(): Promise<void>;

    // ─── Configuration (applied on next runTurn) ─────

    updateConfig(config: Partial<ManagedSessionConfig>): void;

    // ─── Cleanup ─────────────────────────────────────

    /**
     * Destroy: release resources, detach on() handler,
     * flush CopilotSession to disk, remove from SessionManager.
     */
    destroy(): Promise<void>;
}

// ─── Supporting types ────────────────────────────────

interface TurnOptions {
    onDelta?: (delta: string) => void;
    onToolStart?: (name: string, args: any) => void;
}

type TurnResult =
    | { type: "completed"; content: string }
    | { type: "wait"; seconds: number; reason: string; content?: string }
    | { type: "input_required"; question: string; choices?: string[]; allowFreeform?: boolean }
    | { type: "cancelled" }
    | { type: "error"; message: string };

interface SessionConfig {
    model?: string;
    systemMessage?: string | SystemMessageConfig;
    tools?: Tool[];
    workingDirectory?: string;
    hooks?: SessionHooks;
}
```

**Key design points:**

1. **`runTurn()` uses `send()` + per-turn `on()` subscriptions** — listeners are attached inside each turn to capture deltas, tool starts, terminal events, and full event traces.

2. **Event persistence is activity-driven** — `runTurn` activity passes an `onEvent` callback that records non-ephemeral events to CMS as they fire.

3. **`abort()` does not destroy the session** — it cancels the in-flight message. The session returns to idle and is ready for the next `runTurn()` call.

4. **Config updates apply on subsequent turns** — `SessionManager` can update warm-session config, and `ManagedSession.runTurn()` re-registers tools every turn.

5. **`destroy()` releases local session resources** — used before dehydration/shutdown and during explicit delete flows.

### 7.1 Orchestration: `durable-session-v2`

One orchestration per session. Long-lived, event-driven main loop.
Uses the `SessionProxy` to call into the `SessionManager` / `ManagedSession` interface.

```typescript
function* durableSessionOrchestration(ctx, input) {
    let iteration = input.iteration ?? 0;
    let affinityKey = input.affinityKey ?? input.sessionId;
    let needsHydration = input.needsHydration ?? false;

    // SessionProxy — orchestration's view of the remote session
    let session = createSessionProxy(ctx, input.sessionId, affinityKey, input.config);

    // Helper: dehydrate + reset affinity + get new proxy
    function* dehydrateAndReset(reason: string): Generator<any, void, any> {
        yield session.dehydrate(reason);
        needsHydration = true;
        affinityKey = yield ctx.newGuid();
        session = createSessionProxy(ctx, input.sessionId, affinityKey, input.config);
    }

    // ─── MAIN LOOP ──────────────────────────────────────
    while (true) {
        // ① DEQUEUE next message
        setCustomStatus(ctx, "idle", { iteration });
        const msg = yield ctx.dequeueEvent("messages");
        const data = JSON.parse(msg);

        // ② DISPATCH by message type
        switch (data.type) {
            case "abort": {
                // If a turn is running, it was already cancelled by the race.
                // Just loop back to dequeue.
                continue;
            }

            case "destroy": {
                // Graceful shutdown
                if (blobEnabled) {
                    yield* dehydrateAndReset("destroy");
                }
                return "destroyed";
            }

            case "cmd": {
                // Slash commands (set_model, list_models, get_info)
                yield* handleCommand(ctx, data, input, session, iteration);
                continue;
            }

            default: {
                // Regular prompt
                const prompt = data.prompt;

                // ③ HYDRATE if needed
                if (needsHydration && blobEnabled) {
                    affinityKey = yield ctx.newGuid();
                    session = createSessionProxy(ctx, input.sessionId, affinityKey, input.config);
                    yield session.hydrate();
                    needsHydration = false;
                }

                // ④ RUN TURN (race against next message for abort/interrupt)
                setCustomStatus(ctx, "running", { iteration });
                const turnActivity = session.runTurn(prompt);  // ← reads like a method call
                const interruptMsg = ctx.dequeueEvent("messages");
                const race = yield ctx.race(turnActivity, interruptMsg);

                if (race.index === 1) {
                    // Interrupt arrived — running turn is cancelled by race loser
                    const interruptData = JSON.parse(race.value);
                    if (interruptData.type === "abort") {
                        // Turn cancelled → copilotSession.abort() called on worker
                        setCustomStatus(ctx, "idle", { iteration, turnResult: { type: "cancelled" } });
                        continue;
                    }
                    // Other interrupt (new prompt while turn running) — 
                    // carry it into next loop iteration via continueAsNew
                    yield ctx.continueAsNew(continueInput({ prompt: interruptData.prompt }));
                    return "";
                }

                // Turn completed — handle result
                const result = JSON.parse(race.value);
                iteration++;

                // ⑤ HANDLE RESULT
                switch (result.type) {
                    case "completed":
                        setCustomStatus(ctx, "idle", { iteration, turnResult: result });
                        // Race: next message vs idle dehydration timeout
                        if (blobEnabled && idleTimeout >= 0) {
                            const nextMsg = ctx.dequeueEvent("messages");
                            const idleTimer = ctx.scheduleTimer(idleTimeout * 1000);
                            const idleRace = yield ctx.race(nextMsg, idleTimer);
                            if (idleRace.index === 0) {
                                // Message arrived — continueAsNew with prompt
                                yield ctx.continueAsNew(continueInput({
                                    prompt: JSON.parse(idleRace.value).prompt
                                }));
                                return "";
                            }
                            // Idle timeout — dehydrate + reset
                            yield* dehydrateAndReset("idle");
                        }
                        continue; // back to dequeue

                    case "wait":
                        setCustomStatus(ctx, "waiting", {
                            iteration, waitSeconds: result.seconds, turnResult: result
                        });
                        const shouldDehydrate = blobEnabled && result.seconds > dehydrateThreshold;
                        if (shouldDehydrate) {
                            yield* dehydrateAndReset("timer");
                        }
                        // Race: timer vs interrupt
                        const timer = ctx.scheduleTimer(result.seconds * 1000);
                        const waitInterrupt = ctx.dequeueEvent("messages");
                        const waitRace = yield ctx.race(timer, waitInterrupt);
                        if (waitRace.index === 0) {
                            // Timer fired — send continuation prompt
                            yield ctx.continueAsNew(continueInput({
                                prompt: `The ${result.seconds}s wait is complete. Continue.`
                            }));
                        } else {
                            // Interrupted during wait
                            yield ctx.continueAsNew(continueInput({
                                prompt: JSON.parse(waitRace.value).prompt
                            }));
                        }
                        return "";

                    case "input_required":
                        setCustomStatus(ctx, "input_required", {
                            iteration, turnResult: result,
                            pendingQuestion: result.question,
                            choices: result.choices,
                        });
                        // Wait for user answer (with optional dehydration grace period)
                        // ... (grace period race logic same as v1)
                        const answer = yield ctx.dequeueEvent("messages");
                        const answerData = JSON.parse(answer);
                        yield ctx.continueAsNew(continueInput({
                            prompt: `User was asked: "${result.question}"\nUser answered: "${answerData.answer}"`
                        }));
                        return "";

                    case "error":
                        throw new Error(result.message);
                }
            }
        }
    }
}
```

### 7.2 ManagedSession (Session Manager)

The `ManagedSession` wraps a `CopilotSession` and provides the interface that the orchestration calls into (via `SessionProxy`).

```typescript
import { CopilotClient, CopilotSession, type SessionEvent } from "@github/copilot-sdk";
import { Pool } from "pg";

interface TurnResult {
    type: "completed" | "wait" | "input_required" | "cancelled" | "error";
    content?: string;
    seconds?: number;
    reason?: string;
    question?: string;
    choices?: string[];
    message?: string;
}

class ManagedSession {
    readonly sessionId: string;
    private copilotSession: CopilotSession;
    private cmsPool: Pool;
    private eventCursor: number = 0;
    private unsubscribe: (() => void) | null = null;

    constructor(sessionId: string, copilotSession: CopilotSession, cmsPool: Pool) {
        this.sessionId = sessionId;
        this.copilotSession = copilotSession;
        this.cmsPool = cmsPool;

        // Attach event handler ONCE at creation — lives for the session's lifetime
        this.unsubscribe = this.copilotSession.on((event: SessionEvent) => {
            // 1. Trace ALL events (including ephemeral) for observability
            logger.info({ sessionId, event_type: event.type, ephemeral: event.ephemeral }, "[session-event]");

            // 2. Persist non-ephemeral events to CMS
            if (!event.ephemeral) {
                this.writeEventToCMS(event).catch(err => {
                    logger.error({ sessionId, err }, "Failed to write event to CMS");
                });
            }
        });
    }

    /**
     * Run one LLM turn.
     * Uses send() + on() — never sendAndWait().
     * Returns when the turn completes or a yield condition is detected.
     */
    async runTurn(prompt: string, config?: TurnConfig): Promise<TurnResult> {
        return new Promise<TurnResult>((resolve, reject) => {
            let content = "";
            let resolved = false;

            const turnUnsub = this.copilotSession.on((event: SessionEvent) => {
                if (resolved) return;

                switch (event.type) {
                    case "assistant.message":
                        content = event.data.content;
                        break;

                    case "assistant.message_delta":
                        // Notify any live listeners (for real-time streaming)
                        config?.onDelta?.(event.data.deltaContent);
                        break;

                    case "tool.execution_start":
                        // Intercept system tools BEFORE they execute
                        if (event.data.toolName === "wait") {
                            // The wait tool handler will abort — we detect it here
                            // and yield immediately with whatever content we have so far
                        }
                        config?.onToolStart?.(event.data.toolName, event.data.arguments);
                        break;

                    case "session.idle":
                        // Turn complete — session is idle
                        resolved = true;
                        turnUnsub();
                        resolve({ type: "completed", content });
                        break;

                    case "session.error":
                        resolved = true;
                        turnUnsub();
                        reject(new Error(event.data.message));
                        break;

                    case "abort":
                        resolved = true;
                        turnUnsub();
                        // Check if abort was from wait tool or user input
                        if (this.pendingWait) {
                            const wait = this.pendingWait;
                            this.pendingWait = null;
                            resolve({
                                type: "wait",
                                seconds: wait.seconds,
                                reason: wait.reason,
                                content, // content captured before abort
                            });
                        } else if (this.pendingInput) {
                            const input = this.pendingInput;
                            this.pendingInput = null;
                            resolve({
                                type: "input_required",
                                question: input.question,
                                choices: input.choices,
                            });
                        } else {
                            resolve({ type: "cancelled" });
                        }
                        break;
                }
            });

            // Send the message (non-blocking)
            this.copilotSession.send({ prompt }).catch(err => {
                if (!resolved) {
                    resolved = true;
                    turnUnsub();
                    reject(err);
                }
            });
        });
    }

    /**
     * Abort the current in-flight message.
     * Session remains alive for future runTurn() calls.
     */
    async abort(): Promise<void> {
        await this.copilotSession.abort();
    }

    /**
     * Destroy the session — release resources, flush to disk.
     */
    async destroy(): Promise<void> {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
        await this.copilotSession.destroy();
    }

    /**
     * Replay events from CMS since a given cursor.
     * Used when reconnecting to an existing session.
     */
    async replayEvents(afterSequence: number): Promise<SessionEvent[]> {
        const result = await this.cmsPool.query(
            `SELECT event_id, event_type, data, ephemeral, created_at
             FROM copilot_sessions.session_events
             WHERE session_id = $1 AND id > $2
             ORDER BY id ASC`,
            [this.sessionId, afterSequence]
        );
        return result.rows.map(row => ({
            id: row.event_id,
            type: row.event_type,
            data: row.data,
            ephemeral: row.ephemeral,
            timestamp: row.created_at.toISOString(),
            parentId: null,
        }));
    }

    // ─── Private ──────────────────────────────────────────

    private pendingWait: { seconds: number; reason: string } | null = null;
    private pendingInput: { question: string; choices?: string[] } | null = null;

    private async writeEventToCMS(event: SessionEvent): Promise<void> {
        await this.cmsPool.query(
            `INSERT INTO copilot_sessions.session_events
             (session_id, event_id, event_type, ephemeral, data, worker_node_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (session_id, event_id) DO NOTHING`,
            [
                this.sessionId,
                event.id,
                event.type,
                event.ephemeral ?? false,
                JSON.stringify(event.data),
                os.hostname(),
            ]
        );
    }
}
```

### 7.3 SessionManager

```typescript
class SessionManager {
    private client: CopilotClient;
    private sessions = new Map<string, ManagedSession>();
    private cmsPool: Pool;

    constructor(githubToken: string, cmsPool: Pool) {
        this.client = new CopilotClient({ githubToken, logLevel: "error" });
        this.cmsPool = cmsPool;
    }

    /**
     * Get an existing ManagedSession, or create/resume one.
     */
    async getOrCreate(sessionId: string, config: SessionConfig): Promise<ManagedSession> {
        // 1. Check if already in memory
        const existing = this.sessions.get(sessionId);
        if (existing) {
            return existing;
        }

        // 2. Check if local session files exist (post-hydration or same node)
        const sessionDir = `~/.copilot/session-state/${sessionId}`;
        let copilotSession: CopilotSession;
        if (fs.existsSync(sessionDir)) {
            copilotSession = await this.client.resumeSession(sessionId, config);
        } else {
            copilotSession = await this.client.createSession({ sessionId, ...config });
        }

        // 3. Wrap in ManagedSession (attaches on() → CMS writer)
        const managed = new ManagedSession(sessionId, copilotSession, this.cmsPool);
        this.sessions.set(sessionId, managed);

        // 4. Create/update CMS session record
        await this.cmsPool.query(
            `INSERT INTO copilot_sessions.sessions (session_id, orchestration_id, state, model, created_at, updated_at)
             VALUES ($1, $2, 'idle', $3, now(), now())
             ON CONFLICT (session_id) DO UPDATE SET state = 'idle', updated_at = now()`,
            [sessionId, `session-${sessionId}`, config.model]
        );

        return managed;
    }

    /**
     * Get a session by ID (null if not in memory on this node).
     */
    get(sessionId: string): ManagedSession | null {
        return this.sessions.get(sessionId) ?? null;
    }

    /**
     * Dehydrate a session: destroy in memory, upload to blob.
     */
    async dehydrate(sessionId: string, blobStore: SessionBlobStore, reason: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            await session.destroy();
            this.sessions.delete(sessionId);
        }
        await blobStore.dehydrate(sessionId, { reason });

        // Update CMS
        await this.cmsPool.query(
            `UPDATE copilot_sessions.sessions 
             SET state = 'dehydrated', is_dehydrated = true, updated_at = now()
             WHERE session_id = $1`,
            [sessionId]
        );
    }

    /**
     * List all in-memory session IDs on this node.
     */
    activeSessionIds(): string[] {
        return [...this.sessions.keys()];
    }

    /**
     * Shutdown: destroy all sessions, stop CopilotClient.
     */
    async shutdown(): Promise<void> {
        for (const [id, session] of this.sessions) {
            await session.destroy();
        }
        this.sessions.clear();
        await this.client.stop();
    }
}
```

### 7.4 CMS Schema

```sql
-- ─────────────────────────────────────────────────────
-- Schema: copilot_sessions
-- Lives alongside duroxide's schema in the same PG database.
-- ─────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS copilot_sessions;

-- ─── Migration tracking ──────────────────────────────

CREATE TABLE IF NOT EXISTS copilot_sessions._migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Sessions (catalog) ──────────────────────────────

CREATE TABLE copilot_sessions.sessions (
    -- Identity
    session_id              TEXT PRIMARY KEY,
    orchestration_id        TEXT NOT NULL,               -- "session-{session_id}"

    -- User-facing metadata
    name                    TEXT,                         -- user-friendly name (nullable)
    summary                 TEXT,                         -- LLM-generated or user-set summary

    -- State (mirrors DurableSessionStatus)
    state                   TEXT NOT NULL DEFAULT 'pending',
        -- pending | running | idle | waiting | input_required | completed | failed | dehydrated

    -- Configuration
    model                   TEXT,                         -- current model ID
    system_message          TEXT,                         -- system message content
    tools                   JSONB,                        -- tool definitions (name + schema, not handlers)

    -- Worker affinity
    worker_node_id          TEXT,                         -- current/last worker node
    affinity_key            TEXT,                         -- duroxide affinity key

    -- Lifecycle
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at          TIMESTAMPTZ,                  -- last user message timestamp
    deleted_at              TIMESTAMPTZ,                  -- soft delete timestamp

    -- Duroxide cross-references
    current_iteration       INTEGER NOT NULL DEFAULT 0,
    is_dehydrated           BOOLEAN NOT NULL DEFAULT false,
    blob_key                TEXT,                          -- blob storage key if dehydrated

    -- Metrics
    total_turns             INTEGER NOT NULL DEFAULT 0,
    total_input_tokens      BIGINT NOT NULL DEFAULT 0,
    total_output_tokens     BIGINT NOT NULL DEFAULT 0,

    -- Error tracking
    last_error              TEXT,
    last_error_at           TIMESTAMPTZ
);

CREATE INDEX idx_sessions_state
    ON copilot_sessions.sessions(state) WHERE deleted_at IS NULL;
CREATE INDEX idx_sessions_updated
    ON copilot_sessions.sessions(updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_sessions_last_active
    ON copilot_sessions.sessions(last_active_at DESC NULLS LAST) WHERE deleted_at IS NULL;
CREATE INDEX idx_sessions_worker
    ON copilot_sessions.sessions(worker_node_id) WHERE deleted_at IS NULL;


-- ─── Session Events (append-only log) ────────────────

CREATE TABLE copilot_sessions.session_events (
    -- Sequence ID (the cursor)
    id                  BIGSERIAL PRIMARY KEY,

    -- Session reference
    session_id          TEXT NOT NULL REFERENCES copilot_sessions.sessions(session_id),

    -- Event identity (from Copilot SDK SessionEvent)
    event_id            TEXT NOT NULL,                    -- SDK event UUID
    parent_id           TEXT,                             -- SDK parent event UUID
    event_type          TEXT NOT NULL,                    -- "assistant.message", "tool.execution_start", etc.
    ephemeral           BOOLEAN NOT NULL DEFAULT false,   -- transient events (deltas, progress)

    -- Event payload (the SDK's event.data — schema varies by event_type)
    data                JSONB NOT NULL,

    -- Metadata
    iteration           INTEGER NOT NULL DEFAULT 0,       -- orchestration iteration when event was produced
    worker_node_id      TEXT,                              -- which worker node produced this event
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Deduplication: same event can't be written twice (activity retry safety)
    UNIQUE(session_id, event_id)
);

-- Cursor-based reads: "give me events for session X after sequence Y"
CREATE INDEX idx_events_cursor
    ON copilot_sessions.session_events(session_id, id);

-- Type-filtered reads: "give me all assistant.message events for session X"
CREATE INDEX idx_events_type
    ON copilot_sessions.session_events(session_id, event_type);


-- ─── Models Cache ────────────────────────────────────

CREATE TABLE copilot_sessions.models_cache (
    model_id            TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    capabilities        JSONB NOT NULL,                   -- {supports: {vision, reasoning}, limits: {...}}
    policy              JSONB,                            -- {state, terms}
    billing             JSONB,                            -- {multiplier}
    reasoning           JSONB,                            -- {supported: [...], default: "..."}
    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    worker_node_id      TEXT                              -- which worker fetched this
);

CREATE INDEX idx_models_fetched
    ON copilot_sessions.models_cache(fetched_at DESC);
```

### 7.5 CMS Client (for `DurableCopilotClient` reads)

```typescript
import { Pool } from "pg";

class CMSClient {
    private pool: Pool;

    constructor(connectionString: string) {
        this.pool = new Pool({ connectionString });
    }

    /**
     * Initialize schema and run migrations.
     */
    async initialize(): Promise<void> {
        await this.pool.query(`CREATE SCHEMA IF NOT EXISTS copilot_sessions`);
        // Run numbered migration files from migrations/cms/
        await this.runMigrations();
    }

    // ─── Session Catalog ──────────────────────────────

    async listSessions(): Promise<SessionInfo[]> {
        const result = await this.pool.query(
            `SELECT session_id, orchestration_id, name, summary, state, model,
                    worker_node_id, created_at, updated_at, last_active_at,
                    current_iteration, is_dehydrated, total_turns,
                    total_input_tokens, total_output_tokens
             FROM copilot_sessions.sessions
             WHERE deleted_at IS NULL
             ORDER BY COALESCE(last_active_at, updated_at) DESC`
        );
        return result.rows;
    }

    async getSession(sessionId: string): Promise<SessionInfo | null> {
        const result = await this.pool.query(
            `SELECT * FROM copilot_sessions.sessions WHERE session_id = $1`,
            [sessionId]
        );
        return result.rows[0] ?? null;
    }

    async getLastSessionId(): Promise<string | null> {
        const result = await this.pool.query(
            `SELECT session_id FROM copilot_sessions.sessions
             WHERE deleted_at IS NULL
             ORDER BY last_active_at DESC NULLS LAST
             LIMIT 1`
        );
        return result.rows[0]?.session_id ?? null;
    }

    async renameSession(sessionId: string, name: string): Promise<void> {
        await this.pool.query(
            `UPDATE copilot_sessions.sessions SET name = $2, updated_at = now() WHERE session_id = $1`,
            [sessionId, name]
        );
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.pool.query(
            `UPDATE copilot_sessions.sessions SET deleted_at = now(), state = 'deleted' WHERE session_id = $1`,
            [sessionId]
        );
    }

    // ─── Session Events ───────────────────────────────

    async getEvents(sessionId: string, options?: {
        after?: number;         // cursor: sequence ID to start after
        types?: string[];       // event type filter
        includeEphemeral?: boolean;
        limit?: number;
    }): Promise<{ events: SessionEvent[]; cursor: number }> {
        const after = options?.after ?? 0;
        const limit = options?.limit ?? 1000;
        const conditions = [`session_id = $1`, `id > $2`];
        const params: any[] = [sessionId, after];

        if (!options?.includeEphemeral) {
            conditions.push(`NOT ephemeral`);
        }
        if (options?.types?.length) {
            params.push(options.types);
            conditions.push(`event_type = ANY($${params.length})`);
        }

        const result = await this.pool.query(
            `SELECT id, event_id, parent_id, event_type, ephemeral, data, iteration, created_at
             FROM copilot_sessions.session_events
             WHERE ${conditions.join(" AND ")}
             ORDER BY id ASC
             LIMIT $${params.length + 1}`,
            [...params, limit]
        );

        const events = result.rows.map(row => ({
            id: row.event_id,
            type: row.event_type,
            data: row.data,
            ephemeral: row.ephemeral,
            timestamp: row.created_at.toISOString(),
            parentId: row.parent_id,
            _sequence: row.id, // internal cursor value
        }));

        const cursor = events.length > 0 ? events[events.length - 1]._sequence : after;
        return { events, cursor };
    }

    // ─── Models Cache ─────────────────────────────────

    async getModels(maxAgeSec = 300): Promise<ModelInfo[]> {
        const result = await this.pool.query(
            `SELECT * FROM copilot_sessions.models_cache
             WHERE fetched_at > now() - interval '1 second' * $1
             ORDER BY name ASC`,
            [maxAgeSec]
        );
        return result.rows;
    }

    // ─── Cleanup ──────────────────────────────────────

    async close(): Promise<void> {
        await this.pool.end();
    }
}
```

### 7.6 Registration (in `DurableCopilotClient.start()`)

```typescript
async start(): Promise<void> {
    // 1. Create duroxide provider (PG)
    const provider = new PostgresProvider(this.config.store, {
        schema: "duroxide_copilot",
    });

    // 2. Initialize CMS schema (separate PG schema, same database)
    this.cms = new CMSClient(this.config.store);
    await this.cms.initialize();

    // 3. Create CMS PG pool for SessionManager
    this.cmsPool = new Pool({ connectionString: this.config.store });

    // 4. Create SessionManager (long-lived, owns ManagedSessions)
    this.sessionManager = new SessionManager(this.config.githubToken, this.cmsPool);

    // 5. Create blob store if configured
    if (this.config.blobConnectionString) {
        this.blobStore = new SessionBlobStore(this.config.blobConnectionString);
    }

    // 6. Create duroxide Runtime + register orchestration and
    //    SessionProxy activities (see §3.1.1 for the mapping)
    this.runtime = new Runtime(provider, {
        maxSessionsPerRuntime: this.config.maxSessionsPerRuntime ?? 50,
        sessionIdleTimeoutMs: this.config.sessionIdleTimeoutMs ?? 3_600_000,
        workerNodeId: this.config.workerNodeId,
        logLevel: this.config.logLevel ?? "error",
    });
    registerSessionProxyActivities(this.runtime, this.sessionManager, this.blobStore);
    this.runtime.registerOrchestration("durable-session", durableSessionOrchestration);

    // 7. Create duroxide client (for starting orchestrations, enqueuing events)
    this.duroxideClient = new Client(provider);

    // 8. Start runtime (non-blocking)
    this.runtime.start().catch(err => console.error("[runtime]", err));
    this.started = true;

    // 9. Graceful shutdown handler
    const shutdown = async () => { await this.stop(); process.exit(0); };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}
```

---

## 8. Key Invariants

1. **CMS is the source of truth for session lifecycle.** The client writes to CMS before making duroxide calls. If the client disconnects and reconnects, it reads session state from CMS — not from duroxide. Duroxide state is eventually consistent with CMS.

2. **The orchestration never reads or writes CMS.** It talks to the `SessionProxy` and the event queue. Control flow and data flow are cleanly separated.

3. **The `SessionManager` / `ManagedSession` never make durable decisions.** They execute and return a result. The orchestration decides what to do with the result (timer, dehydrate, idle, etc.).

4. **The CopilotSession survives across orchestration turns.** When `runTurn()` returns, the session stays alive in `SessionManager` — the next `runTurn()` finds it there. Dehydration is the orchestration's decision, not automatic on every turn.

5. **We never call `sendAndWait()` internally.** Always `send()` + `on()`. This gives the ManagedSession full control over the turn lifecycle — intercept tools, stream deltas, detect abort — instead of being a blackbox blocking call.

6. **CMS writes are idempotent.** `session_id` is the primary key, `createSession` uses `INSERT ... ON CONFLICT DO NOTHING`, `updateSession` uses `UPDATE ... WHERE session_id = $1`. Retries and duplicate calls are safe.

7. **Only one orchestration per session.** The orchestration ID is `session-{sessionId}`. No fan-out, no sub-orchestrations. One long-lived loop.

8. **CMS access is provider-based.** All reads and writes go through the `SessionCatalogProvider` interface. The initial implementation is PostgreSQL; CosmosDB or other backends can be added without changing client or orchestration code.
