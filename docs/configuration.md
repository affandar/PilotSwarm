# Configuration Guide

> **New here?** See the [Getting Started](./getting-started.md) guide for a full walkthrough from zero to running.

## Prerequisites

- **Node.js >= 24** (required for `--env-file` support)
- **PostgreSQL** (local or managed — Azure Database for PostgreSQL, AWS RDS, etc.)
- **LLM provider credentials** — at least one of:
  - `GITHUB_TOKEN` (easiest — gives access to Claude, GPT, etc. via GitHub Copilot)
  - Azure OpenAI, Azure AI Services, or any OpenAI-compatible API key

Optional:
- **Azure Blob Storage** — for session dehydration/hydration across nodes

## Environment Variables

Start from the template:

```bash
cp .env.example .env
cp .model_providers.example.json .model_providers.json
```

Then edit `.env` with your credentials:

```bash
# Required
DATABASE_URL=postgresql://user:password@localhost:5432/pilotswarm

# LLM provider keys (at least one required)
# Easiest: use GITHUB_TOKEN for GitHub Copilot access
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
# Or: BYOK with Azure OpenAI / other providers
# AZURE_OPENAI_KEY=your-key

# Optional — session dehydration to blob storage
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...
AZURE_STORAGE_CONTAINER=copilot-sessions
```

> **Model providers** are configured in `.model_providers.json`. API keys use `env:VAR_NAME` syntax to reference `.env` variables. Providers whose API key is not set are automatically excluded from the model list.

## PostgreSQL Setup

### Local Development

```bash
# Create database
createdb pilotswarm

# Connection string
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pilotswarm
```

### Azure Database for PostgreSQL

```bash
DATABASE_URL=postgresql://user:password@myserver.postgres.database.azure.com:5432/postgres?sslmode=require
```

The runtime automatically handles SSL certificate validation for Azure-managed PostgreSQL (strips `sslmode` from the URL and configures `rejectUnauthorized: false`).

### Schema Initialization

Both the duroxide runtime and the session catalog (CMS) create their schemas automatically on first connection:

- **`duroxide`** schema — orchestration state, execution history, queues
- **`copilot_sessions`** schema — session records, event log

No manual migration needed.

### Database Reset

To wipe all state and start fresh:

```bash
npm run db:reset
# or
node --env-file=.env scripts/db-reset.js
```

## Single-Process Mode

The simplest setup — client and worker in the same process:

```typescript
import { PilotSwarmClient, PilotSwarmWorker, defineTool } from "pilotswarm-sdk";

const store = process.env.DATABASE_URL;

const worker = new PilotSwarmWorker({
    store,
});
await worker.start();

const client = new PilotSwarmClient({ store });
await client.start();

const session = await client.createSession({
    systemMessage: "You are a helpful assistant.",
});

// Must forward tools to co-located worker
worker.setSessionConfig(session.sessionId, { tools: [myTool] });

const response = await session.sendAndWait("Hello!");
```

This is great for development and testing. The worker runs LLM turns in-process.

## Separate Worker Process

For production, run workers as separate processes:

### Worker Process

```javascript
// worker.js
import { PilotSwarmWorker } from "pilotswarm-sdk";

const worker = new PilotSwarmWorker({
    store: process.env.DATABASE_URL,
    blobConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
    blobContainer: process.env.AZURE_STORAGE_CONTAINER || "copilot-sessions",
});

await worker.start();
console.log("Worker started, polling for orchestrations...");

// Graceful shutdown
process.on("SIGTERM", async () => {
    await worker.stop();
    process.exit(0);
});

// Block forever
await new Promise(() => {});
```

### Client Process

```javascript
// app.js
import { PilotSwarmClient } from "pilotswarm-sdk";

const client = new PilotSwarmClient({
    store: process.env.DATABASE_URL,
    blobEnabled: true,  // enable session dehydration
});
await client.start();

const session = await client.createSession();
await session.send("Monitor the API every 10 minutes");

// Client can exit — the worker will continue processing
console.log(`Session ${session.sessionId} is running on the worker`);
```

The client and worker share the same PostgreSQL database. The client enqueues work; workers poll and execute.

## Worker Options

```typescript
new PilotSwarmWorker({
    // Required
    store: string,           // PostgreSQL connection string
    githubToken: string,     // GitHub Copilot token

    // Optional
    logLevel: "info",        // "none" | "error" | "warning" | "info" | "debug" | "all"
    waitThreshold: 30,       // seconds — waits above this become durable timers
    workerNodeId: "pod-1",   // identifier for this worker (default: hostname)

    // Blob storage for session dehydration
    blobConnectionString: string,   // Azure Storage connection string
    blobContainer: string,          // container name (default: "copilot-sessions")

    // Schema isolation (for multi-tenant on same database)
    duroxideSchema: "duroxide",         // orchestration schema (default: "duroxide")
    cmsSchema: "copilot_sessions",       // session catalog schema (default: "copilot_sessions")
});
```

## Client Options

```typescript
new PilotSwarmClient({
    // Required
    store: string,            // PostgreSQL connection string

    // Optional
    blobEnabled: false,       // enable session dehydration across nodes
    waitThreshold: 30,        // seconds — passed to orchestration
    dehydrateThreshold: 10,   // seconds — waits above this trigger dehydration
    dehydrateOnIdle: 120,     // seconds to wait before dehydrating idle sessions
    dehydrateOnInputRequired: 60, // seconds to wait before dehydrating on user input

    // Schema isolation (must match worker)
    duroxideSchema: "duroxide",         // default: "duroxide"
    cmsSchema: "copilot_sessions",       // default: "copilot_sessions"
});
```

## Azure Blob Storage

Session dehydration stores the full LLM conversation history in blob storage, allowing sessions to move between worker nodes. Without it, sessions are pinned to a single worker.

### Setup

1. Create an Azure Storage Account
2. Create a container (e.g., `copilot-sessions`)
3. Get the connection string from the Azure Portal

```bash
AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=mystorageaccount;AccountKey=...;EndpointSuffix=core.windows.net"
AZURE_STORAGE_CONTAINER=copilot-sessions
```

### How It Works

When a session needs to wait (durable timer) or goes idle:

1. **Dehydrate** — serialize the full conversation to a blob
2. **Release** — the worker drops the in-memory session
3. **Timer fires** — any available worker picks up the job
4. **Hydrate** — download the blob, reconstruct the session
5. **Continue** — resume the LLM turn with full context

This enables true multi-node scaling — sessions can migrate between workers transparently.

## LLM Provider Configuration

PilotSwarm uses `.model_providers.json` to configure LLM providers. API keys are stored in `.env` and referenced via `env:VAR_NAME` syntax.

> **Easiest way to get started:** Set `GITHUB_TOKEN` in `.env`. This gives you access to all models available through GitHub Copilot (Claude, GPT-4.1, GPT-5.1, etc.) with no additional configuration needed.

For BYOK (bring-your-own-key) providers like Azure OpenAI, add the provider to `.model_providers.json` and set the corresponding API key in `.env`. See `.model_providers.example.json` for the full template.

Providers whose API key env var is not set are **automatically excluded** from the model list — they won't appear in the TUI model picker or the `list_available_models` tool. This means you only need credentials for the providers you actually use.

```bash
# Get a GitHub token (easiest path)
gh auth token
```

The token is only needed on the **worker** side. Clients don't need it.

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript |
| `npm run dev` | Watch mode compilation |
| `npm test` | Run test suite |
| `npm run chat` | Interactive chat (single-process) |
| `npm run tui` | Full TUI with embedded workers |
| `npm run tui:remote` | TUI client-only (AKS workers) |
| `npm run worker` | Headless worker process |
| `npm run db:reset` | Reset database schemas |
