# PilotSwarm

> **Experimental** — This project is under active development and not yet ready for production use. APIs may change without notice.

A durable execution runtime for [GitHub Copilot SDK](https://github.com/github/copilot-sdk) agents. Crash recovery, durable timers, session dehydration, and multi-node scaling — powered by [duroxide](https://github.com/microsoft/duroxide). Just add a connection string.

For the fastest first run, start with the [Docker Quickstart Guide](docs/getting-started-docker-appliance.md).

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Builder Agents

If you are building layered apps on top of PilotSwarm, this repo now ships distributable builder-agent templates you can copy into your own repository:

- [Builder Agent Templates](docs/builder-agents.md)
- [DevOps Command Center Sample](examples/devops-command-center/README.md)

These are not active agents in this repo. They are templates intended to be copied into a user repo under `.github/agents/` and `.github/skills/`.

<img width="630" height="239" alt="image" src="https://github.com/user-attachments/assets/807cdf40-b228-41c1-bfe2-8100230544c9" />


## Quick Start

Two paths:

### Try it from this repo (3 minutes)

The Docker quickstart is the fastest first run. One image, browser portal,
local PostgreSQL, two embedded workers — set `GITHUB_TOKEN` and go:

→ [Docker Quickstart Guide](docs/getting-started-docker-appliance.md)

If you'd rather run from source instead of Docker:

```bash
git clone https://github.com/affandar/pilotswarm.git
cd pilotswarm && npm install && npm run build

cp .env.example .env
cp .model_providers.example.json .model_providers.json
# edit .env: set DATABASE_URL and at least one LLM provider key.
# easiest: GITHUB_TOKEN (gives Claude, GPT-4.1, etc. via GitHub Copilot).

./run.sh local --db   # launches Postgres + workers + TUI
```

→ [Full source-based getting started](docs/getting-started.md)

### Use as a library in your own app

```bash
npm install pilotswarm-sdk
```

```typescript
import { PilotSwarmClient, PilotSwarmWorker, defineTool } from "pilotswarm-sdk";

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

// Worker runs LLM turns + tools. In production it lives in its own
// long-running process (see "Durability" below); here we co-locate for demo.
const worker = new PilotSwarmWorker({ store: process.env.DATABASE_URL });
worker.registerTools([getWeather]);
await worker.start();

const client = new PilotSwarmClient({ store: process.env.DATABASE_URL });
await client.start();

const session = await client.createSession({
    toolNames: ["get_weather"],
    systemMessage: "You are a weather assistant.",
});
const response = await session.sendAndWait("What's the weather in NYC?");
console.log(response);

await client.stop();
await worker.stop();
```

PilotSwarm's own framework prompt and management plugins ship embedded inside `pilotswarm-sdk`. Apps layer their own `plugin/` directories on top; they do not need to copy the framework's built-in plugin text into their own repos.

### Durability — recurring and long-waiting agents

The single-process demo above doesn't show the durability story because the
process exits as soon as the response lands. To run an agent that pauses for
hours or runs a recurring schedule, the worker has to be a long-running
process — typically:

- one or more `PilotSwarmWorker`s in their own service (locally with `npm run worker`, in production on Kubernetes), and
- clients (CLI, TUI, browser portal, or your app) connecting to the same PostgreSQL

The agent then calls `wait(...)` for one-shot delays, or `cron(...)` for
recurring schedules. Long waits dehydrate the session to blob storage; any
worker rehydrates it when the timer fires. See [Architecture](docs/architecture.md)
and [Building SDK Apps](docs/sdk/building-apps.md) for the full pattern.

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
