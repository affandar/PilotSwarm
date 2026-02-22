# Durable Copilot SDK — v2 Architecture

## 1. Design Philosophy

The durable-copilot-sdk is a **transparent durability layer underneath the GitHub Copilot SDK**. A developer using the Copilot SDK should be able to switch to the durable version with minimal code changes and gain:

- **Crash resilience** — sessions survive process restarts
- **Durable timers** — agents can wait hours/days without holding a process
- **Multi-node scaling** — sessions run on worker pods, relocatable across nodes
- **Offline continuity** — disconnect, reconnect, pick up where you left off

The API surface mirrors the Copilot SDK exactly. Internally, each SDK call is "remoted" through a duroxide orchestration to a worker node where a real `CopilotSession` runs. The developer never sees orchestrations, activities, event queues, or blob stores.

### Core Principles

1. **Exact SDK semantics** — Every `CopilotClient` and `CopilotSession` method has a durable counterpart with identical behavior. `abort()` cancels the in-flight message (not the session). `destroy()` releases resources (not permanent delete). `on()` delivers the same 35 event types.

2. **Orchestration as mediator** — The duroxide orchestration is the sole coordinator between user intent (client) and LLM execution (worker). It makes all durable decisions: timers, dehydration, abort handling. Neither the activity nor the client makes durable decisions.

3. **CMS as the read-only projection** — A PostgreSQL schema (`copilot_sessions`) holds session metadata and the event log. The `ManagedSession` on the worker writes events continuously. The client reads with a cursor. This is a one-way street — the CMS does not go through the orchestration.

4. **Activities as thin API calls** — Activities are the durable boundary between orchestration and session. They dispatch to the `ManagedSession` interface, not implement business logic. The `ManagedSession` owns the real `CopilotSession` and its lifecycle.

5. **Session affinity without session destruction** — When an activity yields (wait, input_required, completed), the `CopilotSession` stays alive in the `SessionManager` on the worker node. The next activity invocation finds it there. Dehydration to blob is a scale-to-zero / relocation mechanism, not a per-yield tax.

6. **`send()` + `on()` over `sendAndWait()`** — Internally, we never call `sendAndWait()`. We call `send()` and subscribe to events via `on()`. This gives us granular control: intercept tool calls before they execute, stream deltas, detect wait/input requests as they happen, and abort precisely.

---

## 2. Value Propositions

| Capability | Copilot SDK (vanilla) | Durable Copilot SDK |
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
| **Crash resilience** | Orchestration state survives process restarts. If a worker dies mid-turn, the orchestration retries the activity on another node. |
| **Durable timers** | `scheduleTimer()` persists in PG. Process can die, pod can scale to zero, timer still fires. |
| **Scale-out / relocation** | Affinity keys pin activities to a node; resetting the key after dehydration allows any node to pick up the session. |
| **Async mediation** | The orchestration races user messages against running turns and timers — coordinating two async streams (user + LLM) durably. |

```
                            +------------------------------------------------+
                            |                                                |
  +----------------+        |   ORCHESTRATION (coordination / async layer)   |
  |                |        |                                                |        +-------------------+
  |   CLIENT       |        |   Adds:                                        |        |  SESSION MANAGER  |
  |                |        |     - crash resilience (replay-safe state)     |        |                   |
  |  send()    ----+--enq-->|     - durable timers (PG-backed)               |--act-->|  ManagedSession   |
  |  abort()   ----+--enq-->|     - scale-out / relocation (affinity)        |--act-->|   .runTurn()      |
  |  destroy() ----+--enq-->|     - async mediation (race, dequeue)          |--act-->|   .abort()        |
  |                |        |                                                |        |   .destroy()      |
  |  on()      <---+--CMS-- | = = = = = = = = = = = = = = = = = = = = = = =  |--CMS<--|   .on() --> CMS   |
  |  getMsg()  <---+--CMS-- |  (orchestration never touches CMS --           |        |                   |
  |                |        |    it's a direct session --> client channel)   |        |  CopilotSession   |
  +----------------+        |                                                |        |  (real CLI proc)  |
                            +------------------------------------------------+        +-------------------+
                                               |
                               enqueueEvent / customStatus / scheduleTimer
                               dequeueEvent / race / continueAsNew
                                               |
                                      +--------+--------+
                                      |   PostgreSQL    |
                                      |  duroxide schema|
                                      |  CMS schema     |
                                      +-----------------+
```

Two data flows, cleanly separated:
- **Control flow** (solid arrows): client → orchestration → activity → ManagedSession. Durable, ordered, replay-safe.
- **Event flow** (dashed): ManagedSession → CMS → client. Read-only, cursor-based, eventually consistent. The orchestration never touches this path.

### 3.1.1 Activities as the SessionProxy

Activities are **not** a logic layer. They exist solely as the mechanism for the orchestration (which runs in the duroxide replay engine) to call methods on the `SessionManager` and `ManagedSession` (which run in normal async code on the worker).

To make this transparent, we define two proxies that replicate the worker-side interfaces using `scheduleActivity` calls. The orchestration code uses these proxies instead of raw activity names, so it reads like direct method calls.

#### SessionManagerProxy

The `SessionManagerProxy` represents the orchestration's view of the `SessionManager` singleton on the worker. It handles session lifecycle operations that are not scoped to a specific session's affinity:

```typescript
/**
 * SessionManagerProxy — orchestration's view of the SessionManager.
 * Operations that manage the session catalog or don't require session affinity.
 */
function createSessionManagerProxy(ctx: any) {
    return {
        // ─── SessionManager lifecycle ────────────────────
        listActiveSessions() {
            return ctx.scheduleActivity("listActiveSessions", {});
        },
        listModels() {
            return ctx.scheduleActivity("listModels", {});
        },
    };
}
```

#### SessionProxy

The `SessionProxy` represents the orchestration's view of a specific `ManagedSession` on a specific worker node (via affinity key). It wraps both `ManagedSession` methods and session-scoped `SessionManager` methods:

```typescript
/**
 * SessionProxy — orchestration's view of a specific ManagedSession.
 * Each method maps 1:1 to an activity dispatched to the session's worker node.
 */
function createSessionProxy(ctx: any, sessionId: string, affinityKey: string, config: SessionConfig) {
    return {
        // ─── ManagedSession interface ────────────────────
        runTurn(prompt: string) {
            return ctx.scheduleActivityOnSession(
                "runTurn", { sessionId, prompt, config }, affinityKey
            );
        },
        registerTools(tools: ToolDefinition[]) {
            return ctx.scheduleActivityOnSession(
                "registerTools", { sessionId, tools }, affinityKey
            );
        },
        updateModel(model: string) {
            return ctx.scheduleActivityOnSession(
                "updateModel", { sessionId, model }, affinityKey
            );
        },
        // abort() is not a separate activity — it's handled by
        // cancelling the runTurn activity via race (cooperative cancellation).

        // ─── SessionManager (session-scoped) ─────────────
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

// Manager-level operations (no affinity needed)
const models = yield manager.listModels();
```

#### Activity-to-Interface Mapping

**SessionProxy (session-scoped, affinity-pinned):**

| SessionProxy method | Activity | Worker-side call |
|---|---|---|
| `session.runTurn(prompt)` | `"runTurn"` | `sessionManager.getOrCreate(id, cfg).runTurn(prompt)` |
| `session.registerTools(tools)` | `"registerTools"` | `sessionManager.get(id).registerTools(tools)` |
| `session.updateModel(model)` | `"updateModel"` | `sessionManager.get(id).updateModel(model)` |
| `session.dehydrate(reason)` | `"dehydrateSession"` | `sessionManager.dehydrate(id, reason)` |
| `session.hydrate()` | `"hydrateSession"` | `blobStore.hydrate(id)` |
| `session.destroy()` | `"destroySession"` | `sessionManager.get(id).destroy()` |

**SessionManagerProxy (global, no affinity):**

| SessionManagerProxy method | Activity | Worker-side call |
|---|---|---|
| `manager.listActiveSessions()` | `"listActiveSessions"` | `sessionManager.activeSessionIds()` |
| `manager.listModels()` | `"listModels"` | `copilotClient.listModels()` + CMS cache write |

All activity bodies are one-liners. All logic lives in `ManagedSession` (turn execution, event handling, CMS writes) and the orchestration (state machine, timers, dehydration decisions). The activities and proxies are pure plumbing.

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
| **Prompt** (client → LLM) | Client → duroxide event queue → orchestration → activity → ManagedSession → CopilotSession | `enqueueEvent("messages")` | Yes — queued in PG |
| **Response** (LLM → client) | CopilotSession → `on()` → ManagedSession → CMS `session_events` → client polls | PG INSERT + SELECT with cursor | Yes — persisted |
| **Real-time status** | Orchestration → `customStatus` → client `waitForStatusChange()` | duroxide custom status | No — ephemeral per execution |
| **Abort** (client → LLM) | Client → event queue → orchestration → cancel activity → `copilotSession.abort()` | `enqueueEvent({type: "abort"})` | Yes — through orchestration |
| **Dehydration** | Orchestration → dehydrate activity → SessionManager → blob | Activity + Azure Blob | Yes |

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
- **running** — `runTurn` activity executing on worker
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

Key: the session stays alive across activity invocations. Multiple `runTurn()` calls hit the same `CopilotSession` instance. Dehydration only happens on explicit orchestration decision (idle timeout, long timer, graceful shutdown).

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

Worker B: next activity arrives (any worker, affinity key is new)
  |
  +-- 1. hydrateSession activity: download tar from blob, extract to local disk
  +-- 2. runTurn activity: SessionManager.getOrCreate(id)
  |      +-- detects local files --> CopilotClient.resumeSession(id)
  |      +-- full conversation history restored
  +-- 3. ManagedSession wraps the new CopilotSession
  |      +-- attaches on() handler --> CMS writes resume
  +-- Session is now active on Worker B
```

---

## 5. API Mapping — Copilot SDK → Durable Copilot SDK

### 5.1 Client Methods

| Copilot SDK | Durable Copilot SDK | Implementation | Differences |
|---|---|---|---|
| `new CopilotClient(opts?)` | `new DurableCopilotClient(opts)` | Constructor. `opts.store` required (PG connection string). | Adds `store`, `waitThreshold`, `blobConnectionString`, `maxSessionsPerRuntime`, `workerNodeId`, etc. |
| `client.start()` | `client.start()` | Starts duroxide Runtime + initializes CMS schema. | Also `startClientOnly()` for thin clients. |
| `client.stop()` | `client.stop()` | Shuts down Runtime, dehydrates active sessions on SIGTERM. | Returns `void` (SDK returns `Error[]`). |
| `client.forceStop()` | `client.stop()` | No separate force stop — `stop()` with timeout handles this. | — |
| `client.createSession(config?)` | `client.createSession(config?)` | Returns `DurableSession`. Orchestration starts lazily on first `send()`. | `DurableSessionConfig` mirrors `SessionConfig`. |
| `client.resumeSession(id, config?)` | `client.resumeSession(id, config?)` | Returns `DurableSession` wrapping existing orchestration. | Same shape. |
| `client.listSessions()` | `client.listSessions()` | Queries CMS `sessions` table directly (no orchestration). | Returns `DurableSessionInfo[]` with `name`, `summary`, richer status. |
| `client.deleteSession(id)` | `client.deleteSession(id)` | Soft-deletes in CMS + cancels orchestration. | Permanent delete vs SDK's disk delete. |
| `client.listModels()` | `client.listModels()` | Queries CMS `models_cache`. If stale, refreshes via `listModels` activity. | Cached with TTL. |
| `client.getLastSessionId()` | `client.getLastSessionId()` | `SELECT session_id FROM sessions ORDER BY last_active_at DESC LIMIT 1` | — |
| `client.getState()` | `client.getState()` | Tracks duroxide client connection state. | Same enum: `"disconnected" \| "connecting" \| "connected" \| "error"`. |
| `client.ping(msg?)` | `client.ping(msg?)` | Duroxide client health check (query PG). | — |
| `client.getStatus()` | `client.getStatus()` | Returns SDK + duroxide version info. | — |
| `client.getAuthStatus()` | `client.getAuthStatus()` | Queries a worker via activity (worker holds the token). | — |
| `client.on(eventType, handler)` | `client.on(eventType, handler)` | Polls CMS for session state changes. | Same lifecycle events: `session.created`, `session.deleted`, `session.updated`. |
| *N/A* | `client.renameSession(id, name)` | Updates CMS `sessions.name` directly. | New method — not in Copilot SDK. |

### 5.2 Session Methods

| Copilot SDK | Durable Copilot SDK | Implementation | Differences |
|---|---|---|---|
| `session.sessionId` | `session.sessionId` | Same — `readonly string`. | — |
| `session.send(opts)` | `session.send(opts)` | Generates messageId client-side. Enqueues prompt via `enqueueEvent("messages", {prompt, messageId, attachments})`. Returns messageId. | Accepts `MessageOptions` (prompt + attachments). |
| `session.sendAndWait(opts, timeout?)` | `session.sendAndWait(opts, timeout?)` | Calls `send()`, then polls CMS `session_events` for `session.idle` event. Returns last `assistant.message` event. | Returns `AssistantMessageEvent` (full event object, not string). Timeout does NOT abort. |
| `session.on(type, handler)` | `session.on(type, handler, opts?)` | Polls CMS `session_events` table with cursor (`opts.after`). Dispatches matching events to handler. | Adds `{after: number}` for cursor-based replay. Returns unsubscribe function. |
| `session.abort()` | `session.abort()` | Enqueues `{type: "abort"}` to message queue → orchestration races vs activity → activity calls `copilotSession.abort()` → session returns to idle. | **Same semantics** — cancels in-flight message, session stays alive. |
| `session.destroy()` | `session.destroy()` | Enqueues `{type: "destroy"}` → orchestration gracefully shuts down (abort current work, dehydrate if needed). CMS record stays (can resume). | Session can be resumed. Use `client.deleteSession()` for permanent delete. |
| `session.getMessages()` | `session.getMessages()` | `SELECT * FROM session_events WHERE session_id = $1 AND NOT ephemeral ORDER BY id ASC`. | Returns `SessionEvent[]` — same shape as SDK. |
| `session.registerTools(tools?)` | `session.registerTools(tools?)` | Enqueues tool update through message queue → orchestration updates config → next `runTurn` uses new tools. | Takes effect on next turn (not mid-turn). |
| `session.registerPermissionHandler(h?)` | `session.registerPermissionHandler(h?)` | Stores handler client-side. When orchestration relays a permission request through the message queue, client invokes handler and responds. | — |
| `session.registerUserInputHandler(h?)` | `session.registerUserInputHandler(h?)` | Stores handler client-side. When `customStatus` shows `input_required`, client invokes handler and enqueues answer. | — |
| `session.registerHooks(hooks?)` | `session.registerHooks(hooks?)` | Stores hooks client-side. Orchestration relays hook invocations through message queue. | — |
| `session.workspacePath` | `session.workspacePath` | Returns path on the worker node (not directly accessible from client). | May be `undefined` for remote sessions. |
| *N/A* | `session.lastEventSequence` | The sequence ID of the last received event — the cursor for catch-up. | New property. |
| *N/A* | `session.getInfo()` | Queries CMS `sessions` table for full metadata. | New method. |

### 5.3 String Convenience Overloads

For backward compatibility and simplicity, `DurableSession` also accepts plain strings:

```typescript
// Full SDK-compatible form
await session.send({ prompt: "hello" });
await session.sendAndWait({ prompt: "hello" }, 60000);

// Convenience overloads
await session.send("hello");
await session.sendAndWait("hello", 60000);
```

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

### 6.2 Durable Copilot SDK

```typescript
import { DurableCopilotClient, defineTool } from "durable-copilot-sdk";

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
1. Import from `durable-copilot-sdk` instead of `@github/copilot-sdk`
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

These are the core interfaces that live on the worker node. Everything else — activities, orchestrations, the SessionProxy — exists to call into these.

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

    registerTools(tools: Tool[]): void;
    updateModel(model: string): void;
    updateSystemMessage(msg: string | SystemMessageConfig): void;

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

1. **`ManagedSession` attaches `on()` at creation** — not per-turn. The handler writes non-ephemeral events to CMS and traces all events to structured logs. This runs for the session's entire in-memory lifetime, independent of any activity.

2. **`runTurn()` uses `send()` + per-turn `on()` subscriber** — the per-turn subscriber watches for yield-worthy events (idle, abort, wait tool, ask_user). The always-on handler writes to CMS. Two listeners, two purposes.

3. **`abort()` does not destroy the session** — it cancels the in-flight message. The session returns to idle and is ready for the next `runTurn()` call.

4. **Configuration methods are fire-and-forget** — they update internal state applied on the next `runTurn()`. No activity round-trip needed.

5. **`destroy()` is final** — after this, the session must be re-created via `SessionManager.getOrCreate()`. Used before dehydration or shutdown.

### 7.1 Orchestration: `durable-session`

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
                    // Interrupt arrived — activity is cancelled by race loser
                    const interruptData = JSON.parse(race.value);
                    if (interruptData.type === "abort") {
                        // Activity cancelled → copilotSession.abort() called in activity
                        setCustomStatus(ctx, "idle", { iteration, turnResult: { type: "cancelled" } });
                        continue;
                    }
                    // Other interrupt (new prompt while turn running) — 
                    // carry it into next loop iteration via continueAsNew
                    yield ctx.continueAsNew(continueInput({ prompt: interruptData.prompt }));
                    return "";
                }

                // Activity completed — handle result
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

The `ManagedSession` wraps a `CopilotSession` and provides the interface that activities call into.

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
     * Used by activities that reconnect to an existing session.
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

### 7.4 Activities

Activities are thin dispatchers:

```typescript
// ─── runTurn ─────────────────────────────────────────
function createRunTurnActivity(sessionManager: SessionManager) {
    return async (activityCtx: any, input: {
        sessionId: string;
        prompt: string;
        iteration: number;
        config?: SessionConfig;
    }): Promise<TurnResult> => {
        const session = await sessionManager.getOrCreate(input.sessionId, input.config);

        // Poll for cancellation (cooperative)
        let cancelled = false;
        const cancelPoll = setInterval(() => {
            if (activityCtx.isCancelled()) {
                cancelled = true;
                session.abort();
                clearInterval(cancelPoll);
            }
        }, 2_000);

        try {
            const result = await session.runTurn(input.prompt, {
                onDelta: (delta) => {
                    // Could stream via customStatus or just log
                    activityCtx.traceInfo(`[delta] ${delta}`);
                },
                onToolStart: (name, args) => {
                    activityCtx.traceInfo(`[tool] ${name}(${JSON.stringify(args)})`);
                },
            });

            if (cancelled) return { type: "cancelled" };
            return result;
        } finally {
            clearInterval(cancelPoll);
        }
    };
}

// ─── dehydrateSession ─────────────────────────────────
function createDehydrateActivity(sessionManager: SessionManager, blobStore: SessionBlobStore) {
    return async (_ctx: any, input: { sessionId: string; reason?: string }) => {
        await sessionManager.dehydrate(input.sessionId, blobStore, input.reason ?? "unknown");
    };
}

// ─── hydrateSession ───────────────────────────────────
function createHydrateActivity(blobStore: SessionBlobStore) {
    return async (_ctx: any, input: { sessionId: string }) => {
        await blobStore.hydrate(input.sessionId);
    };
}

// ─── listModels ───────────────────────────────────────
function createListModelsActivity(githubToken: string, cmsPool: Pool) {
    return async (_ctx: any, _input: {}) => {
        const client = new CopilotClient({ githubToken });
        try {
            await client.start();
            const models = await client.listModels();
            // Write to CMS cache
            for (const model of models) {
                await cmsPool.query(
                    `INSERT INTO copilot_sessions.models_cache (model_id, name, capabilities, policy, billing, reasoning)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (model_id) DO UPDATE SET
                       capabilities = $3, policy = $4, billing = $5, reasoning = $6, fetched_at = now()`,
                    [model.id, model.name, model.capabilities, model.policy, model.billing,
                     { supported: model.supportedReasoningEfforts, default: model.defaultReasoningEffort }]
                );
            }
            return JSON.stringify(models);
        } finally {
            try { await client.stop(); } catch {}
        }
    };
}
```

### 7.5 CMS Schema

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

### 7.6 CMS Client (for `DurableCopilotClient` reads)

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

### 7.7 Registration (in `DurableCopilotClient.start()`)

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

    // 6. Create duroxide Runtime
    this.runtime = new Runtime(provider, {
        maxSessionsPerRuntime: this.config.maxSessionsPerRuntime ?? 50,
        sessionIdleTimeoutMs: this.config.sessionIdleTimeoutMs ?? 3_600_000,
        workerNodeId: this.config.workerNodeId,
        logLevel: this.config.logLevel ?? "error",
    });

    // 7. Register activities (thin API calls into SessionManager)
    this.runtime.registerActivity("runTurn",
        createRunTurnActivity(this.sessionManager));
    this.runtime.registerActivity("dehydrateSession",
        createDehydrateActivity(this.sessionManager, this.blobStore));
    this.runtime.registerActivity("hydrateSession",
        createHydrateActivity(this.blobStore));
    this.runtime.registerActivity("listModels",
        createListModelsActivity(this.config.githubToken, this.cmsPool));

    // 8. Register orchestration
    this.runtime.registerOrchestration("durable-session", durableSessionOrchestration);

    // 9. Create duroxide client (for starting orchestrations, enqueuing events)
    this.duroxideClient = new Client(provider);

    // 10. Start runtime (non-blocking)
    this.runtime.start().catch(err => console.error("[runtime]", err));
    this.started = true;

    // 11. Graceful shutdown handler
    const shutdown = async () => { await this.stop(); process.exit(0); };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}
```

---

## 8. Key Invariants

1. **CMS is always at least as current as what the client needs.** Events are written by ManagedSession's `on()` handler as they happen, not batched at turn end. If the client disconnects and reconnects, it reads from CMS with its cursor and gets everything it missed.

2. **The orchestration never reads CMS.** It talks to activities and the event queue. Control flow and data flow are cleanly separated.

3. **Activities never make durable decisions.** They call into ManagedSession and return a result. The orchestration decides what to do with the result (timer, dehydrate, idle, etc.).

4. **The CopilotSession survives across activity invocations.** Activity yields → session stays alive in SessionManager → next activity finds it. Dehydration is the orchestration's decision, not automatic on every yield.

5. **We never call `sendAndWait()` internally.** Always `send()` + `on()`. This gives the ManagedSession full control over the turn lifecycle — intercept tools, stream deltas, detect abort — instead of being a blackbox blocking call.

6. **CMS writes are idempotent.** `UNIQUE(session_id, event_id)` + `ON CONFLICT DO NOTHING` means activity retries, replays, and duplicate event deliveries are all safe.

7. **Only one orchestration per session.** The orchestration ID is `session-{sessionId}`. No fan-out, no sub-orchestrations. One long-lived loop.
