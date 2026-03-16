# Building SDK Apps

Use the SDK path when you want to build your own application around PilotSwarm: a service, job runner, custom UI, integration test harness, or a specialized orchestrated workflow.

The SDK gives you the durable runtime primitives. Your app provides:

- tools
- worker configuration
- agent and skill content
- session lifecycle
- whatever UI or API you want on top

## The Basic Shape

Every SDK app has two halves:

- `PilotSwarmWorker` — owns LLM turns, tool execution, plugin loading, and orchestration activities
- `PilotSwarmClient` — creates sessions, sends messages, and waits for updates

In local development they can run in the same process. In production they often run separately.

## Minimal Working App

```ts
import { PilotSwarmClient, PilotSwarmWorker, defineTool } from "pilotswarm";

const getWeather = defineTool("get_weather", {
  description: "Get weather for a city",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string" },
    },
    required: ["city"],
  },
  handler: async ({ city }) => {
    const res = await fetch(`https://wttr.in/${city}?format=j1`);
    return await res.json();
  },
});

const worker = new PilotSwarmWorker({
  store: process.env.DATABASE_URL!,
  githubToken: process.env.GITHUB_TOKEN!,
  pluginDirs: ["./plugin"],
});
worker.registerTools([getWeather]);
await worker.start();

const client = new PilotSwarmClient({
  store: process.env.DATABASE_URL!,
});
await client.start();

const session = await client.createSession({
  toolNames: ["get_weather"],
  model: process.env.COPILOT_MODEL,
});

const result = await session.sendAndWait("What is the weather in Seattle?");
console.log(result);
```

## Recommended App Layout

```text
my-sdk-app/
├── package.json
├── .env
├── plugin/
│   ├── agents/
│   │   ├── default.agent.md
│   │   └── planner.agent.md
│   ├── skills/
│   │   └── domain-knowledge/
│   │       └── SKILL.md
│   └── .mcp.json
├── src/
│   ├── tools.ts
│   ├── worker.ts
│   └── app.ts
```

This keeps the split clean:

- plugin files hold prompts, skills, and MCP config
- worker code registers tool handlers
- app code creates and drives sessions

## Session Creation Model

The client sends only serializable configuration. The worker holds the actual tool handlers.

Typical `createSession()` fields:

- `toolNames` — names of tools registered on the worker
- `model` — default model for the session
- `systemMessage` — optional per-session overlay
- `workingDirectory` — where the worker should operate

Your worker can also contribute defaults to every session through:

- `pluginDirs`
- `skillDirectories`
- `customAgents`
- `mcpServers`
- `systemMessage`

## Plugin-Driven vs Inline Configuration

You can build apps in two styles.

### Recommended: plugin-driven

Put prompts and skills on disk:

- `agents/*.agent.md`
- `skills/*/SKILL.md`
- `.mcp.json`

Then point the worker at `pluginDirs`.

This keeps prompts versioned, reviewable, and easy to reuse across local and remote deployments.

### Programmatic / inline

You can also pass config directly:

```ts
const worker = new PilotSwarmWorker({
  store,
  githubToken,
  systemMessage: "You are a support agent.",
  customAgents: [
    {
      name: "triage",
      description: "Triage agent",
      prompt: "You triage issues quickly.",
      tools: ["get_weather"],
    },
  ],
  skillDirectories: ["./skills"],
  mcpServers: {
    search: {
      command: "node",
      args: ["./mcp/search.js"],
      tools: ["search_docs"],
    },
  },
});
```

This is useful for tests or generated configuration, but plugin files are usually easier to maintain.

## Local vs Remote

### Local

Run the worker and client on your machine. This is the fastest way to build and debug.

### Remote

Run workers in another process or cluster, and keep the client in your app or terminal.

For remote mode:

- the worker environment still needs the tools and plugin files
- the client does not execute tools
- blob storage is recommended if you want reliable dehydration across nodes

## What To Read Next

- [Building Agents For SDK Apps](./building-agents.md)
- [Configuration](../configuration.md)
- [Plugin Architecture & Layering Guide](../plugin-architecture-guide.md)
- [Getting Started](../getting-started.md)
