# PilotSwarm — Architecture

## 1. Design Philosophy

PilotSwarm is a **transparent durability layer underneath the GitHub Copilot SDK**. A developer using the Copilot SDK should be able to switch to the durable version with minimal code changes and gain:

- **Crash resilience** — sessions survive process restarts
- **Durable timers** — agents can wait hours/days without holding a process
- **Multi-node scaling** — sessions run on worker pods, relocatable across nodes
- **Offline continuity** — disconnect, reconnect, pick up where you left off

The API surface mirrors the Copilot SDK exactly. Internally, each SDK call is "remoted" through a duroxide orchestration to a worker node where a real `CopilotSession` runs. The developer never sees orchestrations, activities, event queues, or blob stores.

For the main session state machine itself, see [Main Orchestration Loop](./orchestration-loop.md). For the terminal UI architecture, see [TUI Architecture](./tui-architecture.md).

### Core Principles

1. **Close SDK semantics with durable additions** — Core chat flow mirrors Copilot SDK (`createSession`, `send`, `sendAndWait`, `on`, `abort`), with durability-oriented behavior differences (`destroy` maps to client delete flow, orchestration-backed state, CMS-backed event replay).

2. **Orchestration as mediator** — The duroxide orchestration is the sole coordinator between user intent (client) and LLM execution (worker). It makes all durable decisions: timers, dehydration, abort handling. Neither the activity nor the client makes durable decisions.

3. **CMS as the session catalog** — A PostgreSQL schema (`copilot_sessions`) holds session metadata (state, title, model, timestamps) and persisted events. The client writes lifecycle metadata (create/update/delete), while the worker records non-ephemeral runtime events. Duroxide state is eventually consistent with CMS.

4. **Activities as thin API calls** — Activities are the durable boundary between orchestration and session. They dispatch to the `ManagedSession` interface, not implement business logic. The `ManagedSession` owns the real `CopilotSession` and its lifecycle.

5. **Session affinity without session destruction** — When an activity yields (wait, input_required, completed), the `CopilotSession` stays alive in the `SessionManager` on the worker node. The next activity invocation finds it there. Dehydration to blob is a scale-to-zero / relocation mechanism, not a per-yield tax.

6. **`send()` + `on()` over `sendAndWait()`** — Internally, we never call `sendAndWait()`. We call `send()` and subscribe to events via `on()`. This gives us granular control: intercept tool calls before they execute, stream deltas, detect wait/input requests as they happen, and abort precisely.

---

## 2. Value Propositions

| Capability | Copilot SDK (vanilla) | PilotSwarm |
|---|---|---|
| **Crash recovery** | Session lost if process dies | Orchestration survives, session rehydrates from blob |
| **Long waits** | `setTimeout` — process must stay alive | Durable timer — process can die, wake on any node by default, or preserve worker affinity when requested |
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
     |                       | durable-session-v2          |
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
- **`durable-session-v2` Orchestration** is the durable coordinator. It makes all durable decisions (timers, dehydration, abort routing) and calls into the **SessionManager** and **SessionProxy** on the worker. It never touches CMS. See [Orchestration Design](./orchestration-design.md) for the full module layout and pseudocode.
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
|  (PilotSwarmSession)    |   SQL    |    (orchestration history,    |
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
           |  Copilot SDK    |     |  Copilot SDK    |     |  Copilot SDK    |
           |  (in-process)   |     |  (in-process)   |     |  (in-process)   |
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
| **Response** (LLM → client) | CopilotSession → ManagedSession → orchestration `customStatus` → client `waitForStatusChange()` + persisted `assistant.message` events in CMS for replay | duroxide custom status + CMS `session_events` | Yes — CMS event log is the durable record |
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

All session lifecycle commands follow the same pattern: **write to CMS first, then make the duroxide call**. If the duroxide call fails, CMS is still correct — a periodic reconciler (planned) will detect and fix the inconsistency.

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

## 5. API Mapping — Copilot SDK → PilotSwarm

### 5.1 Client Methods

| Copilot SDK | PilotSwarm | Implementation | Differences |
|---|---|---|---|
| `new CopilotClient(opts?)` | `new PilotSwarmClient(opts)` | Constructor. `opts.store` required. | Adds durable options (`store`, dehydration thresholds, blobEnabled). |
| `client.start()` | `client.start()` | Creates duroxide `Client`; initializes CMS for PostgreSQL stores. | Worker runtime is separate (`PilotSwarmWorker.start()`). |
| `client.stop()` | `client.stop()` | Disposes client handle; leaves worker/runtime independent. | Lightweight client stop. |
| `client.createSession(config?)` | `client.createSession(config?)` | Creates CMS session row; orchestration starts lazily on first send. | Supports serializable config + in-memory tool references. |
| `client.resumeSession(id, config?)` | `client.resumeSession(id, config?)` | Returns `PilotSwarmSession` handle for existing session ID. | No immediate worker call. |
| `client.listSessions()` | `client.listSessions()` | Reads from CMS `sessions` table. | Returns `PilotSwarmSessionInfo[]`. |
| `client.deleteSession(id)` | `client.deleteSession(id)` | Soft-delete in CMS + best-effort orchestration cancel. | Durable delete behavior (not SDK disk semantics). |

### 5.2 Session Methods

| Copilot SDK | PilotSwarm | Implementation | Differences |
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

`PilotSwarmSession` currently uses string-based prompt methods:

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
    githubToken: process.env.GITHUB_TOKEN,  // standard Copilot SDK
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

### 6.2 PilotSwarm

```typescript
import { PilotSwarmClient, defineTool } from "pilotswarm-sdk";

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

const client = new PilotSwarmClient({
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
1. Import from `pilotswarm` instead of `@github/copilot-sdk`
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

// Agents get durable timer tools automatically
await session.send({ prompt: "Check the weather every hour and alert me if it rains" });
// For recurring schedules, the agent should call cron(3600, "...") once and let the orchestration own the loop
// For a one-shot durable delay, the agent calls wait(...)
// If the wait depends on worker-local state, the agent can call wait_on_worker(...) or wait(..., preserveWorkerAffinity: true)

// List all sessions with names and status
const sessions = await client.listSessions();
// → [{sessionId: "abc", name: "Weather Bot", state: "waiting", ...}]

// Per-session info can include live cron/context-window metadata
const info = await session.getInfo();
// → { cronActive: true, cronInterval: 3600, contextUsage: { currentTokens, tokenLimit, ... } }

// Scale to multiple workers
const client = new PilotSwarmClient({
    store: process.env.DATABASE_URL,
    blobConnectionString: process.env.BLOB_CONN,  // enables relocation
    maxSessionsPerRuntime: 50,
});
```

---

## 7. Implementation Detail

The implementation specifics — interfaces, schemas, and per-component
class skeletons — have moved into focused docs under
[docs/internals/](./internals/) so this doc can stay at the architecture
level.

| Topic | Doc |
|---|---|
| `SessionManager` singleton + `ManagedSession` per-session class. Turn execution, event subscription, dehydrate/hydrate, registration | [internals/session-manager.md](./internals/session-manager.md) |
| `copilot_sessions` PostgreSQL schema and the client-side CMS reader | [internals/cms-schema.md](./internals/cms-schema.md) |
| `durable-session-v2` orchestration — module layout, drain/decide pseudocode, TurnResult dispatch, sub-agents, shutdown cascade, CAN, hydration, replay invariants | [orchestration-design.md](./orchestration-design.md) |

### 7.1 Orchestration: `durable-session-v2`

One orchestration per session. Long-lived, flat event-driven loop backed by a
KV FIFO work buffer. Uses the `SessionProxy` to call into the `SessionManager`
/ `ManagedSession` interface.

The full design — module layout, runtime model, drain/decide pseudocode,
TurnResult dispatch, sub-agent lifecycle, shutdown cascade, CAN, hydration,
replay invariants — is in [Orchestration Design](./orchestration-design.md).

At a glance:

```text
index.ts ──► createRuntime ──► runLoop {
                                    drain  (queue + timer fires → KV FIFO)
                                    decide (pop one unit, dispatch)
                                    if no work → continueAsNew
                                }
```

The current latest is v1.0.52 in
[`packages/sdk/src/orchestration/`](../packages/sdk/src/orchestration/);
frozen prior versions live as `orchestration_1_0_*.ts` siblings.

The legacy single-file pseudocode that used to live here (a `dequeueEvent →
switch → race` shape from v1.0.4) is preserved in
[`docs/proposals-impl/orchestration-queue-drain-historical.md`](./proposals-impl/orchestration-queue-drain-historical.md)
for archaeology.


## 8. Sub-Agent Architecture

### 8.1 Overview

The runtime supports **autonomous sub-agents** — child sessions that run as independent durable orchestrations. A parent session can spawn sub-agents to work on tasks in parallel, each with its own conversation, tools, and LLM context.

Sub-agents are not sub-orchestrations in the duroxide sense. Each sub-agent is a full orchestration instance (`session-{childSessionId}`) created via the `PilotSwarmClient` SDK path. The parent orchestration tracks children in its `subAgents[]` array, which is carried across `continueAsNew` boundaries.

### 8.2 Built-in Agent Tools

Seven tools are injected into every session by `ManagedSession` to enable sub-agent delegation:

| Tool | Parameters | TurnResult type | What it does |
|------|-----------|-----------------|-------------|
| `spawn_agent` | `task`, `system_message?`, `model?`, `tool_names?` | `spawn_agent` | Creates a child session + orchestration. Returns agent ID. |
| `message_agent` | `agent_id`, `message` | `message_agent` | Sends a follow-up message to a running sub-agent. |
| `check_agents` | — | `check_agents` | Returns status of all sub-agents (running/completed/failed). |
| `wait_for_agents` | `agent_ids?` | `wait_for_agents` | Blocks until sub-agents finish. Returns their results. |
| `complete_agent` | `agent_id` | `complete_agent` | Marks a sub-agent as completed and stops its orchestration. |
| `cancel_agent` | `agent_id`, `reason?` | `cancel_agent` | Cancels a running sub-agent. |
| `delete_agent` | `agent_id`, `reason?` | `delete_agent` | Deletes a sub-agent entirely. |

These tools abort the current turn (like `wait` and `ask_user`) — the `ManagedSession` detects the tool call, captures the arguments, and returns a typed `TurnResult` to the orchestration. The orchestration then performs the durable operation.

### 8.3 Orchestration-Level Handling

When `runTurn()` returns a sub-agent TurnResult, the orchestration handles it:

```
spawn_agent:
  1. Call spawnChildSession activity → creates child session via SDK
  2. Add to subAgents[] array with status "running"
  3. Send result back to parent LLM as next prompt

message_agent:
  1. Call sendToSession activity → enqueues message on child's event queue
  2. Resume parent LLM with confirmation

check_agents:
  1. Call getStatus() for each sub-agent
  2. Collect statuses + latest results
  3. Resume parent LLM with status summary

wait_for_agents:
  1. Poll child orchestration statuses via getStatus()
  2. Wait (with timeout) until all specified children reach terminal state
  3. Resume parent LLM with collected results

complete_agent / cancel_agent / delete_agent:
  1. Send completion/cancellation message to child orchestration
  2. Update subAgents[] entry status
  3. Resume parent LLM with confirmation
```

### 8.4 Nesting and Limits

- **Max concurrent sub-agents per session:** 8 (`MAX_SUB_AGENTS`)
- **Max nesting depth:** 2 levels (root → child → grandchild, `MAX_NESTING_LEVEL`)
- Sub-agents inherit the parent's tools and model by default (overridable via `tool_names` and `model` parameters)
- Sub-agents are fully durable — they survive crashes, restarts, and node migrations independently
- The `subAgents[]` array is carried across `continueAsNew` boundaries

### 8.5 Parent–Child Communication

Child sessions communicate with their parent via `sendToSession` — a general-purpose activity that enqueues a message on any session's event queue. Children also report completion status through their orchestration's `customStatus`, which the parent polls via `getStatus()`.

The CMS tracks parent–child relationships via the `parentSessionId` column on the sessions table. The TUI uses this to render a tree view of sessions.

### 8.6 Data Flow

```
Parent Orchestration                           Child Orchestration
  │                                              │
  │ runTurn(prompt) → spawn_agent                 │
  │   │                                           │
  │   └─ spawnChildSession activity ──────────────┤
  │      (creates child via PilotSwarmClient)  │
  │                                               │ runTurn(task)
  │ runTurn("agent spawned: {id}")                │   │
  │   │                                           │   └─► LLM works...
  │   └─► LLM continues...                       │
  │                                               │ setCustomStatus(result)
  │ runTurn → check_agents                        │
  │   │                                           │
  │   └─ getStatus(childOrchId) ◄─────────────────┘
  │      (reads child's customStatus)
  │
  │ runTurn("agent results: {...}")
  │   └─► LLM synthesizes...
```

---

## 9. Orchestration Versioning

Orchestration code is **replayed from the beginning** on every new event. Changing the sequence of `yield` statements (adding, removing, or reordering) creates a new version that is incompatible with in-flight orchestrations recorded under the old yield sequence.

### 9.1 Versioning Strategy

The current latest version lives as a folder; frozen prior versions live as
sibling single files:

```
src/orchestration_1_0_47.ts   ┐
src/orchestration_1_0_48.ts   │ frozen — replay only
src/orchestration_1_0_49.ts   │
src/orchestration_1_0_50.ts   │
src/orchestration_1_0_51.ts   ┘
src/orchestration/            ← current latest (1.0.52, eight modules)
src/orchestration.ts          ← compatibility shim that re-exports the latest
```

The current latest version is declared in
[`src/orchestration-version.ts`](../packages/sdk/src/orchestration-version.ts).
The active registry (latest plus the five most recent frozen versions) is in
[`src/orchestration-registry.ts`](../packages/sdk/src/orchestration-registry.ts).
Older versions are pruned from the repo.

Bumping the version is a copy-folder-and-rename operation, documented in the
[directory refactor proposal](./proposals-impl/orchestration-directory-refactor.md).

A running execution replays under the version it started on, but every new
start and every `continueAsNewVersioned(...)` handoff targets the shared
latest version. That means the latest handler must treat `OrchestrationInput`
as a backward-compatible wire format for every version that is still
registered in the repo (down to
`DURABLE_SESSION_COMPATIBILITY_FLOOR_VERSION`).

### 9.2 When to Create a New Version

- Adding or removing `yield` statements
- Changing the order of yielded actions
- Adding or removing `setCustomStatus()` calls (these are recorded in duroxide history)
- Changing the `continueAsNew` input shape in a way that breaks deserialization
- Changing `continueAsNew` semantics in a way that makes older carried state resume incorrectly under the new latest handler

### 9.3 Safe Changes (No New Version Needed)

- Changing activity implementation (activity bodies run in normal code, not replayed)
- Changing `ManagedSession` logic
- Adding new tools to `ManagedSession`
- Changing CMS queries

---

## 10. Extensibility

### 10.1 Agent Definitions (.agent.md)

The runtime loads `.agent.md` files from a configurable plugin directory. Each file defines a reusable agent persona with YAML frontmatter:

```yaml
---
name: planner
description: Creates structured plans for complex tasks.
tools:
  - view
  - grep
---

# Planner Agent
You are a planning agent. Break tasks into steps...
```

The YAML `name` and `description` become agent metadata. The markdown body becomes the agent's system message. The `tools` list specifies which worker-registered tools the agent can use.

Agents are loaded by `AgentLoader` and surfaced as spawnable sub-agents.

### 10.2 Skills (SKILL.md)

Skills are knowledge modules loaded from `skills/<name>/SKILL.md`. Each skill provides domain-specific instructions:

```yaml
---
name: durable-timers
description: Expert knowledge on durable timer patterns.
---

# Durable Timer Patterns
You are running in a durable execution environment...
```

Skills are injected into the system message to give LLMs domain expertise. A skill directory can also include a `tools.json` file listing tools the skill requires:

```json
{ "tools": ["wait", "check_agents"] }
```

### 10.3 MCP Servers (.mcp.json)

External tool servers following the Model Context Protocol can be configured via `.mcp.json` files:

```json
{
  "my-server": {
    "command": "node",
    "args": ["server.js"],
    "tools": ["*"]
  },
  "remote-api": {
    "type": "http",
    "url": "https://api.example.com/mcp",
    "tools": ["query"],
    "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
  }
}
```

MCP servers support both local (stdio) and remote (HTTP/SSE) transports. Environment variable references (`${VAR}`) in string values are expanded at load time.

---

## 11. Key Invariants

1. **CMS is the source of truth for session lifecycle.** The client writes to CMS before making duroxide calls. If the client disconnects and reconnects, it reads session state from CMS — not from duroxide. Duroxide state is eventually consistent with CMS.

2. **The orchestration never reads or writes CMS.** It talks to the `SessionProxy` and the event queue. Control flow and data flow are cleanly separated.

3. **The `SessionManager` / `ManagedSession` never make durable decisions.** They execute and return a result. The orchestration decides what to do with the result (timer, dehydrate, idle, etc.).

4. **The CopilotSession survives across orchestration turns.** When `runTurn()` returns, the session stays alive in `SessionManager` — the next `runTurn()` finds it there. Dehydration is the orchestration's decision, not automatic on every turn.

5. **We never call `sendAndWait()` internally.** Always `send()` + `on()`. This gives the ManagedSession full control over the turn lifecycle — intercept tools, stream deltas, detect abort — instead of being a blackbox blocking call.

6. **CMS writes are idempotent.** `session_id` is the primary key, `createSession` uses `INSERT ... ON CONFLICT DO NOTHING`, `updateSession` uses `UPDATE ... WHERE session_id = $1`. Retries and duplicate calls are safe.

7. **One orchestration per session, sub-agents are independent orchestrations.** The orchestration ID is `session-{sessionId}`. Sub-agents spawn new orchestrations via the `PilotSwarmClient` SDK — they are not sub-orchestrations of the parent. The parent tracks children in its `subAgents[]` array. Max 8 concurrent sub-agents per parent, max 2 nesting levels.

8. **CMS access is provider-based.** All reads and writes go through the `SessionCatalogProvider` interface. The initial implementation is PostgreSQL; CosmosDB or other backends can be added without changing client or orchestration code.

9. **Sub-agent TurnResults abort the current turn.** Like `wait` and `ask_user`, sub-agent tools (`spawn_agent`, `message_agent`, etc.) abort the in-flight CopilotSession turn. The `ManagedSession` captures the tool arguments and returns a typed `TurnResult` to the orchestration, which performs the durable operation and resumes the LLM with the result.

10. **Orchestration versions are immutable, and the carried input is a compatibility contract.** Once an orchestration version is deployed and has in-flight instances, its yield sequence cannot change. New versions are separate files. The latest handler must continue to understand carried input from the oldest version that is still registered, and that compatibility must be behavioral as well as syntactic.
