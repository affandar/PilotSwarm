# Building Agents For SDK Apps

This is the canonical guide for building agents on PilotSwarm when you are using the SDK directly.

For a complete worked example, see [examples/devops-command-center](../../examples/devops-command-center). It includes root and child system agents, named agents, skills, a session policy, and worker-side mock tools.

If you only remember one thing, remember this:

- prompts live in plugin files
- tool handlers live in worker code
- sessions only reference tool names

## The Recommended Path

Author agents in a plugin directory and load that directory from your worker.

```text
plugin/
├── agents/
│   ├── default.agent.md
│   ├── planner.agent.md
│   └── researcher.agent.md
├── skills/
│   └── web-research/
│       ├── SKILL.md
│       └── tools.json
└── .mcp.json
```

## Step 1: Create `default.agent.md`

`default.agent.md` is your app-wide overlay for every session on the worker. PilotSwarm layers it underneath the embedded framework base prompt.

```md
---
name: default
description: Base instructions for all sessions.
---

# My App Default Agent

You are a helpful assistant running in PilotSwarm.

Always use `write_artifact` + `export_artifact` when you create a file the user should download.
If you need to wait or poll, use the `wait` tool rather than bash sleep. For long waits, assume the next turn may resume on a different worker unless you intentionally pass `preserveWorkerAffinity: true` for worker-local work.
```

Important behavior:

- the markdown body becomes the app-wide default layer for your sessions
- it is not a selectable agent
- it still applies even when another agent prompt is used
- it extends the embedded PilotSwarm framework instructions rather than replacing them

## Step 2: Add named agents

Named agents are the personas users invoke with `@name` or that other agents spawn by name.

```md
---
name: researcher
description: Researches topics and writes concise markdown summaries.
tools:
  - web_fetch
  - write_artifact
  - export_artifact
---

# Researcher Agent

You gather information, summarize it clearly, and save substantial outputs as artifacts.
Prefer tables when comparing several results.
```

How it works:

- YAML frontmatter becomes runtime metadata
- the markdown body becomes the agent prompt
- `tools` limits the tools this agent may use

## Step 3: Register the tools on the worker

The worker must register any tool the agent is allowed to call.

```ts
import { PilotSwarmWorker, defineTool } from "pilotswarm-sdk";

const webFetch = defineTool("web_fetch", { /* ... */ });
const writeArtifact = defineTool("write_artifact", { /* ... */ });
const exportArtifact = defineTool("export_artifact", { /* ... */ });

const worker = new PilotSwarmWorker({
  store: process.env.DATABASE_URL!,
  githubToken: process.env.GITHUB_TOKEN!,
  pluginDirs: ["./plugin"],
});

worker.registerTools([webFetch, writeArtifact, exportArtifact]);
await worker.start();
```

If the tool is not registered on the worker, listing it in an agent file is not enough.

## Step 4: Optional skills

Skills are shared domain knowledge bundles.

```md
---
name: web-research
description: Research workflow guidance for browsing and summarizing sources.
---

When researching:

1. Start from primary sources when possible.
2. Record exact URLs.
3. Save long outputs as markdown artifacts.
```

Optional `tools.json` can declare the tools that skill expects:

```json
{
  "tools": ["web_fetch", "write_artifact", "export_artifact"]
}
```

Use skills when several agents should share the same operating guidance.

## Step 5: Optional system agents

System agents are long-lived background agents started or spawned by the runtime.

Example:

```md
---
name: sweeper
description: Cleans up old sessions.
system: true
id: sweeper
parent: pilotswarm
title: Sweeper Agent
initialPrompt: >
  You are now online. Start your cleanup loop and report summary status.
---

# Sweeper Agent

You clean up stale sessions and report cluster hygiene.
```

Use system agents only when you want durable background behavior. Most apps only need named agents.

`initialPrompt` for a system agent is bootstrap startup content. It is sent automatically when the session is created, but it should not be treated as an ordinary user-authored chat line in the CLI/TUI.

## Step 6: Create sessions that can use the agents

```ts
const session = await client.createSession({
  model: "github:claude-opus-4.6",
  toolNames: ["web_fetch", "write_artifact", "export_artifact"],
});

await session.sendAndWait("@researcher Find the top 5 announcements from this week and save them as a report.");
```

The worker supplies the actual agent definitions and tool handlers. The client only needs the serializable session config.

## Agent Contract You Should Build Against

### `default.agent.md`

- body becomes the app-wide default prompt layer
- not selectable
- not a tool filter
- should contain app-wide rules you always want
- is wrapped beneath the embedded PilotSwarm framework base prompt

### `*.agent.md`

- frontmatter declares metadata
- body is the agent prompt
- `tools` is a filter, not a tool implementation

### Tools

- must be registered on the worker
- should have accurate descriptions and schemas
- should not rely on prompt text alone for critical correctness

### System-agent spawning

For known named agents, use `spawn_agent(agent_name="...")`.

Use `task=` only for truly ad hoc custom sub-agents. Do not use `task="sweeper"` or `task="resourcemgr"` for named system agents.

### Sub-agent models

If an agent wants to choose a different model for a sub-agent:

1. call `list_available_models`
2. use only an exact returned `provider:model` value
3. never guess or shorten the name

## Common Mistakes

- Putting tool names in an agent file but never registering the tool handler
- Treating `default.agent.md` like a selectable agent
- Assuming the client can execute tools
- Using `task=` instead of `agent_name=` for known named agents
- Letting prompts carry critical correctness without runtime validation
- Treating a system agent's `initialPrompt` as user chat instead of startup/bootstrap behavior

## What To Read Next

- [Building SDK Apps](./building-apps.md)
- [Agent Contracts](../contracts/agent-contracts.md)
- [Plugin Architecture & Layering Guide](../plugin-architecture-guide.md)
