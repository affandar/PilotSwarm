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
# review/edit the local model catalog (keys stay in env files)
$EDITOR .model_providers.json
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

# Optional — env-only PostgreSQL/runtime scaling knobs
# DUROXIDE_PG_POOL_MAX=10
# PILOTSWARM_CMS_PG_POOL_MAX=3
# PILOTSWARM_FACTS_PG_POOL_MAX=3
# PILOTSWARM_ORCHESTRATION_CONCURRENCY=2
# PILOTSWARM_WORKER_CONCURRENCY=2
```

> **Model providers** are configured in the local `.model_providers.json`, which is usually copied from the checked-in `.model_providers.example.json` template. API keys use `env:VAR_NAME` syntax to reference `.env` variables. Providers whose API key is not set are automatically excluded from the model list.

### Portal Auth Add-Ons

The shipped browser portal supports provider-based auth.

- default: `none`
- built-in optional provider: `entra`

Enable Entra for portal deployments with:

```bash
PORTAL_AUTH_PROVIDER=entra
PORTAL_AUTH_ENTRA_TENANT_ID=<tenant-id>
PORTAL_AUTH_ENTRA_CLIENT_ID=<client-id>
PORTAL_AUTHZ_ADMIN_GROUPS=admin1@contoso.com,admin2@contoso.com
PORTAL_AUTHZ_USER_GROUPS=user1@contoso.com,user2@contoso.com
```

For now, `PORTAL_AUTHZ_ADMIN_GROUPS` and `PORTAL_AUTHZ_USER_GROUPS` are interpreted
as comma-delimited user email allowlists, not Entra group IDs.

For tenants that prefer to drive admission from Entra **app roles** instead of
an email allowlist, see the operator runbook at
[`docs/portal-entra-app-roles.md`](./portal-entra-app-roles.md). The portal
matches the JWT `roles` claim by case-insensitive equality against exactly
two canonical values: `admin` and `user`. There is no override env var —
the setup script creates exactly these two roles, and extra granularity
belongs in new app roles checked explicitly in code.

> **Provisioning the Entra app registration.** PilotSwarm ships
> `deploy/scripts/auth/Setup-PortalAuth.ps1` to create (or append a
> redirect URI to) the Entra application backing the portal. It
> requires a `-ServiceTreeId` (operator-supplied) and supports two
> optional switches that align with the role-driven authz engine:
> `-CreateAppRoles` defines `admin` and `user` app roles on the
> application object (recommended for production stamps), and
> `-AssignmentRequired` flips the service principal to require explicit
> user/group assignment before any token is issued. `-AssignmentRequired`
> is OFF by default — in restricted tenants it can trip an AADSTS90094
> admin-consent prompt; the recommended production lockdown is
> `-CreateAppRoles` plus role assignments in Entra (the role
> assignment **is** the allowlist), with the portal engine's
> deny-by-default behavior. See
> `deploy/scripts/auth/README.md`,
> [`docs/portal-entra-app-roles.md`](./portal-entra-app-roles.md), and
> the `pilotswarm-portal-app-reg` skill for full usage. For
> npm-orchestrator stamps, this is wired into the new-env flow by the
> `pilotswarm-npm-deployer` agent.

Portal branding and sign-in copy come from `plugin.json.portal`, with
`plugin.json.tui` used as a fallback when the portal plugin metadata does not
provide an override. Preferred portal metadata shape is nested under
`portal.branding`, `portal.ui`, and `portal.auth`; browser logo assets can be
supplied with `portal.branding.logoFile` and optional
`portal.branding.faviconFile`.

The provider can also be selected in plugin metadata:

```json
{
  "portal": {
    "auth": {
      "provider": "entra"
    }
  }
}
```

Selection precedence is:

1. `PORTAL_AUTH_PROVIDER`
2. `plugin.json.portal.auth.provider`
3. provider inference from provider-specific env vars
4. `none`

When the resolved provider is `none`, the portal still assigns a stable shared
identity to browser users: `provider=none`, `subject=unknown`, display name
`Unknown User`. All unauthenticated browser users in that no-auth deployment
therefore share the same Admin Console profile, GitHub Copilot key override,
profile settings, and session owner identity.

Current authorization is Phase 1 only:

- group-based allow/deny
- normalized `admin` / `user` role assignment
- no session ownership filtering yet

## PostgreSQL Setup

### PostgreSQL Pool Sizing And Runtime Concurrency

PilotSwarm uses environment variables only for PostgreSQL pool sizing and
Duroxide runtime concurrency.

- `DUROXIDE_PG_POOL_MAX`
  Sets the `duroxide-pg` provider pool size. Default: `10`.
- `PILOTSWARM_CMS_PG_POOL_MAX`
  Sets the session catalog (`pg.Pool`) max size. Default: `3`.
- `PILOTSWARM_FACTS_PG_POOL_MAX`
  Sets the facts store (`pg.Pool`) max size. Default: `3`.
- `PILOTSWARM_ORCHESTRATION_CONCURRENCY`
  Sets Duroxide orchestration concurrency. Default: `2`.
- `PILOTSWARM_WORKER_CONCURRENCY`
  Sets Duroxide activity/worker concurrency. Default: `2`.

Example:

```bash
DUROXIDE_PG_POOL_MAX=10
PILOTSWARM_CMS_PG_POOL_MAX=3
PILOTSWARM_FACTS_PG_POOL_MAX=3
PILOTSWARM_ORCHESTRATION_CONCURRENCY=2
PILOTSWARM_WORKER_CONCURRENCY=2
```

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

  PostgreSQL pool sizing and runtime concurrency are intentionally **not** part of
  `PilotSwarmWorkerOptions`. Configure them with the env vars above.

## Enhanced Facts & Knowledge Graph (optional)

By default the facts store is plain Postgres (`PgFactStore`) — every session gets
the `store_fact` / `read_facts` / `delete_fact` tools. Two **optional, independently
injected** providers extend this without changing the default:

- **EnhancedFactStore** — multi-signal retrieval (lexical + semantic + hybrid) plus
  a durable in-DB embedder, backed by a HorizonDB (preview) cluster with
  `pgvector` + `pg_textsearch` + `pg_durable`. Lights up `facts_search`,
  `facts_similar`, and a per-turn `search_skills` tool.
- **GraphStore** — an open knowledge graph (Apache AGE) for entities/edges with
  fact-`scopeKey` evidence anchors. Lights up the graph read tools
  (`graph_search_nodes` / `graph_search_edges` / `graph_neighbourhood`) plus a
  harvester-only crawl-queue + graph-write surface.

The two axes are orthogonal: enhanced-facts works without a graph, and a graph
works over a base fact store (you get graph tools but no search tools). Graph
tools key off **graph presence alone** (`graphDatabaseUrl` set), never the facts
capability.

```typescript
new PilotSwarmWorker({
    store: process.env.DATABASE_URL,

    // ── EnhancedFactStore (optional) ──
    // Setting enhancedFactsDatabaseUrl alone constructs the enhanced provider
    // (factsProvider inferred "horizon"). Resolution for the facts URL is
    // enhancedFactsDatabaseUrl ?? cmsFactsDatabaseUrl ?? store.
    enhancedFactsDatabaseUrl: process.env.HORIZON_DATABASE_URL,
    factsProvider: "horizon",            // optional; inferred when the URL is set
    enhancedFactsSchema: "horizon_facts", // default: "horizon_facts"
    horizonEmbed: {                       // optional; omit ⇒ lexical-only search
        url: process.env.HORIZON_EMBED_URL,
        model: process.env.HORIZON_EMBED_MODEL,
        dim: Number(process.env.HORIZON_EMBED_DIM),
        apiKey: process.env.HORIZON_EMBED_API_KEY,
    },

    // ── GraphStore (optional, opt-in) ──
    // Unset ⇒ no graph, no graph tools. May reuse the enhanced facts URL.
    graphDatabaseUrl: process.env.HORIZON_GRAPH_DATABASE_URL,
    graphSchema: "horizon_graph",         // default: "horizon_graph"
});
```

> **Schema-collision guard.** Apache AGE creates a Postgres schema named after the
> graph. When `graphDatabaseUrl` is the **same** database as the facts store, the
> `graphSchema` MUST differ from the facts schema — the worker fails fast at start
> if they collide. The defaults (`horizon_facts` vs `horizon_graph`) are already
> distinct.

> **Env shortcut.** The shipped worker entrypoints (the CLI/portal embedded worker
> and the standalone K8s worker) wire all of the above from the canonical
> `HORIZON_*` env vars via the SDK helper `horizonConfigFromEnv()`. Custom apps can
> use the same one-liner — it returns `{}` when `HORIZON_DATABASE_URL` is unset, so
> default deployments are unaffected:
>
> ```typescript
> import { PilotSwarmWorker, horizonConfigFromEnv } from "pilotswarm-sdk";
>
> const worker = new PilotSwarmWorker({
>     store: process.env.DATABASE_URL,
>     githubToken: process.env.GITHUB_TOKEN,
>     ...horizonConfigFromEnv(), // HORIZON_DATABASE_URL / _GRAPH_DATABASE_URL / _EMBED_* / _*_SCHEMA
> });
> ```
>
> See [`.env.example`](../.env.example) for the full list of `HORIZON_*` vars.

The **client** and **management client** must resolve the **same** facts target as
the worker, or session cleanup hits the wrong database. Pass the matching fields:

```typescript
new PilotSwarmClient({
    store: process.env.DATABASE_URL,
    enhancedFactsDatabaseUrl: process.env.HORIZON_DATABASE_URL, // match the worker
    factsProvider: "horizon",
    enhancedFactsSchema: "horizon_facts",
});
```

To run a `harvester: true` ingestion agent continuously as its own service over a
shared HorizonDB, see [Deploying a Knowledge Harvester](./harvester-deployment.md).

### Role-based tool exposure

Which enhanced/graph tools a session sees is the cross product of capability,
graph presence, and **session role** (`agentIdentity`):

| Tool group | Who gets it | Gated on |
|------------|-------------|----------|
| `store_fact` / `read_facts` / `delete_fact` | every session | always |
| `facts_search` / `facts_similar` | every reader (incl. `agent-tuner`) | enhanced + `capabilities.search` |
| `search_skills` | every reader **except `facts-manager`** (it owns the namespace) | enhanced + `capabilities.search` |
| `graph_search_nodes` / `graph_search_edges` / `graph_neighbourhood` | every reader | `graphDatabaseUrl` set |
| `graph_stats` (read-only) | `facts-manager` + `agent-tuner` | `graphDatabaseUrl` set |
| crawl queue + `graph_upsert_*` / `graph_merge_nodes` / `graph_delete_*` | app **harvester role** + `facts-manager` (dormant) | `graphDatabaseUrl` set |

`agent-tuner` is **strictly read-only**: it gets every read tool (including
`graph_stats`) but never a write, delete, crawl, or mutating control tool — even
if a stale config sets the harvester flag. See [Facts Table](./facts-table.md) for
the full capability/role model and the harvester crawl protocol.

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

PilotSwarm uses the local `.model_providers.json` to configure LLM providers. Most setups copy that file from the checked-in `.model_providers.example.json` template first. API keys are stored in `.env` and referenced via `env:VAR_NAME` syntax.

> **Easiest way to get started:** Set `GITHUB_TOKEN` in `.env`. This gives you access to all models available through GitHub Copilot (Claude, GPT-4.1, GPT-5.1, etc.) with no additional configuration needed.

For BYOK (bring-your-own-key) providers like Azure OpenAI, edit the local `.model_providers.json` and set the corresponding API key in `.env`.

BYOK providers whose API key env var is not set are **automatically excluded** from the model list — they won't appear in the TUI model picker or the `list_available_models` tool. This means you only need credentials for the providers you actually use.

The `github-copilot` provider is different: configured GitHub Copilot models remain visible even when the worker-wide `GITHUB_TOKEN` env var is not set, because a user may supply a per-user key from the Admin Console. Creating a session with a GitHub Copilot model requires either the worker env `GITHUB_TOKEN` or the session owner's per-user GitHub Copilot key. Non-GitHub provider models can still be created when no GitHub key is configured.

```bash
# Get a GitHub token (easiest path)
gh auth token
```

The token is only needed on the **worker** side. Clients don't need it.

### Per-User GitHub Copilot Key Override

In addition to the worker-wide `GITHUB_TOKEN`, each user can store their own
GitHub Copilot key in their CMS user profile. When a session runs on a model
served by the `github-copilot` provider, the worker first looks up the
session owner's per-user key and uses it as the GitHub token for that
session's `CopilotClient`. If the user has not configured a key (or the
session has no resolvable owner), the worker falls back to the env-supplied
`GITHUB_TOKEN`. If neither is available, creating a session with a
`github-copilot:*` model fails with a clear configuration error; other
configured providers are unaffected.

Users manage their key from the **Admin Console**:

- Native TUI: press `Shift+A` to open the console, then `e` to set or
  replace the key, `c` to clear it, `r` to refresh, `Esc` to close.
- Portal: click the `Admin` button in the toolbar, then use the inline
  form to set, clear, or refresh.

The raw key is never exposed through the public profile API — both the
management client (`getUserProfile`) and the shared UI selector
(`selectAdminConsole`) only carry a `githubCopilotKeySet` boolean. The
key text is read internally only by the worker's per-session token
resolver.

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
