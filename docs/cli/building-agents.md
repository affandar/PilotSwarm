# Building Agents For CLI Apps

This is the agent-authoring guide for CLI/TUI-based apps.

For a full reference plugin that uses named agents, system agents, skills, a session policy, and custom TUI branding, see [examples/devops-command-center](../../examples/devops-command-center).

The good news is that the agent format is the same as the SDK path. The practical difference is how those files get loaded:

- in local CLI mode, the TUI loads your plugin directory into embedded workers
- in remote CLI mode, the deployed workers must already have the same plugin content

## The Fastest Working Setup

```text
plugin/
├── agents/
│   ├── default.agent.md
│   ├── researcher.agent.md
│   └── reviewer.agent.md
├── skills/
│   └── web-research/
│       ├── SKILL.md
│       └── tools.json
└── .mcp.json
```

And optionally:

```text
worker-tools.js
```

for custom tool handlers.

If you want the CLI to feel like an app instead of stock PilotSwarm, also add `plugin.json` with a `tui.title` and `tui.splash` or `tui.splashFile`.

## Step 1: Write `default.agent.md`

This is the app-wide default instruction layer for all sessions started by the CLI workers.

```md
---
name: default
description: Base instructions for this CLI app.
---

# Research Console Default Agent

You are a concise research assistant.
Always turn substantial outputs into downloadable markdown artifacts.
Use `wait` when you need to pause or poll.
```

## Step 2: Write named agents

```md
---
name: researcher
description: Researches a topic and saves findings as a markdown artifact.
tools:
  - web_fetch
  - write_artifact
  - export_artifact
---

# Researcher Agent

Gather facts, summarize the results, and save the final output as an artifact.
```

These agents can be invoked from the CLI sessions with `@researcher` or spawned by other agents using `spawn_agent(agent_name="researcher")`.

## Step 3: Add any needed skills

```md
---
name: web-research
description: Guidance for source-based web research.
---

Prefer primary sources.
Save long outputs as markdown artifacts.
Keep a clean list of links you used.
```

Optional `tools.json`:

```json
{
  "tools": ["web_fetch", "write_artifact", "export_artifact"]
}
```

## Step 4: Register tool handlers

If your agents need custom tools, the CLI still needs worker-side code for them.

```js
import { defineTool } from "pilotswarm-sdk";

const webFetch = defineTool("web_fetch", {
  description: "Fetch a web page",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string" },
    },
    required: ["url"],
  },
  handler: async ({ url }) => {
    const res = await fetch(url);
    return await res.text();
  },
});

export default {
  tools: [webFetch],
};
```

## Step 5: Run the CLI app

### Local mode

```bash
npx pilotswarm local --env .env --plugin ./plugin --worker ./worker-tools.js
```

### Remote mode

```bash
npx pilotswarm remote --env .env.remote --store "$DATABASE_URL"
```

In remote mode, make sure the remote workers were deployed with the same plugin files and worker tool code.

## System Agents In CLI Apps

You can define system agents in plugin files the same way as in SDK apps:

```md
---
name: watcher
description: Background watcher.
system: true
id: watcher
title: Watcher Agent
initialPrompt: >
  You are online. Start monitoring and report summary status.
---

# Watcher Agent

You monitor the system in the background.
```

Use system agents only when you really want background durable behavior. Named agents are simpler for most CLI apps.

## Contracts Worth Remembering

- `default.agent.md` is the app-wide default prompt layer under the embedded PilotSwarm framework base
- named agents use `agent_name`, not `task`, when spawned by name
- tool names in agent files do not implement the tools; worker code does
- sub-agent model overrides should use exact `provider:model` values returned by `list_available_models`
- `initialPrompt` is treated as bootstrap session startup content, not as a normal user-authored chat line in the TUI

See [Agent Contracts](../contracts/agent-contracts.md) for the authoritative version of these rules.

## What To Read Next

- [Building CLI Apps](./building-cli-apps.md)
- [Building Agents For SDK Apps](../sdk/building-agents.md)
- [Keybindings](../keybindings.md)
