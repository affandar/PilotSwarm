# Proposal: Integrating Squad Tools with PilotSwarm

## Status

Draft

## Overview

[Squad](https://github.com/bradygaster/squad) is an AI agent team framework built on the GitHub Copilot SDK. It defines 5 custom tools (`squad_route`, `squad_decide`, `squad_memory`, `squad_status`, `squad_skill`) that agents use to coordinate work, record decisions, and manage knowledge.

PilotSwarm can host Squad tools on its durable worker runtime, giving Squad sessions crash recovery, durable timers, multi-node scaling, and session persistence.

This document explains how Squad tools integrate with PilotSwarm, why tools must be registered on the worker (not the client), and how session identity flows through tool handlers.

---

## Why Tools Live on the Worker

Tools contain **handler functions** — JavaScript closures that execute when the LLM calls the tool. Closures cannot be serialized into a database or sent over a network.

PilotSwarm's architecture separates the client (which sends prompts and reads events) from the worker (which runs the LLM and executes tool handlers):

```
Client (any machine)           Worker (AKS pod)
  │                              │
  │  prompt (serializable)       │
  ├─────────────────────────────►│
  │                              │  LLM calls tool
  │                              │  → handler() runs HERE
  │  events (serializable)       │
  │◄─────────────────────────────┤
```

The prompt and events travel through PostgreSQL (duroxide orchestration). Only **serializable data** crosses this boundary — strings, JSON, numbers. Functions cannot cross.

This is why:
- `worker.registerTools([...])` registers tool handlers on the worker
- `client.createSession({ toolNames: ["squad_route"] })` references tools by **name** (a string), not by object

The worker resolves tool names to handler functions at execution time.

---

## Type Compatibility

Squad's tool interface (`SquadTool`) and the Copilot SDK's tool interface (`Tool`) are identical:

```ts
// Squad
interface SquadTool<TArgs> {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    handler: SquadToolHandler<TArgs>;
}
type SquadToolHandler<TArgs> = (args: TArgs, invocation: SquadToolInvocation) => Promise<unknown>;

// Copilot SDK (used by PilotSwarm)
interface Tool<TArgs> {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    handler: ToolHandler<TArgs>;
}
type ToolHandler<TArgs> = (args: TArgs, invocation: ToolInvocation) => Promise<unknown>;
```

Both `SquadToolInvocation` and `ToolInvocation` have the same fields:

```ts
{
    sessionId: string;
    toolCallId: string;
    toolName: string;
    arguments: unknown;
}
```

This means **Squad tools can be registered directly on a PilotSwarm worker** with no adapter layer.

---

## Session Identity in Tool Handlers

PilotSwarm augments every user-registered tool's `invocation` with a `durableSessionId` field:

```ts
{
    sessionId: string;          // Copilot SDK session ID
    durableSessionId: string;   // PilotSwarm durable session ID
    toolCallId: string;
    toolName: string;
    arguments: unknown;
}
```

In practice, both IDs are the same (PilotSwarm passes its durable session ID to the Copilot SDK's `resumeSession`). But `durableSessionId` is explicitly documented as the PilotSwarm session UUID.

Additionally, PilotSwarm records `durableSessionId` in CMS `tool.execution_start` and `tool.execution_complete` events, enabling post-hoc correlation of tool calls to durable sessions.

### Squad tools don't need session IDs

Squad's 5 built-in tool handlers do not use `invocation.sessionId`. Agent identity comes from tool arguments (e.g. `args.author` in `squad_decide`, `args.agent` in `squad_memory`), not from the invocation context.

This means Squad tools work on PilotSwarm without any session ID adaptation.

---

## Integration Pattern

### Basic: Register Squad tools on a PilotSwarm worker

```ts
import { PilotSwarmClient, PilotSwarmWorker } from "pilotswarm-sdk";
import { ToolRegistry } from "@bradygaster/squad-sdk";

// Worker setup
const worker = new PilotSwarmWorker({
    store: process.env.DATABASE_URL,
    githubToken: process.env.GITHUB_TOKEN,
});

// Register Squad tools — they're compatible as-is
const squadRegistry = new ToolRegistry(".squad");
const squadTools = squadRegistry.getTools();
worker.registerTools(squadTools);

await worker.start();

// Client setup
const client = new PilotSwarmClient({
    store: process.env.DATABASE_URL,
});
await client.start();

// Create a session with Squad tools available
const session = await client.createSession({
    toolNames: [
        "squad_route",
        "squad_decide",
        "squad_memory",
        "squad_status",
        "squad_skill",
    ],
    workingDirectory: process.cwd(),  // so tools find .squad/
});

await session.sendAndWait("Analyze the project architecture");
```

### Per-session tool subsets

Different sessions can use different subsets of Squad tools:

```ts
// Lead agent gets all tools
const lead = await client.createSession({
    toolNames: ["squad_route", "squad_decide", "squad_memory", "squad_status", "squad_skill"],
});

// Worker agent gets only memory and skill tools
const worker = await client.createSession({
    toolNames: ["squad_memory", "squad_skill"],
});
```

### Custom tools alongside Squad tools

```ts
import { defineTool } from "pilotswarm-sdk";

const myTool = defineTool("project_search", {
    description: "Search the project codebase",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    handler: async (args, invocation) => {
        // invocation.durableSessionId is available here
        return searchCodebase(args.query);
    },
});

worker.registerTools([...squadTools, myTool]);
```

---

## Squad Tool Reference

| Tool | What it does | Filesystem access |
|------|-------------|-------------------|
| `squad_route` | Route a task to another agent | None (session pool stub) |
| `squad_decide` | Write a decision to `.squad/decisions/inbox/` | Write |
| `squad_memory` | Append to agent history in `.squad/agents/{name}/history.md` | Read + Write |
| `squad_status` | Query session pool state | None (in-memory) |
| `squad_skill` | Read/write skill files in `.squad/skills/{name}/SKILL.md` | Read + Write |

### Notes

- **`squad_route`**: Currently returns a stub response ("session creation will be implemented"). In PilotSwarm, the equivalent is the built-in `spawn_agent` tool. A Squad adapter could wire `squad_route` to call PilotSwarm's `spawn_agent` internally.

- **`squad_status`**: Queries an in-memory session pool via a `sessionPoolGetter` callback. In PilotSwarm, the equivalent is the built-in `list_sessions` tool or `mgmt.listSessions()`. A Squad adapter could provide a `sessionPoolGetter` that delegates to PilotSwarm's management client.

- **Filesystem tools** (`squad_decide`, `squad_memory`, `squad_skill`): These read/write files relative to the `.squad/` directory. They work as-is, but the worker pod must have access to the `.squad/` directory (e.g. via a persistent volume or mounted working directory).

---

## Limitations

1. **`squad_route` is a stub** — Squad's routing tool doesn't create sessions yet. In PilotSwarm, use `spawn_agent` instead.

2. **`squad_status` needs session pool** — Without a `sessionPoolGetter`, it returns empty results. Wire it to PilotSwarm's `mgmt.listSessions()` for live data.

3. **Filesystem access in remote mode** — Squad's filesystem-based tools require the `.squad/` directory to be accessible on the worker pod. In AKS deployments, this means mounting the directory or using a shared volume.

4. **No per-session closures** — Tool handlers registered on the worker are shared across all sessions. Use `invocation.durableSessionId` (or `invocation.sessionId`) for session context, not closure-captured variables.

---

## Related

- [PilotSwarm Layer Diagram](../layer-diagram.md) — shows where tools fit in the architecture
- [Management Client Proposal](./management-client-boundary-cleanup.md) — `mgmt.listSessions()` for Squad status integration
- GitHub Issue [#1](https://github.com/affandar/pilotswarm/issues/1) — original session-scoped tool registration request
