# durable-copilot-sdk

Make Copilot SDK apps durable with zero orchestration code.

Wraps the [GitHub Copilot SDK](https://github.com/github/copilot-sdk) with [duroxide](https://github.com/affandar/duroxide) to give your AI agents **durable timers, crash recovery, and multi-node scaling** — just add a connection string.

## Quick Start

```typescript
import { DurableCopilotClient, defineTool } from "durable-copilot-sdk";

// 1. Define tools (same as Copilot SDK — you already know this)
const getWeather = defineTool("get_weather", {
    description: "Get weather for a city",
    parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
    },
    handler: async (args) => {
        const res = await fetch(`https://wttr.in/${args.city}?format=j1`);
        return await res.json();
    },
});

// 2. Create a client (same shape as CopilotClient)
const client = new DurableCopilotClient({
    store: "sqlite://./dev.db",   // postgres:// for production
    githubToken: process.env.GITHUB_TOKEN,
});

// 3. Create a session (same shape as CopilotClient.createSession)
const session = await client.createSession({
    tools: [getWeather],
    systemMessage: "You are a helpful weather assistant.",
});

// 4. Send a message (same shape as CopilotSession.sendAndWait)
const response = await session.sendAndWait("Check NYC weather every hour for 8 hours");
console.log(response);

// 5. Check detailed status (new — exposes durable state)
const info = await session.getInfo();
console.log(info.status);  // "completed"

// 6. Clean up
await client.stop();
```

## What You Get (Automatically)

| Feature | Standard Copilot SDK | durable-copilot-sdk |
|---------|---------------------|---------------------|
| Tool calling | ✅ | ✅ Same `defineTool()` API |
| Wait/pause | ❌ `sleep()` blocks process | ✅ Durable timer — process shuts down, wakes up later |
| Crash recovery | ❌ Lost | ✅ Resumes from last checkpoint |
| Multi-node | ❌ Single process | ✅ Any node can pick up work (Phase 2) |
| Triggers | ❌ Manual only | ✅ Timers, events, cron schedules |
| Session portability | ❌ Local files | ✅ Blob storage (Phase 3) |
| Progress saving | ❌ None | ✅ LLM-driven checkpoints (Phase 4) |

## What You Don't Need to Learn

- No orchestrations, activities, or continue-as-new
- No session management or hydration/dehydration
- No worker affinity or activity tags
- No blob storage configuration (until Phase 3)

The framework handles all of this internally using [duroxide](https://github.com/affandar/duroxide).

## API

### `new DurableCopilotClient(options)` — mirrors `CopilotClient`

```typescript
const client = new DurableCopilotClient({
    // --- Familiar Copilot SDK options ---
    githubToken: "...",             // GitHub token (server-side only)
    cliPath: "/path/to/cli",       // CLI binary path (auto-detected)
    cwd: "/path/to/workspace",     // Working directory
    logLevel: "error",             // CLI log level

    // --- Durability (the only new thing) ---
    store: "sqlite://./dev.db",     // or "postgres://..."
    waitThreshold: 60,              // seconds — short waits sleep, long waits dehydrate
});
```

### `client.createSession(config)` — mirrors `CopilotClient.createSession()`

```typescript
const session = await client.createSession({
    sessionId: "custom-id",          // optional, auto-generated if omitted
    model: "claude-sonnet-4",        // LLM model to use
    tools: [tool1, tool2],           // Your tools (defineTool())
    systemMessage: "You are...",     // System prompt
    workingDirectory: "/path",       // Working directory
    onUserInputRequest: async (req, inv) => ({  // handle ask_user
        answer: "yes", wasFreeform: false
    }),
    hooks: { ... },                  // pre/post tool hooks
});
```

### `session.sendAndWait(prompt, timeout?)` — mirrors `CopilotSession.sendAndWait()`

Send a message and wait for the response. Durable timers and tool calls happen transparently. Client process must stay alive until it resolves.

### `session.send(prompt)` — mirrors `CopilotSession.send()`

Fire-and-forget. The client can exit after this call — the work runs durably on the server. Reconnect later with `client.resumeSession(id)` and call `session.wait()`.

### `session.wait(timeout?)` — new (durable-only)

Block until the session reaches a terminal state. Does NOT send a new message — use after `send()` or after resuming a session from a new process.

```typescript
// Process 1: fire and forget
const session = await client.createSession({ tools, systemMessage });
await session.send("Deploy the app and monitor for 1 hour");
saveToFile(session.sessionId);
process.exit(0);

// Process 2 (hours later): reconnect and wait
const id = readFromFile();
const session = await client.resumeSession(id);
const response = await session.wait();
console.log(response); // "Deployment complete. Monitored for 1 hour. All healthy."
```

### `session.sendEvent(name, data)` — durable equivalent of answering `onUserInputRequest`

Send an event to a waiting session (e.g., user input response).

### `session.getInfo(): Promise<DurableSessionInfo>` — new (durable-only)

Get status, pending questions, wait state, result, iteration count.

Status values: `"pending" | "running" | "idle" | "waiting" | "input_required" | "completed" | "failed"`

### `session.abort()` — mirrors `CopilotSession.abort()`

### `session.destroy()` — mirrors `CopilotSession.destroy()`

### `session.getMessages()` — mirrors `CopilotSession.getMessages()`

### `session.schedule(schedule)` — new (durable-only)

Schedule recurring invocations: `{ cron: "*/30 * * * *" }` or `{ every: 3600 }`.

### `client.resumeSession(id, config?)` — mirrors `CopilotClient.resumeSession()`

### `client.listSessions()` — mirrors `CopilotClient.listSessions()`

### `client.deleteSession(id)` — mirrors `CopilotClient.deleteSession()`

### `client.start()` — server-side only, starts the duroxide worker

### `client.stop()` — mirrors `CopilotClient.stop()`

## How It Works Internally

```
session.sendAndWait("Deploy and monitor")
    │
    ▼
┌────────────────────────────────────────────────────────┐
│ duroxide orchestration (hidden from user)               │
│                                                         │
│   loop:                                                 │
│     activity: runAgentTurn(state)                       │
│       → CopilotClient.createSession / resumeSession    │
│       → session.sendAndWait(prompt, tools)              │
│       → LLM works, calls tools, calls wait/checkpoint  │
│       → returns: { answer | needWait | needUserInput }  │
│                                                         │
│     if answer → complete, sendAndWait() resolves        │
│     if needWait:                                        │
│       short (< threshold) → sleep in-process            │
│       long (> threshold) → durable timer                │
│     if needUserInput → wait_for_event("user_answer")   │
│     continue-as-new                                     │
└────────────────────────────────────────────────────────┘
```

The system automatically injects two tools into every session:
- **`wait(seconds, reason)`** — the LLM calls this to wait. Short waits sleep in-process; long waits become durable timers.
- **`checkpoint(summary)`** — the LLM calls this to save progress. Enables crash recovery.

## Requirements

- Node.js >= 24
- SQLite (dev) or PostgreSQL (production) for durable state
- GitHub Copilot access (token) — **server-side only**, not needed for client

## Phases

| Phase | What | Requires |
|-------|------|----------|
| **1** | Single node, durable timers + crash recovery | Nothing extra |
| **2** | Multi-node with worker affinity | duroxide activity tags |
| **3** | Session dehydration to blob storage | Azure Blob |
| **4** | Delta checkpointing, crash resilience with RPO | Azure Append Blob |

## License

MIT
