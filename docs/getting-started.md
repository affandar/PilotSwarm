# Getting Started — From Zero to Running

This guide walks through setting up a fully working durable-copilot-runtime environment
from scratch — the durable execution runtime for GitHub Copilot SDK agents.

By the end you'll have:

- A PostgreSQL database (local or Azure)
- A GitHub Copilot token
- A working `.env` file
- The TUI running with embedded workers (local mode)
- Optionally: AKS workers + Azure Blob Storage for production

---

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Node.js | **≥ 24** | `node --version` |
| npm | ≥ 10 | `npm --version` |
| GitHub CLI | any | `gh --version` |
| PostgreSQL | ≥ 14 | `psql --version` |

Optional (for AKS deployment):

| Tool | Version | Check |
|------|---------|-------|
| Azure CLI | any | `az --version` |
| kubectl | any | `kubectl version --client` |
| Docker | any | `docker --version` |

---

## Step 1: Clone and Install

```bash
git clone https://github.com/microsoft/durable-copilot-runtime.git
cd durable-copilot-runtime
npm install
npm run build
```

### Using as a dependency in another project

If you're building your own app on top of the runtime:

```bash
cd your-project

# Option A: file reference (local development)
npm install ../path/to/durable-copilot-runtime

# Option B: npm link (symlink — changes reflected immediately)
cd /path/to/durable-copilot-runtime && npm link
cd /path/to/your-project && npm link durable-copilot-runtime
```

Either way, import from `durable-copilot-runtime`:

```typescript
import { DurableCopilotClient, DurableCopilotWorker } from "durable-copilot-runtime";
```

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
createdb durable_copilot
```

Your connection string:

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/durable_copilot
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

### For local PostgreSQL

Create `.env` in the project root:

```bash
cat > .env << 'EOF'
# Required
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/durable_copilot
GITHUB_TOKEN=ghu_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Optional — defaults shown
# WORKERS=4
# COPILOT_MODEL=gpt-4.1
# LOG_LEVEL=info
EOF
```

Replace the `GITHUB_TOKEN` value with your actual token from `gh auth token`.

### For Azure PostgreSQL

Create `.env.remote`:

```bash
cat > .env.remote << 'EOF'
# Required
DATABASE_URL=postgresql://copilotadmin:<password>@my-copilot-pg.postgres.database.azure.com:5432/postgres?sslmode=require
GITHUB_TOKEN=ghu_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

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
node --env-file=.env examples/chat.js
```

This runs one worker + one client in a single process. Type a message and get a response.

### Full TUI (embedded workers, local PG)

```bash
./run.sh local --db
# or
node bin/tui.js local --env .env
```

### Full TUI (embedded workers, Azure PG)

```bash
./run.sh local
# or
node bin/tui.js local --env .env.remote
```

You should see the TUI with a sessions list, chat pane, and worker log panes.
Press `n` to create a new session, type a message, and hit Enter.

### What happens on first run

1. The duroxide runtime connects to PostgreSQL and creates the `duroxide` schema
   (orchestration state, execution history, task queues).
2. The CMS creates the `copilot_sessions` schema (session records, event log).
3. Workers start polling for orchestrations.
4. You're ready to chat.

---

## Step 6 (Optional): AKS Production Setup

For production, run workers on AKS and the TUI as a thin client.

### 6a. Azure Blob Storage

Session dehydration lets sessions move between worker nodes.

```bash
# Create storage account
az storage account create \
    --resource-group rg-copilot-runtime \
    --name mycopilotstorage \
    --sku Standard_LRS

# Create container
az storage container create \
    --account-name mycopilotstorage \
    --name copilot-sessions

# Get connection string
az storage account show-connection-string \
    --resource-group rg-copilot-runtime \
    --name mycopilotstorage \
    --query connectionString -o tsv
```

Add to `.env.remote`:

```bash
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=mycopilotstorage;AccountKey=...
AZURE_STORAGE_CONTAINER=copilot-sessions
```

### 6b. AKS Cluster + ACR

```bash
# Create ACR
az acr create \
    --resource-group rg-copilot-runtime \
    --name mycopilotacr \
    --sku Basic

# Create AKS cluster (attach ACR)
az aks create \
    --resource-group rg-copilot-runtime \
    --name my-copilot-aks \
    --node-count 3 \
    --attach-acr mycopilotacr \
    --generate-ssh-keys

# Get kubectl credentials
az aks get-credentials \
    --resource-group rg-copilot-runtime \
    --name my-copilot-aks
```

### 6c. Deploy Workers

The deploy script handles everything — DB reset, Docker build, ACR push, K8s rollout:

```bash
# Set your ACR name
export ACR_NAME=mycopilotacr

# Deploy (resets DB, builds image, pushes, rolls out)
./scripts/deploy-aks.sh
```

Or step by step:

```bash
# 1. Create namespace + secrets
kubectl apply -f deploy/k8s/namespace.yaml

kubectl create secret generic copilot-runtime-secrets \
    -n copilot-runtime \
    --from-literal=DATABASE_URL="$DATABASE_URL" \
    --from-literal=GITHUB_TOKEN="$(gh auth token)" \
    --from-literal=AZURE_STORAGE_CONNECTION_STRING="$AZURE_STORAGE_CONNECTION_STRING" \
    --from-literal=AZURE_STORAGE_CONTAINER="copilot-sessions"

# 2. Build and push Docker image
az acr login --name mycopilotacr
npm run build
docker buildx build --platform linux/amd64 \
    -f deploy/Dockerfile.worker \
    -t mycopilotacr.azurecr.io/copilot-runtime-worker:latest \
    --push .

# 3. Update image in deploy/k8s/worker-deployment.yaml, then apply
kubectl apply -f deploy/k8s/worker-deployment.yaml

# 4. Verify
kubectl get pods -n copilot-runtime -l app.kubernetes.io/component=worker
```

### 6d. Connect TUI (Client-Only)

```bash
./run.sh remote
# or
node bin/tui.js remote --env .env.remote
```

The TUI connects to the same PostgreSQL as the AKS workers. No `GITHUB_TOKEN` needed
on the client side — workers handle all LLM calls.

---

## Database Schemas

Both schemas are created automatically. No manual migration.

| Schema | Created By | Contains |
|--------|-----------|----------|
| `duroxide` | duroxide runtime | Orchestration instances, execution history, task hub queues |
| `copilot_sessions` | CMS (`src/cms.ts`) | Session records, append-only event log |

### Custom Schema Names

By default, the runtime uses `duroxide` and `copilot_sessions` as schema names. To run
multiple independent deployments on the **same database**, set custom schema names:

```typescript
// Worker
const worker = new DurableCopilotWorker({
    store: process.env.DATABASE_URL,
    githubToken: process.env.GITHUB_TOKEN,
    duroxideSchema: "team_alpha_duroxide",
    cmsSchema: "team_alpha_sessions",
});

// Client — must match worker's schema names
const client = new DurableCopilotClient({
    store: process.env.DATABASE_URL,
    duroxideSchema: "team_alpha_duroxide",
    cmsSchema: "team_alpha_sessions",
});
```

Each deployment gets its own schemas, fully isolated from others on the same database.

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

## Sharing an Existing AKS Cluster

Multiple teams or projects can share one AKS cluster. Each deployment gets its
own Kubernetes namespace, secrets, and optionally its own database schemas.

### Option A: Separate Databases (Simplest)

Each deployment uses a different PostgreSQL database on the same server. No code
changes needed — just different `DATABASE_URL`s.

```
Team Alpha: postgresql://user:pass@pg-server:5432/alpha_copilot
Team Beta:  postgresql://user:pass@pg-server:5432/beta_copilot
```

### Option B: Separate Schemas (Same Database)

Use custom schema names to isolate deployments within a single database.
Set `duroxideSchema` and `cmsSchema` on both worker and client (see above).

### Setup Per Team

Each team creates their own namespace and secrets:

```bash
# Create a namespace for this deployment
TEAM_NS=copilot-alpha

kubectl create namespace $TEAM_NS

# Store secrets
kubectl create secret generic copilot-runtime-secrets \
    -n $TEAM_NS \
    --from-literal=DATABASE_URL="postgresql://..." \
    --from-literal=GITHUB_TOKEN="$(gh auth token)" \
    --from-literal=AZURE_STORAGE_CONNECTION_STRING="..." \
    --from-literal=AZURE_STORAGE_CONTAINER="alpha-sessions"
```

Copy and customize the deployment manifests:

```bash
# Copy K8s manifests
cp deploy/k8s/worker-deployment.yaml deploy/k8s/worker-deployment-alpha.yaml
```

Edit the copy to update:
- `metadata.namespace` → your team namespace
- `spec.template.spec.containers[0].image` → your ACR image

Then deploy:

```bash
kubectl apply -f deploy/k8s/worker-deployment-alpha.yaml
```

### Connect TUI to a Specific Namespace

```bash
node bin/tui.js remote \
    --env .env.alpha \
    --namespace copilot-alpha \
    --label app.kubernetes.io/component=worker
```

### Resource Isolation

For tighter isolation, use Kubernetes resource quotas:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: copilot-quota
  namespace: copilot-alpha
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 4Gi
    limits.cpu: "8"
    limits.memory: 8Gi
    pods: "10"
```

---

## `.env` Reference

```bash
# ─── Required ─────────────────────────────────────────────────────
DATABASE_URL=postgresql://user:pass@host:5432/dbname
GITHUB_TOKEN=ghu_...                    # only needed where workers run

# ─── Optional: Blob Storage (multi-node) ──────────────────────────
AZURE_STORAGE_CONNECTION_STRING=...     # enables session dehydration
AZURE_STORAGE_CONTAINER=copilot-sessions

# ─── Optional: Workers ────────────────────────────────────────────
WORKERS=4                               # embedded workers in TUI (0 = client-only)
COPILOT_MODEL=gpt-4.1                   # default LLM model
SYSTEM_MESSAGE="You are a helpful assistant."  # or path to .md file

# ─── Optional: Plugin ─────────────────────────────────────────────
PLUGIN_DIRS=./plugin                    # skills, agents, MCP config
WORKER_MODULE=./my-worker.js            # custom worker module

# ─── Optional: AKS / K8s ──────────────────────────────────────────
K8S_NAMESPACE=copilot-runtime               # for kubectl log streaming
K8S_POD_LABEL=app.kubernetes.io/component=worker

# ─── Optional: Debugging ──────────────────────────────────────────
LOG_LEVEL=info                          # none|error|warning|info|debug|all
```

---

## Next Steps

- [Building Apps](./building-apps.md) — skills, agents, tools, MCP servers, plugins
- [Configuration](./configuration.md) — all worker/client constructor options
- [Deploying to AKS](./deploying-to-aks.md) — production deployment details
- [Architecture](./architecture.md) — orchestration internals
