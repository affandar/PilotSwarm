# Deploying to Azure Kubernetes Service (AKS)

This guide walks through deploying PilotSwarm workers to AKS for production multi-node operation.

> **Two deployment paths.** The repo ships two side-by-side ways to deploy
> PilotSwarm to AKS:
>
> 1. **Legacy `scripts/deploy-aks.sh`** (the rest of this document).
>    Imperative bash + raw `kubectl apply` against `deploy/k8s/*.yaml`.
>    Stable, well-trodden, and not going away.
> 2. **GitOps IaC pipeline under `deploy/`** (described below in
>    [GitOps IaC Path](#gitops-iac-path)). Bicep-managed Azure infra +
>    Flux-driven cluster manifests, pulled from versioned blob
>    containers. Modeled on the postgresql-fleet-manager reference
>    implementation, simplified for PilotSwarm's single-service Node.js
>    shape. This path adds Edge Mode (AFD vs Private AppGw) and TLS
>    Source (AKV vs Let's Encrypt) topology choices.
>
> Choose one. They share the same Kubernetes cluster shape but stamp it
> out via different mechanisms; running both against the same cluster
> will fight over the same resources.

## GitOps IaC Path

The IaC pipeline under `deploy/` provisions Azure infra via Bicep and
keeps cluster state in sync via Flux Kustomizations sourced from blob
containers. Public entry points:

- `deploy/scripts/new-env.mjs` — generate a per-env `.env` + bicep
  parameter files. Picks defaults for the topology axes below.
- `deploy/scripts/deploy.mjs` — orchestrates the per-service bicep +
  manifest stage in `infraOrder` then `services` order from
  `deploy/services/deploy-manifest.json`.
- `deploy/scripts/test/*.test.mjs` — `npm run test:deploy-scripts`.

### Topology Matrix

The IaC path supports a `(EDGE_MODE × TLS_SOURCE)` matrix. Four
combinations are supported; two are blocked:

| `EDGE_MODE` | `TLS_SOURCE`     | Edge ingress                                  | Cert source                                            | Notes                                          |
|-------------|------------------|-----------------------------------------------|--------------------------------------------------------|------------------------------------------------|
| `afd`       | `letsencrypt`    | AFD → AppGw (Private Link) + AGIC             | cert-manager + Let's Encrypt prod (HTTP-01)            | OSS default. Zero CA setup.                    |
| `afd`       | `akv`            | AFD → AppGw (Private Link) + AGIC             | OneCertV2-PublicCA via AKV (registered automatically)  | EV2 default. BYO public CA.                    |
| `private`   | `akv`            | AKS web-app-routing addon (NGINX) + ILB       | OneCertV2-PrivateCA via AKV (registered automatically) | Enterprise / AME. No AFD, no AppGw, no AGIC.   |
| `private`   | `akv-selfsigned` | AKS web-app-routing addon (NGINX) + ILB       | AKV `Self` issuer (auto-generated, in-place)           | No CA; private-VNet smoke tests.               |

Default for OSS = `afd` + `letsencrypt`. Default for EV2 =
`afd` + `akv`.

- **`EDGE_MODE=afd`** — Azure Front Door fronts a regional Application
  Gateway over Private Link. Public TLS terminates at AFD; AppGw is
  reachable only via the AFD private endpoint. Use for any Internet-
  facing deployment.
- **`EDGE_MODE=private`** — No AFD, no AppGw, no AGIC, no GlobalInfra
  resource group. AKS uses the [web-app-routing
  addon](https://learn.microsoft.com/azure/aks/app-routing) (managed
  NGINX) with an internal-only Azure Load Balancer. Reachable from
  peered VNets / Bastion / VPN / ExpressRoute. The `globalinfra` and
  `afd` services are skipped by `deploy.mjs`. Bicep also provisions a
  Private DNS Zone (`PRIVATE_DNS_ZONE`) and links it to the AKS VNet;
  `deploy.mjs` writes an A record `${HOST}.${PRIVATE_DNS_ZONE}` →
  internal LB IP after the Portal rolls out.
- **`TLS_SOURCE=akv`** — Portal cert is issued by an AKV cert issuer.
  The bicep auto-registers `OneCertV2-PublicCA` (afd mode) or
  `OneCertV2-PrivateCA` (private mode) on the Key Vault using the
  shared `akv-certificate-issuer.bicep` module — no manual issuer
  setup. Override with `PORTAL_TLS_ISSUER_NAME` if you have a different
  registered CA. Cert is projected into the cluster via Secret Store
  CSI; afd mode binds it to AppGw via the `appgw-ssl-certificate` AGIC
  annotation, private mode mounts it directly into the NGINX-fronted
  Portal pod's TLS secret.
- **`TLS_SOURCE=akv-selfsigned`** *(private only)* — uses the AKV
  built-in `Self` issuer to mint a self-signed cert. Browsers will
  warn; only suitable for private-VNet smoke tests where you control
  the trust store.
- **`TLS_SOURCE=letsencrypt`** *(afd only)* — `cert-manager` is
  installed in-cluster via Flux (HelmRelease pinned to v1.20.2 exact).
  The `letsencrypt-prod` ClusterIssuer (HTTP-01 solver) issues a real
  CA cert and writes it into the K8s Secret named in the Ingress
  `tls.secretName`. AGIC imports it from there. No AKV cert, no
  manual upload step. Requires `ACME_EMAIL` in the env.

### Variant Overlays

`deploy/gitops/portal/overlays/` ships three flavors, one per supported
combo (`akv` and `akv-selfsigned` share an overlay because the only
difference is the AKV issuer name, set by Portal bicep, not by
kustomize):

- `afd-letsencrypt/` — AFD + AppGw + AGIC + cert-manager-managed Secret.
- `afd-akv/` — AFD + AppGw + AGIC + Secret Store CSI (AKV cert).
- `private-akv/` — web-app-routing NGINX + ILB + Secret Store CSI
  (AKV cert, OneCertV2-PrivateCA or `Self`).

Portal bicep selects the overlay automatically:

```bicep
kustomizationPath: 'overlays/${edgeMode}-${
  tlsSource == 'akv-selfsigned' ? 'akv' : tlsSource
}'
```

### Skip Logic

`deploy.mjs` skips entire services based on env flags:

| Service                  | Skip when                                            |
|--------------------------|------------------------------------------------------|
| `globalinfra`, `afd`     | `EDGE_MODE != afd`                                   |
| `cert-manager`           | `TLS_SOURCE != letsencrypt`                          |
| `cert-manager-issuers`   | `TLS_SOURCE != letsencrypt`                          |

Both single-service runs (`deploy.mjs <svc>`) and `deploy.mjs all` honor
these gates.

### cert-manager Pinning

`deploy/gitops/cert-manager/base/helm-release.yaml` pins
`version: 1.20.2` exact (no semver range). To upgrade, edit that field
in a PR — Flux will not auto-roll. The OCI HelmRepository points at
`oci://quay.io/jetstack/charts` (official Jetstack registry) for OSS;
EV2 stays on the AKV path so this chart source is OSS-only.

ClusterIssuers live in a separate Kustomization
(`cert-manager-issuers`) so the issuer install retries cleanly while
cert-manager CRDs are landing — Flux retry handles the ordering, no
explicit `dependsOn` between the two fluxConfigurations resources.

### Private Mode: NGINX + Internal LB + Private DNS

In `EDGE_MODE=private` the cluster uses the AKS web-app-routing addon
(`addonProfiles.webAppRouting`) instead of AGIC. The addon installs a
managed NGINX ingress controller in the `app-routing-system`
namespace; the default ingress class is
`webapprouting.kubernetes.azure.com`.

Two pieces are wired by `deploy.mjs` after Flux reconciles the Portal
manifests, because they depend on runtime state Bicep can't observe:

1. **Internal LB.** `deploy.mjs` patches the cluster-scoped
   `nginxingresscontroller/default` CR with
   `spec.loadBalancerAnnotations.service.beta.kubernetes.io/azure-load-balancer-internal=true`.
   The addon controller propagates the annotation onto the underlying
   `app-routing-system/nginx` Service, and Azure recreates the LB as
   internal-only.
2. **Private DNS A record.** `deploy.mjs` polls the Service for its
   internal IP, then idempotently upserts an A record
   `${HOST}` → internal-LB IP on the Bicep-provisioned Private DNS Zone
   (`PRIVATE_DNS_ZONE`). Re-running the Portal deploy refreshes the
   record if the LB IP changes.

Callers reach the Portal at `https://${HOST}.${PRIVATE_DNS_ZONE}` from
inside the AKS VNet (or any VNet linked to the same Private DNS Zone:
peered VNets, Bastion-attached jump boxes, VPN, ExpressRoute). The
zone is **not** publicly resolvable.

### Unsupported Combinations

- **`EDGE_MODE=private` with `TLS_SOURCE=letsencrypt`** — Let's Encrypt
  HTTP-01 needs a public IP for ACME validation; private mode has none.
  DNS-01 against an Azure Public DNS zone is not in scope (we don't
  provision public zones). Use `TLS_SOURCE=akv` (OneCertV2-PrivateCA /
  AME) or `TLS_SOURCE=akv-selfsigned` for private deployments.
- **`EDGE_MODE=afd` with `TLS_SOURCE=akv-selfsigned`** — Azure Front
  Door rejects self-signed origin certs at the TLS validation step.
  Use `TLS_SOURCE=letsencrypt` (free, public CA) or `TLS_SOURCE=akv`
  with a public CA (e.g. OneCertV2-PublicCA).

`new-env.mjs` and `deploy.mjs` both refuse these combos at preflight.

### Model Providers (LLM catalog)

The IaC path mounts the worker's model catalog as a kustomize-generated
ConfigMap (`copilot-worker-model-providers`) sourced from
[`deploy/gitops/worker/base/model_providers.json`](../deploy/gitops/worker/base/model_providers.json),
exposed to the runtime via `PS_MODEL_PROVIDERS_PATH=/app/config/model_providers.json`.
This is **separate from** the legacy `scripts/deploy-aks.sh` flow,
which bakes `deploy/config/model_providers.ghcp.json` into the image.

Built-in providers in the base catalog:

| Provider | Auth secret (KV → SPC) | Endpoint | When it loads |
|---|---|---|---|
| `ghcp` (GitHub Copilot) | `GITHUB_TOKEN` | `https://api.githubcopilot.com` | Always |
| `anthropic` (direct) | `ANTHROPIC_API_KEY` | `https://api.anthropic.com` | When the key is set (sentinel-tolerant) |
| `azure-foundry`, `azure-foundry-router` | `AZURE_OAI_KEY` | `__FOUNDRY_ENDPOINT__/openai/v1` | Only when `FOUNDRY_ENABLED=true` |

`__FOUNDRY_ENDPOINT__` is rewritten to the live Foundry account URL
during `--steps manifests` (from the `FOUNDRY_ENDPOINT` Bicep output).
When Foundry is disabled, the placeholder stays in the file and the
worker's catalog loader silently drops the Foundry providers
(`apiKey: env:AZURE_OAI_KEY` resolves to the stripped `__PS_UNSET__`
sentinel, i.e. undefined).

#### Enabling Foundry on a stamp

```bash
npm run deploy:new-env -- <name> --foundry-enabled y
# scaffolds deploy/envs/local/<name>/foundry-deployments.json
# (a JSON array; the stdout banner lists common entries to copy in)

# edit the JSON to your desired model deployments, then:
npm run deploy -- --env <name>
```

`foundry.bicep` provisions one `Microsoft.CognitiveServices/accounts`
(kind=AIServices) per stamp, each entry as a child
`accounts/deployments`, and writes `azure-oai-key` directly to KV via
co-located `listKeys()`. When `FOUNDRY_ENABLED=false`,
`auto-secrets-sentinel.bicep` writes the `__PS_UNSET__` sentinel into
the same KV secret so the SPC mount still succeeds.

> **Phase 1 only.** Foundry uses key auth; Claude is direct-Anthropic.
> Phase 2 (SDK Entra-mode for Foundry) and Phase 3 (Foundry-hosted
> Claude) are tracked in
> [`docs/proposals/foundry-entra-mode-auth.md`](./proposals/foundry-entra-mode-auth.md)
> and [`docs/proposals/foundry-hosted-claude.md`](./proposals/foundry-hosted-claude.md).

#### Per-stamp catalog overrides

Drop a kustomize overlay patch on the
`copilot-worker-model-providers` ConfigMap in
`deploy/gitops/worker/overlays/<overlay>/` to diverge from the base
catalog for one stamp. Keep `__FOUNDRY_ENDPOINT__` in the patched JSON
to keep endpoint substitution; hard-code the URL to opt out.

### Local Development

Local dev outside Azure (e.g. kind, k3d, plain Docker) is **not** part
of the IaC path. Use the legacy local scripts (`./run.sh`,
`scripts/deploy-aks.sh`) for those scenarios. The IaC path assumes an
Azure target.

### Querying Logs (KQL)

The base-infra Bicep provisions a per-stamp Log Analytics workspace
(`<RESOURCE_PREFIX>-log`) and an AKS Container Insights Data Collection
Rule that ships pod stdout/stderr to the workspace using the modern
**ContainerLogV2** schema. This gives you historical, queryable logs
that survive pod restarts — a step up from `kubectl logs`, which only
shows the current and previous container instance.

Find the workspace:

```bash
# From base-infra deployment outputs (set after `--steps bicep`):
az deployment group show \
  -g "$RESOURCE_GROUP" \
  -n base-infra \
  --query "properties.outputs.logAnalyticsWorkspaceName.value" -o tsv
# → <RESOURCE_PREFIX>-log
```

Open the workspace in the Azure portal → **Logs**, and run KQL like:

```kusto
// Last 200 portal log lines
ContainerLogV2
| where PodNamespace == "pilotswarm"
| where PodName startswith "pilotswarm-portal"
| order by TimeGenerated desc
| take 200
| project TimeGenerated, PodName, ContainerName, LogMessage

// Worker errors in the last 1h
ContainerLogV2
| where PodNamespace == "pilotswarm"
| where PodName startswith "copilot-runtime-worker"
| where TimeGenerated > ago(1h)
| where LogLevel in ("error", "warn") or LogMessage contains_cs "ERROR"
| order by TimeGenerated desc

// Pod restarts / OOMKills
KubeEvents
| where Namespace == "pilotswarm"
| where Reason in ("BackOff", "Failed", "OOMKilling", "Killing")
| order by TimeGenerated desc
| project TimeGenerated, Name, Reason, Message
```

Notes:

- **Ingestion lag is ~3–10 minutes.** Tail follow-ups should still use
  `kubectl logs -f` for live debugging; KQL is the historical view.
- **Retention** defaults to 30 days (free tier). Tune via
  `LOG_ANALYTICS_RETENTION_DAYS` in `deploy/envs/local/<env>/env`.
  Up to 730 days is supported; 30+ is billed at the workspace's
  PerGB2018 rate.
- **ContainerLogV2** is the only schema enabled. The legacy
  `ContainerLog` table is deprecated (retiring 2026-09-30) and is not
  populated.
- **Cost.** A small dev stamp typically lands at 1–3 GB/day; ingestion
  is ~$2.30/GB after the free 5 GB/month per workspace. Use the
  `Usage | summarize sum(Quantity) by DataType` query to monitor.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Your App (Client)                                                   │
│  PilotSwarmClient({ store: DATABASE_URL })                       │
│  → createSession, sendAndWait, on()                                  │
└────────────────────┬─────────────────────────────────────────────────┘
                     │ PostgreSQL
                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│  PostgreSQL (Azure Database for PostgreSQL)                           │
│  ┌─────────────────┐  ┌──────────────────┐                           │
│  │ duroxide schema  │  │ copilot_sessions │                           │
│  │ (orchestrations) │  │ (session catalog)│                           │
│  └─────────────────┘  └──────────────────┘                           │
└────────────────────┬─────────────────────────────────────────────────┘
                     │ PostgreSQL
                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│  AKS Worker Pods (N replicas)                                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                │
│  │ worker-1 │ │ worker-2 │ │ worker-3 │ │ worker-N │                │
│  │ polls PG │ │ polls PG │ │ polls PG │ │ polls PG │                │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘                │
│                                                                      │
│  Each pod: node examples/worker.js                                   │
│  → Picks up orchestrations from the queue                            │
│  → Runs LLM turns via Copilot SDK                                   │
│  → Dehydrates/hydrates sessions via Azure Blob Storage               │
└──────────────────────────────────────────────────────────────────────┘
```

## Prerequisites

- Azure CLI (`az`) installed and logged in
- `kubectl` configured for your AKS cluster
- An Azure Container Registry (ACR) for Docker images
- An Azure Database for PostgreSQL (Flexible Server)
- An Azure Storage Account (for session blob storage)

## WARNING: Runaway Deployments

**Before deploying**, always check for old worker pods in other namespaces that may still be connected to the same database:

```bash
kubectl get pods --all-namespaces -l app.kubernetes.io/component=worker --no-headers
```

Old workers from a previous namespace (e.g. `copilot-sdk` vs `copilot-runtime`) will process orchestrations with **stale orchestration code**, causing nondeterminism errors. Delete any old deployments before deploying:

```bash
kubectl delete deployment copilot-runtime-worker -n <old-namespace>
```

## Step 1: Create Kubernetes Resources

## Prefer The Repo Script

For this repository, prefer the canonical deploy/reset path:

```bash
./scripts/deploy-aks.sh
```

That script refreshes the Kubernetes secret, optionally wipes remote state, builds the SDK, pushes the worker image, and waits for rollout completion.

### Namespace

```bash
kubectl apply -f deploy/k8s/namespace.yaml
```

This creates the `copilot-runtime` namespace.

### Secrets

PilotSwarm's checked-in model-catalog template is [`.model_providers.example.json`](../.model_providers.example.json). Workers actually load the local `.model_providers.json`, which is gitignored so teams can keep personal endpoint URLs and similar local details out of source control. The Kubernetes secret only needs the env vars referenced by that real runtime catalog and the worker runtime.

Store your credentials as a Kubernetes secret:

```bash
kubectl create secret generic copilot-runtime-secrets \
    -n copilot-runtime \
    --from-literal=DATABASE_URL="postgresql://user:pass@myserver.postgres.database.azure.com:5432/postgres?options=-csearch_path%3Dcopilot_runtime&sslmode=require" \
    --from-literal=GITHUB_TOKEN="ghp_xxxxxxxxxxxx" \
    --from-literal=DUROXIDE_PG_POOL_MAX="10" \
    --from-literal=PILOTSWARM_CMS_PG_POOL_MAX="3" \
    --from-literal=PILOTSWARM_FACTS_PG_POOL_MAX="3" \
    --from-literal=PILOTSWARM_ORCHESTRATION_CONCURRENCY="2" \
    --from-literal=PILOTSWARM_WORKER_CONCURRENCY="2" \
    --from-literal=AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=..." \
    --from-literal=AZURE_STORAGE_CONTAINER="copilot-sessions"
```

Worker sizing is env-driven:

- `DUROXIDE_PG_POOL_MAX` — `duroxide-pg` provider pool size. Default: `10`.
- `PILOTSWARM_CMS_PG_POOL_MAX` — CMS `pg.Pool` max size. Default: `3`.
- `PILOTSWARM_FACTS_PG_POOL_MAX` — facts `pg.Pool` max size. Default: `3`.
- `PILOTSWARM_ORCHESTRATION_CONCURRENCY` — Duroxide orchestration concurrency. Default: `2`.
- `PILOTSWARM_WORKER_CONCURRENCY` — Duroxide activity/worker concurrency. Default: `2`.

Provider availability in selectors is env-driven at worker startup. If you add or remove a provider key, refresh the secret and restart the workers; changing the checked-in template alone is not enough, and changing the real `.model_providers.json` only takes effect after the updated file is present in the runtime environment.

### Portal Pods

If you also deploy the shipped browser portal, treat it as a separate runtime
surface from the worker pods:

- package the same app plugin into the portal image
- set `PLUGIN_DIRS` in the portal deployment so the web process can read
  `plugin.json.portal`, `plugin.json.tui`, creatable agent metadata, and
  session policy
- keep portal branding in `plugin.json.portal`, using `plugin.json.tui` as a
  fallback or shared source only when that is intentional

If the portal pod cannot see the app plugin, the browser UI falls back to
generic PilotSwarm branding and generic-session creation even when the worker
supports named agents.

Portal auth is provider-based. For the shipped Entra add-on, add these env vars
to `copilot-runtime-secrets` (or the portal deployment env) before restarting
the portal:

```bash
PORTAL_AUTH_PROVIDER=entra
PORTAL_AUTH_ENTRA_TENANT_ID=<tenant-id>
PORTAL_AUTH_ENTRA_CLIENT_ID=<client-id>
PORTAL_AUTHZ_ADMIN_GROUPS=admin1@contoso.com,admin2@contoso.com
PORTAL_AUTHZ_USER_GROUPS=user1@contoso.com,user2@contoso.com
```

Register the portal ingress URL as the SPA redirect URI in Entra. The portal
core does not require Entra specifically, so alternate providers can use the
same deployment slot without changing the portal shell contract.

Use the canonical `PORTAL_AUTH_*` / `PORTAL_AUTHZ_*` keys only. The portal no
longer reads legacy `ENTRA_*` aliases.

Current authz is Phase 1 only:

- authenticated users whose email appears in the configured admin/user allowlists are allowed in
- `admin` and `user` have the same portal permissions today
- per-user session visibility is a later phase

### Refresh GitHub Token

The GitHub token expires periodically. To update:

```bash
kubectl create secret generic copilot-runtime-secrets \
    -n copilot-runtime \
    --from-literal=DATABASE_URL="..." \
    --from-literal=GITHUB_TOKEN="$(gh auth token)" \
    --from-literal=DUROXIDE_PG_POOL_MAX="10" \
    --from-literal=PILOTSWARM_CMS_PG_POOL_MAX="3" \
    --from-literal=PILOTSWARM_FACTS_PG_POOL_MAX="3" \
    --from-literal=PILOTSWARM_ORCHESTRATION_CONCURRENCY="2" \
    --from-literal=PILOTSWARM_WORKER_CONCURRENCY="2" \
    --from-literal=AZURE_STORAGE_CONNECTION_STRING="..." \
    --from-literal=AZURE_STORAGE_CONTAINER="copilot-sessions" \
    --dry-run=client -o yaml | kubectl apply -f -
```

The same pattern applies to Azure/OpenAI or Anthropic BYOK keys. If a provider should disappear from selectors, make sure its env var is absent when the secret is reapplied, then restart the deployment and verify the live model surface.

## Step 2: Build and Push Docker Image

### Login to ACR

```bash
az acr login --name <your-acr-name>
```

### Build and Push

```bash
# Build TypeScript first
npm run build

# Build and push Docker image
docker buildx build \
    --platform linux/amd64 \
    -f deploy/Dockerfile.worker \
    -t <your-acr-name>.azurecr.io/copilot-runtime-worker:latest \
    --push .
```

The Dockerfile (`deploy/Dockerfile.worker`) builds a minimal image:
- `node:24-slim` base
- Production dependencies only (`npm install --omit=dev`)
- Copies `dist/` and `examples/worker.js`
- Runs as non-root `node` user

## Step 3: Deploy Workers

### Edit the Deployment

Update `deploy/k8s/worker-deployment.yaml` with your ACR URL:

```yaml
containers:
  - name: worker
    image: <your-acr-name>.azurecr.io/copilot-runtime-worker:latest
```

### Apply

```bash
kubectl apply -f deploy/k8s/worker-deployment.yaml
```

### Verify

```bash
kubectl get pods -n copilot-runtime -l app.kubernetes.io/component=worker
```

Expected output:

```
NAME                                  READY   STATUS    RESTARTS   AGE
copilot-runtime-worker-xxxxx-aaaaa        1/1     Running   0          30s
copilot-runtime-worker-xxxxx-bbbbb        1/1     Running   0          30s
copilot-runtime-worker-xxxxx-ccccc        1/1     Running   0          30s
copilot-runtime-worker-xxxxx-ddddd        1/1     Running   0          30s
```

### Check Logs

```bash
kubectl logs -n copilot-runtime -l app.kubernetes.io/component=worker --prefix --tail=20
```

You should see:

```
[pod/copilot-runtime-worker-xxxxx/worker] [worker] Pod: copilot-runtime-worker-xxxxx
[pod/copilot-runtime-worker-xxxxx/worker] [worker] Started ✓ Polling for orchestrations...
```

After a cold start or destructive reset, the workers will automatically recreate the built-in system sessions (`PilotSwarm Agent`, `Sweeper Agent`, `Resource Manager Agent`, `Facts Manager`). A truly empty session list is therefore temporary.

## Reset Remote State For Reproduction Or Replay Cleanup

When orchestration logic changed or you want a clean reproduction:

```bash
kubectl scale deployment copilot-runtime-worker -n copilot-runtime --replicas=0
NODE_TLS_REJECT_UNAUTHORIZED=0 node --env-file=.env.remote scripts/db-reset.js --yes
kubectl scale deployment copilot-runtime-worker -n copilot-runtime --replicas=6
kubectl rollout status deployment/copilot-runtime-worker -n copilot-runtime --timeout=180s
```

This drops:

- `duroxide`
- `copilot_sessions`
- `pilotswarm_facts`
- all blobs in `copilot-sessions` when blob storage is configured

After the workers come back, expect the built-in system sessions to be recreated immediately. For replay-sensitive testing, verify that the recreated root `PilotSwarm Agent` is healthy before starting new user sessions.

## Step 4: Connect Your Client

From your application (anywhere with network access to the same PostgreSQL):

```typescript
import { PilotSwarmClient } from "pilotswarm-sdk";

const client = new PilotSwarmClient({
    store: process.env.DATABASE_URL,
    blobEnabled: true,
});
await client.start();

// Sessions are processed by AKS worker pods
const session = await client.createSession();
await session.send("Monitor this service every 5 minutes for the next 24 hours");

console.log(`Session ${session.sessionId} is running on AKS`);
```

Or use the TUI in remote mode:

```bash
npm run tui:remote
```

## Scaling

### Horizontal Scaling

Adjust the replica count:

```bash
kubectl scale deployment copilot-runtime-worker -n copilot-runtime --replicas=8
```

Workers are stateless — each polls the PostgreSQL queue for available work. duroxide ensures exactly-once execution.

### Resource Tuning

The default resource requests/limits in the deployment:

```yaml
resources:
    requests:
        cpu: "250m"
        memory: "512Mi"
    limits:
        cpu: "1000m"
        memory: "1Gi"
```

Each worker runs one LLM turn at a time. Increase CPU limits if tool execution is compute-heavy.

### Spot Instances

The deployment includes a toleration for Azure spot instances:

```yaml
tolerations:
    - key: "kubernetes.azure.com/scalesetpriority"
      operator: "Equal"
      value: "spot"
      effect: "NoSchedule"
```

Spot instances are safe because sessions are durable — if a spot node is evicted, the orchestration retries automatically on another node.

## Updating Workers

### Rolling Update

```bash
# Rebuild and push
npm run build
docker buildx build --platform linux/amd64 -f deploy/Dockerfile.worker \
    -t <your-acr-name>.azurecr.io/copilot-runtime-worker:latest --push .

# Restart pods (pulls latest image)
kubectl rollout restart deployment/copilot-runtime-worker -n copilot-runtime

# Wait for rollout to complete
kubectl rollout status deployment/copilot-runtime-worker -n copilot-runtime
```

In-flight orchestrations are safe during rollouts. If a worker is killed mid-turn, duroxide will retry the activity on another worker after the lock timeout.

### Database Reset

To wipe all orchestration and session state:

```bash
node --env-file=.env.remote scripts/db-reset.js --yes
```

This drops both the `duroxide` and `copilot_sessions` schemas. Use with caution — all in-flight sessions will be lost.

## Troubleshooting

### Workers Not Picking Up Work

```bash
# Check pods are running
kubectl get pods -n copilot-runtime -l app.kubernetes.io/component=worker

# Check logs for errors
kubectl logs -n copilot-runtime -l app.kubernetes.io/component=worker --tail=50

# Verify database connectivity
kubectl exec -n copilot-runtime deploy/copilot-runtime-worker -- \
    node -e "console.log('DB OK')" --env-file=/dev/null
```

### Session Stuck in "running"

A session may be stuck if the activity timed out. Check the orchestration status:

```bash
# From your machine
node --env-file=.env.remote -e "
    import { PilotSwarmClient } from './dist/index.js';
    const c = new PilotSwarmClient({ store: process.env.DATABASE_URL });
    await c.start();
    const s = await c.resumeSession('SESSION_ID');
    console.log(await s.getInfo());
    await c.stop();
"
```

### GitHub Token Expired

If workers log authentication errors, refresh the secret:

```bash
kubectl create secret generic copilot-runtime-secrets -n copilot-runtime \
    --from-literal=GITHUB_TOKEN="$(gh auth token)" \
    --dry-run=client -o yaml | kubectl apply -f -

# Restart workers to pick up new secret
kubectl rollout restart deployment/copilot-runtime-worker -n copilot-runtime
```

## Sharing An Existing AKS Cluster

Multiple teams or projects can share one AKS cluster. Each deployment gets its
own Kubernetes namespace, secrets, and optionally its own database schemas.

### Option A: Separate Databases (Simplest)

Each deployment uses a different PostgreSQL database on the same server. No code
changes needed — just different `DATABASE_URL`s.

```
Team Alpha: postgresql://user:pass@pg-server:5432/alpha_pilotswarm
Team Beta:  postgresql://user:pass@pg-server:5432/beta_pilotswarm
```

### Option B: Separate Schemas (Same Database)

Use custom schema names to isolate deployments within a single database. Set
`duroxideSchema` and `cmsSchema` on both worker and client (see
[Getting Started → Custom Schema Names](./getting-started.md#custom-schema-names)).

### Setup Per Team

Each team creates their own namespace and secrets:

```bash
TEAM_NS=copilot-alpha

kubectl create namespace $TEAM_NS

kubectl create secret generic copilot-runtime-secrets \
    -n $TEAM_NS \
    --from-literal=DATABASE_URL="postgresql://..." \
    --from-literal=GITHUB_TOKEN="$(gh auth token)" \
    --from-literal=AZURE_STORAGE_CONNECTION_STRING="..." \
    --from-literal=AZURE_STORAGE_CONTAINER="alpha-sessions"
```

Copy and customize the deployment manifests:

```bash
cp deploy/k8s/worker-deployment.yaml deploy/k8s/worker-deployment-alpha.yaml
```

Edit the copy to update:
- `metadata.namespace` → your team namespace
- `spec.template.spec.containers[0].image` → your ACR image

Then deploy:

```bash
kubectl apply -f deploy/k8s/worker-deployment-alpha.yaml
```

### Connect The TUI To A Specific Namespace

```bash
node packages/cli/bin/tui.js remote \
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
