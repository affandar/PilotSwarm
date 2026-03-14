# Building a Durable AI REST API Service with PilotSwarm SDK

> **Level**: Intermediate | **Time**: 30 min | **Focus**: Building beyond the TUI — custom REST APIs, headless deployments, full control

## What You'll Build

A production-ready REST API service that exposes **durable AI sessions** with crash recovery, resumable operations, and horizontal scaling. No terminal UI—just HTTP endpoints you can call from any client.

By the end, you'll have:

```
my-ai-service/
├── src/
│   ├── tools/
│   │   └── database-query.ts      ← Your custom tools
│   ├── worker.ts                   ← Worker (runs LLM turns, executes tools)
│   ├── server.ts                   ← Express/Fastify API (HTTP endpoints)
│   └── management.ts               ← Admin operations (list, delete, stop)
├── plugins/                         ← Optional: agents, skills, MCP servers
│   ├── agents/
│   │   └── api-assistant.agent.md
│   └── skills/
│       └── api-tools/SKILL.md
├── .model_providers.json            ← Multi-provider LLM config (optional)
├── .env                             ← Database, API keys, secrets
└── package.json
```

Three independent services running against the same database:

```
┌──────────────┐   HTTP    ┌──────────────┐
│   REST API   │──────────→│   Worker     │
│   (client)   │           │   (executor) │
└──────────────┘           └──────────────┘
       ↓                           ↓
       └───────────→ PostgreSQL ←─┘
          (single shared database)
```

This is a **durable execution pattern**: if the worker crashes mid-turn, it resumes safely. If your API dies, the session orchestration keeps running in duroxide, waiting for the next client connection.

---

## Prerequisites

| What | Why |
|------|-----|
| Node.js ≥ 24 | Required by the runtime. Check: `node --version` |
| npm ≥ 10 | Dependency management. Check: `npm --version` |
| PostgreSQL ≥ 14 | Session store. Or SQLite for local dev. Check: `psql --version` |
| GitHub API token | Or bring your own LLM (Azure, custom endpoint). [Get token](https://github.com/settings/tokens) |

### Optional (Production)

- **Azure Blob Storage** — for session dehydration (long-lived session checkpoints)
- **Docker** — can containerize worker + API separately
- **Kubernetes** — auto-scale workers independently from API servers

---

## Architecture: Co-located vs. Distributed

### Co-located Mode (Single Process)

Worker and client in one Node.js process. Fastest for local dev and testing.

```typescript
const worker = new PilotSwarmWorker({ store });
await worker.start();

const client = new PilotSwarmClient({ store });
await client.start();

// Session logic happens in the same process
const session = await client.createSession();
```

**Pros**: No network overhead. Simplest setup.  
**Cons**: Worker crash = API crash. Single point of failure for both.

### Distributed Mode (Separate Processes)

Worker and client connect to the same database independently. Perfect for production.

```
┌─────────────────────────────┐          ┌──────────────────────────┐
│  API Server (process 1)     │          │  Worker (process 2)      │
│  - HTTP listeners           │          │  - LLM turns             │
│  - PilotSwarmClient         │          │  - Tool execution        │
│  - Session management       │          │  - PilotSwarmWorker      │
└─────────────────────────────┘          └──────────────────────────┘
           ↓                                        ↓
           └─────────────→ PostgreSQL ←───────────┘
```

**Pros**: Independent scaling. Worker crash doesn't kill API. Deploy each separately.  
**Cons**: Slightly more complex. Network I/O between them goes through DB.

We'll show both patterns—start co-located, scale to distributed.

---

## Part 1: Project Setup

### Initialize Project

```bash
mkdir my-ai-service
cd my-ai-service
npm init -y
npm install pilotswarm express dotenv
npm install --save-dev typescript @types/node @types/express tsx
npx tsc --init
```

### Create `.env`

```bash
# PostgreSQL connection (or sqlite:// for local dev)
DATABASE_URL=postgresql://postgres:password@localhost:5432/my_ai_service

# GitHub Copilot token (required unless using custom provider)
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Optional: custom LLM provider (replaces GitHub token)
# LLM_PROVIDER_TYPE=azure
# LLM_ENDPOINT=https://my-resource.openai.azure.com/openai/deployments/gpt-4
# LLM_API_KEY=sk-xxxxxxxxxxxx

# Optional: session state directory
SESSION_STATE_DIR=/tmp/copilot-sessions

# Optional: Azure Blob for session dehydration
# AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;...
# AZURE_STORAGE_CONTAINER=copilot-sessions
```

### Create `package.json` Scripts

```json
{
  "scripts": {
    "build": "tsc",
    "start": "npm run build && node dist/server.js",
    "worker": "npm run build && node dist/worker.js",
    "dev": "tsx src/server.ts",
    "worker:dev": "tsx src/worker.ts"
  }
}
```

The key insight: **import paths match the `dist/` structure after build**.

---

## Part 2: Define Tools

Create `src/tools/database-query.ts`:

```typescript
import { defineTool } from "pilotswarm";

export const databaseQueryTool = defineTool(
  "query_database",
  {
    description: "Execute a read-only SQL SELECT query against the application database",
    parameters: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "SQL SELECT query (max 1000 characters). Avoid UPDATE/DELETE.",
        },
      },
      required: ["sql"],
    },
    handler: async ({ sql }: { sql: string }) => {
      // In production: real database connection, query execution, safety checks
      if (sql.length > 1000) {
        throw new Error("Query too long (max 1000 chars)");
      }
      if (/\b(UPDATE|DELETE|DROP|INSERT|TRUNCATE)\b/i.test(sql)) {
        throw new Error("Mutations not allowed — SELECT only");
      }

      // Mock response for demo
      console.log(`[tool] Executing query: ${sql.slice(0, 50)}...`);
      return {
        rows: [
          { id: 1, name: "Alice", created_at: "2024-01-15" },
          { id: 2, name: "Bob", created_at: "2024-01-16" },
        ],
        count: 2,
      };
    },
  }
);
```

In `src/tools/index.ts`:

```typescript
export { databaseQueryTool } from "./database-query.js";
```

---

## Part 3: Worker Setup

Create `src/worker.ts` (runs LLM turns, executes tools):

```typescript
import dotenv from "dotenv";
import { PilotSwarmWorker } from "pilotswarm";
import { databaseQueryTool } from "./tools/index.js";

dotenv.config();

// ─── Configuration ───────────────────────────────────────

const worker = new PilotSwarmWorker({
  // ─── Database ─────────────────────
  store: process.env.DATABASE_URL!,
  duroxideSchema: "duroxide",           // Can isolate multiple deployments
  cmsSchema: "copilot_sessions",

  // ─── LLM Provider ──────────────────
  githubToken: process.env.GITHUB_TOKEN,  // Or omit + use custom provider
  // provider: {
  //   type: "azure",
  //   baseUrl: process.env.LLM_ENDPOINT!,
  //   apiKey: process.env.LLM_API_KEY!,
  //   azure: { apiVersion: "2024-10-21" },
  // },

  // ─── Turn Limits ────────────────────
  turnTimeoutMs: 300_000,                // 5 min timeout per LLM turn
  waitThreshold: 30,                     // Waits < 30s sleep in-process
  sessionIdleTimeoutMs: 1_000 * 60 * 60, // 1 hour: auto-dehydrate idle sessions

  // ─── State Management ──────────────
  sessionStateDir: process.env.SESSION_STATE_DIR || "~/.copilot/session-state",

  // ─── Blob Storage (Optional) ───────
  blobConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
  blobContainer: process.env.AZURE_STORAGE_CONTAINER || "copilot-sessions",

  // ─── Plugins ──────────────────────
  pluginDirs: ["./plugins"],             // Load agents/skills/MCP from plugins/
  skillDirectories: ["./skills"],        // Additional skill directories
  customAgents: [
    {
      name: "api-assistant",
      description: "Specialized in API design and database queries",
      prompt: `You are an expert API designer with access to database queries. 
You help design REST endpoints, optimize database schemas, and write clean SQL.
Keep responses concise and focused.`,
      tools: ["query_database"],  // Restrict to specific tools
    },
  ],

  // ─── Logging ───────────────────────
  logLevel: process.env.LOG_LEVEL || "info",
  traceWriter: (msg) => console.log(`[duroxide] ${msg}`),

  // ─── Cluster Mode (K8s) ────────────
  workerNodeId: process.env.POD_NAME || "worker-1",
});

// ─── Register Tools ────────────────────────────────────

worker.registerTools([databaseQueryTool]);

// ─── Startup ────────────────────────────────────────────

(async () => {
  console.log("[worker] Starting...");
  console.log(`[worker] Store: ${process.env.DATABASE_URL?.replace(/\/\/.*@/, "//***@")}`);
  console.log(`[worker] Plugins: ${worker.loadedSkillDirs.join(", ") || "none"}`);
  console.log(`[worker] Agents: ${worker.loadedAgents.map(a => a.name).join(", ") || "none"}`);

  await worker.start();

  console.log("[worker] ✓ Started. Polling for orchestrations...");
  if (worker.modelProviders) {
    const groups = worker.modelProviders.getModelsByProvider();
    for (const g of groups) {
      console.log(`[worker] Models: ${g.providerId}: ${g.models.map(m => m.qualifiedName).join(", ")}`);
    }
  }

  // Keep process alive
  process.on("SIGTERM", async () => {
    console.log("[worker] SIGTERM received, shutting down...");
    await worker.stop?.();
    process.exit(0);
  });
})();
```

**Key points:**

- `store`: PostgreSQL or SQLite connection string
- `turnTimeoutMs`: Max time for a single LLM turn before aborting
- `pluginDirs`: Automatically load agents/skills/MCP servers from directories
- `registerTools()`: Worker-level tools available to all sessions by name
- `logLevel` + `traceWriter`: Diagnostics for duroxide orchestration

**Running the worker:**

```bash
npm run worker:dev        # Development (tsx hot-reload)
# or
DATABASE_URL=... npm run worker  # Production
```

---

## Part 4: REST API Service

Create `src/server.ts` (HTTP endpoints using PilotSwarmClient):

```typescript
import dotenv from "dotenv";
import express, { Request, Response, NextFunction } from "express";
import { PilotSwarmClient } from "pilotswarm";

dotenv.config();

const app = express();
app.use(express.json());

// ─── Initialize Client ─────────────────────────────────

let client: PilotSwarmClient;

(async () => {
  client = new PilotSwarmClient({
    store: process.env.DATABASE_URL!,
    duroxideSchema: "duroxide",      // Must match worker's schema
    cmsSchema: "copilot_sessions",
    blobEnabled: true,               // Enable session dehydration
    traceWriter: (msg) => console.log(`[client] ${msg}`),
  });

  await client.start();
  console.log("[api] Client started ✓");
})();

// ─── Middleware ────────────────────────────────────────

// Error handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(`[api] Error: ${err.message}`);
  res.status(500).json({ error: err.message });
});

// ─── REST Endpoints ────────────────────────────────────

/**
 * POST /sessions
 * Create a new AI session.
 * Body: { model?: "gpt-4o", systemMessage?: "...", toolNames?: ["query_database"] }
 */
app.post("/sessions", async (req: Request, res: Response) => {
  try {
    const { model, systemMessage, toolNames } = req.body;

    const session = await client.createSession({
      model: model || "gpt-4o",
      systemMessage: systemMessage || "You are a helpful assistant.",
      toolNames: toolNames || ["query_database"],
    });

    res.status(201).json({
      sessionId: session.sessionId,
      createdAt: new Date(),
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /sessions/:id
 * Resume a session (get its ID to continue chatting).
 */
app.get("/sessions/:id", async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id;
    const session = await client.resumeSession(sessionId);

    res.json({
      sessionId,
      info: "Session resumed. Ready to receive prompts.",
    });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * POST /sessions/:id/message
 * Send a prompt to the session and wait for completion.
 * Body: { prompt: "Analyze the Q4 sales data" }
 * Returns: { response: "...", status: "completed|waiting|input_required" }
 */
app.post("/sessions/:id/message", async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id;
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt in body" });
    }

    // Resume session
    const session = await client.resumeSession(sessionId);

    // Send prompt and wait for result (default 5 min timeout)
    const result = await session.sendAndWait(prompt, 300_000);

    res.json({
      sessionId,
      response: result || "(session waiting or pending input)",
      status: "completed",
    });
  } catch (err: any) {
    // Could be input_required, waiting, error, etc.
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /sessions/:id/stream
 * Subscribe to real-time events (SSE — Server-Sent Events).
 * Emit each event as it happens during the turn.
 *
 * Usage:
 *   const es = new EventSource("/sessions/abc/stream");
 *   es.onmessage = (e) => console.log(JSON.parse(e.data));
 */
app.get("/sessions/:id/stream", async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id;
    const session = await client.resumeSession(sessionId);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Forward events to client
    session.on((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    // Keep connection alive
    const keepAlive = setInterval(() => {
      res.write(": keepalive\n\n");
    }, 30_000);

    res.on("close", () => {
      clearInterval(keepAlive);
    });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * DELETE /sessions/:id
 * Delete a session (soft-delete: preserved in DB but marked deleted).
 */
app.delete("/sessions/:id", async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id;
    await client.deleteSession(sessionId);

    res.json({
      sessionId,
      deleted: true,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /health
 * Health check for load balancers / orchestrators.
 */
app.get("/health", (req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date() });
});

/**
 * GET /
 * API info
 */
app.get("/", (req: Request, res: Response) => {
  res.json({
    name: "AI Service API",
    version: "1.0.0",
    endpoints: [
      "POST /sessions",
      "GET /sessions/:id",
      "POST /sessions/:id/message",
      "GET /sessions/:id/stream",
      "DELETE /sessions/:id",
      "GET /health",
    ],
  });
});

// ─── Start ─────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[api] Listening on http://localhost:${PORT}`);
  console.log(`[api] POST /sessions to create, POST /sessions/:id/message to chat`);
});
```

**Test it locally:**

```bash
# Terminal 1: Start worker
npm run worker:dev

# Terminal 2: Start API server
npm run dev

# Terminal 3: Test API
curl -X POST http://localhost:3000/sessions \
  -H "Content-Type: application/json" \
  -d '{"systemMessage":"You are helpful"}'

# Response: { "sessionId": "abc-def-ghi", "createdAt": "..." }

# Send message
SESSION_ID=abc-def-ghi
curl -X POST http://localhost:3000/sessions/$SESSION_ID/message \
  -H "Content-Type: application/json" \
  -d '{"prompt":"What is 2+2?"}'

# Response: { "sessionId": "abc-def-ghi", "response": "2 + 2 = 4", "status": "completed" }
```

---

## Part 5: Management Endpoints (Admin)

Create `src/management.ts`:

```typescript
import dotenv from "dotenv";
import express from "express";
import { PilotSwarmManagementClient } from "pilotswarm";

dotenv.config();

const app = express();
app.use(express.json());

let mgmt: PilotSwarmManagementClient;

(async () => {
  mgmt = new PilotSwarmManagementClient({
    store: process.env.DATABASE_URL!,
    duroxideSchema: "duroxide",
    cmsSchema: "copilot_sessions",
    traceWriter: (msg) => console.log(`[mgmt] ${msg}`),
  });

  await mgmt.start();
  console.log("[mgmt] Started ✓");
})();

/**
 * GET /admin/sessions
 * List all sessions with live status.
 */
app.get("/admin/sessions", async (req, res) => {
  try {
    const sessions = await mgmt.listSessions();
    res.json({ sessions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /admin/sessions/:id
 * Get detailed view of a session.
 */
app.get("/admin/sessions/:id", async (req, res) => {
  try {
    const session = await mgmt.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Not found" });
    res.json(session);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /admin/sessions/:id
 * Rename session.
 */
app.patch("/admin/sessions/:id", async (req, res) => {
  try {
    const { title } = req.body;
    await mgmt.renameSession(req.params.id, title);
    res.json({ renamed: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /admin/sessions/:id
 * Cancel and delete a session.
 */
app.delete("/admin/sessions/:id", async (req, res) => {
  try {
    await mgmt.deleteSession(req.params.id, "Deleted by admin");
    res.json({ deleted: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /admin/models
 * List all available LLM models across providers.
 */
app.get("/admin/models", async (req, res) => {
  try {
    const models = await mgmt.listModels();
    res.json({ models });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.MGMT_PORT || 3001;
app.listen(PORT, () => {
  console.log(`[mgmt] Admin API on http://localhost:${PORT}`);
});
```

**Admin endpoints:**

```bash
# List all sessions
curl http://localhost:3001/admin/sessions

# Get session details
curl http://localhost:3001/admin/sessions/abc-def-ghi

# Rename session
curl -X PATCH http://localhost:3001/admin/sessions/abc-def-ghi \
  -H "Content-Type: application/json" \
  -d '{"title":"Q4 Analysis"}'

# Delete session
curl -X DELETE http://localhost:3001/admin/sessions/abc-def-ghi

# List available models
curl http://localhost:3001/admin/models
```

---

## Part 6: Plugin System

Optional but recommended for larger apps.

### Plugin Directory Structure

Create `plugins/` in your root:

```
plugins/
├── agents/
│   └── api-assistant.agent.md
├── skills/
│   └── api-tools/
│       └── SKILL.md
└── plugin.json
```

### Agent Definition (`plugins/agents/api-assistant.agent.md`)

```markdown
---
name: api-assistant
description: Specialized in REST API design and database queries
---

# API Assistant

You are an expert API designer. You:
- Design clean, RESTful endpoints
- Optimize SQL queries
- Suggest database schemas
- Review API contracts

When asked, provide clear recommendations with code examples.
```

### Skill Definition (`plugins/skills/api-tools/SKILL.md`)

```markdown
---
name: api-tools
description: Knowledge about REST API design patterns
---

# REST API Tools

## Status Codes
- 2xx: Success
- 4xx: Client error (bad request, auth, etc.)
- 5xx: Server error

## Pagination
Always use `?page=1&limit=20` for list endpoints.

## Error Responses
Always return `{error: "description"}`.
```

### Plugin Manifest (`plugins/plugin.json`)

```json
{
  "name": "api-tooling",
  "version": "1.0.0",
  "description": "API design and database tools",
  "author": "My Company"
}
```

The worker automatically loads these when you set `pluginDirs: ["./plugins"]`.

---

## Part 7: Distributed Deployment

Once your API is working locally, scale to production:

### Process 1: API Server (Separate Port)

```bash
# .env
DATABASE_URL=postgresql://prod-host/my_ai_service
GITHUB_TOKEN=ghp_xxxx
PORT=3000
MGMT_PORT=3001

npm run dev
```

### Process 2: Worker (Separate Process / Pod)

```bash
# Same .env (same database!)
export DATABASE_URL=postgresql://prod-host/my_ai_service
export GITHUB_TOKEN=ghp_xxxx

npm run worker
```

**Key insight:** Both connect to the same PostgreSQL database. They don't talk directly—duroxide coordinates through the DB.

### Scale with Docker Compose

Create `docker-compose.yml`:

```yaml
version: "3.8"

services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: password
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  worker:
    build: .
    command: npm run worker
    environment:
      DATABASE_URL: postgresql://postgres:password@postgres:5432/my_ai_service
      GITHUB_TOKEN: ${GITHUB_TOKEN}
    depends_on:
      - postgres

  api:
    build: .
    command: npm run start
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgresql://postgres:password@postgres:5432/my_ai_service
      PORT: 3000
    depends_on:
      - postgres
      - worker

volumes:
  pgdata:
```

```bash
# Start everything
docker-compose up

# Scale workers
docker-compose up --scale worker=3
```

### Scale on Kubernetes

See [Deploying to AKS](./deploying-to-aks.md) for full K8s setup. Key points:

- **Worker Deployment**: `replicas: 3` (or auto-scale based on CPU)
- **API Deployment**: `replicas: 2+` (load-balanced)
- **Single Database**: Both connect to same RDS/Azure Database for PostgreSQL
- **Blob Storage**: Optional but recommended for checkpointing long-running sessions

---

## Part 8: Configuration Reference

### PilotSwarmWorkerOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `store` | string | **required** | PostgreSQL URL or `sqlite://` for file-based |
| `githubToken` | string | optional | GitHub Copilot API token. Omit if using `provider` |
| `provider` | object | optional | Custom LLM (Azure, Anthropic, OpenAI). Replaces GitHub token |
| `turnTimeoutMs` | number | undefined | Max time (ms) for one LLM turn. 0 = no limit |
| `waitThreshold` | number | 30 | Waits ≤ this many seconds sleep in-process (no dehydration) |
| `sessionIdleTimeoutMs` | number | undefined | Auto-dehydrate sessions idle > this many ms |
| `pluginDirs` | string[] | [] | Directories to load agents/skills/MCP configs from |
| `skillDirectories` | string[] | [] | Additional skill dirs (beyond plugins) |
| `customAgents` | object[] | [] | Custom agents (beyond plugins) |
| `mcpServers` | object | {} | MCP server configs |
| `modelProvidersPath` | string | auto-discover | Path to `.model_providers.json` |
| `systemMessage` | string | auto | Base system prompt for all sessions |
| `disableManagementAgents` | boolean | false | Disable built-in sweeper/resource-mgr agents |
| `logLevel` | string | "info" | "debug" \| "info" \| "warning" \| "error" \| "none" |
| `traceWriter` | function | disabled | Callback for duroxide trace logs |
| `sessionStateDir` | string | `~/.copilot/session-state` | Local cache for session state files |
| `blobConnectionString` | string | optional | Azure Blob Storage connection (for dehydration) |
| `blobContainer` | string | "copilot-sessions" | Blob container name |
| `duroxideSchema` | string | "duroxide" | PostgreSQL schema for orchestration tables |
| `cmsSchema` | string | "copilot_sessions" | PostgreSQL schema for session catalog |
| `workerNodeId` | string | hostname | Unique identifier for this worker (for clustering) |

### PilotSwarmClientOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `store` | string | **required** | PostgreSQL URL (must match worker's) |
| `blobEnabled` | boolean | false | Enable session dehydration to blob storage |
| `waitThreshold` | number | 30 | Waits ≤ this many seconds sleep in-process |
| `dehydrateThreshold` | number | 30 | Dehydrate after this many seconds (if blobEnabled) |
| `checkpointInterval` | number | -1 | Seconds between periodic checkpoints (-1 = disabled) |
| `rehydrationMessage` | string | optional | Message prepended to prompt after worker restart |
| `duroxideSchema` | string | "duroxide" | Must match worker's schema |
| `cmsSchema` | string | "copilot_sessions" | Must match worker's schema |
| `traceWriter` | function | disabled | Callback for diagnostics |

### PilotSwarmManagementClientOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `store` | string | **required** | PostgreSQL URL |
| `duroxideSchema` | string | "duroxide" | PostgreSQL schema for orchestration |
| `cmsSchema` | string | "copilot_sessions" | PostgreSQL schema for sessions catalog |
| `modelProvidersPath` | string | auto-discover | Path to `.model_providers.json` |
| `traceWriter` | function | disabled | Callback for diagnostics |

---

## Part 9: Multi-Provider LLM Configuration

For production, support multiple LLM providers. Create `.model_providers.json`:

```json
{
  "providers": [
    {
      "id": "github",
      "type": "github",
      "description": "GitHub Copilot API",
      "token": "${GITHUB_TOKEN}",
      "models": [
        {
          "name": "gpt-4o",
          "description": "GPT-4 Omni (latest)",
          "costPer1kInputTokens": 0.015,
          "costPer1kOutputTokens": 0.06
        }
      ]
    },
    {
      "id": "azure",
      "type": "azure",
      "description": "Azure OpenAI",
      "baseUrl": "${AZURE_ENDPOINT}",
      "apiKey": "${AZURE_API_KEY}",
      "apiVersion": "2024-10-21",
      "models": [
        {
          "name": "gpt-4-deployment",
          "description": "GPT-4 on Azure",
          "costPer1kInputTokens": 0.01,
          "costPer1kOutputTokens": 0.03
        }
      ]
    },
    {
      "id": "anthropic",
      "type": "anthropic",
      "description": "Anthropic Claude",
      "apiKey": "${ANTHROPIC_API_KEY}",
      "models": [
        {
          "name": "claude-3-opus-20240229",
          "description": "Claude 3 Opus"
        }
      ]
    }
  ],
  "defaultProvider": "github"
}
```

Reference in `worker.ts`:

```typescript
const worker = new PilotSwarmWorker({
  store: process.env.DATABASE_URL,
  modelProvidersPath: "./.model_providers.json",
  // githubToken not needed — loaded from .model_providers.json
});
```

Client can request a specific model:

```typescript
const session = await client.createSession({
  model: "azure:gpt-4-deployment",  // prefix with provider:model
});
```

---

## Part 10: Key Differences from the TUI

| Aspect | TUI (`pilotswarm-tui`) | Custom API (This Guide) |
|--------|------------------------|------------------------|
| **UI** | Terminal UI (blessed) | HTTP endpoints |
| **Deployment** | Single process (co-located) | Worker + API separated (scalable) |
| **Tool Registration** | Via plugin system | `worker.registerTools()` + plugin system |
| **Session Management** | Interactive terminal input | REST API (`POST /message`, webhooks) |
| **Admin Ops** | Built-in TUI commands | `/admin/*` endpoints or `PilotSwarmManagementClient` |
| **Scaling** | Not suitable for horizontal scaling | Design for K8s / Docker Swarm |

**When to choose each:**

- **TUI**: Local dev, demos, interactive testing
- **Custom API**: Production, REST-first, multi-tenant SaaS, headless services

---

## Troubleshooting

### "Could not connect to PostgreSQL"

Check `DATABASE_URL` and that PostgreSQL is running:

```bash
psql $DATABASE_URL -c "SELECT 1"
```

### "Nondeterministic orchestration error"

This means your orchestration (duroxide internal state machine) yielded actions in a different order during replay. This is rare if you're not modifying the SDK, but if you see it: reset the database.

```bash
npm run db:reset
```

### "Tool not found"

- Verify tool is registered: `worker.registerTools([myTool])`
- Verify session references it: `toolNames: ["my_tool_name"]`
- Restart worker (tool registry is loaded at startup)

### "Session waiting for user input"

When the LLM requests input via `ask_user` tool, the orchestration pauses waiting for an answer. Send the answer:

```bash
curl -X POST http://localhost:3000/sessions/$SESSION_ID/answer \
  -H "Content-Type: application/json" \
  -d '{"answer":"Yes"}'
```

---

## Next Steps

1. **Add authentication**: Wrap endpoints with JWT or API key validation
2. **Add metrics**: Export Prometheus metrics (turns/sec, latency, errors)
3. **Add webhooks**: Notify external systems when session completes
4. **Add fine-tuning**: Support customer-trained models via `customAgents`
5. **Add multi-tenancy**: Isolate sessions by organization (separate schemas)

See [System Reference](./system-reference.md) and [Deploying to AKS](./deploying-to-aks.md) for deeper dives.

---

## Summary

You've built a production-ready durable AI service with:

✅ **Worker** that executes LLM turns and tools  
✅ **REST API** for session management and messaging  
✅ **Admin panel** for monitoring and lifecycle  
✅ **Distributed architecture** ready for K8s  
✅ **Plugin system** for custom agents and skills  
✅ **Multi-provider LLM support** (GitHub, Azure, Anthropic)  
✅ **Crash recovery** via duroxide + PostgreSQL  

The same database powers both client and worker—any worker can pick up where another left off. Scale workers independently from the API. Deploy with confidence.

Happy building! 🚀
EOF
