# User Guide

> This guide is now a legacy broad overview. If you are starting fresh, use [docs/README.md](./README.md) and then pick one of these paths: [Working On PilotSwarm](./contributors/working-on-pilotswarm.md), [Building SDK Apps](./sdk/building-apps.md), or [Building CLI Apps](./cli/building-cli-apps.md).

> **New here?** Start with the [Getting Started](./getting-started.md) guide to set up PostgreSQL, configure your model providers, and create your `.env` file.

## What is PilotSwarm?

pilotswarm is a durable execution runtime for [GitHub Copilot SDK](https://github.com/github/copilot-sdk) agents, powered by [duroxide](https://github.com/microsoft/duroxide). It gives your AI agents **crash recovery, durable timers, session dehydration, and multi-node scaling** — just add a connection string.

Your code stays almost identical to the standard Copilot SDK. The runtime handles orchestration, session persistence, and fault tolerance transparently.

## Standard Copilot SDK vs Durable

### Standard Copilot SDK

```typescript
import { CopilotClient, defineTool } from "@github/copilot-sdk";

const weather = defineTool("get_weather", {
    description: "Get weather for a city",
    parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
    },
    handler: async ({ city }) => {
        const res = await fetch(`https://wttr.in/${city}?format=j1`);
        return await res.json();
    },
});

const client = new CopilotClient({ githubToken: process.env.GITHUB_TOKEN }); // standard SDK
const session = await client.createSession({
    tools: [weather],
    systemMessage: "You are a weather assistant.",
});

const response = await session.sendAndWait("What's the weather in NYC?");
console.log(response);

await client.stop();
```

This works — but if the process crashes, the session is lost. `sleep()` blocks the process. You can't scale across nodes.

### PilotSwarm (single-process mode)

```typescript
import { PilotSwarmClient, PilotSwarmWorker, defineTool } from "pilotswarm-sdk";

// Same tool definition — unchanged from standard Copilot SDK
const weather = defineTool("get_weather", {
    description: "Get weather for a city",
    parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
    },
    handler: async ({ city }) => {
        const res = await fetch(`https://wttr.in/${city}?format=j1`);
        return await res.json();
    },
});

// Worker runs LLM turns and executes tools
const worker = new PilotSwarmWorker({
    store: process.env.DATABASE_URL,
});
await worker.start();

// Client manages sessions and sends prompts
const client = new PilotSwarmClient({
    store: process.env.DATABASE_URL,
});
await client.start();

// Create a session (serializable config for orchestration)
const session = await client.createSession({
    systemMessage: "You are a weather assistant.",
});

// Register tools on the WORKER — tools contain handler functions
// that can only run in the worker process
worker.setSessionConfig(session.sessionId, { tools: [weather] });

const response = await session.sendAndWait("What's the weather in NYC?");
console.log(response);

await client.stop();
await worker.stop();
```

**Key difference:** Tools are registered on the `PilotSwarmWorker`, not on the client. Tool handlers are functions — they can't be serialized over the wire. The client only sends serializable config (model, system message) through the database.

Now the agent can call `wait(3600, "Waiting 1 hour before next check")` and the process shuts down entirely. A durable timer fires an hour later and the agent picks up exactly where it left off — on any available node.

## What You Get Automatically

| Feature | Standard Copilot SDK | PilotSwarm |
|---------|---------------------|---------------------|
| Tool calling | ✅ | ✅ Same `defineTool()` API |
| Wait/pause | ❌ `sleep()` blocks process | ✅ Durable timer — process shuts down, wakes up later |
| Crash recovery | ❌ Session lost | ✅ Resumes from last checkpoint |
| Multi-node | ❌ Single process | ✅ Any worker node can pick up work |
| Session persistence | ❌ In-memory only | ✅ PostgreSQL + Azure Blob Storage |
| Event streaming | ❌ Local only | ✅ Persisted events, cross-process subscriptions |

## Core Concepts

### Client and Worker

The runtime separates concerns into two components:

- **`PilotSwarmClient`** — manages sessions, sends prompts, subscribes to events. Lightweight, no GitHub token needed. Only handles serializable data.
- **`PilotSwarmWorker`** — runs LLM turns, executes tool handlers, manages the Copilot runtime. Requires a GitHub token. **This is where tools are registered.**

Both connect to the same PostgreSQL database via a connection string.

### Why Tools Live on the Worker

Tool definitions include handler functions (JavaScript closures). Functions can't be serialized into a database or sent over the wire. Since the worker is the process that actually calls the LLM and executes tool invocations, tools must be registered there.

The client only sends **serializable config** through duroxide:
- `model` — which LLM to use
- `systemMessage` — system prompt
- `workingDirectory` — for file operations
- `waitThreshold` — when to dehydrate
- `toolNames` — names of tools to activate (resolved on the worker)

The worker adds **non-serializable config** in-memory:
- `tools` — `defineTool()` handlers (registered at worker startup or per-session)
- `hooks` — pre/post tool execution hooks

### Registering Custom Tools

There are two ways to register tools, depending on your deployment:

**1. Worker-level registry** (recommended for production / remote mode):

Register tools once at worker startup. They're available to all sessions on that worker. Clients reference them by name.

```typescript
// worker.js — runs on K8s pods
const weather = defineTool("get_weather", {
    description: "Get weather for a city",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    handler: async ({ city }) => {
        const res = await fetch(`https://wttr.in/${city}?format=j1`);
        return await res.json();
    },
});

const worker = new PilotSwarmWorker({ store, githubToken });
worker.registerTools([weather]);   // ← register before or after start()
await worker.start();

// app.js — runs on any machine (just needs the database URL)
const client = new PilotSwarmClient({ store });
await client.start();

const session = await client.createSession({
    toolNames: ["get_weather"],     // ← reference by name (serializable)
    systemMessage: "You are a weather assistant.",
});
const response = await session.sendAndWait("What's the weather in NYC?");
```

The tool names travel through duroxide as plain strings. The worker resolves them to actual Tool objects from its registry at execution time.

**2. Per-session config** (same-process / development mode):

When client and worker run in the same process, you can pass Tool objects directly via `worker.setSessionConfig()`:

```typescript
const worker = new PilotSwarmWorker({ store, githubToken });
const client = new PilotSwarmClient({ store });
await worker.start();
await client.start();

const session = await client.createSession({ systemMessage: "..." });
worker.setSessionConfig(session.sessionId, { tools: [myTool] });
```

**Combining both:** You can mix worker-level and per-session tools. Per-session tools take precedence if names conflict.

```typescript
// Worker has a global "get_weather" tool
worker.registerTools([weather]);

// This session also gets a session-specific "search_docs" tool
const session = await client.createSession({ toolNames: ["get_weather"] });
worker.setSessionConfig(session.sessionId, { tools: [searchDocs] });
// The session now has both: get_weather (from registry) + search_docs (per-session)
```

### Sessions

Sessions are the primary unit of interaction. Each session:
- Has a unique ID (auto-generated or custom)
- Persists across process restarts
- Tracks conversation history in the database
- Can be resumed from any client

```typescript
// Create a new session
const session = await client.createSession({
    model: "claude-sonnet-4",
    systemMessage: "You are a helpful assistant.",
});

// Resume an existing session
const resumed = await client.resumeSession("session-id-here");

// List all sessions
const sessions = await client.listSessions();
```

### Sending Messages

Two modes:

```typescript
// Synchronous: send and wait for response
const response = await session.sendAndWait("Hello!", 60_000);

// Asynchronous: fire-and-forget, check later
await session.send("Monitor this for 1 hour");
// ... later, from any process ...
const result = await session.wait(120_000);
```

### Event Streaming

Subscribe to real-time events from any session:

```typescript
// All events
session.on((event) => {
    console.log(event.eventType, event.data);
});

// Specific event type
session.on("assistant.message", (event) => {
    console.log("Assistant:", event.data.content);
});
```

Event types include:
- `user.message` — user sent a prompt
- `assistant.message` — assistant response
- `assistant.reasoning` — reasoning/thinking content
- `tool.execution_start` / `tool.execution_complete` — tool calls
- `session.idle` — session waiting for input
- `assistant.usage` — token usage statistics

### Durable Timers

The runtime automatically injects a `wait` tool into every session. When the LLM calls it:

- **Short waits** (< threshold): sleep in-process
- **Long waits** (≥ threshold): dehydrate the session to blob storage, schedule a durable timer, and shut down. When the timer fires, any available worker picks up the session.

You don't need to do anything special — just tell the agent to wait:

```
"Check this API every 10 minutes and alert me if the latency exceeds 200ms"
```

The LLM will call `wait(600, "Waiting 10 minutes before next check")` and the framework handles the rest.

### User Input (ask_user)

Sessions can ask for user input via the built-in `ask_user` tool:

```typescript
const session = await client.createSession({
    systemMessage: "Ask the user before making decisions.",
    onUserInputRequest: async (request) => {
        console.log(`Question: ${request.question}`);
        const answer = await getUserInput();
        return { answer };
    },
});
```

If no handler is provided, the session dehydrates and emits an `input_required` status. Your app can respond later:

```typescript
const info = await session.getInfo();
if (info.status === "input_required") {
    await session.sendEvent("user_answer", { answer: "yes" });
}
```

### Sub-Agents

The runtime supports **autonomous sub-agents** — child sessions that run as independent durable orchestrations. A parent session can spawn sub-agents to work on tasks in parallel, each with its own conversation, tools, and LLM context.

Seven built-in tools are injected into every session:

| Tool | Description |
|------|-------------|
| `spawn_agent(task, system_message?, model?, tool_names?)` | Start a new sub-agent with a task. Returns an agent ID. |
| `message_agent(agent_id, message)` | Send additional instructions to a running sub-agent. |
| `check_agents()` | Get status of all sub-agents (running/completed/failed) with latest output. |
| `wait_for_agents(agent_ids?)` | Block until sub-agents finish. Returns their results. |
| `complete_agent(agent_id)` | Mark a sub-agent as completed. |
| `cancel_agent(agent_id, reason?)` | Cancel a running sub-agent. |
| `delete_agent(agent_id, reason?)` | Delete a sub-agent entirely. |

**Usage:** Just describe the work in your prompt — the LLM decides when to delegate:

```
"Research these 3 topics in parallel: quantum computing advances, 
 fusion energy progress, and space exploration milestones"
```

The LLM will call `spawn_agent("Research quantum computing advances")`, `spawn_agent("Research fusion energy progress")`, etc., then `wait_for_agents()` to collect results.

**Key behaviors:**
- Sub-agents inherit the parent's tools and model by default (overridable per-agent)
- Sub-agents are fully durable — they survive crashes, restarts, and node migrations
- Max 8 concurrent sub-agents per session, max 2 nesting levels (root → child → grandchild)
- Sub-agents run as independent orchestrations — they can use `wait` for durable timers
- The TUI renders sub-agents as a tree under their parent session

#### Fan-Out / Fan-In Pattern

```
1. spawn_agent("Research topic A")    → agentA
2. spawn_agent("Research topic B")    → agentB
3. spawn_agent("Research topic C")    → agentC
4. wait_for_agents()                  → collect all results
5. Synthesize the combined findings
```

#### Background Worker Pattern

```
1. spawn_agent("Monitor X every 60 seconds")  → agent
2. Continue handling user requests normally
3. Periodically check_agents() to see updates
```

#### Specialized Delegation Pattern

```
1. spawn_agent("Analyze the data", system_message="You are a data analyst")
2. spawn_agent("Write the report", system_message="You are a technical writer")
3. wait_for_agents() → combine results
```

### Agent Definitions (.agent.md)

Define reusable agent personas using `.agent.md` files in your plugin directory:

```yaml
---
name: planner
description: Creates structured plans for complex tasks.
tools:
  - view
  - grep
---

# Planner Agent
You are a planning agent. Break complex tasks into clear, 
actionable steps with dependencies and priorities.
```

The YAML frontmatter defines the agent's `name`, `description`, and `tools`. The markdown body becomes the agent's system message. Agents are loaded from the plugin directory at startup and can be used as sub-agent templates.

### Skills (SKILL.md)

Skills are knowledge modules that inject domain-specific instructions into the LLM's system message. Place them in `skills/<name>/SKILL.md`:

```yaml
---
name: durable-timers
description: Expert knowledge on durable timer patterns.
---

# Durable Timer Patterns
You are running in a durable execution environment with a `wait` tool...
```

A skill directory can also include a `tools.json` to declare required tools:

```json
{ "tools": ["wait", "check_agents"] }
```

### MCP Servers (.mcp.json)

Connect external tool servers via the Model Context Protocol. Create a `.mcp.json` file in your plugin directory:

```json
{
  "my-local-server": {
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

Supports both local (stdio) and remote (HTTP/SSE) transports. Environment variable references (`${VAR}`) are expanded at load time.

### Session Info

Get the current state of any session:

```typescript
const info = await session.getInfo();
console.log(info.status);      // "running" | "idle" | "waiting" | "completed" | ...
console.log(info.iterations);  // number of LLM turns completed
console.log(info.title);       // LLM-generated session summary
```

## API Reference

### `PilotSwarmClient`

| Method | Description |
|--------|-------------|
| `new PilotSwarmClient(options)` | Create a client |
| `client.start()` | Initialize (connect to store) |
| `client.stop()` | Clean up |
| `client.createSession(config?)` | Create a new session (serializable config + optional local handlers/tools in same-process mode) |
| `client.resumeSession(id, config?)` | Resume an existing session |
| `client.listSessions()` | List all active sessions |
| `client.deleteSession(id)` | Soft-delete a session |

### `PilotSwarmWorker`

| Method | Description |
|--------|-------------|
| `new PilotSwarmWorker(options)` | Create a worker |
| `worker.start()` | Start polling for orchestrations |
| `worker.stop()` | Graceful shutdown |
| `worker.registerTools(tools)` | **Register tools for all sessions** (worker-level registry) |
| `worker.setSessionConfig(id, config)` | Register tools and hooks for a specific session |

### `PilotSwarmSession`

| Method | Description |
|--------|-------------|
| `session.sendAndWait(prompt, timeout?)` | Send prompt, wait for response |
| `session.send(prompt)` | Fire-and-forget |
| `session.wait(timeout?)` | Block until terminal state |
| `session.getInfo()` | Get status, iterations, etc. |
| `session.getMessages()` | Get persisted events from CMS |
| `session.on(handler)` | Subscribe to all events |
| `session.on(type, handler)` | Subscribe to specific event type |
| `session.sendEvent(name, data)` | Send event to waiting session |
| `session.abort()` | Cancel current turn |
| `session.destroy()` | Delete session |
| `session.sessionId` | The session UUID |
