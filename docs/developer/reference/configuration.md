# Configuration Guide

> **New here?** See the [Getting Started](../../quickstart/local.md) guide for a full walkthrough from zero to running.

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

Then edit `.env` with the database and optional compatibility credentials:

```bash
# Required
DATABASE_URL=postgresql://user:password@localhost:5432/pilotswarm

# Optional legacy bootstrap keys. New deployments add runtime providers in
# Admin Console → Model Providers or through PilotSwarmManagementClient.
# GITHUB_TOKEN=github_pat_xxxxxxxxxxxx
# AZURE_OAI_KEY=your-key

# Optional — session dehydration to blob storage
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...
AZURE_STORAGE_CONTAINER=copilot-sessions

# Optional — env-only PostgreSQL/runtime scaling knobs
# DUROXIDE_PG_POOL_MAX=10
# PILOTSWARM_CMS_PG_POOL_MAX=3
# PILOTSWARM_FACTS_PG_POOL_MAX=3
# PILOTSWARM_ORCHESTRATION_CONCURRENCY=2
# PILOTSWARM_WORKER_CONCURRENCY=2
# PILOTSWARM_TURN_TIMEOUT_MS=1200000
```

> **Provider types and models** are declared in `.model_providers.json`, usually
> copied from the checked-in type-only `.model_providers.example.json`. Runtime
> provider instances carry credentials and are created in **Admin Console →
> Model Providers** or through `PilotSwarmManagementClient.createProvider()` /
> `createMyProvider()`. `setModelDefault()` controls future ordinary sessions;
> `setSystemModelDefault()` independently controls system machinery. With no
> configured default, PilotSwarm deterministically selects the first model of
> the first eligible runtime provider and stamps that exact `provider:model`
> before orchestration starts.

Credential references and `defaultModel` in a catalog remain supported only as
a one-time legacy bootstrap path. New catalogs should contain neither.

### Portal Auth Add-Ons

The shipped browser portal supports provider-based auth.

- default: `none`
- built-in optional providers: `entra`, `proxy`

Enable Entra for portal deployments with:

```bash
PORTAL_AUTH_PROVIDER=entra
PORTAL_AUTH_ENTRA_TENANT_ID=<tenant-id>
PORTAL_AUTH_ENTRA_CLIENT_ID=<client-id>
PORTAL_AUTHZ_ADMIN_GROUPS=admin1@contoso.com,admin2@contoso.com
PORTAL_AUTHZ_USER_GROUPS=user1@contoso.com,user2@contoso.com

# Per-user session ownership and sharing posture
AUTHZ_ENFORCE_OWNERSHIP=true
SESSIONS_DEFAULT_VISIBILITY=private
SESSIONS_SYSTEM_VISIBILITY=read
```

For now, `PORTAL_AUTHZ_ADMIN_GROUPS` and `PORTAL_AUTHZ_USER_GROUPS` are interpreted
as comma-delimited user email allowlists, not Entra group IDs.

For tenants that prefer to drive admission from Entra **app roles** instead of
an email allowlist, see the operator runbook at
[`docs/portal-entra-app-roles.md`](../deploy/entra-app-roles.md). The portal
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
> [`docs/portal-entra-app-roles.md`](../deploy/entra-app-roles.md), and
> the `pilotswarm-portal-app-reg` skill for full usage. For
> npm-orchestrator stamps, this is wired into the new-env flow by the
> `pilotswarm-npm-deployer` agent.

For deployments already protected by an identity-aware reverse proxy, use the
request-authenticated `proxy` provider. The default `jwt` mode verifies the
proxy's signed assertion, including issuer and audience:

```bash
PORTAL_AUTH_PROVIDER=proxy
PORTAL_AUTH_PROXY_MODE=jwt
PORTAL_AUTH_PROXY_JWKS_URL=https://access.example.com/cdn-cgi/access/certs
PORTAL_AUTH_PROXY_ISSUER=https://access.example.com
PORTAL_AUTH_PROXY_AUDIENCE=<application-audience>
# Optional; defaults to Cloudflare Access's assertion header.
# PORTAL_AUTH_PROXY_JWT_HEADER=cf-access-jwt-assertion
```

Claim names are configurable with `PORTAL_AUTH_PROXY_SUBJECT_CLAIM`,
`PORTAL_AUTH_PROXY_EMAIL_CLAIM`, `PORTAL_AUTH_PROXY_NAME_CLAIM`,
`PORTAL_AUTH_PROXY_ROLES_CLAIM`, and `PORTAL_AUTH_PROXY_GROUPS_CLAIM`.
Authorization still flows through the ordinary `PORTAL_AUTHZ_*` policy.

Unsigned header mode is only safe when the portal origin cannot be reached
except through the trusted proxy. It deliberately refuses startup without the
explicit acknowledgement:

```bash
PORTAL_AUTH_PROVIDER=proxy
PORTAL_AUTH_PROXY_MODE=header
PORTAL_AUTH_PROXY_TRUST_HEADERS=true
# Defaults: x-forwarded-user, x-forwarded-email,
# x-forwarded-preferred-username, x-forwarded-groups
```

Override those names with `PORTAL_AUTH_PROXY_SUBJECT_HEADER`,
`PORTAL_AUTH_PROXY_EMAIL_HEADER`, `PORTAL_AUTH_PROXY_NAME_HEADER`, and
`PORTAL_AUTH_PROXY_GROUPS_HEADER`. The proxy completes sign-in before the SPA
loads, so this provider has no browser-side PKCE flow or token cache.

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

When `AUTHZ_ENFORCE_OWNERSHIP=true`, every session request is checked against
the authenticated principal's owner/share relationship. `private` sessions are
owner/admin only; `shared_read` and targeted read grants allow reads;
`shared_write` and targeted write grants allow reads and messages. Manage,
destroy, and share operations remain owner/admin only. Set
`SESSIONS_SYSTEM_VISIBILITY=admin` to hide system sessions from ordinary users.

`SESSIONS_DEFAULT_VISIBILITY` applies only to newly-created sessions. Migration
`0029` stamps existing sessions as `private`; before enabling enforcement on an
existing collaborative deployment, explicitly share the sessions that should
remain visible or keep enforcement disabled during the transition. See
[Access, sharing & security](../../user-guide/security-and-sharing.md).

## PostgreSQL Setup

### Worker Runtime Tuning

PilotSwarm deployments use environment variables for PostgreSQL pool sizing,
Duroxide runtime concurrency, and process-wide worker limits.

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
- `PILOTSWARM_TURN_TIMEOUT_MS`
  Sets the wall-clock cap for one Copilot turn across the worker deployment.
  Default: `1200000` (20 minutes). Set `0` to disable the cap. An explicit
  `PilotSwarmWorker({ turnTimeoutMs })` option takes precedence over the env var.

Example:

```bash
DUROXIDE_PG_POOL_MAX=10
PILOTSWARM_CMS_PG_POOL_MAX=3
PILOTSWARM_FACTS_PG_POOL_MAX=3
PILOTSWARM_ORCHESTRATION_CONCURRENCY=2
PILOTSWARM_WORKER_CONCURRENCY=2
PILOTSWARM_TURN_TIMEOUT_MS=1200000
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

> **Note:** the direct `{ store }` client construction shown here is appropriate only because client and worker are co-located in one trusted process. It is internal (worker/portal-host embedding and testing). Standalone client apps should use web mode — `new PilotSwarmClient({ apiUrl })` — as shown below.

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

Client apps connect over the deployment's Web API (hosted by the portal server) — no database or storage credentials needed:

```javascript
// app.js
import { PilotSwarmClient } from "pilotswarm-sdk";

const client = new PilotSwarmClient({
    apiUrl: "https://portal.example.com",  // your deployment's portal URL
    // getAccessToken: async () => token,  // for auth-protected deployments
});
await client.start();

const session = await client.createSession();
await session.send("Monitor the API every 10 minutes");

// Client can exit — the worker will continue processing
console.log(`Session ${session.sessionId} is running on the worker`);
```

The client talks to the portal's [Web API](../../api/reference.md); the portal enqueues work into PostgreSQL, and workers poll and execute. Direct `{ store }` client construction (connecting straight to the database) still exists but is internal — for worker/portal-host embedding and internal testing only.

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
    turnTimeoutMs: 1_200_000, // explicit override; 0 disables the cap

    // Blob storage for session dehydration
    blobConnectionString: string,   // Azure Storage connection string
    blobContainer: string,          // container name (default: "copilot-sessions")

    // Schema isolation (for multi-tenant on same database)
    duroxideSchema: "ps_duroxide",      // orchestration schema (default: "ps_duroxide")
    cmsSchema: "copilot_sessions",       // session catalog schema (default: "copilot_sessions")
});
```

  PostgreSQL pool sizing and Duroxide concurrency are intentionally **not** part
  of `PilotSwarmWorkerOptions`; configure them with the env vars above. Turn
  timeout supports both layers: the explicit constructor option wins, then
  `PILOTSWARM_TURN_TIMEOUT_MS`, then the 20-minute SDK default.

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
    graphSchema: "horizon_graph",         // AGE graph name; default: "horizon_graph"
    graphRegistrySchema: "horizon_graph_registry", // sidecar schema; default: `${graphSchema}_registry`
    graphNamespaceCacheTtlMs: 60000,       // namespace-list cache; 0 disables
});
```

> **Schema-collision guard.** Apache AGE creates a Postgres schema named after the
> graph. When `graphDatabaseUrl` is the **same** database as the facts store, the
> `graphSchema` MUST differ from the facts schema — the worker fails fast at start
> if they collide. The defaults (`horizon_facts` vs `horizon_graph`) are already
  > distinct. The graph namespace registry is a separate relational sidecar schema
  > (`graphRegistrySchema` / `HORIZON_GRAPH_REGISTRY_SCHEMA`) and must also differ
  > from the AGE graph name. By default it is `${graphSchema}_registry`.

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
> See [`.env.horizondb.example`](../../../.env.horizondb.example) for the full list of `HORIZON_*` vars.

**Direct-mode (internal) clients** and management clients embedded next to the
worker must resolve the **same** facts target as the worker, or session cleanup
hits the wrong database. Pass the matching fields (web-mode `{ apiUrl }` clients
need none of this — the portal host resolves it server-side):

```typescript
new PilotSwarmClient({
    store: process.env.DATABASE_URL,
    enhancedFactsDatabaseUrl: process.env.HORIZON_DATABASE_URL, // match the worker
    factsProvider: "horizon",
    enhancedFactsSchema: "horizon_facts",
});
```

To run a `crawler: true` ingestion agent continuously as its own service over a
shared HorizonDB, see [Deploying a Knowledge Harvester](../deploy/harvester.md).

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
| crawl queue + `graph_remove_evidence` + namespace archive | app **crawler role** + `facts-manager` (dormant) | `graphDatabaseUrl` set |
| `graph_upsert_*` / `graph_merge_nodes` / `graph_delete_*` | every non-tuner session | `graphDatabaseUrl` set |

`agent-tuner` is **strictly read-only**: it gets every read tool (including
`graph_stats`) but never a write, delete, crawl, or mutating control tool — even
if a stale config sets the crawler/legacy harvester flag. See [Facts Table](../../architecture/facts.md) for
the full capability/role model and the crawler crawl protocol.

## Client Options

### Web Mode (supported)

Client applications connect to a deployment's [Web API](../../api/reference.md)
(hosted by the portal server) and need no database or storage credentials:

```typescript
new PilotSwarmClient({
    // Required
    apiUrl: "https://portal.example.com",  // portal Web API base URL

    // Optional
    getAccessToken: async () => token,     // bearer-token supplier for authenticated deployments
});
```

`PilotSwarmManagementClient` accepts the same options. Session handles keep the
same programming model (`send` / `wait` / `sendAndWait` / `on` / `getMessages` /
`getInfo` / `destroy`); model-listing methods are async in web mode, so always
`await` them.

### Direct Mode (internal)

Direct `{ store }` construction connects straight to PostgreSQL. It is internal —
for worker/portal-host embedding and internal testing only, not for client apps:

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
    duroxideSchema: "ps_duroxide",      // default: "ps_duroxide"
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

The model catalog describes provider types, models, and capabilities. Runtime
provider instances hold credentials and are created through management APIs or
**Admin Console → Model Providers**. New configuration should not put runtime
credentials or session defaults in the static catalog; credential-bearing
catalog entries are accepted only as a legacy bootstrap source during the
transition.

For a personal GitHub Copilot credential, open the Admin Console and choose
**Add GitHub Copilot provider**. The provider is private to its
owner. An administrator may separately allow system sessions to use their own
personal provider, but that machinery grant never makes it available to other
users. Administrators can also create shared providers for ordinary cluster
use.

When a personal provider credential expires, use **Update Key** on that
provider instead of deleting or replacing it. The update changes only the
write-only credential; the provider identity, defaults, routing references,
and usage ledger remain unchanged.

The same page owns independent routing settings:

- **My Session Default**: shared providers plus the current user's own.
- **Cluster Session Default**: shared providers only; administrator-managed.
- **System Session Default**: shared providers plus the current administrator's
  system-enabled personal providers.
- **System Agent Overrides**: persistent per-agent choices; changing one uses a
  durable model switch, while restart remains a separate session action.

Changing ordinary defaults affects future sessions only. Changing the system
default can optionally Complete, Terminate, or Hard Delete & Restart existing
inheriting system sessions; per-agent overrides are excluded.

```bash
# Get a GitHub token (easiest path)
gh auth token
```

Credentials are write-only: provider reads, defaults reads, logs, and selector
view models never return them. Browser and terminal password drafts are cleared
on save and cancel; the native UI also removes its draft before awaiting the
provider create or credential-update request.

### Providers With No Key: Workload Identity Federation

A provider type declared `anthropic-wif` stores no credential. The worker
authenticates as itself using Workload Identity Federation, exchanging an
identity token its own platform issues for a short-lived Anthropic access
token. Nothing is stored in the database, so there is no key to rotate and
none to leak.

Declare the type in the model catalog with no `apiKey`:

```json
{
  "id": "anthropic-wif",
  "type": "anthropic-wif",
  "baseUrl": "https://api.anthropic.com",
  "models": [{ "name": "claude-opus-5" }]
}
```

In **Admin Console → Model Providers** the type appears in the Add provider
list like any other. It asks for no key: where the API key field would be, it
says *Use the Workload Identity configured in the worker*. **Update Key** is
not offered on such a provider, and the server refuses a key update on one —
there is no stored key to replace, so what changes instead is the worker's own
identity configuration.

Such a provider is always **shared**, and a personal one is refused. A personal
provider exists to run on its owner's own credentials; this type has none and
runs on the worker's, which belongs to the organization. A personal one would
spend the cluster's own account under a name no administrator can cap, hold or
delete, because a personal provider answers only to its owner.

The worker reads that configuration from its environment. These name the
federation rule, the organization, and the service account the minted token
acts as:

| Variable | Meaning |
|---|---|
| `ANTHROPIC_FEDERATION_RULE_ID` | The federation rule to evaluate (`fdrl_…`) |
| `ANTHROPIC_ORGANIZATION_ID` | The Anthropic organization (UUID) |
| `ANTHROPIC_SERVICE_ACCOUNT_ID` | The service account the token acts as (`svac_…`) |
| `ANTHROPIC_WORKSPACE_ID` | Required only when the rule spans several workspaces |

The identity token itself comes from whichever of these the platform provides,
in this order:

1. `ANTHROPIC_IDENTITY_TOKEN` — the JWT itself.
2. `ANTHROPIC_IDENTITY_TOKEN_FILE` — a file holding it, re-read on every
   exchange so a token that rotates on disk is always current.
3. `AZURE_FEDERATED_TOKEN_FILE` with `AZURE_TENANT_ID` — a Kubernetes-projected
   token, which Microsoft Entra ID does not accept as an assertion for anyone
   but itself. The worker redeems it at Entra first and presents the result.
   The identity claimed defaults to the injected `AZURE_CLIENT_ID`, and the
   audience to that identity's own id; override either with
   `ANTHROPIC_WIF_AZURE_CLIENT_ID` or `ANTHROPIC_WIF_AZURE_SCOPE` when the rule
   names a different identity or a separate audience registration.

A token is cached until shortly before it expires and minted once per worker
however many sessions are running, because the callback that supplies it is
invoked before every outbound request. No token is trusted for more than an
hour however long it claims to be valid: nothing tells a worker that a
credential was revoked, and the only symptom would be requests failing until
the token aged out on its own. A worker missing any required variable says
which one at session creation, rather than failing the first turn with an
authentication error.

The exchange itself goes to `https://api.anthropic.com` unless
`ANTHROPIC_WIF_TOKEN_URL` (or, failing that, `ANTHROPIC_BASE_URL`) says
otherwise. The assertion posted there is a signed identity token, so a
deployment that repoints `ANTHROPIC_BASE_URL` at a gateway for unrelated
reasons should pin the exchange back with `ANTHROPIC_WIF_TOKEN_URL`.

### Legacy Per-User GitHub Copilot Key

The profile-key management APIs remain during the migration window for rollback
and adoption tooling. They are not the current Admin Console experience and new
deployments should create personal runtime providers instead. A deployment may
still consume `GITHUB_TOKEN` or legacy key material through its compatibility
bootstrap path, but it should translate that material into provider/default
desired state rather than maintain a second long-lived configuration source.

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript |
| `npm run dev` | Watch mode compilation |
| `npm test` | Run test suite |
| `npm run chat` | Interactive chat (single-process) |
| `npm run tui` | Full TUI with embedded workers |
| `npm run tui:remote` | TUI client-only against a remote deployment (`.env.remote` carries `PILOTSWARM_API_URL`) |
| `npm run worker` | Headless worker process |
| `npm run db:reset` | Reset database schemas |
