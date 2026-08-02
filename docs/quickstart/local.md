# Getting Started — From Zero to Running

This guide walks through setting up a fully working PilotSwarm environment
from scratch — the durable execution runtime for GitHub Copilot SDK agents.

If you want the fastest possible first-run path, start with the
[Starter Docker Quickstart](./docker.md) and come
back here when you want the full source-based setup.

By the end you'll have:

- A PostgreSQL database (local or Azure)
- LLM access via model providers (GitHub Copilot, Azure OpenAI, or any OpenAI-compatible endpoint)
- A working `.env` and local `.model_providers.json` copied from `.model_providers.example.json`
- The TUI running with embedded workers (local mode)
- Optionally: AKS workers + Azure Blob Storage for production

---

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Node.js | **≥ 24** | `node --version` |
| npm | ≥ 10 | `npm --version` |
| PostgreSQL | ≥ 14 | `psql --version` |
| GitHub CLI | any | `gh --version` |

Optional (for AKS deployment): see [Deploying to AKS](../developer/deploy/aks.md).

---

## Step 1: Clone and Install

```bash
git clone https://github.com/affandar/pilotswarm.git
cd pilotswarm
npm install
npm run build
```

### Installing the CLI on its own

You do **not** need the repo to use the CLI. To talk to a deployment that
someone else runs — create sessions, manage agent packages, open the TUI —
install the `pilotswarm` package globally:

```bash
npm install -g pilotswarm

pilotswarm --version
pilotswarm auth login --api-url https://<your-portal>
pilotswarm agents list
```

That package provides four binaries: `pilotswarm` (TUI + subcommands),
`pilotswarm-cli` (alias), `pilotswarm-web` (portal server), and
`pilotswarm-mcp` (MCP server).

**Pin the version** when you want repeatable installs rather than the moving
`latest` tag: `npm install -g pilotswarm@0.5.29`.

#### If your network blocks the public npm registry

Corporate-managed devices are often blocked from `registry.npmjs.org` and
routed through an internal mirror, which may also hold newly published
versions for several days. Two fallbacks, in order of preference:

**1. Install through your mirror.** Point npm at it for this install only:

```bash
npm install -g pilotswarm --registry https://<your-npm-mirror>/
```

If the mirror 404s on a recent version, it has not cleared the mirror's
quarantine window yet — install the latest version it does carry:

```bash
npm view pilotswarm versions --registry https://<your-npm-mirror>/ | tail -5
npm install -g pilotswarm@<version-it-has> --registry https://<your-npm-mirror>/
```

**2. Download the tarball and install from the file.** Every npm package is a
plain `.tgz`, so any HTTP client can fetch it and npm can install from disk —
no registry access needed at install time:

```bash
# Resolve the tarball URL (swap in your mirror if npmjs.org is blocked)
npm view pilotswarm dist.tarball
# → https://registry.npmjs.org/pilotswarm/-/pilotswarm-0.5.29.tgz

curl -fL -o pilotswarm.tgz https://registry.npmjs.org/pilotswarm/-/pilotswarm-0.5.29.tgz
npm install -g ./pilotswarm.tgz
```

The URL is predictable — `<registry>/pilotswarm/-/pilotswarm-<version>.tgz` —
so you can construct it by hand for any version, and carry the file to an
air-gapped machine. `npm install -g ./file.tgz` still resolves that package's
**dependencies** from your configured registry; on a fully offline host, use
`npm pack` on a connected machine and copy the whole `node_modules` tree, or
run from a clone as below.

#### Running from a clone (unreleased changes)

A global install gives you the last **published** release. To use changes that
have not shipped yet — including subcommands added since that release — run
the repo's entry point directly:

```bash
node /path/to/pilotswarm/packages/app/tui/bin/tui.js agents list
```

An alias makes this painless:

```bash
alias psw='node /path/to/pilotswarm/packages/app/tui/bin/tui.js'
```

If you have both a global install and a clone, remember the global one wins on
`PATH`. `npm uninstall -g pilotswarm` removes it (and all four binaries).

### Using as a dependency in another project

If you're building your own app on top of the runtime:

```bash
cd your-project

# Published npm package
npm install pilotswarm-sdk

# Option A: file reference (local development)
npm install ../path/to/pilotswarm/packages/sdk

# Option B: npm link (symlink — changes reflected immediately)
cd /path/to/pilotswarm && npm link
cd /path/to/your-project && npm link pilotswarm-sdk
```

Either way, import from `pilotswarm-sdk`:

```typescript
import { PilotSwarmClient, PilotSwarmWorker } from "pilotswarm-sdk";
```

If you want the published terminal UI package as well:

```bash
npm install pilotswarm
```

The latest published release is `0.4.0` for `pilotswarm-sdk`,
`pilotswarm-horizon-store`, and `pilotswarm` (the app package with the TUI, portal, and MCP bins). Pin that version in applications when
you want repeatable installs instead of the moving npm `latest` tag.

Inside this repo, the recommended terminal UI path is
[`run.sh`](../../run.sh) or
[`packages/app/tui/bin/tui.js`](../../packages/app/tui/bin/tui.js).

---

## Step 2: Set Up PostgreSQL

The runtime needs a PostgreSQL database. Both the duroxide runtime and the session
catalog create their schemas **automatically** on first connection — no migrations needed.

### Option A: Local PostgreSQL

```bash
# macOS (Homebrew)
brew install postgresql@16
brew services start postgresql@16

# Create the database
createdb pilotswarm
```

Your connection string:

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pilotswarm
```

### Option B: Azure Database for PostgreSQL (Flexible Server)

```bash
# Create resource group
az group create --name rg-copilot-runtime --location eastus

# Create PostgreSQL server
az postgres flexible-server create \
    --resource-group rg-copilot-runtime \
    --name my-copilot-pg \
    --admin-user copilotadmin \
    --admin-password '<strong-password>' \
    --sku-name Standard_B1ms \
    --tier Burstable \
    --version 16 \
    --public-access 0.0.0.0

# Allow your IP
az postgres flexible-server firewall-rule create \
    --resource-group rg-copilot-runtime \
    --name my-copilot-pg \
    --rule-name allow-me \
    --start-ip-address $(curl -s ifconfig.me) \
    --end-ip-address $(curl -s ifconfig.me)
```

Your connection string:

```
DATABASE_URL=postgresql://copilotadmin:<password>@my-copilot-pg.postgres.database.azure.com:5432/postgres?sslmode=require
```

> The runtime auto-handles Azure SSL (`rejectUnauthorized: false`).

### Verify connectivity

```bash
psql "$DATABASE_URL" -c "SELECT 1"
```

---

## Step 3: Get a GitHub Token

The worker needs a GitHub Copilot token to call the LLM API.

```bash
# Login if not already
gh auth login

# Get your token
gh auth token
```

This prints a `ghu_...` token. The runtime refreshes it automatically via `gh auth token`
in `run.sh`, so you don't need to worry about expiry for local dev.

---

## Step 4: Create Your `.env` File

PilotSwarm uses the local `.model_providers.json` for LLM configuration and `.env` for secrets (API keys, database URL). The repo checks in `.model_providers.example.json` as the template so personal endpoint URLs can stay out of git.

> **Easiest way to get started:** Set `GITHUB_TOKEN` — this gives you access to all models available through GitHub Copilot (Claude, GPT-4.1, etc.) with no additional setup. You can add BYOK providers later.

### For local PostgreSQL

Copy the example files:

```bash
cp .env.example .env
cp .model_providers.example.json .model_providers.json
# review/edit the local model catalog (keys stay in .env / .env.remote)
$EDITOR .model_providers.json
```

Then edit `.env` with your credentials:

```bash
# Required
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pilotswarm

# Option A: GitHub Copilot (easiest — gives access to Claude, GPT, etc.)
GITHUB_TOKEN=ghu_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Option B: Azure OpenAI / BYOK (no GitHub subscription needed)
AZURE_OPENAI_KEY=your-azure-openai-key
# Add more provider keys as needed — see .model_providers.json
```

> **Note:** You only need credentials for the providers you want to use. Providers without valid API keys are automatically hidden from the model picker and agent tools.

### For Azure PostgreSQL

Create `.env.remote`:

```bash
cat > .env.remote << 'EOF'
# Required
DATABASE_URL=postgresql://copilotadmin:<password>@my-copilot-pg.postgres.database.azure.com:5432/pilotswarm?sslmode=require

# LLM provider keys (at least one required)
GITHUB_TOKEN=ghu_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# AZURE_OPENAI_KEY=your-azure-openai-key

# Optional — Azure Blob Storage for session dehydration (multi-node)
# AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...
# AZURE_STORAGE_CONTAINER=copilot-sessions

# Optional — defaults shown
# WORKERS=4
# COPILOT_MODEL=gpt-4.1
# LOG_LEVEL=info
EOF
```

---

## Step 5: Run It

### Quick test (simple CLI chat)

```bash
npm run chat
```

This runs one worker + one client in a single process (via
`packages/sdk/examples/chat.js`). Type a message and get a response.

### TUI (embedded workers, local PG)

```bash
./run.sh local --db
# or
node packages/app/tui/bin/tui.js local --env .env
```

### TUI (embedded workers, remote PG)

```bash
./run.sh local
# or
node packages/app/tui/bin/tui.js local --env .env.remote
```

### TUI (connect to a deployed runtime)

If someone has already deployed PilotSwarm for you (see
[Deploying to AKS](../developer/deploy/aks.md)), you only need one value — the
portal URL. Logs stream over the Web API; no `DATABASE_URL` or `kubectl`
required:

```bash
npx pilotswarm remote --api-url https://portal.example.com
```

Auth is discovered from the deployment: no-auth deployments start
immediately, and Entra-protected deployments open your browser for an interactive sign-in in
the terminal (tokens are cached at `~/.config/pilotswarm/auth/`). You can
also sign in ahead of time:

```bash
npx pilotswarm auth login --api-url https://portal.example.com
```

`PILOTSWARM_API_URL` in the environment (or in `.env.remote`) works instead
of the flag. Direct database access (`pilotswarm remote --store "$DATABASE_URL"`)
still exists, but it's for operators/internal use. See the
[Web API reference](../api/reference.md) for the underlying API.

You should see the TUI with:

- a sessions tree
- chat and activity panes
- an inspector with sequence, logs, node map, and files tabs

Press `n` to create a new session, `p` to focus the prompt, and `Enter` to send.

### What happens on first run

1. The duroxide runtime connects to PostgreSQL and creates the `ps_duroxide` schema
   (orchestration state, execution history, task queues).
2. The CMS creates the `copilot_sessions` schema (session records, titles, event log).
3. The facts store creates the `pilotswarm_facts` schema.
4. Embedded workers start polling for orchestrations.
5. You're ready to chat.

---

## Step 6 (Optional): Production Deployment

For multi-node production deployments — running workers on Kubernetes with a
remote PostgreSQL and Azure Blob Storage for session dehydration — see the
dedicated guide:

→ [Deploying to AKS](../developer/deploy/aks.md)

It covers Azure Blob Storage setup, AKS cluster + ACR provisioning, the
worker deployment manifest, connecting the TUI to the deployment
(`pilotswarm remote --api-url <portal-url>` — the portal URL is the only
value users need), sharing one cluster across multiple teams, scaling,
rolling updates, and troubleshooting.

---

## Database Schemas

Both schemas are created automatically. No manual migration.

| Schema | Created By | Contains |
|--------|-----------|----------|
| `ps_duroxide` | duroxide runtime | Orchestration instances, execution history, task hub queues |
| `copilot_sessions` | CMS (`src/cms.ts`) | Session records, append-only event log |

### Custom Schema Names

By default, the runtime uses `ps_duroxide` and `copilot_sessions` as schema names (the pre-0.2 `duroxide` schema is treated as legacy and auto-migrated). To run
multiple independent deployments on the **same database**, set custom schema names:

```typescript
// Worker
const worker = new PilotSwarmWorker({
    store: process.env.DATABASE_URL,
    duroxideSchema: "team_alpha_duroxide",
    cmsSchema: "team_alpha_sessions",
});

// Direct-mode client (internal/testing) — must match worker's schema names
const client = new PilotSwarmClient({
    store: process.env.DATABASE_URL,
    duroxideSchema: "team_alpha_duroxide",
    cmsSchema: "team_alpha_sessions",
});
```

Each deployment gets its own schemas, fully isolated from others on the same database.

> **Note:** Schema names are a worker/deployment concern. Client apps should
> connect through the deployed portal with `{ apiUrl }` (no schema config
> needed) — direct `{ store }` client construction is for internal embedding
> and testing only. See [Building SDK Apps](../developer/building/sdk-apps.md).

### Reset

To wipe everything and start fresh:

```bash
# Local
node --env-file=.env scripts/db-reset.js --yes

# Remote
node --env-file=.env.remote scripts/db-reset.js --yes
```

This drops both schemas. They'll be recreated on next startup.

---

## `.env` Reference

```bash
# ─── Required ─────────────────────────────────────────────────────
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# ─── LLM Provider Keys (at least one required) ───────────────────
GITHUB_TOKEN=ghu_...                    # GitHub Copilot (easiest to get started)
AZURE_OPENAI_KEY=...                    # Azure OpenAI
AZURE_MODEL_ROUTER_KEY=...              # Azure Model Router
AZURE_FW_GLM5_KEY=...                   # Azure AI Services (GLM-5, etc.)
AZURE_KIMI_K25_KEY=...                  # Azure AI Services (Kimi-K2.5, etc.)
# Only set keys for providers you use. Others are auto-hidden.

# ─── Optional: Blob Storage (multi-node) ──────────────────────────
AZURE_STORAGE_CONNECTION_STRING=...     # enables session dehydration
AZURE_STORAGE_CONTAINER=copilot-sessions

# ─── Optional: Workers ────────────────────────────────────────────
WORKERS=4                               # embedded workers in TUI (0 = client-only)
SYSTEM_MESSAGE="You are a helpful assistant."  # or path to .md file

# ─── Optional: Plugin ─────────────────────────────────────────────
PLUGIN_DIRS=./plugin                    # skills, agents, MCP config

# ─── Optional: Remote access (TUI → deployed portal) ─────────────
PILOTSWARM_API_URL=https://portal.example.com   # same as `pilotswarm remote --api-url`

# ─── Optional: AKS / K8s (direct --store remote mode only) ───────
K8S_NAMESPACE=copilot-runtime               # for kubectl log streaming
K8S_POD_LABEL=app.kubernetes.io/component=worker

# ─── Optional: Debugging ──────────────────────────────────────────
LOG_LEVEL=info                          # none|error|warning|info|debug|all
```

---

## Next Steps

- [Building SDK Apps](../developer/building/sdk-apps.md) — recommended path for custom apps and services
- [Building CLI Apps](../developer/building/cli-apps.md) — recommended path for the shipped TUI
- [Examples](../developer/building/examples.md) — includes the DevOps Command Center layered-app sample
- [Web API Reference](../api/reference.md) — HTTP/WebSocket control plane (`/api/v1`)
- [Configuration](../developer/reference/configuration.md) — all worker/client constructor options
- [Deploying to AKS](../developer/deploy/aks.md) — production deployment details
- [Architecture](../architecture/system.md) — orchestration internals
