---
date: 2026-01-XX
git_commit: f91042ad6cbaf585633fecabeb7980289a2794b4
branch: feature/aks-gitops-iac
repository: affandar/PilotSwarm
topic: "AKS GitOps IaC — existing deploy surface, runtime env shape, and reference bicep modules"
tags: [research, codebase, aks, deploy, gitops, kustomize, bicep, ingress]
status: complete
last_updated: 2026-01-XX
---

# Research: AKS GitOps IaC — existing deploy surface and runtime inputs

## Research Question

Map the existing PilotSwarm AKS deploy surface (scripts, manifests, Dockerfiles, ingress), the runtime env var shape for worker + portal, blob/CMS/facts bootstrap assumptions, and existing health/probe endpoints — all at `file:line` precision — so that planning for a parallel FLUX + Kustomize + EV2 + Bicep GitOps path can proceed without unknowns. Also confirm the location of the two reference Bicep modules that are to be copied verbatim from `postgresql-fleet-manager`.

## Summary

- The canonical imperative deploy path is `scripts/deploy-aks.sh` (`kubectl apply` + `docker buildx --push` + one K8s Secret created via `kubectl create secret`). All inputs flow through one env file (`.env.remote` or `.env`) and one K8s Secret (`copilot-runtime-secrets`).
- K8s surface is minimal and flat: `deploy/k8s/namespace.yaml`, `deploy/k8s/worker-deployment.yaml`, `deploy/k8s/portal-deployment.yaml` (ServiceAccount + Role + RoleBinding + Deployment + Service), `deploy/k8s/portal-ingress.yaml`. No ConfigMap today — everything is envFrom a single Secret.
- Ingress today is NGINX via AKS App Routing (`ingressClassName: webapprouting.kubernetes.azure.com`) with `cert-manager`, long proxy timeouts, HTTP/1.1 upgrade (WebSocket), and buffering disabled. TLS via cert-manager + Key Vault-synced secret.
- Worker has **no HTTP listener, no `/healthz`, no liveness/readiness probes**. Portal exposes `GET /api/health` on port `3001`.
- Images are currently pinned to `:latest` with `imagePullPolicy: Always`.
- Blob bootstrap expects one container (default `copilot-sessions`) that holds both session tarballs (`<sessionId>.tar.gz`, `<sessionId>.meta.json`) and artifacts (prefix `artifacts/<sessionId>/…`). No separate artifact container today.
- CMS + Facts migrations run inline at worker startup via `PgSessionCatalogProvider.initialize()` and `FactStore.initialize()` — no Job, no CLI migrator.
- Reference Bicep modules to copy verbatim live at `src/Deploy/Common/bicep/frontdoor-origin-route.bicep` and `src/Deploy/Common/bicep/approve-private-endpoint.bicep` in `postgresql-fleet-manager` (not `Common/bicep/...` at repo root as the orchestrator-supplied path suggested — corrected path below).

## Documentation System

- **Framework**: plain Markdown — no mkdocs/docusaurus/sphinx config detected at repo root.
- **Docs Directory**: `docs/` (contains `deploying-to-aks.md`, `aks-topology.md`, and other guides).
- **Navigation Config**: N/A (no site generator).
- **Style Conventions**: H1 per file, `##` section headers, fenced code blocks, occasional mermaid. `docs/deploying-to-aks.md` is the canonical AKS guide the plan must align with.
- **Build Command**: N/A (Markdown rendered by GitHub).
- **Standard Files**: `README.md` at repo root; `docs/deploying-to-aks.md:1` is the AKS-facing guide.

## Verification Commands

From root `package.json` and `packages/sdk/package.json`:

- **Test Command**: `./scripts/run-tests.sh` (parallel by default) — also invoked by `scripts/deploy-aks.sh:144`. Workspace equivalents: `npm test` (runs sdk tests via vitest).
- **Lint Command**: `npm run lint` → `tsc --noEmit` in `packages/sdk` (`packages/sdk/package.json` `"lint": "tsc --noEmit"`).
- **Build Command**: `npm run build` → `npm run build --workspaces` (root `package.json`); worker build is `npm run build -w packages/sdk` (`scripts/deploy-aks.sh:180`).
- **Type Check**: `npm run lint` (same as lint — it is `tsc --noEmit`).

## Detailed Findings

### 1. Existing AKS deploy surface (must remain unchanged)

The new GitOps tree must live side-by-side with this surface. Boundary files:

- **`scripts/deploy-aks.sh`** — imperative end-to-end flow:
  - Loads `.env.remote` or `.env` by line-by-line export (`scripts/deploy-aks.sh:60-75`).
  - Requires `DATABASE_URL` (`scripts/deploy-aks.sh:77-80`).
  - Configuration knobs: `ACR_NAME=pilotswarmacr`, `IMAGE_NAME=copilot-runtime-worker`, `NAMESPACE=${K8S_NAMESPACE:-copilot-runtime}`, `K8S_CONTEXT` (`scripts/deploy-aks.sh:84-92`).
  - Rebuilds the single K8s Secret `copilot-runtime-secrets` with ~25 optional `--from-literal` flags (`scripts/deploy-aks.sh:100-127`).
  - Refreshes `acr-pull` docker-registry Secret via `az acr login --expose-token` (`scripts/deploy-aks.sh:129-137`).
  - Gated by full test suite (`scripts/deploy-aks.sh:141-154`).
  - Scales workers to 0, waits for termination, runs `scripts/db-reset.js --yes` (`scripts/deploy-aks.sh:158-174`).
  - `npm run build -w packages/sdk` (`scripts/deploy-aks.sh:180`).
  - `docker buildx build --platform linux/amd64 -f deploy/Dockerfile.worker … --push` (`scripts/deploy-aks.sh:187-193`).
  - Namespace + worker manifest apply via `sed` substitution of the namespace name (`scripts/deploy-aks.sh:204-207`), then `kubectl rollout restart` + `rollout status --timeout=120s` (`scripts/deploy-aks.sh:210-214`).
  - Note: the script does **not** apply `portal-deployment.yaml` or `portal-ingress.yaml` — those are applied out-of-band.

- **`scripts/reset-local.sh`** — local+remote DB/blob reset helper:
  - Parses mode `remote` / `--yes`, sources `.env.remote` or `.env` (`scripts/reset-local.sh:22-43`).
  - Schema defaults: `DUROXIDE_SCHEMA=duroxide`, `CMS_SCHEMA=copilot_sessions`, `FACTS_SCHEMA=pilotswarm_facts` (`scripts/reset-local.sh:51-53`).
  - Blob purge uses `AZURE_STORAGE_CONTAINER` default `copilot-sessions` (`scripts/reset-local.sh:117`, `:233`).
  - Remote mode also rebuilds+pushes the worker image and `kubectl apply`s `deploy/k8s/namespace.yaml` + `deploy/k8s/worker-deployment.yaml`, then `rollout restart` (`scripts/reset-local.sh:259-277`). Default registry literal `toygresaksacr.azurecr.io` at `scripts/reset-local.sh:259` (overridable via `ACR_REGISTRY`).

- **`deploy/k8s/namespace.yaml`** — single `Namespace copilot-runtime` with label `app.kubernetes.io/name: pilotswarm` (`deploy/k8s/namespace.yaml:1-7`).

- **`deploy/k8s/worker-deployment.yaml`** — `Deployment copilot-runtime-worker`, `replicas: 3` (`deploy/k8s/worker-deployment.yaml:10`), image `pilotswarmacr.azurecr.io/copilot-runtime-worker:latest` with `imagePullPolicy: Always` (`:46-47`), `imagePullSecrets: acr-pull` (`:24-25`), spot toleration `kubernetes.azure.com/scalesetpriority=spot:NoSchedule` (`:26-30`), initContainer to chown `/home/node/.copilot` (`:31-43`), env only `POD_NAME` (downward API) + `RUST_LOG=info` + `envFrom: copilot-runtime-secrets` (`:48-57`), resources `250m/1Gi → 1000m/2Gi` (`:58-64`), `emptyDir` volume `copilot-home` at `/home/node/.copilot` (`:65-70`). **No `livenessProbe` / `readinessProbe`, no `ports`, no Service** — workers are pollers, not servers.

- **`deploy/k8s/portal-deployment.yaml`** — in one file:
  - `ServiceAccount pilotswarm-portal` (`:1-8`),
  - `Role pilotswarm-portal-log-reader` with `pods` get/list/watch + `pods/log` get (`:10-30`),
  - `RoleBinding` (`:32-47`),
  - `Deployment pilotswarm-portal` with `replicas: 1` (`:58`), image `pilotswarmacr.azurecr.io/pilotswarm-portal:latest` + `imagePullPolicy: Always` (`:74-75`), single port `containerPort: 3001` (`:76-77`), env `PORTAL_TUI_MODE=remote` + `PLUGIN_DIRS=/app/packages/cli/plugins` + `envFrom: copilot-runtime-secrets` (`:78-85`), resources `250m/256Mi → 2/1Gi` (`:86-92`). **No probes** configured (portal has `/api/health` available but is not wired).
  - `Service pilotswarm-portal` ClusterIP, port 3001→3001 (`:95-113`).

- **`deploy/k8s/portal-ingress.yaml`** — `networking.k8s.io/v1 Ingress` `pilotswarm-portal-ingress`, `ingressClassName: webapprouting.kubernetes.azure.com` (AKS App Routing / NGINX) (`:18`), host `pilotswarm-portal.westus3.cloudapp.azure.com` (`:21, :24`), TLS secret `keyvault-pilotswarm-portal-tls` (`:22`). Annotations that need AGIC equivalents (see §5 below):
  - `cert-manager.io/cluster-issuer: letsencrypt-prod` (`:7`),
  - `nginx.ingress.kubernetes.io/ssl-redirect: "true"` (`:8`),
  - `nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"` (`:9`),
  - `nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"` (`:10`),
  - `nginx.ingress.kubernetes.io/proxy-http-version: "1.1"` (`:11`),
  - `nginx.ingress.kubernetes.io/proxy-buffering: "off"` (`:12`),
  - `nginx.ingress.kubernetes.io/proxy-request-buffering: "off"` (`:13`).

- **`deploy/Dockerfile.worker`** — see §4. `deploy/Dockerfile.portal` — see §4. `deploy/Dockerfile.starter` exists (`1684` bytes) but is not referenced by worker/portal deploys (starter/all-in-one image used by `deploy/bin/start-starter.sh`).

- **`docs/deploying-to-aks.md`** — canonical guide. Describes architecture, the single K8s Secret model, the portal env vars (`PORTAL_AUTH_PROVIDER`, `PORTAL_AUTH_ENTRA_TENANT_ID`, `PORTAL_AUTH_ENTRA_CLIENT_ID`, `PORTAL_AUTHZ_ADMIN_GROUPS`, `PORTAL_AUTHZ_USER_GROUPS`), and the `npm run build` + `docker buildx build --platform linux/amd64 -f deploy/Dockerfile.worker …` flow (`docs/deploying-to-aks.md:82-173`). Any new GitOps path must continue to agree with this document or update it in the same change.

### 2. Runtime env var shape

#### Worker (`packages/sdk/examples/worker.js` — the Dockerfile entrypoint)

All config is pulled from `process.env` at entrypoint (`packages/sdk/examples/worker.js:28-69`):

| Env var | Usage site | Notes |
|---|---|---|
| `DATABASE_URL` | `:59` | PostgreSQL conn string; `postgresql://` prefix triggers CMS init (`packages/sdk/src/worker.ts:275`). |
| `GITHUB_TOKEN` | `:60` | Optional; BYOK providers work without it (`scripts/deploy-aks.sh:97-98`). |
| `LOG_LEVEL` | `:32, :61` | Default `"info"`. |
| `AZURE_STORAGE_CONNECTION_STRING` | `:62` | Enables `SessionBlobStore`. |
| `AZURE_STORAGE_CONTAINER` | `:63` | Default `"copilot-sessions"`. |
| `SESSION_STATE_DIR` | `:64` | Default `os.homedir()/.copilot/session-state` (`packages/sdk/src/worker.ts:37`). |
| `PS_MODEL_PROVIDERS_PATH` / `MODEL_PROVIDERS_PATH` | `:65` | Path to `.model_providers.json`. |
| `POD_NAME` | `:33` | Downward API (`deploy/k8s/worker-deployment.yaml:49-52`). |
| `PLUGIN_DIRS` | `:36-41` | CSV; auto-adds `/app/plugin` if that path has a `plugin.json`. |
| `PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS` | `packages/sdk/src/worker.ts:470` | Graceful shutdown. |

LLM provider keys (referenced by `scripts/deploy-aks.sh:108-117` and loaded indirectly via `loadModelProviders()` at `packages/sdk/src/worker.ts:161`):
`LLM_ENDPOINT`, `LLM_API_KEY`, `LLM_PROVIDER_TYPE`, `LLM_API_VERSION`, `AZURE_FW_GLM5_KEY`, `AZURE_KIMI_K25_KEY`, `AZURE_OAI_KEY`, `AZURE_GPT51_KEY`, `AZURE_MODEL_ROUTER_KEY`, `ANTHROPIC_API_KEY`.

Schema names (all overridable, defaults hard-coded):
- `duroxide` — `packages/sdk/src/worker.ts:36`, `packages/sdk/src/client.ts:32`.
- `copilot_sessions` — `packages/sdk/src/cms.ts:367`.
- `pilotswarm_facts` — `packages/sdk/src/facts-store.ts:85`.

#### Portal (`packages/portal/server.js` + `packages/portal/auth/`)

| Env var | Usage site | Notes |
|---|---|---|
| `PORT` | `server.js:55` | Default `3001`. |
| `WORKERS` | `:56-58` | Passed through opts. |
| `DATABASE_URL` | `:62` | Falls back to `sqlite::memory:`. |
| `PORTAL_TUI_MODE` / `PORTAL_MODE` | `:17-20` | `"remote"` in-cluster; else inferred from `KUBERNETES_SERVICE_HOST`. |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | `:23-33` | If both present, server runs HTTPS directly (bypasses Ingress TLS termination). |
| `PORTAL_AUTH_PROVIDER` | `packages/portal/auth/config.js:67` | `entra` \| `none`; falls back to plugin config then `inferAuthProviderId`. |
| `PORTAL_AUTH_ENTRA_TENANT_ID` | `packages/portal/auth/providers/entra.js:7` | Required for entra. |
| `PORTAL_AUTH_ENTRA_CLIENT_ID` | `packages/portal/auth/providers/entra.js:8` | Required for entra. |
| `PORTAL_AUTHZ_DEFAULT_ROLE` | `packages/portal/auth/config.js:86` | Default `"user"`. |
| `PORTAL_AUTHZ_ADMIN_GROUPS` / `PORTAL_AUTHZ_USER_GROUPS` | `packages/portal/auth/config.js:87-97` | CSV; provider-scoped aliases `PORTAL_AUTH_ENTRA_ADMIN_GROUPS` / `…_USER_GROUPS` also accepted (`:76-80`). |
| `PORTAL_AUTH_ALLOW_UNAUTHENTICATED` | `packages/portal/auth/config.js:99-102` | Default true only when provider is `none`. |
| `PLUGIN_DIRS` | `deploy/k8s/portal-deployment.yaml:81-82` | Set to `/app/packages/cli/plugins` in-cluster. |

`.env.example` (`/.env.example:1-37`) is the only checked-in env template; `.env.remote` is gitignored.

### 3. Current K8s manifest shape (for a Kustomize `base/` reimplementation)

Consolidated from §1 — the new `deploy/gitops/base/` must at minimum include:

| Resource | File today | Key shape to preserve |
|---|---|---|
| Namespace | `deploy/k8s/namespace.yaml:1-7` | name `copilot-runtime`, label `app.kubernetes.io/name=pilotswarm`. |
| Worker Deployment | `deploy/k8s/worker-deployment.yaml:1-71` | replicas 3, image, spot toleration, busybox initContainer, `emptyDir` volume, `envFrom` single Secret. |
| Portal ServiceAccount + RBAC | `deploy/k8s/portal-deployment.yaml:1-47` | Needed for the log-reader feature (portal reads pods/log). |
| Portal Deployment | `deploy/k8s/portal-deployment.yaml:49-93` | replicas 1, image, port 3001, `envFrom` single Secret, `PORTAL_TUI_MODE=remote`, `PLUGIN_DIRS=/app/packages/cli/plugins`. |
| Portal Service | `deploy/k8s/portal-deployment.yaml:95-113` | ClusterIP, 3001→3001. |
| Portal Ingress | `deploy/k8s/portal-ingress.yaml:1-33` | See annotations in §1 and AGIC mapping in §5. |
| Secret `copilot-runtime-secrets` | **not in `deploy/k8s/`** | Created imperatively by `scripts/deploy-aks.sh:100-127`; GitOps replacement will need `configMapGenerator`/`secretGenerator` or an AKV-CSI `SecretProviderClass`. |
| Secret `acr-pull` | **not in `deploy/k8s/`** | Docker-registry secret; today refreshed by `scripts/deploy-aks.sh:129-137` from `az acr login --expose-token`. |

Image reference format today is the string literal `pilotswarmacr.azurecr.io/copilot-runtime-worker:latest` (`deploy/k8s/worker-deployment.yaml:46`) and `…/pilotswarm-portal:latest` (`deploy/k8s/portal-deployment.yaml:74`) with `imagePullPolicy: Always`. Both are pinned only by tag; digest pinning is not done.

No ConfigMap is used anywhere under `deploy/k8s/`.

### 4. Dockerfile contents

**`deploy/Dockerfile.worker` (`:1-28`)**
- Base `FROM node:24-slim` (`:2`).
- Installs `ca-certificates` (`:5`).
- `WORKDIR /app` (`:7`).
- Copies `package.json`, `package-lock.json`, workspace `package.json` for `packages/sdk` and `packages/cli`, and `scripts/postinstall.js` (`:10-13`).
- `RUN npm install --omit=dev --force` (`:14`).
- Copies built `packages/sdk/dist/`, bundled `packages/sdk/plugins/`, `packages/sdk/examples/worker.js`, and `packages/cli/plugins/` (`:17-20`).
- Copies `.model_providers.json*` (glob, optional — the file is gitignored) (`:23`).
- `USER node` (`:26`) (non-root, uid implicit from base image).
- `ENTRYPOINT ["node", "packages/sdk/examples/worker.js"]` (`:28`).
- **No `EXPOSE`** — worker has no HTTP listener.

**`deploy/Dockerfile.portal` (`:1-58`)**
- Base `FROM node:24-slim` (`:6`).
- Installs `ca-certificates python3 make g++` (`:8-9`) for native deps.
- `npm install --force` (full devDeps — Vite build happens in-image) (`:24`).
- Copies sdk dist/plugins, cli bin/src/plugins, ui-core/ui-react src, portal server/auth/runtime/index.html + `src/` + `vite.config.ts`/`tsconfig.json` (`:27-45`).
- `RUN npm run build --workspace=packages/portal` → Vite build to `packages/portal/dist/` (`:48`). `server.js` serves `DIST_DIR` statically (`packages/portal/server.js:14, :197-202`).
- Copies optional `.model_providers.json*` (`:51`).
- `EXPOSE 3001` (`:53`).
- `USER node` (`:56`).
- `ENTRYPOINT ["node", "packages/portal/server.js"]` (`:58`).

### 5. Ingress annotation → AGIC mapping inputs

Spec Q12b requires AGIC equivalents of the NGINX annotations at `deploy/k8s/portal-ingress.yaml:6-13`. The concrete inputs the new ingress must preserve (regardless of target controller):

- HTTP→HTTPS redirect: `nginx.ingress.kubernetes.io/ssl-redirect: "true"` (`:8`).
- Long-lived upstream timeouts: `proxy-read-timeout: "3600"` / `proxy-send-timeout: "3600"` (`:9-10`) — required because the portal holds a WebSocket at `path: /portal-ws` (`packages/portal/server.js:204`).
- HTTP/1.1 upstream to allow `Upgrade`: `proxy-http-version: "1.1"` (`:11`).
- Streaming (no buffering) in both directions: `proxy-buffering: "off"` / `proxy-request-buffering: "off"` (`:12-13`) — required for SSE/WS.
- TLS termination at ingress using a Key Vault-synced secret (`secretName: keyvault-pilotswarm-portal-tls`, `:22`). cert-manager today issues to that same secret (`:7`), but in an AFD + Private Link design TLS may terminate at AFD and the ingress may become cleartext internal.
- Backend: ClusterIP Service `pilotswarm-portal:3001` (`:29-33`).
- No session-affinity annotation is present today (portal auth is stateless JWT), and no probe-path override is present (AGIC default is `/`; portal responds 200 on `/api/health`, see §8).

### 6. Blob bootstrap — what containers/paths `SessionBlobStore` expects

Constructor signature: `new SessionBlobStore(connectionString, containerName = "copilot-sessions", sessionStateDir?)` (`packages/sdk/src/blob-store.ts:86`). A single container holds both concerns:

- Session state: `${sessionId}.tar.gz` and `${sessionId}.meta.json` at the container root (`packages/sdk/src/blob-store.ts:130, :141, :184, :262, :291, :316-317`).
- Artifacts: prefixed `artifacts/<sessionId>/<safeName>` (`packages/sdk/src/blob-store.ts:335, :410, :485`).

No code creates the container — `SessionBlobStore` assumes it exists (`fromConnectionString` + `getContainerClient`, `:90-91`). BaseInfra Bicep therefore only needs to ensure the single container (default name `copilot-sessions`) exists — no separate artifacts container is assumed by code. Spec FR-011's expectation that BaseInfra creates blob containers holds; no SDK change is needed.

### 7. CMS / Facts migrations — inline at worker startup

- Shared runner: `packages/sdk/src/pg-migrator.ts:27-74` — uses `pg_advisory_lock` keyed on a per-system seed + schema-name hash, creates the schema if missing (`:38`), maintains `"<schema>".schema_migrations` (`:40-47`), runs each pending migration in its own transaction (`:54-68`).
- CMS wrapper: `packages/sdk/src/cms-migrator.ts:20-22` (seed `0x636D73` = `"cms"` at `:12`).
- Facts wrapper: `packages/sdk/src/facts-migrator.ts` + `packages/sdk/src/facts-migrations.ts`.
- Invocation is inline at worker startup:
  - CMS: `this._catalog = await PgSessionCatalogProvider.create(store, this.config.cmsSchema); await this._catalog.initialize();` (`packages/sdk/src/worker.ts:277-278`), where `.initialize()` calls `runCmsMigrations` (`packages/sdk/src/cms.ts:448-452`).
  - Facts: `this.factStore = await createFactStoreForUrl(store, this.config.factsSchema); await this.factStore.initialize();` (`packages/sdk/src/worker.ts:284-285`), calling `runFactsMigrations` (`packages/sdk/src/facts-store.ts:156-159`).
- Duroxide schema is created by the duroxide Postgres provider itself: `PostgresProvider.connectWithSchema(store, this.config.duroxideSchema ?? DEFAULT_DUROXIDE_SCHEMA)` (`packages/sdk/src/worker.ts:812`).

Implication: no separate K8s Job is required for DB bootstrap — the first worker pod to come up runs all schemas' migrations under advisory locks, and additional pods serialize on the lock. Spec FR-012 is compatible with the status quo.

### 8. Health / probe endpoints

- **Worker**: no HTTP listener, no `/healthz`. `packages/sdk/examples/worker.js` ends with `await new Promise(() => {})` (`:103`) — the process is kept alive by the duroxide polling runtime. There are no `livenessProbe` or `readinessProbe` fields under `deploy/k8s/` (ripgrep on `deploy/k8s/` for `probe|health|readiness|liveness` returned no matches). K8s liveness today relies on the container process exiting (e.g., on unhandled failure in `worker.start()`).
- **Portal**: `GET /api/health` at `packages/portal/server.js:83-90`. Returns JSON `{ ok: true, started, mode }`. `started` reflects `runtime.started` (lazy — not set until first `runtime.start()` call triggered by bootstrap/WS subscription; the endpoint still returns 200 before that). `/api/portal-config` and `/api/auth-config` are also unauthenticated (`:92-114`). Port `3001` (`:55`, `deploy/k8s/portal-deployment.yaml:76-77`). No probe is configured on the portal Deployment today.

For an AGIC backend health probe, `/api/health` on port `3001` (HTTP 200 at all times) is the ready target. For a K8s readiness probe, the same path is sufficient.

### 9. Reference repo modules to copy verbatim

Orchestrator prompt named `Common/bicep/frontdoor-origin-route.bicep` and `Common/bicep/approve-private-endpoint.bicep`. Actual paths in the fleet manager repo are nested under `src/Deploy/`:

- `C:\Repos\postgresql-fleet-manager\src\Deploy\Common\bicep\frontdoor-origin-route.bicep`
- `C:\Repos\postgresql-fleet-manager\src\Deploy\Common\bicep\approve-private-endpoint.bicep`

Both live in the same directory as the broader `Common/bicep/` library including `flux-config.bicep`, `deployment-storage-container.bicep`, `private-dns-zones.bicep`, `storage-account.bicep`, `user-assigned-managed-identity*.bicep`, and related private-endpoint modules — useful peers to reference but **only these two are tagged for verbatim copy** per SpecResearch.md. SpecResearch.md Q1/Q2 at `.paw/work/aks-gitops-iac/SpecResearch.md:14-39` already documents the overall `src/Deploy/` shape and flow.

## Code References

- `scripts/deploy-aks.sh:1-221` — canonical imperative deploy flow.
- `scripts/reset-local.sh:250-278` — remote rebuild+reapply branch; default ACR literal at `:259`.
- `deploy/k8s/namespace.yaml:1-7` — `copilot-runtime` namespace.
- `deploy/k8s/worker-deployment.yaml:1-71` — worker Deployment (no probes, no ports).
- `deploy/k8s/portal-deployment.yaml:1-113` — portal SA+RBAC+Deployment+Service.
- `deploy/k8s/portal-ingress.yaml:1-33` — NGINX/App Routing ingress, cert-manager, WS-friendly timeouts.
- `deploy/Dockerfile.worker:1-28` — worker image.
- `deploy/Dockerfile.portal:1-58` — portal image (Vite build in-image).
- `packages/sdk/examples/worker.js:28-103` — worker entrypoint, env shape, graceful shutdown.
- `packages/sdk/src/worker.ts:36-37` — default schema + session-state dir constants.
- `packages/sdk/src/worker.ts:137-155` — blob store construction: single container (default `copilot-sessions`) for sessions + artifacts.
- `packages/sdk/src/worker.ts:268-285` — worker `start()`: CMS + Facts init with inline migrations.
- `packages/sdk/src/worker.ts:812` — duroxide Postgres provider schema bootstrap.
- `packages/sdk/src/blob-store.ts:86-99` — constructor (container assumed pre-existing).
- `packages/sdk/src/blob-store.ts:130-144, :335, :410-412, :485-488` — blob path conventions (`<sessionId>.tar.gz`, `<sessionId>.meta.json`, `artifacts/<sessionId>/…`).
- `packages/sdk/src/cms.ts:367, :445-452` — default schema `copilot_sessions`, inline `initialize()` → `runCmsMigrations`.
- `packages/sdk/src/facts-store.ts:85, :153-159` — default schema `pilotswarm_facts`, inline `initialize()` → `runFactsMigrations`.
- `packages/sdk/src/pg-migrator.ts:27-83` — shared advisory-lock migration runner.
- `packages/portal/server.js:17-20` — portal mode (`remote` when `KUBERNETES_SERVICE_HOST` set).
- `packages/portal/server.js:23-38` — optional in-process HTTPS when `TLS_CERT_PATH`/`TLS_KEY_PATH` set (bypasses Ingress TLS).
- `packages/portal/server.js:54-64` — default port 3001, runtime store from `DATABASE_URL`.
- `packages/portal/server.js:83-90` — `GET /api/health` (unauthenticated, always 200).
- `packages/portal/server.js:137-153` — `POST /api/rpc` (auth required).
- `packages/portal/server.js:204-210` — `/portal-ws` WebSocket (authenticated).
- `packages/portal/auth/config.js:53-110` — env-driven auth provider + policy resolution.
- `packages/portal/auth/providers/entra.js:6-16, :22-35` — Entra JWT validation (`issuer = https://login.microsoftonline.com/{tenant}/v2.0`, audience = `PORTAL_AUTH_ENTRA_CLIENT_ID`).
- `/.env.example:1-37` — env template (only `.env` template checked in).
- `docs/deploying-to-aks.md:1-200+` — canonical AKS guide the plan must stay aligned with.
- `C:\Repos\postgresql-fleet-manager\src\Deploy\Common\bicep\frontdoor-origin-route.bicep` — verbatim-copy target.
- `C:\Repos\postgresql-fleet-manager\src\Deploy\Common\bicep\approve-private-endpoint.bicep` — verbatim-copy target.

## Architecture Documentation

- **Single-Secret env pattern**: every runtime env var (DB URL, GitHub token, all LLM keys, all `PORTAL_AUTH_*` / `PORTAL_AUTHZ_*`, blob connection string, blob container name) is funneled through the same K8s Secret `copilot-runtime-secrets` and mounted by `envFrom: secretRef` on both worker and portal Deployments. A Kustomize overlay that wants to preserve current behavior bit-for-bit must keep this single-Secret shape (or generate it from a `secretGenerator` / Key Vault provider).
- **ACR pull via dynamic docker-registry secret**: `acr-pull` is recreated from `az acr login --expose-token` on every deploy (`scripts/deploy-aks.sh:129-137`). A GitOps path must either switch to AKS→ACR kubelet managed-identity auth (removing `imagePullSecrets: acr-pull`) or keep a rotation mechanism outside FLUX.
- **Two independently deployed services**: worker is a stateless PG poller with no HTTP surface; portal is an Express/WS server on 3001. They share the same image registry and same Secret but have independent images (`copilot-runtime-worker`, `pilotswarm-portal`) and rollout lifecycles.
- **Inline, idempotent DB migrations under advisory lock** (`pg-migrator.ts`) make the worker safe to scale horizontally without a migrate Job — consistent with FR-012.
- **Blob container is a single shared namespace** for session tarballs and artifacts (prefix `artifacts/`). BaseInfra only needs one container; multi-container is not required by code.
- **Ingress today is NGINX/App Routing + cert-manager + AKV-synced TLS Secret**. No session-affinity, no custom health-check path configured. WebSocket-friendly annotations are the significant non-default surface.

## Open Questions

None that block planning. All spec focus areas resolved with file:line evidence. A few items worth naming explicitly so planning accounts for them:

1. **AGIC + AKV-CSI vs cert-manager**: today cert-manager owns `keyvault-pilotswarm-portal-tls`. Whether the new AGIC path keeps cert-manager or switches to AKV-CSI `SecretProviderClass` is a planning choice, not a code-research unknown (`deploy/k8s/portal-ingress.yaml:7, :22`).
2. **`acr-pull` Secret under GitOps**: the current imperative rotation (`scripts/deploy-aks.sh:129-137`) has no GitOps equivalent in-tree; planning must decide between kubelet MI auth (drop the Secret) or external rotator.
3. **Worker `POD_NAME` downward API** and **spot toleration** (`deploy/k8s/worker-deployment.yaml:27-30, :49-52`) — both must be preserved in the Kustomize base.
4. **Portal TLS dual-mode**: `server.js:23-33` will terminate TLS in-process if `TLS_CERT_PATH`/`TLS_KEY_PATH` are set. The current Ingress terminates TLS at the edge and does not set these env vars; planning should explicitly choose one of the two TLS paths for the AFD+PL design.
