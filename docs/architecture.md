# Architecture: durable-copilot-sdk

## The Problem

The GitHub Copilot SDK lets you build AI agents that call tools, answer questions, and perform multi-step tasks. The SDK does persist session state to local disk (`~/.copilot/session-state/`), so sessions survive process restarts on the same machine. But the state is **local and non-relocatable**, which creates fundamental limitations:

1. **No durable waits.** If the agent says "check back in 1 hour," you must keep a process alive to trigger the resume. There's no timer primitive that fires independently.

2. **No load balancing.** Session files are pinned to one machine's filesystem. You can't distribute agent work across a cluster — whichever node has the files must run the agent.

3. **No VM crash resilience.** If the VM dies (hardware failure, spot eviction, disk loss), the session state goes with it. The agent can't relocate to another node.

4. **No external triggers.** The agent only works when a human sends a prompt. There's no way to wake an agent on a timer or external event.

5. **No async user input.** When the agent asks a question (`ask_user`), it blocks the process waiting for stdio input. There's no way to route the question to a web UI, Slack, or email and resume later.

`durable-copilot-sdk` solves all of these by wrapping the Copilot SDK with [duroxide](https://github.com/affandar/duroxide), a durable execution framework. The developer's code barely changes — they use the same `defineTool()` API, the same model selection, the same system prompts. They just swap `CopilotClient` for `DurableCopilotClient` and add a database connection string.

---

## High-Level Architecture

### Client / Server Model

`durable-copilot-sdk` follows a **client/server model**, just like duroxide itself:

- **Client side** (`client.createSession()`, `session.sendAndWait()`, `session.getInfo()`) — a thin API that writes to and reads from Postgres. Can be an Express route handler, a CLI tool, a cron job, or anything with a database connection. No Copilot SDK needed on the client. The API mirrors the Copilot SDK: `DurableCopilotClient` ↔ `CopilotClient`, `DurableSession` ↔ `CopilotSession`.

- **Server side** (`client.start()`) — a long-running worker process that polls Postgres for work, runs Copilot SDK sessions, executes tools, and manages orchestrations. This is where the Copilot CLI runs.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLIENT (any process)                        │
│                                                                     │
│  import { DurableCopilotClient } from "durable-copilot-sdk";       │
│                                                                     │
│  const client = new DurableCopilotClient({                          │
│      store: "postgres://...",                                       │
│  });                                                                │
│                                                                     │
│  // Same API as CopilotClient — just read/write Postgres            │
│  const session = await client.createSession({                       │
│      tools: [getWeather, queryDb],                                  │
│      systemMessage: "You are a helpful assistant.",                  │
│  });                                                                │
│  await session.sendAndWait("Deploy and monitor for 1 hour");        │
│  const info = await session.getInfo();                              │
│  await session.sendEvent("user_answer", { answer: "yes" });         │
│                                                                     │
└──────────┬──────────────────────────────────────────────────────────┘
           │ Postgres (reads/writes)
           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         POSTGRES                                    │
│                                                                     │
│  duroxide tables: orchestrations, activities, timers, events        │
│  agent_events: user input questions, answers (out-of-band)          │
│                                                                     │
└──────────┬──────────────────────────────────────────────────────────┘
           │ Postgres (poll / LISTEN)
           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    SERVER (worker processes)                         │
│                                                                     │
│  const worker = new DurableCopilotClient({                          │
│      store: "postgres://...",                                       │
│      githubToken: process.env.GITHUB_TOKEN,                         │
│  });                                                                │
│  await worker.start();  // ← starts duroxide runtime + Copilot CLI  │
│                                                                     │
│  ┌──────────────┐  ┌────────────────┐  ┌────────────────────────┐  │
│  │ duroxide      │  │ SessionManager │  │ System Tools           │  │
│  │ runtime       │  │ (CopilotClient │  │ (wait, checkpoint)     │  │
│  │ (polling)     │  │  + CLI procs)  │  │                        │  │
│  └──────┬───────┘  └───────┬────────┘  └───────────┬────────────┘  │
│         │                  │                        │               │
│  ┌──────▼──────────────────▼────────────────────────▼────────────┐  │
│  │                  Orchestration + Activities                    │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  Worker 1 (AKS pod)          Worker 2 (AKS pod)                    │
│  worker.start()              worker.start()                        │
│  Both compete for work from the same Postgres                      │
└─────────────────────────────────────────────────────────────────────┘
```

### The Split

| Operation | Runs on | Needs Copilot CLI? | Needs Postgres? |
|-----------|---------|-------------------|-----------------|
| `client.createSession(config)` | Client | No | Yes (write) |
| `session.sendAndWait(prompt)` | Client | No | Yes (write+poll) |
| `session.getInfo()` | Client | No | Yes (read) |
| `session.sendEvent(name, data)` | Client | No | Yes (write) |
| `client.listSessions()` | Client | No | Yes (read) |
| `client.start()` | Server/Worker | **Yes** | Yes (poll) |

This means the client can be a lightweight web server, a serverless function, or even a CLI script. All it does is write orchestration requests to Postgres and read results back. The heavy work (LLM calls, tool execution, session management) happens on the worker nodes.

### What Happens When You Call `session.sendAndWait()`

1. Client writes a message event to the orchestration in Postgres
2. A worker picks up the orchestration (via `SELECT FOR UPDATE SKIP LOCKED`)
3. The worker creates/resumes a Copilot SDK session, sends the prompt, handles tools
4. If the LLM calls `wait()`, control returns to duroxide for a durable timer
5. If the LLM finishes, the result is written to Postgres
6. Client's `sendAndWait()` poll resolves with the assistant's response

---

## Inside the Copilot SDK

To understand the architecture, you need to understand what the SDK actually does — and what it doesn't.

### What the SDK Is

The Copilot SDK (`@github/copilot-sdk`) is a thin JSON-RPC shim over the closed-source Copilot CLI (`@github/copilot`). When you create a `CopilotClient`, it:

1. **Spawns** the Copilot CLI as a child process
2. **Connects** via JSON-RPC over stdio pipes
3. **Forwards** your prompts to the CLI, which calls the LLM (GitHub Copilot API)
4. **Handles callbacks** when the LLM invokes tools — the CLI sends a JSON-RPC `"tool.call"` request back to your process, your handler runs, and the result is sent back

```
Your Process                    CLI Process (closed source)
    │                               │
    ├─ session.send(prompt) ───────▶│──── calls LLM API ────▶ GitHub Copilot API
    │                               │◀─── LLM response ◀────
    │                               │
    │◀── "tool.call" { get_weather }│     (LLM wants a tool)
    ├── handler runs ──────────────▶│
    │◀── result ───────────────────▶│──── feeds result ─────▶ LLM
    │                               │◀─── final answer ◀────
    │◀── "session.idle" ───────────│
    │                               │
```

### Session State

The CLI stores session state on local disk at `~/.copilot/session-state/{sessionId}/`:

```
events.jsonl      ← Append-only event log (every message, tool call, result)
workspace.yaml    ← Session metadata (id, cwd, timestamps)
session.db        ← SQLite database (agent todos/planning)
checkpoints/      ← Context compaction summaries
plan.md           ← Agent's working plan
files/            ← Persistent artifacts
```

This is an event-sourced log. When you call `resumeSession(id)`, the CLI reads `events.jsonl` back and reconstructs the conversation. This means:

- **Sessions survive process restarts** — kill the CLI, start a new one, resume works
- **Sessions are portable** — copy the files to another machine, resume works
- **Sessions are append-only** — ideal for incremental backups

### What the SDK Cannot Do

- **Timers/scheduling** — no `setTimeout` equivalent that fires independently of the process
- **External triggers** — no way to wake an agent from an external event
- **Relocatable state** — sessions are local files, not portable across machines. Can't load-balance, can't survive VM loss.
- **Async user input** — `onUserInputRequest` blocks the process waiting for a response

These are exactly the gaps duroxide fills.

---

## The Orchestration Loop

The core of `durable-copilot-sdk` is a duroxide orchestration that drives the Copilot SDK session.

### Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                DUROXIDE ORCHESTRATION                             │
│                "durable-copilot-agent"                            │
│                                                                  │
│  Input: AgentState { prompt, sessionId, iteration, ... }         │
│                                                                  │
│  1. ACTIVITY: runAgentTurn(state)                                │
│     ├─ Create or resume Copilot session                          │
│     ├─ Register user tools + system tools (wait, checkpoint)     │
│     ├─ sendAndWait(prompt)                                       │
│     │   └─ CLI inner loop: LLM → tools → LLM → tools → ...     │
│     │   └─ If wait tool called: handler signals, returns         │
│     └─ Returns TurnResult:                                       │
│        { type: "completed", answer }                             │
│        { type: "wait", seconds, reason }                         │
│        { type: "user_input", question, choices }                 │
│        { type: "error", message }                                │
│                                                                  │
│  2. BRANCH on TurnResult:                                        │
│     ├─ completed → orchestration returns answer                  │
│     ├─ wait (short) → sleep in activity, loop                    │
│     ├─ wait (long) → durable timer, continue-as-new              │
│     ├─ user_input → wait_for_event, continue-as-new              │
│     └─ error → retry or fail                                     │
│                                                                  │
│  3. continue-as-new(updatedState) → bounded history              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Activity: runAgentTurn

This is the bridge between duroxide and the Copilot SDK. It's a single activity that:

1. Retrieves or creates a `CopilotSession` from the `SessionManager`
2. Registers all tools (user-provided + system tools)
3. Calls `sendAndWait(prompt)`
4. The CLI's inner loop runs — the LLM may call multiple tools in sequence
5. If a system tool (`wait`, `checkpoint`) fires, it sets a pending action
6. When `sendAndWait()` completes (or is aborted), the activity returns a `TurnResult`

```typescript
// Simplified — actual implementation handles errors, timeouts, etc.
async function runAgentTurn(state: AgentState): Promise<TurnResult> {
    let pendingAction: PendingAction | null = null;

    const session = await sessionManager.getOrCreate(state.sessionId, {
        tools: mergeTools(userTools, createSystemTools((action) => {
            pendingAction = action;
            if (action.type === "wait" && action.seconds > state.waitThreshold) {
                session.abort();  // break out of sendAndWait
            }
        })),
        systemMessage: state.systemMessage,
        onUserInputRequest: async (request) => {
            pendingAction = { type: "user_input", ...request };
            session.abort();
            throw new Error("DEFERRED");
        },
    });

    try {
        const response = await session.sendAndWait({ prompt: state.prompt });

        if (pendingAction) {
            return pendingAction;  // wait, user_input, etc.
        }

        return { type: "completed", answer: response?.data?.content };
    } catch (err) {
        if (pendingAction) {
            return pendingAction;  // aborted due to system tool
        }
        return { type: "error", message: err.message };
    }
}
```

### The Wait Tool — How Durable Timers Work

When the LLM decides to wait (e.g., "check back in 1 hour"), it calls the injected `wait` tool. Here's what happens:

**Short wait (< threshold, default 60s):**
```
LLM calls wait(30, "polling interval")
  → handler sleeps 30s in-process
  → returns "waited 30 seconds"
  → LLM continues in the same sendAndWait() call
  → no duroxide involvement, fast path
```

**Long wait (> threshold):**
```
LLM calls wait(3600, "check back in 1 hour")
  → handler sets pendingAction = { type: "wait", seconds: 3600 }
  → handler calls session.abort()
  → sendAndWait() throws/returns
  → activity returns { type: "wait", seconds: 3600, reason: "..." }

Orchestration receives TurnResult:
  → ctx.create_timer(Duration::from_secs(3600))
  → orchestration dehydrates (no process, no memory, no cost)
  → ... 1 hour passes ...
  → timer fires in Postgres
  → orchestration rehydrates
  → state.prompt = "The 1-hour wait is complete. Continue."
  → continue_as_new(state) → runs next turn
```

The LLM doesn't know the difference. It called `wait(3600)`, and from its perspective (on resume), the wait happened. In reality, the entire process shut down and woke up an hour later.

### The Checkpoint Tool — How Progress Is Saved

When the LLM calls `checkpoint("deployed to staging")`:

- **Phase 1:** Logs the summary (no-op for durability — duroxide's event history is the checkpoint)
- **Phase 4:** Tracks the `events.jsonl` byte offset, uploads only the new bytes to Azure Append Blob. Cost is proportional to work done since last checkpoint, not total session size.

The system prompt instructs the LLM to checkpoint after significant steps:

```
You have a checkpoint tool. Call it after completing each significant step
and before any long wait. This ensures your progress is saved.
```

---

## User Input — The ask_user Problem

The Copilot SDK has an `onUserInputRequest` handler. When the LLM uses the `ask_user` tool, the CLI sends a callback to your process. The standard SDK blocks until you return an answer — typically from stdio.

In a durable agent, there's no stdio. The user might respond in minutes, hours, or days. Here's how we handle it:

### The Flow

```
1. LLM calls ask_user("Should I deploy to production?")
   
2. CLI sends "userInput.request" to SDK process
   
3. Our onUserInputRequest handler:
   a. Sets pendingAction = { type: "user_input", question: "...", choices: [...] }
   b. Calls session.abort() to break sendAndWait()
   c. Throws to prevent returning an answer
   
4. Activity returns { type: "user_input", question, choices }
   
5. Orchestration:
   a. Schedules activity: writeUserInputRequest(agentId, question, choices)
      → Writes to agent_events table in Postgres (out-of-band, not duroxide)
   b. Creates durable wait: ctx.wait_for_event("user_answer")
   c. continue_as_new(state) — dehydrates
   
6. ... time passes (minutes, hours, days) ...

7. External process (LISTEN/NOTIFY on agent_events):
   → Sees new question for agentId
   → Delivers to user via web UI, Slack, email, etc.
   → User answers
   → External process calls: session.sendEvent("user_answer", { answer: "yes" })
     → This is just a duroxide raise_event (writes to Postgres)

8. Orchestration rehydrates:
   a. Receives the answer
   b. state.prompt = "The user answered: yes. Continue."
   c. Resumes session, sends prompt, LLM continues
```

### Out-of-Band Signaling via Postgres

User input flows through a **dedicated Postgres table**, not through duroxide's event system. This decouples the "question delivery" concern from the "answer delivery" concern:

```sql
CREATE TABLE agent_events (
    id SERIAL PRIMARY KEY,
    agent_id TEXT NOT NULL,
    event_type TEXT NOT NULL,        -- 'user_input_request', 'checkpoint', 'wait', etc.
    payload JSONB NOT NULL,          -- { question, choices, ... }
    created_at TIMESTAMPTZ DEFAULT now()
);
```

**Why out-of-band (not duroxide)?** Duroxide events (`raise_event` / `wait_for_event`) are for the orchestration to consume. But the question needs to reach an *external system* (web UI, Slack bot) that isn't a duroxide orchestration. The external system needs a simple way to discover pending questions.

**The external process** that bridges agents to users is a separate concern:

```typescript
// User-facing service (Express, Slack bot, etc.)
// Polls or LISTENs on agent_events table

// Show pending questions to user
app.get("/agents/:id/questions", async (req, res) => {
    const questions = await db.query(
        "SELECT * FROM agent_events WHERE agent_id = $1 AND event_type = 'user_input_request' AND answered = false",
        [req.params.id]
    );
    res.json(questions);
});

// User answers a question → raise duroxide event
app.post("/agents/:id/answer", async (req, res) => {
    const session = client.resumeSession(req.params.id);
    await session.sendEvent("user_answer", req.body);
    await db.query("UPDATE agent_events SET answered = true WHERE id = $1", [req.body.questionId]);
    res.json({ ok: true });
});
```

This keeps the worker completely headless — it writes questions to Postgres and waits. The user-facing service reads questions and writes answers. They never communicate directly. Postgres is the bus.

---

## Timers and Scheduling

### One-off Timers

Any `wait()` call above the threshold becomes a durable timer:

```
duroxide timer → stored in Postgres → fires even if no process is running
             → worker picks up when timer fires → resumes orchestration
```

Timer precision depends on the duroxide polling interval (default 1s for duroxide-pg-opt with LISTEN/NOTIFY).

### Recurring Schedules

`session.schedule()` creates an orchestration that loops with timers:

```typescript
const session = await client.createSession({
    tools: [checkHealth],
    systemMessage: "You monitor server health.",
});

// Runs every 30 minutes
await session.schedule({ every: 1800 });

// Or cron expression
await session.schedule({ cron: "0 9 * * *" });
```

Internally, this creates a duroxide orchestration:

```
orchestration: scheduled-agent
  loop:
    1. run the agent (sub-orchestration or inline)
    2. create_timer(next_interval)
    3. continue_as_new
```

Each run is independent — if one run fails or takes longer than the interval, the next one still fires on schedule (or can be configured to skip if previous is still running).

### External Event Triggers

Beyond timers, agents can be triggered by external events:

```typescript
// Create a session that waits for a webhook
const session = await client.createSession({
    tools: [processData],
    systemMessage: "You process incoming data.",
});
await session.send("Wait for incoming data");

// Later, from a webhook handler:
await session.sendEvent("webhook_data", { payload: req.body });
```

This uses duroxide's `wait_for_event` / `raise_event` primitives. Events are stored in Postgres and delivered reliably even if the agent process isn't running when the event arrives.

---

## Node Affinity — The Stickiness Problem

### Why It Matters

The Copilot CLI stores session state on the **local filesystem** of the worker node:

```
Worker Node A:
  ~/.copilot/session-state/abc-123/
    events.jsonl    (8MB of conversation history)
    session.db
    workspace.yaml
```

When the agent dehydrates (long wait, user input), the orchestration state goes to Postgres. But the session files stay on Node A's disk. If the orchestration rehydrates on Node B, there are no session files — `resumeSession()` fails.

### Phase 1 Solution: Single Node

No problem. Everything runs on one node. Session files are always local.

### Phase 2 Solution: Activity Tags

When multiple workers are available, we need to route activities to the node that has the session files. We use duroxide's activity tag system:

```
1. First activity runs on any node (no tag)
   → Worker A picks it up
   → Creates Copilot session, files stored on Worker A
   → Returns { workerId: "worker-A", sessionId: "abc-123" }

2. Orchestration stores workerId in AgentState

3. Next activity uses .with_tag("worker-A")
   → Routed specifically to Worker A
   → Session files are there, resumeSession() works
```

Each worker registers with its own identity:

```typescript
// Worker startup
const workerId = process.env.HOSTNAME;  // e.g., "toygres-worker-7b4f9"
const options = RuntimeOptions.default()
    .withWorkerTags(TagFilter.defaultAnd([workerId]));
```

### Session Broken Detection

What if Worker A is temporarily overloaded or restarted (but not crashed)?

The worker maintains an in-memory `Map<sessionId, CopilotSession>`. When an activity arrives:

```typescript
async function runAgentTurn(state: AgentState): Promise<TurnResult> {
    if (state.sessionId && !sessionManager.isAlive(state.sessionId)) {
        return { type: "session_broken", sessionId: state.sessionId };
    }
    // ... normal flow
}
```

If the session is broken, the orchestration can:
- Create a fresh session (lose conversation history, but duroxide has the logical state)
- Attempt rehydration from blob storage (Phase 3)
- Route to a different worker (clear the tag)

---

## Dehydration and Hydration

### The Problem (Phase 3)

When an agent waits for hours or days, keeping a Copilot CLI process alive on a specific node is wasteful. We want to:

1. **Dehydrate:** Save session files to shared storage, free the node
2. **Hydrate:** Restore session files on any available node, resume

### Dehydrate Flow

```
Agent finishes a turn, needs to wait 2 hours
  │
  ▼
ORCHESTRATION:
  1. schedule_activity("dehydrate", { sessionId })
     .with_tag(workerId)             ← must run on the node with the files
     
  DEHYDRATE ACTIVITY (on Worker A):
     a. session.destroy()            ← disconnect from CLI
     b. tar ~/.copilot/session-state/{sessionId}/
     c. upload tar → Azure Blob Storage (or Postgres Large Object)
     d. rm -rf the local directory   ← free disk
     e. return { blobRef: "sessions/abc-123.tar.gz" }
     
  2. create_timer(7200)              ← 2-hour durable timer
  3. continue_as_new({ ...state, blobRef, workerId: null })
                                      ← clear affinity, any node can pick up
```

### Hydrate Flow

```
Timer fires after 2 hours
  │
  ▼
ORCHESTRATION:
  1. schedule_activity("hydrate", { blobRef })
     (no tag — any node can do this)
     
  HYDRATE ACTIVITY (on Worker B — whatever's available):
     a. download blob → ~/.copilot/session-state/{sessionId}/
     b. create or resume Copilot session from files
     c. return { workerId: "worker-B", sessionId }
     
  2. Run next agent turn with .with_tag("worker-B")
  3. Agent resumes, LLM sees full conversation history
```

### Session File Sizes

Typical session sizes after real usage:

| Session type | events.jsonl | Total dir |
|-------------|-------------|-----------|
| Simple (few turns) | 2-10 KB | 5-15 KB |
| Medium (50 turns) | 100-500 KB | 150-600 KB |
| Long (500+ turns) | 2-10 MB | 3-12 MB |

For most agent workloads (tens of turns per activation), dehydration/hydration moves < 1 MB. This is fast even over network storage.

### Graceful Shutdown

When a worker node is being scaled down or redeployed:

```typescript
process.on("SIGTERM", async () => {
    // Dehydrate all active sessions before exiting
    for (const sessionId of sessionManager.activeSessionIds()) {
        await dehydrateSession(sessionId, blobStore);
    }
    await worker.stop();
    process.exit(0);
});
```

This ensures no session state is lost during planned node shutdowns. The orchestrations will pick up on other nodes after rehydration.

---

## Crash Recovery (Phase 4)

### The Problem

Graceful shutdown handles planned restarts. But what about unplanned crashes? A node dies mid-turn — the in-flight `sendAndWait()` is lost, session files are gone with the disk.

### What Duroxide Preserves

Even without any checkpointing, duroxide's Postgres event history contains:

```
ActivityScheduled  { name: "runAgentTurn", input: { prompt, sessionId, ... } }
ActivityCompleted  { result: { answer: "deployed to staging", ... } }
ActivityScheduled  { name: "runAgentTurn", input: { prompt: "now monitor..." } }
ActivityCompleted  { result: { type: "wait", seconds: 300 } }
TimerCreated       { fire_at: "..." }
TimerFired
ActivityScheduled  { name: "runAgentTurn", input: { ... } }
← CRASH HERE — no completion
```

Duroxide knows:
- ✅ Every activity input and output (full logical history)
- ✅ The last prompt that was sent
- ✅ All tool calls and their results (embedded in activity results)

Duroxide does NOT know:
- ❌ The raw conversation (that was in events.jsonl on the dead node)

### Recovery Without Checkpoints

After the activity times out:

1. Duroxide re-dispatches the activity
2. New worker picks it up (no tag — old node is dead)
3. No session files → create a fresh session
4. Build context from duroxide history: "Here's what you've done so far: [summary from prior activity results]"
5. LLM continues with reconstructed context

**Trade-off:** The LLM loses the raw conversation nuances but retains all factual information (tool calls, results, decisions). Good enough for most workloads.

### Recovery With Delta Checkpoints (Phase 4)

For workloads that need higher fidelity recovery:

```
During normal operation, the LLM calls checkpoint():
  → Track events.jsonl byte offset
  → Upload only new bytes to Azure Append Blob
  → Cost: proportional to work since last checkpoint

On crash:
  → Download the append blob (concatenation of all deltas)
  → Reconstruct events.jsonl up to the last checkpoint
  → resumeSession() — LLM sees full conversation up to checkpoint
  → Re-send the last prompt (from duroxide's ActivityScheduled event)
  → Lost: only events since the last checkpoint (one LLM turn worst case)
```

The RPO (Recovery Point Objective) equals the time since the last checkpoint. If the LLM checkpoints after every significant step, this is typically < 1 turn of work.

---

## Component Interaction Summary

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│   session = client.createSession({ tools, systemMessage })           │
│                                                                      │
│   Option A — sendAndWait (client stays alive):                       │
│     response = await session.sendAndWait("Deploy the app")           │
│       └─ Polls Postgres until result available                      │
│                                                                      │
│   Option B — send + wait (client can exit and reconnect):            │
│     await session.send("Deploy the app")  // returns immediately     │
│     process.exit(0)                                                  │
│     // ... hours later, new process ...                              │
│     session = await client.resumeSession(savedId)                    │
│     response = await session.wait()       // polls until done        │
│                                                                      │
│   ════════════════════════════════════════════════════════════        │
│   DUROXIDE WORKER (background, any node)                             │
│   ════════════════════════════════════════════════════════════        │
│                                                                      │
│   Orchestration picks up:                                            │
│       │                                                              │
│       ├─ 2. schedule_activity("runAgentTurn", state)                │
│       │      ├─ SessionManager.getOrCreate(sessionId)                │
│       │      ├─ mergeTools(userTools, systemTools)                   │
│       │      ├─ session.sendAndWait(prompt)                          │
│       │      │   ├─ LLM thinks, calls get_weather("NYC")           │
│       │      │   │   └─ handler executes, returns { temp: 72 }      │
│       │      │   ├─ LLM thinks, calls wait(3600, "monitor")        │
│       │      │   │   └─ handler: pendingAction = wait(3600)         │
│       │      │   │   └─ handler: session.abort()                     │
│       │      │   └─ sendAndWait throws (aborted)                     │
│       │      └─ return { type: "wait", seconds: 3600 }              │
│       │                                                              │
│       ├─ 3. TurnResult is "wait" with seconds > threshold           │
│       │      ├─ (Phase 3: dehydrate session → blob)                 │
│       │      ├─ ctx.create_timer(3600s)                              │
│       │      └─ continue_as_new(state)                               │
│       │                                                              │
│       │   ═══ DEHYDRATED — no process, no memory, no cost ═══       │
│       │                                                              │
│       ├─ 4. Timer fires (1 hour later, any node)                    │
│       │      ├─ (Phase 3: hydrate session from blob)                │
│       │      ├─ state.prompt = "The 1-hour wait is complete."       │
│       │      └─ schedule_activity("runAgentTurn", state)            │
│       │           ├─ session.resumeSession(id)                       │
│       │           ├─ sendAndWait("The wait is complete. Continue.")  │
│       │           └─ LLM continues working...                        │
│       │                                                              │
│       └─ 5. Eventually: { type: "completed", answer: "..." }       │
│              └─ orchestration returns, result stored in Postgres     │
│                                                                      │
│   ════════════════════════════════════════════════════════════        │
│                                                                      │
│   sendAndWait() / wait() resolves with the answer                    │
│       └─ Reads completion from Postgres → "Done. Deployed."        │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Instantiation and Startup

### Client Side

The client only needs a database connection. No Copilot CLI, no GitHub token:

```typescript
import { DurableCopilotClient, defineTool } from "durable-copilot-sdk";

// Define tools (schemas only — handlers run on the server)
const getWeather = defineTool("get_weather", {
    description: "Get weather for a city",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    handler: async (args) => fetchWeather(args.city),
});

// Client — just a Postgres connection, no GitHub token
const client = new DurableCopilotClient({
    store: "postgres://user:pass@host:5432/agents",
});

// Same API shape as CopilotClient.createSession() + CopilotSession.sendAndWait()
const session = await client.createSession({
    tools: [getWeather],
    model: "claude-sonnet-4",
    systemMessage: "You are a helpful ops assistant.",
});

const response = await session.sendAndWait("Deploy the app and monitor for 1 hour");
const info = await session.getInfo();
```

### Server Side

The server needs the GitHub token and Copilot CLI. It registers the same tools (with handlers) and starts the duroxide runtime:

```typescript
const worker = new DurableCopilotClient({
    store: "postgres://user:pass@host:5432/agents",
    githubToken: process.env.GITHUB_TOKEN,
});

// Start the worker — begins polling Postgres for orchestrations
await worker.start();

// worker.start() does:
//   1. Parse store URL → create duroxide-pg-opt provider
//   2. Create SessionManager(githubToken)
//   3. Create system tools (wait, checkpoint) bound to config
//   4. Register orchestration: "durable-copilot-agent"
//   5. Register activities: "runAgentTurn", (Phase 3: dehydrate, hydrate)
//   6. Start duroxide runtime — begins polling for work
```

### Multi-Node Deployment

On AKS, each pod runs `worker.start()`. All pods share the same Postgres:

```yaml
# kubernetes deployment
replicas: 3
containers:
  - name: agent-worker
    command: ["node", "server.js"]   # calls worker.start()
    env:
      - name: DATABASE_URL
        value: "postgres://..."
      - name: GITHUB_TOKEN
        valueFrom: { secretKeyRef: ... }
```

All three pods compete for orchestrations via `SELECT FOR UPDATE SKIP LOCKED`. No coordination layer needed.

The client (web app, API server) can run separately — it only needs `DATABASE_URL`, not `GITHUB_TOKEN`:

```yaml
# separate deployment for the API
replicas: 2
containers:
  - name: agent-api
    command: ["node", "api.js"]    # Express server calling client.createSession(), session.sendAndWait()
    env:
      - name: DATABASE_URL
        value: "postgres://..."
```

---

## External Communication

All communication between the client, workers, and external systems flows through **Postgres**. No direct process-to-process communication.

```
┌────────────────┐     ┌──────────────────┐     ┌────────────────┐
│   CLIENT       │     │    POSTGRES       │     │  WORKER         │
│   (web app)    │     │                   │     │  (worker.start) │
│                │     │                   │     │                 │
│ sendAndWait()  │─1──▶│ orchestration     │─2──▶│ picks up work   │
│                │     │ created           │     │ runs LLM turn   │
│                │     │                   │     │                 │
│                │     │                   │     │ LLM asks user:  │
│                │     │                   │◀─3──│ activity writes  │
│                │     │ agent_events      │     │ to agent_events │
│                │     │ (question row)    │     │                 │
│                │     │                   │     │ orchestration   │
│                │     │                   │     │ wait_for_event  │
│ poll questions │◀─4──│ query             │     │ (dehydrated)    │
│                │     │ agent_events      │     │                 │
│                │     │                   │     │                 │
│ user answers   │─5──▶│ raise_event       │─6──▶│ rehydrates      │
│                │     │ (duroxide event)  │     │ resumes LLM     │
│                │     │                   │     │                 │
│ sendAndWait()  │◀─7──│ read completion   │     │ completes       │
│   resolves     │     │                   │     │                 │
└────────────────┘     └──────────────────┘     └────────────────┘
```

### Three Communication Channels

#### 1. Orchestration Control (duroxide)

```typescript
// Client writes
const session = await client.createSession(config);
await session.sendAndWait(prompt);                                // → creates orchestration
await session.sendEvent("user_answer", { answer });               // → raise_event in duroxide

// Client reads
const info = await session.getInfo();    // → status, pendingQuestion, result, etc.
const sessions = await client.listSessions();   // → all durable sessions
```

These use duroxide's native Postgres tables. The client is just a duroxide client.

#### 2. Agent Events (out-of-band Postgres table)

```sql
-- Workers write questions here
INSERT INTO agent_events (agent_id, event_type, payload)
VALUES ('abc', 'user_input_request', '{"question": "Deploy?", "choices": ["yes","no"]}');

-- Workers write status updates here
INSERT INTO agent_events (agent_id, event_type, payload)
VALUES ('abc', 'checkpoint', '{"summary": "Compiled and tested"}');

INSERT INTO agent_events (agent_id, event_type, payload)
VALUES ('abc', 'waiting', '{"seconds": 3600, "reason": "monitoring"}');
```

External systems poll or LISTEN/NOTIFY on this table to discover what agents are doing. This is the "push" channel — agents write, external systems read.

#### 3. LISTEN/NOTIFY (real-time)

For low-latency notification, workers can `NOTIFY agent_events` after inserting. An external listener process (the "event bridge") picks up notifications and routes them:

```typescript
// Event bridge process — runs alongside the API server
const pgListener = new PgListener("postgres://...");
pgListener.on("agent_events", async (payload) => {
    const { agentId, eventType, data } = payload;
    
    if (eventType === "user_input_request") {
        // Route to wherever the user is
        await slack.postMessage(`Agent ${agentId} asks: ${data.question}`);
        // or: await websocket.send(agentId, data);
        // or: await email.send(user, data);
    }
});
```

This event bridge is application-specific — the framework provides the `agent_events` table and the NOTIFY, but the routing logic is up to the developer.

### Why This Design?

| Alternative | Problem |
|------------|---------|
| Hooks in worker process | Worker is headless — no HTTP server, no sockets. Hooks couple delivery to the worker lifecycle. |
| Direct WebSocket from worker | Workers scale up/down, crash, relocate. Sticky connections break. |
| Duroxide events for questions | Duroxide events are consumed by orchestrations, not external systems. No way to "peek" at pending questions. |
| **Postgres table (chosen)** | Any process can read/write. LISTEN/NOTIFY for real-time. Survives worker crashes. Decoupled. |
