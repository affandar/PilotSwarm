# Building Apps on durable-copilot-sdk

This is a proposal to standardize the five building blocks of any app built on the
durable-copilot-sdk: **Skills**, **Agents**, **Tools**, **MCP Servers**, and **Runtime**. This doc covers
the raw SDK — no UI framework, no TUI. Just the durable LLM runtime and how to configure it.

For the off-the-shelf TUI framework, see [tui-apps.md](./tui-apps.md).

## The Five Building Blocks

Every app built on the durable-copilot-sdk is composed of five layers:

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                   │
│  Skills (packaging)                                               │
│    Reusable knowledge + tool bundles loaded from disk             │
│    ↓                                                              │
│  Agents (composition)                                             │
│    Named sub-personas assembled from one or more skills           │
│    ↓                                                              │
│  Tools (execution)                                                │
│    LLM-callable functions with handlers that do real work         │
│    ↓                                                              │
│  MCP Servers (integration)                                        │
│    Optional external tool providers over stdio/http               │
│    for isolation, governance, and shared integrations             │
│    ↓                                                              │
│  Runtime (infrastructure)                                         │
│    Worker process, database, secrets, binaries — where it all     │
│    runs and what the tool handlers need to function                │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

| Layer | What | Where | Owned by |
|-------|------|-------|----------|
| **Skills** | Prompt section + tool manifest | Files on disk (`skills/<name>/`) | App developer or shared packages |
| **Agents** | Name + description + composed skills + tool filter | Session config | App developer |
| **Tools** | Name + description + parameters + handler function | Worker code (local handlers) | App developer |
| **MCP Servers** | External tool providers (stdio/http) + tool allowlist | Session/service config | Platform + app developer |
| **Runtime** | Worker process + DB + secrets + artifacts | Deployment target (local, K8s, etc.) | Operations |

---

## 1. Tools

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

You never define these — they're part of the SDK.

### Registering Tools on the Worker

```typescript
import { DurableCopilotWorker } from "durable-copilot-sdk";

const worker = new DurableCopilotWorker({
  store: process.env.DATABASE_URL,
  githubToken: process.env.GITHUB_TOKEN,
});

worker.registerTools([deployService, checkHealth, rollback]);
await worker.start();
```

Tools registered here are available to all sessions on this worker. Clients reference
them by name via `toolNames: ["deploy_service"]` at session creation.

---

## 2. Skills

Skills are a **packaging layer** — a reusable bundle of domain knowledge (prompt),
tool manifest, and optional scripts. They follow the Copilot ecosystem convention:
each skill is a directory containing a `SKILL.md` file with YAML frontmatter.

### Skill Directory Structure

```
skills/
  build/
    SKILL.md               ← Required: frontmatter (name, description) + domain knowledge
    tools.json             ← Optional: tool names this skill provides
    scripts/               ← Optional: scripts the skill's tools may invoke
      build-rust.sh
      build-node.sh
  deploy/
    SKILL.md
    tools.json
    scripts/
      apply-manifests.sh
  observe/
    SKILL.md
    tools.json
```

### SKILL.md Format

The standard Copilot skill file — YAML frontmatter followed by markdown body:

```markdown
---
name: build
description: Building duroxide and SDKs from source. Use when compiling Rust crates, Node native addons, or packaging container images.
---

# Build Tools

You can build Rust projects from source using the build tools.

## Key Knowledge

- Build order: core crate → providers → SDKs → container image
- Rust builds use `cargo build --release`
- Node native addons use napi-rs (requires Rust toolchain + Node headers)
- Always stream build output to blob storage via `upload_log`
- Builds take 5-15 minutes — use `wait` with appropriate intervals to poll

## Common Patterns

When building from a git ref:
1. Clone the repo
2. Checkout the ref
3. Run the build script: `scripts/build-rust.sh`
4. Upload logs to blob storage
```

The `name` and `description` in the frontmatter are used for:
- **Matching**: The TUI or agent framework can select skills by name
- **Display**: Show skill descriptions in help output or dashboards
- **Filtering**: `disabledSkills: ["chaos"]` to disable a skill by name

### tools.json (Optional)

Declares which tool names belong to this skill:

```json
{
  "tools": ["smelt_build_duroxide", "smelt_build_stress_worker", "smelt_upload_log"]
}
```

If omitted, the skill is knowledge-only (prompt injection, no tool association).

### scripts/ (Optional)

Scripts that the skill's tool handlers invoke at runtime. These are baked into the
worker image alongside the skill directory. Tool handlers reference them by path:

```typescript
const buildDuroxide = defineTool("smelt_build_duroxide", {
  description: "Build duroxide from source",
  parameters: { /* ... */ },
  handler: async (args) => {
    // Script lives in the skill directory, baked into the image
    const result = await exec(`./skills/build/scripts/build-rust.sh ${args.ref}`);
    return { output: result.stdout, exitCode: result.exitCode };
  },
});
```

Scripts keep tool handlers thin — the handler is glue code, the script has the real logic.
This also makes scripts testable independently of the LLM.

### Loading Skills

```typescript
import { loadSkills } from "durable-copilot-sdk";

// Load all skill directories — reads SKILL.md frontmatter + body, tools.json
const skills = await loadSkills("./skills");
// Returns: [{ name: "build", description: "...", prompt: "...", toolNames: [...] }, ...]

// Compose into a system message
const systemMessage = basePrompt + "\n\n" + skills.map(s => s.prompt).join("\n\n");

// Get all tool names across all skills
const allToolNames = skills.flatMap(s => s.toolNames);
```

### Compatibility with Copilot Ecosystem

The `SKILL.md` format is the same used by GitHub Copilot (`.agents/skills/` and
`.github/skills/`). Skills written for the durable-copilot-sdk can be used by Copilot
and vice versa — the markdown body is injected into the LLM context the same way.

The additions (`tools.json`, `scripts/`) are optional extensions that the durable SDK
uses but Copilot ignores.

### Why Skills Exist

Without skills, you hard-code knowledge into the system prompt and duplicate it
across agents. Skills solve:

- **Reuse across agents**: The `observe` skill (metrics, logs) is used by both the
  tester and chaos agents.
- **Reuse across apps**: Share a `kubectl` skill between Smelter and a deploy bot.
- **Deployment as artifact**: Drop a skill folder into the image — no code changes.
- **Community skills**: Publish a skill as an npm package or git repo.

---

## 3. Agents

Agents are **named sub-personas** composed from one or more skills. Each agent has a
focused system prompt and a filtered tool set. The orchestrator LLM delegates to the
right agent based on the task.

Agents are configured by your app service/worker control plane. Thin clients should
attach to preconfigured sessions, not compose agents directly.

### Defining Agents

```typescript
const session = await serviceClient.createSession({
  systemMessage: `You are a test coordinator. Delegate to specialized agents:
    @builder for building, @deployer for deployment, @tester for running tests.`,

  customAgents: [
    {
      name: "builder",
      description: "Builds projects from source and packages container images",
      // Prompt composed from skills
      prompt: skills.filter(s => ["build", "docker"].includes(s.name))
                     .map(s => s.prompt).join("\n\n"),
      // Tools filtered to just this agent's skill set
      tools: skills.filter(s => ["build", "docker"].includes(s.name))
                    .flatMap(s => s.toolNames),
    },
    {
      name: "deployer",
      description: "Deploys and manages infrastructure on Kubernetes",
      prompt: skills.find(s => s.name === "deploy").prompt,
      tools: skills.find(s => s.name === "deploy").toolNames,
    },
    {
      name: "tester",
      description: "Runs test scenarios and analyzes results",
      prompt: skills.filter(s => ["test", "observe"].includes(s.name))
                     .map(s => s.prompt).join("\n\n"),
      tools: skills.filter(s => ["test", "observe"].includes(s.name))
                    .flatMap(s => s.toolNames),
    },
  ],
});
```

### How Agents and Skills Relate

```
Skills (on disk):              Agents (runtime):

  build/   ──────────────────► @builder
  docker/  ──────────────────►   (build + docker skills)

  deploy/  ──────────────────► @deployer
                                  (deploy skill)

  test/    ──────────────────► @tester
  observe/ ──────────┬───────►   (test + observe skills)
                     │
  chaos/   ──────────┤────────► @chaos
                     └────────►   (chaos + observe skills)
```

- Skills are **many-to-many** with agents — one skill can serve multiple agents
- Agents are **focused** — each has just the knowledge and tools it needs
- The orchestrator's system prompt stays small — it only knows about delegation

### When to Use Agents vs Flat Tools

| Scenario | Approach |
|----------|----------|
| Simple app, < 5 tools | Flat tools — no agents needed |
| Medium app, 5-10 tools | Skills for organization, single agent or flat |
| Complex app, 10+ tools with distinct phases | Skills + agents — decompose into specialists |

---

## 4. MCP Servers

MCP servers are the integration boundary for external tools and systems. Use them when
you need shared integrations, stronger isolation, or central policy control.

Like skills and agents, MCP server config belongs on the service/worker side, not in thin clients.

### Defining MCP server config (service/worker side)

```typescript
const session = await serviceClient.createSession({
  model: "claude-sonnet-4",
  systemMessage: "You are a release manager. Delegate to @deployer.",
  customAgents: agents,
  toolNames: ["deploy_service", "check_health", "query_metrics"],

  // Proposal: passed through to Copilot session config
  mcpServers: {
    kubernetes: {
      command: "node",
      args: ["./mcp/k8s-server.js"],
      tools: ["kubectl_get", "kubectl_apply", "kubectl_logs"],
      env: { KUBECONFIG: "/var/run/secrets/kubeconfig" },
    },
    observability: {
      type: "http",
      url: "https://mcp-observe.internal.example.com",
      tools: ["query_metrics", "query_logs"],
      headers: { Authorization: `Bearer ${process.env.OBS_MCP_TOKEN}` },
    },
  },
});
```

### When to use MCP servers

| Scenario | Recommendation |
|----------|----------------|
| App-specific local logic | Keep as in-process worker tools |
| Shared integrations across many apps | Expose via MCP server |
| Strong isolation/audit requirements | Prefer MCP boundary |

---

## 5. Runtime

The runtime is everything the tools and worker need to function — the infrastructure
layer beneath the SDK.

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
The SDK doesn't manage this — it's your deployment concern.

- **Local dev**: Install on your machine (`cargo install`, `brew install kubectl`)
- **Docker/K8s**: Bake into the worker container image
- **Serverless**: Bundle in the deployment package

Rule: **if a tool handler calls it, it must exist at runtime.**

### Database

The SDK auto-creates its schemas on first startup:
- `duroxide` — orchestration state (instances, executions, history)
- `copilot_sessions` — CMS (sessions, session_events)

Your PostgreSQL user needs `CREATE SCHEMA` permission on first run.

### Deployment Topologies

**Single Process** — simplest, for development:
```
┌─ Your Machine ──────────────────────────────────┐
│  node app.js                                     │
│    ├─ DurableCopilotWorker (polls DB)            │
│    └─ DurableCopilotClient (sends messages)      │
│                                                  │
│  .env:                                           │
│    DATABASE_URL=postgresql://...                  │
│    GITHUB_TOKEN=ghu_...                          │
└──────────────────────────────────────────────────┘
         │
         ▼
    PostgreSQL
```

**Separated Client/Worker** — for production:
```
┌─ Client (user's machine or API server) ──────┐
│  DurableCopilotClient                         │
│    Needs: DATABASE_URL                        │
└────────────────┬──────────────────────────────┘
                 │ PostgreSQL
                 ▼
┌─ Worker (K8s pod, VM, etc.) ─────────────────┐
│  DurableCopilotWorker + registered tools      │
│    Needs: DATABASE_URL, GITHUB_TOKEN          │
│    + tool artifacts + optional blob storage   │
│                                               │
│  skills/  (on disk, baked into image)         │
└───────────────────────────────────────────────┘
         │
         ▼
    PostgreSQL + Azure Blob (optional)
```

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

A complete app split into service/worker configuration and a thin client:

```typescript
// service.js — service/worker side (owns skills, agents, MCP, tools)
import { DurableCopilotWorker, DurableCopilotClient, loadSkills } from "durable-copilot-sdk";
import { deployService, checkHealth, rollback, buildProject } from "./tools.js";
import { composeAgents } from "./agents.js";

const worker = new DurableCopilotWorker({
  store: process.env.DATABASE_URL,
  githubToken: process.env.GITHUB_TOKEN,
  blobConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
});

// Register all tools (handlers execute here on the worker)
worker.registerTools([deployService, checkHealth, rollback, buildProject]);
await worker.start();

const serviceClient = new DurableCopilotClient({
  store: process.env.DATABASE_URL,
  blobEnabled: true,
  dehydrateThreshold: 300,
});
await serviceClient.start();

// Service-side only: load skills and compose agents
const skills = await loadSkills("./skills");
const agents = composeAgents(skills);

export async function createManagedSession(): Promise<string> {
  const session = await serviceClient.createSession({
    model: "claude-sonnet-4",
    systemMessage: "You are a release manager. Delegate to @builder and @deployer.",
    customAgents: agents, // service-side config
    toolNames: [...new Set(agents.flatMap(a => a.tools))],
    mcpServers: {
      observability: {
        type: "http",
        url: "https://mcp-observe.internal.example.com",
        tools: ["query_metrics", "query_logs"],
      },
    },
  });
  return session.sessionId;
}
```

```typescript
// client.js — thin client (does not load skills/agents/MCP config)
import { DurableCopilotClient } from "durable-copilot-sdk";

const client = new DurableCopilotClient({
  store: process.env.DATABASE_URL,
  blobEnabled: true,
});
await client.start();

// Session is created by the service with full server-side config
const sessionId = await fetch("https://app.example.com/sessions", { method: "POST" })
  .then(r => r.text());
const session = await client.resumeSession(sessionId);

// Use the session:

await session.send("Build and deploy auth-service to staging");
session.on("assistant.message", (evt) => console.log(evt.data?.content));

const result = await session.sendAndWait("Deploy auth-service to staging");
console.log(result);

session.on("tool.execution_end", (evt) => console.log(`[tool] ${evt.data?.toolName}`));
```

## Further Reading

- [TUI Apps](./tui-apps.md) — Off-the-shelf terminal UI with the AppAdapter framework
- [Architecture](./architecture.md) — SDK internals: orchestration flow, session lifecycle
- [Configuration](./configuration.md) — All environment variables and options
- [Deploying to AKS](./deploying-to-aks.md) — Production deployment guide
