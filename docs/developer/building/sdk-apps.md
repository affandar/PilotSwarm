# Building SDK Apps

Use the SDK path when you want to build your own application around PilotSwarm: a service, job runner, custom UI, integration test harness, or a specialized orchestrated workflow.

If you want a concrete layered-app reference while reading this guide, use [examples/devops-command-center](../../../examples/devops-command-center). It includes the same plugin files you would ship in a real app plus a programmatic SDK entrypoint.

If you want reusable Copilot custom agents that help scaffold this kind of app in another repository, see [Builder Agent Templates](./builder-agents.md).

The SDK gives you the durable runtime primitives. Your app provides:

- tools
- worker configuration
- agent and skill content
- session lifecycle
- whatever UI or API you want on top

Install it from npm:

```bash
npm install pilotswarm-sdk
```

## The Basic Shape

Every SDK app has two halves:

- `PilotSwarmWorker` — owns LLM turns, tool execution, plugin loading, and orchestration activities
- `PilotSwarmClient` — creates sessions, sends messages, and waits for updates

The worker is a trusted backend component and always connects directly to the store. Client code talks to a deployment through its [Web API](../../api/reference.md) and needs only the portal URL — no database or storage credentials.

## Minimal Working App

The worker half runs in your backend and connects directly to the store:

```ts
import { PilotSwarmWorker, defineTool } from "pilotswarm-sdk";

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
```

The client half connects to the deployment's Web API — all it needs is the portal URL:

```ts
import { PilotSwarmClient } from "pilotswarm-sdk";

const client = new PilotSwarmClient({
  apiUrl: "https://portal.example.com",
});
await client.start();

const session = await client.createSession({
  model: process.env.COPILOT_MODEL,
});

const result = await session.sendAndWait("What is the weather in Seattle?");
console.log(result);
```

If the deployment requires sign-in, pass a `getAccessToken` callback alongside `apiUrl`. In web mode tool wiring lives on the worker side — sessions use the tools your plugin's agents and worker defaults declare, and `createSessionForAgent(name)` binds a session to a specific agent.

For same-process local testing you can construct the client directly against the store (`new PilotSwarmClient({ store })`), but direct construction is internal/testing-only — client apps should use `apiUrl`.

## Management Client

For fleet-level operations — listing sessions, groups, stats — use `PilotSwarmManagementClient`, also over the Web API:

```ts
import { PilotSwarmManagementClient } from "pilotswarm-sdk";

const mgmt = new PilotSwarmManagementClient({
  apiUrl: "https://portal.example.com",
});
await mgmt.start();

const sessions = await mgmt.listSessions();
console.log(`${sessions.length} sessions`);
```

A handful of low-level methods (raw command channels, session dumps, some usage stats) are direct-mode only and throw `WEB_MODE_UNSUPPORTED` in web mode. See the [Web API reference](../../api/reference.md) for the full surface.

## Facts & Graph

To read and write a deployment's memory — facts (key/value + search) and the
knowledge graph — from an SDK app, see [Facts & Graph](./facts-and-graph.md). It
covers the store layering (`FactStore` → `EnhancedFactStore`, `GraphStore`),
building a store over the Web API (`createWebFactStore` / `createWebGraphStore`),
capability detection, and the server-side access model.

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

PilotSwarm's own framework prompt and management plugins are embedded in the installed `pilotswarm-sdk` package. Your app ships only its own `plugin/` directory and worker code.

The DevOps sample uses exactly this split:

- plugin files in [examples/devops-command-center/plugin](../../../examples/devops-command-center/plugin)
- worker-side tools in [examples/devops-command-center/tools.js](../../../examples/devops-command-center/tools.js)
- SDK app driver in [examples/devops-command-center/sdk-app.js](../../../examples/devops-command-center/sdk-app.js)
- helper launcher in [scripts/run-devops-sdk-sample.sh](../../../scripts/run-devops-sdk-sample.sh)

## Session Creation Model

The client sends only serializable configuration. The worker holds the actual tool handlers.

Typical `createSession()` fields:

- `toolNames` — names of tools registered on the worker
- `model` — default model for the session
- `systemMessage` — optional per-session overlay
- `workingDirectory` — where the worker should operate

In web mode (`{ apiUrl }`), `createSession()` takes only `model`, `reasoningEffort`, and `groupId` (an initial placement into one of *your* session groups — groups are private per-user organization, and a foreign/unknown group id is rejected with 403); worker-side fields such as `toolNames`, `systemMessage`, and `workingDirectory` are direct-mode only. To bind a session to a specific agent (and the tools it declares), use `createSessionForAgent(name, opts)`.

Your worker can also contribute defaults to every session through:

- `pluginDirs`
- `skillDirectories`
- `customAgents`
- `mcpServers`
- `systemMessage`

`default.agent.md` in your app plugin is layered underneath the embedded PilotSwarm framework base prompt. It extends the app-wide instructions for your sessions; it does not replace PilotSwarm's framework rules.

If the same plugin also powers the shipped UI packages, `plugin.json` may additionally define:

- `tui.title`, `tui.splash`, `tui.splashFile` for the CLI/TUI, plus optional
  `tui.splashMobile` / `tui.splashMobileFile` — a narrow-viewport splash
  variant swapped in when the main art is wider than the pane
- `portal.branding.title`, `portal.branding.pageTitle`, `portal.branding.splash`,
  `portal.branding.splashFile`, optional `portal.branding.splashMobile` /
  `portal.branding.splashMobileFile` (narrow-viewport variant, e.g. phones),
  `portal.branding.logoFile`, and optional
  `portal.branding.faviconFile` for browser portal branding
- `portal.ui.loadingMessage` and `portal.ui.loadingCopy` for browser portal
  startup copy
- `portal.auth.*` for browser sign-in copy

Flat legacy keys such as `portal.title` and `portal.loadingMessage` are still
accepted for backwards compatibility, but nested `portal.branding` /
`portal.ui` / `portal.auth` is the preferred shape.

Portal branding falls back to `portal.*`, then the matching `tui.*` values, and
finally PilotSwarm defaults. Portal auth is provider-based; the built-in
optional provider is Entra ID, but the portal core no longer assumes Entra as
the only supported option.

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

Run the worker and client on your machine. This is the fastest way to build and debug. For same-process testing the client may embed directly against the store, but treat that as internal/testing-only.

### Remote

Run workers in another process or cluster, and keep the client in your app or terminal.

For remote mode:

- the client connects with `{ apiUrl }` and needs only the portal URL — see the [Web API reference](../../api/reference.md)
- the worker environment still needs the tools and plugin files
- the client does not execute tools
- blob storage is recommended if you want reliable dehydration across nodes

## Layered-App Checklist

For apps you expect other LLMs or engineers to extend, keep these layers separate:

- plugin files for prompts, agents, skills, MCP config, session policy, and optional CLI branding
- worker code for tool handlers and any runtime-only defaults
- app code for session orchestration, API/UI behavior, and deployment wiring

That is the pattern used by the DevOps sample and the one we recommend pointing future LLMs at.

## What To Read Next

- [Building Agents For SDK Apps](./sdk-agents.md)
- [Facts & Graph](./facts-and-graph.md)
- [Web API Reference](../../api/reference.md)
- [Configuration](../reference/configuration.md)
- [Plugin Architecture & Layering Guide](./plugins.md)
- [Examples](./examples.md)
- [Getting Started](../../quickstart/local.md)
