# Building Apps on PilotSwarm

> This guide is now a legacy overview. For the current recommended paths, start with [Building SDK Apps](./sdk/building-apps.md), [Building Agents For SDK Apps](./sdk/building-agents.md), or [Building CLI Apps](./cli/building-cli-apps.md).

This guide explains how to build apps on PilotSwarm. The primary
extension mechanism is **plugins** — a directory structure containing agents, skills,
and MCP server configs. Workers load plugin contents at startup and pass them through
to the Copilot SDK via proven session config fields (`skillDirectories`, `customAgents`,
`mcpServers`). Clients are thin proxies that send prompts and render events.

The runtime ships a full TUI as a CLI (`pilotswarm`) — see
[Putting It All Together](#putting-it-all-together) for usage.

## Architecture: Plugins + Tools + Runtime

Every app built on PilotSwarm has three layers:

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                   │
│  Plugin (packaging)                                               │
│    A directory containing:                                       │
│    • agents/*.agent.md  — named sub-personas                     │
│    • skills/*/SKILL.md  — domain knowledge                       │
│    • .mcp.json          — external tool providers                │
│    ↓                                                              │
│  Tools (execution)                                                │
│    LLM-callable functions registered on the worker               │
│    ↓                                                              │
│  Runtime (infrastructure)                                         │
│    Worker process, database, secrets — where it all runs          │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

| Layer | What | Where | Owned by |
|-------|------|-------|----------|
| **Plugin** | Agents + skills + MCP configs | `plugin/` directory | App developer |
| **Tools** | Name + description + parameters + handler function | Worker code (`worker.registerTools()`) | App developer |
| **Runtime** | Worker process + DB + secrets + artifacts | Deployment target (local, K8s, etc.) | Operations |

---

## 1. Plugins

A plugin is a directory with agents, skills, and MCP configs. The worker reads plugin
contents at startup and passes them to every Copilot SDK session via:

- **`skillDirectories`** — paths to `skills/` subdirectories containing `SKILL.md` files
- **`customAgents`** — agent configs parsed from `agents/*.agent.md` files
- **`mcpServers`** — MCP server configs parsed from `.mcp.json`

### Plugin Directory Structure

```
my-plugin/
├── agents/                  ← Optional: agent definitions
│   ├── planner.agent.md
│   └── monitor.agent.md
├── skills/                  ← Optional: skill directories
│   ├── durable-timers/
│   │   └── SKILL.md
│   └── concise-assistant/
│       └── SKILL.md
└── .mcp.json                ← Optional: MCP server configs
```

### How Loading Works

```
Worker startup                              Every session creation
──────────────                              ──────────────────────
PilotSwarmWorker({                      SessionManager.getOrCreate():
  pluginDirs: ["./plugin"],                   SDK.createSession({
  systemMessage: "...",                         skillDirectories: [...plugin skill dirs],
})                                              customAgents: [...parsed .agent.md files],
  ↓ _loadPlugins()                              mcpServers: {...parsed .mcp.json},
  reads plugin/skills/* → skillDirectories    })
  reads plugin/agents/*.agent.md → agents
  reads plugin/.mcp.json → mcpServers
```

### Agent Files (`.agent.md`)

Agents are defined as markdown files with YAML frontmatter:

```markdown
---
name: planner
description: Creates structured plans for complex tasks
tools:
  - view
  - grep
---

# Planner Agent

You are a planning agent. Break down complex tasks into ordered steps.
Do not execute — only plan.
```

### Skill Files (`SKILL.md`)

Skills are domain knowledge bundles — YAML frontmatter + markdown body:

```markdown
---
name: durable-timers
description: Expert knowledge on durable timer patterns
---

# Durable Timer Patterns

You have a `wait` tool that creates timers surviving process restarts...
```

### MCP Server Config (`.mcp.json`)

External tool providers — local subprocess or remote HTTP:

```json
{
  "kubernetes": {
    "command": "kubectl-mcp",
    "args": ["serve"],
    "tools": ["*"]
  },
  "remote-api": {
    "type": "http",
    "url": "https://api.example.com/mcp",
    "tools": ["query"],
    "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
  }
}
```

Environment variable references (`${VAR}`) in string values are expanded at load time.

### Advanced: Direct Config (No Plugin Directory)

For programmatic control, bypass the plugin directory entirely:

```javascript
const worker = new PilotSwarmWorker({
  store: process.env.DATABASE_URL,
  githubToken: process.env.GITHUB_TOKEN,
  skillDirectories: ["/path/to/my-skills"],
  customAgents: [{ name: "reviewer", prompt: "You review code.", tools: null }],
  mcpServers: { "my-server": { command: "node", args: ["server.js"], tools: ["*"] } },
});
```

These merge with any plugin-loaded config. Direct config takes precedence.

---

## 2. Tools

Tools are the lowest layer — functions the LLM can call. Each tool has a schema (what the
LLM sees) and a handler (what actually executes).

### Defining a Tool

```typescript
import { defineTool } from "@github/copilot-sdk";

const deployService = defineTool("deploy_service", {
  description: "Deploy a service to the specified environment",
  parameters: {
    type: "object",
    properties: {
      service: { type: "string", description: "Service name" },
      env: { type: "string", enum: ["staging", "production"] },
    },
    required: ["service", "env"],
  },
  handler: async ({ service, env }) => {
    // This code runs on the worker — needs kubectl, credentials, etc.
    const result = await exec(`kubectl apply -f manifests/${service}.yaml -n ${env}`);
    return { status: "deployed", output: result.stdout };
  },
});
```

### System Tools (Auto-Injected)

Two tools are injected into every session automatically:

- **`wait`** — Durable timer. Short waits sleep in-process; long waits dehydrate the session
  and schedule a durable timer that survives process restarts and node migrations.
- **`ask_user`** — Pause and wait for user input. The orchestration dehydrates and blocks
  until the user responds via the event queue.

You never define these — they're part of the runtime.

### Registering Tools on the Worker

```typescript
import { PilotSwarmWorker } from "@affandar/pilotswarm";

const worker = new PilotSwarmWorker({
  store: process.env.DATABASE_URL,
  githubToken: process.env.GITHUB_TOKEN,
});

worker.registerTools([deployService, checkHealth, rollback]);
await worker.start();
```

Tools registered here are available to all sessions on this worker. Clients reference
them by name via `toolNames: ["deploy_service"]` at session creation.

---

## 3. Runtime

The runtime is everything the tools and worker need to function — the infrastructure
layer beneath the runtime.

### Required Secrets

A bare-bones app needs exactly two secrets:

| Secret | Purpose |
|--------|---------|
| `DATABASE_URL` | PostgreSQL connection string. Duroxide backend + CMS both use this. |
| `GITHUB_TOKEN` | GitHub Copilot API token for LLM requests. |

Optional for additional features:

| Secret | Purpose |
|--------|---------|
| `AZURE_STORAGE_CONNECTION_STRING` | Blob storage for session dehydration. Without this, sessions are pinned to their worker — if it dies, active sessions are lost. |
| `AZURE_STORAGE_CONTAINER` | Blob container name (default: `copilot-sessions`). |

### Tool Artifacts

If a tool handler calls an external binary, that binary must exist where the worker runs.
The runtime doesn't manage this — it's your deployment concern.

- **Local dev**: Install on your machine (`cargo install`, `brew install kubectl`)
- **Docker/K8s**: Bake into the worker container image
- **Serverless**: Bundle in the deployment package

Rule: **if a tool handler calls it, it must exist at runtime.**

### Database

The runtime auto-creates its schemas on first startup:
- `duroxide` — orchestration state (instances, executions, history)
- `copilot_sessions` — CMS (sessions, session_events)

Your PostgreSQL user needs `CREATE SCHEMA` permission on first run.

### Deployment Topologies

**Local Development** — embedded workers in TUI (default):
```
┌─ Your Machine ──────────────────────────────────┐
│  npx pilotswarm --env .env              │
│  (or: ./run.sh)                                  │
│                                                  │
│    ├─ PilotSwarmWorker × 4 (poll DB)         │
│    └─ PilotSwarmClient (sends messages)      │
│                                                  │
│  .env:                                           │
│    DATABASE_URL=postgresql://...                  │
│    GITHUB_TOKEN=ghu_...                          │
└──────────────────────────────────────────────────┘
         │
         ▼
    PostgreSQL
```

The TUI embeds 4 worker runtimes by default (`WORKERS=4`). For the simplest possible
setup (no TUI), `examples/chat.js` runs one worker + one client in a single process.

**Production** — TUI client-only + AKS workers:
```
┌─ Your Machine (TUI) ─────────────────────────┐
│  npx pilotswarm remote               │
│    --store postgresql://...                   │
│    --namespace my-app                         │
│    └─ PilotSwarmClient                    │
│    Needs: DATABASE_URL                        │
└────────────────┬──────────────────────────────┘
                 │ PostgreSQL
                 ▼
┌─ K8s Pods (Workers) ─────────────────────────┐
│  node examples/worker.js                      │
│  PilotSwarmWorker × N replicas            │
│    Needs: DATABASE_URL, GITHUB_TOKEN          │
│    + tool artifacts + optional blob storage   │
│                                               │
│  plugin/  (baked into Docker image)           │
└───────────────────────────────────────────────┘
         │
         ▼
    PostgreSQL + Azure Blob (optional)
```

Deploy workers via `./scripts/deploy-aks.sh` (resets DB, builds image, pushes to ACR,
rolls out to AKS). The TUI streams worker logs via `kubectl`.

---

## The CMS (Session Catalog)

Every app gets a **CMS** automatically — a PostgreSQL schema (`copilot_sessions`) that
tracks session lifecycle and persists events.

### What It Stores

**`sessions` table** — one row per session:

| Column | Description |
|--------|-------------|
| `session_id` | Primary key |
| `orchestration_id` | Linked duroxide instance |
| `title` | LLM-generated summary |
| `state` | `pending`, `running`, `idle`, `waiting`, `completed`, `failed` |
| `model` | LLM model name |
| `created_at`, `last_active_at` | Timestamps |
| `current_iteration` | Turn counter |
| `last_error` | Last error message |

**`session_events` table** — append-only event log:

| Column | Description |
|--------|-------------|
| `seq` | Auto-incrementing sequence (cursor for polling) |
| `session_id` | Which session |
| `event_type` | `assistant.message`, `user.message`, `tool.execution_start`, `tool.execution_end` |
| `data` | JSONB event payload |
| `created_at` | Timestamp |

### How Events Flow

```
Client                              Worker
  │                                   │
  ├─ session.send(prompt)             │
  │   enqueues to duroxide ──────────►│ orchestration runs
  │                                   ├─ LLM executes turn
  │                                   ├─ recordEvents() → session_events table
  │                                   │
  ├─ session.on("assistant.message")  │
  │   polls session_events (500ms) ◄──┘
  │   uses afterSeq cursor for incremental reads
```

- **Events persist when no client is attached.** Reconnect and catch up from any `seq`.
- **Multiple clients can read the same session.** The CMS is a shared read model.
- **Your app can add its own tables** alongside the CMS schema for app-specific data.

---

## The Orchestration (You Don't Write This)

The orchestration loop is generic and shared across all apps. It handles:

- Message dequeuing (FIFO event queue)
- Session hydration from blob (if dehydrated)
- Turn execution (sends prompt + tools to LLM)
- Result handling: `completed` → idle wait, `wait` → durable timer, `input_required` → dehydrate + wait
- Error retries with exponential backoff
- Session dehydration on idle/wait thresholds
- `continueAsNew` for long-running sessions (prevents history bloat)

You configure it, you don't code it:

| Parameter | Default | Tune for |
|-----------|---------|----------|
| `dehydrateThreshold` | 30s | How long before a `wait()` call triggers dehydration. Set higher for apps with long tool calls. |
| `idleTimeout` | 30s | How long after turn completion before dehydrating. Set higher for slow user response patterns. |
| `inputGracePeriod` | 30s | Grace period after `ask_user` before dehydrating. |

---

## Putting It All Together

The runtime ships a full TUI client as a CLI: `pilotswarm`. You provide a plugin
directory and optionally a worker module with custom tools — the TUI handles everything
else (sessions, events, log streaming, chat rendering).

### The Simplest App: Plugin-Only (No Code)

If you only need agents, skills, and MCP servers — no custom tools — you don't write
any JavaScript at all:

```
my-app/
├── plugin/
│   ├── agents/
│   │   └── deployer.agent.md
│   ├── skills/
│   │   └── kubernetes/SKILL.md
│   ├── .mcp.json
│   └── system.md                    # System message (optional)
├── .env                             # DATABASE_URL + GITHUB_TOKEN
└── package.json
```

```bash
npm install @affandar/pilotswarm
npx pilotswarm --env .env --plugin ./plugin
```

The CLI embeds 4 workers, loads your plugin, and launches the TUI. Done.

### Adding Custom Tools

For apps that need tool handlers (code that runs on the worker), create a worker module:

```javascript
// tools.js — exports tools + config for the TUI to load
import { defineTool } from "@github/copilot-sdk";

const deployService = defineTool("deploy_service", {
  description: "Deploy a service to the specified environment",
  parameters: {
    type: "object",
    properties: {
      service: { type: "string" },
      env: { type: "string", enum: ["staging", "production"] },
    },
    required: ["service", "env"],
  },
  handler: async ({ service, env }) => {
    const result = await exec(`kubectl apply -f manifests/${service}.yaml -n ${env}`);
    return { status: "deployed", output: result.stdout };
  },
});

export default {
  tools: [deployService],
  systemMessage: "You are a release manager for production deployments.",
};
```

```bash
npx pilotswarm --env .env --plugin ./plugin --worker ./tools.js
```

### Production: Separate Worker + Remote TUI

For production, run the worker as its own process (or K8s deployment) and connect
the TUI in client-only mode:

```
my-app/
├── plugin/
│   ├── agents/
│   │   └── deployer.agent.md
│   ├── skills/
│   │   └── kubernetes/SKILL.md
│   └── .mcp.json
├── src/
│   └── tools.js
├── worker.js                        # Standalone worker entry point
├── Dockerfile                       # Bakes plugin + tools into image
└── package.json
```

**Worker** (owns plugins + tools — runs on K8s or a VM):

```javascript
// worker.js
import { PilotSwarmWorker } from "@affandar/pilotswarm";
import { deployService, checkHealth, rollback } from "./src/tools.js";

const worker = new PilotSwarmWorker({
  store: process.env.DATABASE_URL,
  githubToken: process.env.GITHUB_TOKEN,
  blobConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
  pluginDirs: ["./plugin"],
  systemMessage: "You are a release manager for production deployments.",
});

worker.registerTools([deployService, checkHealth, rollback]);
await worker.start();
```

**TUI** (thin client — needs only the database URL):

```bash
npx pilotswarm remote \
  --store postgresql://... \
  --namespace my-app-workers
```

The TUI connects to the same database, streams worker logs via `kubectl logs`,
and renders events. No `GITHUB_TOKEN` needed on the client side.

### Dockerfile (for the worker)

```dockerfile
FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY plugin/ ./plugin/
COPY src/ ./src/
COPY worker.js ./
CMD ["node", "worker.js"]
```

### CLI Reference

```
pilotswarm [local|remote] [flags]

FLAG                     ENV VAR EQUIVALENT
--store <url>            DATABASE_URL
--env <file>             (default: .env / .env.remote)
--plugin <dir>           PLUGIN_DIRS              (default: ./plugin)
--worker <module>        WORKER_MODULE
--workers <n>            WORKERS                  (default: 4)
--model <name>           COPILOT_MODEL
--system <msg|file>      SYSTEM_MESSAGE           (or plugin/system.md)
--namespace <ns>         K8S_NAMESPACE            (default: copilot-runtime)
--label <selector>       K8S_POD_LABEL
--log-level <level>      LOG_LEVEL

All flags can be set via the corresponding env var.
CLI flags take precedence over env vars.
```

## Further Reading

- [Architecture](./architecture.md) — SDK internals: orchestration flow, session lifecycle
- [Configuration](./configuration.md) — All environment variables and options
- [Deploying to AKS](./deploying-to-aks.md) — Production deployment guide
