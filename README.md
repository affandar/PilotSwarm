# durable-copilot-runtime

A durable execution runtime for [GitHub Copilot SDK](https://github.com/github/copilot-sdk) agents. Crash recovery, durable timers, session dehydration, and multi-node scaling — powered by [duroxide](https://github.com/microsoft/duroxide). Just add a connection string.

## Quick Start

```bash
npm install durable-copilot-runtime
cp .env.example .env
# edit .env with DATABASE_URL and GITHUB_TOKEN
```

```typescript
import { DurableCopilotClient, DurableCopilotWorker, defineTool } from "durable-copilot-runtime";

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
const worker = new DurableCopilotWorker({
    store: process.env.DATABASE_URL,          // PostgreSQL connection string
    githubToken: process.env.GITHUB_TOKEN,
});
worker.registerTools([getWeather]);           // register tools at the worker level
await worker.start();

// Start a client (manages sessions — can run on a different machine)
const client = new DurableCopilotClient({
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
// The agent calls wait(3600) between checks — the process shuts down,
// a durable timer fires an hour later, and any worker resumes the session.

await client.stop();
await worker.stop();
```

## What You Get

| Feature | Copilot SDK | durable-copilot-runtime |
|---------|-------------|---------------------|
| Tool calling | ✅ | ✅ Same `defineTool()` API |
| Wait/pause | ❌ Blocks process | ✅ Durable timer — process shuts down, resumes later |
| Crash recovery | ❌ Session lost | ✅ Automatic resume from last state |
| Multi-node | ❌ Single process | ✅ Sessions migrate between worker pods |
| Session persistence | ❌ In-memory | ✅ PostgreSQL + Azure Blob Storage |
| Event streaming | ❌ Local only | ✅ Cross-process event subscriptions |

## How It Works

The runtime automatically injects a `wait` tool into every session. When the LLM needs to pause:

1. **Short waits** (< 30s) — sleep in-process
2. **Long waits** (≥ 30s) — dehydrate session to blob storage → durable timer → any worker hydrates and continues

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
| [Chat](examples/chat.js) | Interactive console chat | `npm run chat` |
| [TUI](cli/tui.js) | Multi-session terminal UI with logs | `npx durable-copilot-runtime-tui` |
| [Worker](examples/worker.js) | Headless worker for K8s | `npm run worker` |
| [Tests](test/sdk.test.js) | Automated test suite | `npm test` |

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](docs/getting-started.md) | From zero to running — PostgreSQL, GitHub token, `.env`, AKS |
| [User Guide](docs/guide.md) | Runtime concepts, API reference, standard vs durable comparison |
| [Configuration](docs/configuration.md) | PostgreSQL, blob storage, environment variables, worker/client options |
| [Deploying to AKS](docs/deploying-to-aks.md) | Kubernetes deployment, scaling, rolling updates |
| [Examples](docs/examples.md) | Chat app, TUI, worker, and test suite walkthrough |
| [Architecture](docs/architecture.md) | Internal design — orchestrations, session proxy, dehydration |

## Requirements

- Node.js >= 24
- PostgreSQL
- GitHub Copilot access token (worker-side only)
- Azure Blob Storage (optional, for session dehydration across nodes)

## License

MIT
