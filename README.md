# PilotSwarm

> **Experimental** — This project is under active development and not yet ready for production use. APIs may change without notice.

A durable execution runtime for [GitHub Copilot SDK](https://github.com/github/copilot-sdk) agents. Crash recovery, durable timers, session dehydration, and multi-node scaling — powered by [duroxide](https://github.com/microsoft/duroxide). Just add a connection string.

**v0.1.9** — Web portal, BYOK model providers (no GitHub token required), TUI prompt editor with file attach, artifact picker improvements. See [CHANGELOG.md](CHANGELOG.md) for details.

## Builder Agents

If you are building layered apps on top of PilotSwarm, this repo now ships distributable builder-agent templates you can copy into your own repository:

- [Builder Agent Templates](docs/builder-agents.md)
- [DevOps Command Center Sample](examples/devops-command-center/README.md)

These are not active agents in this repo. They are templates intended to be copied into a user repo under `.github/agents/` and `.github/skills/`.

<img width="630" height="239" alt="image" src="https://github.com/user-attachments/assets/807cdf40-b228-41c1-bfe2-8100230544c9" />


## Quick Start

```bash
npm install pilotswarm-sdk
cp .env.example .env
# review/edit the checked-in model catalog (no secrets inside)
$EDITOR .model_providers.json
# edit .env: set DATABASE_URL and at least one LLM provider key
# easiest: set GITHUB_TOKEN (gives access to Claude, GPT, etc. via GitHub Copilot)
```

```typescript
import { PilotSwarmClient, PilotSwarmWorker, defineTool } from "pilotswarm-sdk";

// Define tools — same API as Copilot SDK
const getWeather = defineTool("get_weather", {
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

// Start a worker (runs LLM turns, executes tools)
const worker = new PilotSwarmWorker({
    store: process.env.DATABASE_URL,          // PostgreSQL connection string
});
worker.registerTools([getWeather]);           // register tools at the worker level
await worker.start();

// Start a client (manages sessions — can run on a different machine)
const client = new PilotSwarmClient({
    store: process.env.DATABASE_URL,
});
await client.start();

// Create a session — reference tools by name (serializable)
const session = await client.createSession({
    toolNames: ["get_weather"],
    systemMessage: "You are a weather assistant.",
});

const response = await session.sendAndWait("Check NYC weather every hour for 8 hours");
console.log(response);
// For recurring schedules, the agent can call cron(3600, ...)
// so the process shuts down, a durable wake-up fires later,
// and any worker resumes the session. Use wait(...) for one-shot delays.

await client.stop();
await worker.stop();
```

PilotSwarm's own framework prompt and management plugins ship embedded inside `pilotswarm-sdk`. Apps layer their own `plugin/` directories on top; they do not need to copy the framework's built-in plugin text into their own repos.

## What You Get

| Feature | Copilot SDK | PilotSwarm |
|---------|-------------|---------------------|
| Tool calling | ✅ | ✅ Same `defineTool()` API |
| Wait/pause | ❌ Blocks process | ✅ Durable timer — process shuts down, resumes later |
| Crash recovery | ❌ Session lost | ✅ Automatic resume from last state |
| Multi-node | ❌ Single process | ✅ Sessions migrate between worker pods |
| Session persistence | ❌ In-memory | ✅ PostgreSQL + Azure Blob Storage |
| Event streaming | ❌ Local only | ✅ Cross-process event subscriptions |

## How It Works

The runtime automatically injects `wait` and `cron` tools into every session. When the LLM needs to pause or schedule recurring work:

1. **Short waits** (< 30s) — sleep in-process
2. **Long waits** (≥ 30s) — dehydrate session to blob storage → durable timer → any worker hydrates and continues
3. **Recurring schedules** — use `cron(...)` so the orchestration re-arms itself automatically after each cycle

```
Client                        PostgreSQL                     Worker Pods
  │                              │                              │
  │── send("monitor hourly") ──→ │                              │
  │                              │── orchestration queued ────→ │
  │                              │                              │── runTurn (LLM)
  │                              │                              │── wait(3600)
  │                              │                              │── dehydrate → blob
  │                              │── durable timer (1 hour) ──→ │
  │                              │                              │── hydrate ← blob
  │                              │                              │── runTurn (LLM)
  │                              │                              │── response
  │←── result ──────────────────│                              │
```

## Examples

| Example | Description | Command |
|---------|-------------|---------|
| [Chat](packages/sdk/examples/chat.js) | Interactive console chat | `npm run chat` |
| [TUI](packages/cli/bin/tui.js) | Multi-session terminal UI with logs | `npm run tui` |
| [Worker](packages/sdk/examples/worker.js) | Headless worker for K8s | `npm run worker` |
| [Tests](packages/sdk/test/sdk.test.js) | Automated test suite | `npm test` |

## Documentation

Start with the documentation hub:

- [Documentation Index](docs/README.md)

Common entry points:

- [Working On PilotSwarm](docs/contributors/working-on-pilotswarm.md) — contributors working on the SDK, TUI, providers, prompts, or orchestration
- [Builder Agent Templates](docs/builder-agents.md) — copyable Copilot custom agents for users building apps on top of PilotSwarm
- [Building SDK Apps](docs/sdk/building-apps.md) — app developers using `PilotSwarmClient` and `PilotSwarmWorker`
- [Building Agents For SDK Apps](docs/sdk/building-agents.md) — the clearest path for authoring `default.agent.md`, named agents, skills, and tools
- [Building CLI Apps](docs/cli/building-cli-apps.md) — plugin- and worker-module-driven apps on the shipped TUI
- [Building Agents For CLI Apps](docs/cli/building-agents.md) — the CLI-focused agent-authoring guide
- [Example Applications](docs/examples.md) — includes the DevOps Command Center sample for layered apps
- [Getting Started](docs/getting-started.md) — install, PostgreSQL, `.env`, and first run
- [Configuration](docs/configuration.md) — environment variables, blob storage, worker/client options
- [Deploying to AKS](docs/deploying-to-aks.md) — Kubernetes deployment, scaling, and rolling updates
- [Architecture](docs/architecture.md) — internal design and runtime flow

## Requirements

- Node.js >= 24
- PostgreSQL
- GitHub Copilot access token (worker-side only)
- Azure Blob Storage (optional, for session dehydration across nodes)

## License

MIT
