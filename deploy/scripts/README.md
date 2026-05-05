# OSS Node deploy orchestrator (`deploy/scripts/`)

A multi-platform Node.js deploy driver for PilotSwarm on AKS that
**coexists with** — and never replaces — the existing paths:

| Path | What it is | When to use |
|---|---|---|
| `scripts/deploy-aks.sh` | Imperative bash script targeting an existing dev cluster (`docs/deploying-to-aks.md`). | Engineer smoke loop on a one-off cluster. |
| `deploy/services/ev2-deploy-dev.ps1` | EV2-driven GitOps deploy (Bicep + Kustomize + Flux Storage Bucket, see `docs/deploying-to-aks-ev2.md`). | Production rollouts via the internal EV2 service. |
| **`deploy/scripts/deploy.mjs`** *(this README)* | OSS-friendly equivalent of the EV2 path, runnable from any contributor's box without EV2. | Reproducing the GitOps deploy locally; future GitHub Actions wrapper. |

Same outcome as the EV2 path: Bicep deployed → image pushed to ACR →
Kustomize manifests staged with `.env` substitution → tree uploaded to
the Flux Storage Bucket → rollout verified against the running cluster.

## Prerequisites

- **Node.js ≥ 20** (already a repo dep — `node --version`)
- **Azure CLI** (`az login` against the target subscription)
- **Docker** (for `worker` / `portal` image builds; not required for `baseinfra` / `globalinfra`)
- **`oras`** ([install](https://oras.land/docs/installation)) — used to push the `docker save` tarball into ACR
- **`kubectl`** ([install](https://kubernetes.io/docs/tasks/tools/)) — used by the `rollout` step
- **`flux`** ([install](https://fluxcd.io/flux/installation/#install-the-flux-cli)) — used by the `rollout` step to force-reconcile the Flux Bucket source + Kustomization against the just-uploaded blobs (`kubectl wait kustomization --for=condition=Ready` is unreliable here — see `deploy/scripts/lib/wait-rollout.mjs` for why)

CLI checks are **lazy**: each step only validates the tools it actually
needs, so `--steps bicep` works without `oras` / `docker` installed.

## Quickstart

There are two ways to point this script at a target subscription / cluster:

Every deploy targets a personal local env at
`deploy/envs/local/<name>/env`, scaffolded by `npm run deploy:new-env`
from `deploy/envs/template.env`. The local file is standalone — no
runtime cascade — so editing the template never retroactively changes
existing envs.

```bash
# 1. Sign in and select the target subscription
az login
az account set --subscription "<subscription-id>"

# 2. Scaffold a personal env. Run interactively (prompts for env name,
#    subscription, location) or pass everything via flags. <name> must
#    match /^[a-z][a-z0-9]{0,11}$/.
npm run deploy:new-env
#    or non-interactive:
npm run deploy:new-env -- foo --subscription <id> --location westus3
#    The scaffolder generates RESOURCE_GROUP, GLOBAL_RESOURCE_PREFIX,
#    GLOBAL_RESOURCE_GROUP, PORTAL_RESOURCE_NAME using the same patterns
#    EV2 uses (deploy/services/<svc>/Ev2*Deployment/serviceModel.json):
#      RESOURCE_GROUP         = ${RESOURCE_PREFIX}-<regionShort>-rg
#      GLOBAL_RESOURCE_PREFIX = ${RESOURCE_PREFIX}global
#      GLOBAL_RESOURCE_GROUP  = ${GLOBAL_RESOURCE_PREFIX}

# 3. Deploy. Use the same env name passed to new-env.
npm run deploy -- all foo

# 4. Single-service / single-step deploys
npm run deploy -- worker foo
npm run deploy -- worker foo --steps build,push
npm run deploy -- baseinfra foo --steps bicep
```

The reserved labels `dev` and `prod` are NOT valid OSS env names — they
are used by the EV2 path for ServiceGroup naming.

### First-time bring-up (`all`)

For an end-to-end deploy on a fresh subscription / cluster, use the `all`
aggregate. It runs the canonical EV2-equivalent sequence
(`globalinfra → baseinfra → worker → portal`) in a single invocation,
sharing the same env map across services so Bicep outputs (ACR login
server, deployment storage account, etc.) cascade forward automatically:

```bash
# Full bring-up (all infra + both services, default pipeline per service)
npm run deploy -- all foo

# Infra-only refresh across all services
npm run deploy -- all foo --steps bicep

# App-only redeploy (skips infra services automatically — their default
# pipeline doesn't include manifests/rollout, so the intersection is empty
# and they're logged as "no applicable steps")
npm run deploy -- all foo --steps manifests,rollout
```

In `all` mode each service's Bicep step deploys **only its own module** —
dependencies (e.g. BaseInfra) were already deployed by an earlier item
in the same invocation, so we don't redundantly re-apply them. Outside
of `all` mode, single-service invocations still redeploy their
dependencies (idempotent, but slower) so a one-off `worker foo` works
even if BaseInfra hasn't been refreshed in this shell.

The mapping `service → module(s)` is in
[`deploy/scripts/lib/service-info.mjs`](lib/service-info.mjs)
(`SERVICE_TO_MODULES` for single-service, `ALL_MODE_MODULES` for `all`).

The `package.json` wrapper exposes the same CLI:

```bash
npm run deploy -- worker foo --steps manifests
```

> **Note**: when invoking via `npm run deploy`, separate npm flags from
> deploy-script flags with `--`. Inside the scripts themselves the entry
> point is `deploy/scripts/deploy.mjs`; you can call `node` directly if
> you prefer (e.g. `node deploy/scripts/deploy.mjs worker foo`).

## CLI reference

```
npm run deploy -- <service> <env> [flags]

Services:  worker | portal | baseinfra | globalinfra | all
Envs:      a local env name created with `npm run deploy:new-env`

Flags:
  --steps <list>      build,bicep,push,manifests,rollout (or 'noop')
  --region <name>     Override LOCATION from <env>.env
  --image-tag <tag>   Default: <env>-<short-sha>[-dirty]
  --clean             Wipe deploy/.tmp/<service>-<env>/ before running
  --force             Ignore deploy markers; redeploy every Bicep module even
                      if its template + rendered params are unchanged
  --help, -h
```

### Step matrix

| Step | What it does | Applies to |
|---|---|---|
| `noop` | Load env, run preflight (Azure login + subscription match), exit. | all |
| `build` | `docker build` the service image and `docker save` to a tarball under `deploy/.tmp/<svc>-<env>/`. | worker, portal |
| `push` | `oras cp` the tarball into the per-region ACR (no Docker daemon push). | worker, portal |
| `bicep` | Render `deploy/services/<Module>/bicep/<Module>.params.template.json` with `${VAR}` substitution from the env map, then `az deployment {sub|group} create`. Captures Bicep outputs back into the env map for downstream steps. | per-service module list |
| `seed-secrets` | Read seedable secrets (`GITHUB_TOKEN` + `ANTHROPIC_API_KEY`) from the loaded env map (set by `new-env` in `deploy/envs/local/<name>/env`), validate they are non-empty, and `az keyvault secret set` each into the env's KV. SPC mounts them into the worker pod. See [Secrets & identity](#secrets--identity-bicep-deploy-path-only). | baseinfra |
| `manifests` | Substitute the overlay `.env` using the env map, stage the rendered `gitops/<svc>/` tree under `deploy/.tmp/<svc>-<env>/`, then `az storage blob upload-batch` the **unrendered** Kustomize tree to the Flux Storage Bucket. Flux reconciles the cluster from there. Worker / cert-manager / cert-manager-issuers each use a single `overlays/default` overlay (per-env values flow in via the staged `.env`); Portal overlays are keyed by `${EDGE_MODE}-${TLS_SOURCE}` (`overlays/afd-letsencrypt`, `overlays/afd-akv`, `overlays/private-akv` — `akv-selfsigned` shares the `private-akv` overlay). | worker, portal |
| `rollout` | `flux reconcile kustomization <svc>-<svc> -n flux-system --with-source` (forces the Bucket source to re-pull the just-uploaded blobs and the Kustomization to apply that revision), then `kubectl rollout status deployment/<svc>` in `NAMESPACE`, then verifies live `image` ends with the expected tag. | worker, portal |

The default pipeline (no `--steps`) is the full chain. For `baseinfra`
and `globalinfra` the chain ends at `bicep` (no app artifacts to roll
out).

## Env-file schema

Every deploy targets a personal local env at `deploy/envs/local/<name>/env`
(the entire `local/` directory is gitignored). Local env files are
**standalone** — `deploy.mjs` reads them directly with no runtime cascade
onto a shared base file.

`deploy/envs/template.env` is a checked-in template consumed only by the
scaffolder (`npm run deploy:new-env`): it copies the template, substitutes
deployment-target keys, prompts for per-stamp secrets, and writes the
complete file under `local/<name>/env`. Subsequent edits to `template.env`
affect only newly-scaffolded envs — never existing ones.

`dev` and `prod` are reserved labels used by the EV2 path for ServiceGroup
naming; they are NOT valid OSS env names.

Files are flat `KEY=value`, no quoting, no shell expansion.

| Key | Used by | Notes |
|---|---|---|
| `SUBSCRIPTION_ID` | preflight | Must match `az account show --query id`. |
| `LOCATION`, `RESOURCE_GROUP`, `RESOURCE_PREFIX` | bicep, manifests, rollout | Region + RG + Bicep `resourceNamePrefix`. |
| `GLOBAL_RESOURCE_GROUP`, `GLOBAL_RESOURCE_PREFIX` | bicep (globalinfra) | Front Door RG + prefix. |
| `PORTAL_RESOURCE_NAME` | bicep (portal) | Portal logical name. |
| `NAMESPACE` | manifests, rollout | Target Kubernetes namespace (`pilotswarm` per A-11). |
| `EDGE_MODE` | bicep, manifests, rollout | `afd` (default) or `private`. Controls AFD/AppGw/AGIC vs AKS web-app-routing addon. Drives Portal overlay path. |
| `TLS_SOURCE` | bicep, manifests | `letsencrypt` \| `akv` \| `akv-selfsigned`. Drives Portal overlay path and AKV cert issuer. See [docs/deploying-to-aks.md](../../docs/deploying-to-aks.md) for the supported `(EDGE_MODE × TLS_SOURCE)` combos. |
| `HOST`, `PRIVATE_DNS_ZONE` | bicep (portal), rollout (portal) | Required when `EDGE_MODE=private`. Bicep provisions the Private DNS Zone + VNet link; deploy.mjs writes the A record `${HOST}.${PRIVATE_DNS_ZONE}` → internal LB IP after Portal rollout. |
| `ACME_EMAIL` | bicep (cert-manager-issuers) | Required when `TLS_SOURCE=letsencrypt`. Let's Encrypt registration / renewal-failure notices. |
| `PORTAL_TLS_ISSUER_NAME` | bicep (portal) | Optional override for the AKV cert issuer name. Defaults to `OneCertV2-PublicCA` (afd) / `OneCertV2-PrivateCA` (private), auto-registered by Portal bicep. |
| `AZURE_TENANT_ID` | manifests | Workload identity federation tenant. |
| `PORTAL_HOSTNAME` | manifests (portal) | Public hostname for AFD origin. |
| `SSL_CERT_DOMAIN_SUFFIX`, `WAF_MODE`, `ACR_SKU`, `APP_GATEWAY_PRIVATE_IP` | bicep | Static infra params. |
| `IMAGE` | manifests | Auto-composed from `ACR_LOGIN_SERVER` + service image repo + `--image-tag`; do **not** seed manually. |

**Bicep outputs are never seeded.** `ACR_NAME`, `ACR_LOGIN_SERVER`, `KV_NAME`,
`AKS_CLUSTER_NAME`, `BLOB_CONTAINER_ENDPOINT`, `DEPLOYMENT_STORAGE_ACCOUNT_NAME`,
`DEPLOYMENT_STORAGE_CONTAINER_NAME`, `WORKLOAD_IDENTITY_CLIENT_ID`,
`APPROVAL_MANAGED_IDENTITY_ID`, `FRONT_DOOR_*`, `APPLICATION_GATEWAY_NAME`,
`PRIVATE_LINK_CONFIGURATION_NAME`
all cascade into the env Map at runtime via the FR-022 alias map. A full
`node deploy.mjs all <env>` invocation handles this end-to-end. Standalone
split-step runs (e.g. `worker dev --steps manifests` without first running
`--steps bicep` in the same process) fail fast with a clear "unresolved
placeholder" error directing you to run a prior `--steps bicep`.

## How `.env` substitution works (vs. EV2)

| | EV2 path | OSS path |
|---|---|---|
| Source | `*.Configuration.json` per service | `deploy/envs/local/<name>/env` (standalone, scaffolded from `deploy/envs/template.env`) |
| Scope binding | EV2 RP injects subscription / region / IDs into the parameters JSON | `deploy/scripts/lib/common.mjs` resolves env file → JS Map |
| `.env` substitution | `GenerateEnvForEv2.ps1` rewrites overlay `.env` from JSON params | `deploy/scripts/lib/substitute-env.mjs` rewrites overlay `.env` from the env map |
| Per-service identity | Per-service scope binding | Shared `csiIdentity` UAMI clientId cascades from BaseInfra Bicep output → both worker and portal overlays |

Both paths produce the **same rendered overlay `.env`** before upload.
The Kustomize tree itself is uploaded **unrendered** — Flux runs
`kustomize build` in-cluster against the substituted `.env`.

If a key referenced by the overlay `.env` is not present in the env
map, the substitute step **fails closed** with a sorted list of missing
keys before any file is written.

## Bicep param flow

`deploy/services/<Module>/bicep/<Module>.params.template.json` files use
literal `${VAR}` placeholders. The `bicep` step:

2. Reads the template, substitutes `${VAR}` from the env map (via `render-params.mjs`).
2. Writes the rendered JSON under `deploy/.tmp/<svc>-<env>/params/`.
3. Runs `az deployment {sub|group} create` with `--parameters @<rendered>.json`.
4. Captures named outputs back into the env map (e.g. `acrLoginServer`, `kvName`) so later steps can consume them.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Subscription mismatch` | `az account show` returns a different sub than `<env>.env`. | `az account set --subscription "<id>"`. |
| `Required CLI 'oras' not found` | `oras` not on PATH. | Install per [oras.land](https://oras.land/docs/installation). |
| `Missing keys for overlay .env: …` | `<env>.env` is missing keys that the overlay references. | Run `--steps bicep` first to populate Bicep-output keys in the same process. |
| `Live image tag mismatch` after rollout | `flux reconcile --with-source` returned but the Deployment still shows the prior image. | Re-run `--steps rollout`. If persistent, inspect with `kubectl describe kustomization/<svc>-<svc> -n flux-system` and `flux get sources bucket -n flux-system` to confirm the Bucket artifact revision and the Kustomization's `lastAppliedRevision` agree. |

## Tests

Stdlib-only unit tests cover the two trickiest pieces of the orchestrator:
the fail-closed `.env` substitution rules and the FR-022 Bicep-output
alias map.

```sh
npm run test:deploy-scripts
```

Test files live at `deploy/scripts/test/*.test.mjs` and run with the
built-in Node test runner (no new dependencies).

## Secrets & identity (bicep-deploy path only)

This deploy path uses **managed identity for Azure resources** and keeps a
single gitignored env file holding only the two human-only secrets the
runtime cannot bootstrap on its own.

> **Legacy `scripts/deploy-aks.sh` is unchanged.** It still builds the
> `copilot-runtime-secrets` K8s secret from local env vars
> (`DATABASE_URL`, `GITHUB_TOKEN`, `AZURE_STORAGE_CONNECTION_STRING`,
> etc.) and the runtime falls through to legacy connection-string code
> paths because `PILOTSWARM_USE_MANAGED_IDENTITY` is unset.

### Per-env secrets file

`npm run deploy:new-env` prompts for the two seedable secrets and appends
them to `deploy/envs/local/<name>/env` (gitignored — the entire
`deploy/envs/local/` directory is excluded by
`deploy/envs/.gitignore`). Required keys:

| Key | Why it's a secret | How it's used |
|---|---|---|
| `GITHUB_TOKEN` | Human-issued PAT, cannot be created at deploy time | Synced to KV → mounted into worker pod via SPC as `github-token` |
| `ANTHROPIC_API_KEY` | Vendor-issued API key | Synced to KV → mounted as `anthropic-api-key` |

Everything else that used to live in K8s secrets is now either:
- **Config** (e.g. `DATABASE_URL`, `AZURE_STORAGE_ACCOUNT_URL`,
  `KV_NAME`, `DEPLOYMENT_STORAGE_ACCOUNT_NAME`) — sourced from Bicep
  outputs, surfaced via the worker `ConfigMap` in the rendered overlay; or
- **Acquired at runtime** via managed identity — Postgres AAD tokens
  for CMS+facts; Blob OAuth tokens for session blobs.

The `seed-secrets` step reads those two keys from the loaded env map,
validates both are non-empty, then `az keyvault secret set` for each.
It runs **after** `bicep` (so the KV exists) and **before**
`manifests`/`rollout`.

### Managed identity feature switch

The bicep-deploy path enables MI mode by setting these in the overlay
`.env` (substituted into the worker `ConfigMap`):

| Key | Effect |
|---|---|
| `PILOTSWARM_USE_MANAGED_IDENTITY=1` | Master switch. Both blob and Postgres factories follow the MI branch. |
| `AZURE_STORAGE_ACCOUNT_URL=https://<acct>.blob.core.windows.net/` | Worker constructs `BlobServiceClient(accountUrl, DefaultAzureCredential)`. SAS generation throws `NotSupportedInManagedIdentityMode` — artifact downloads must proxy through the worker. |
| `PILOTSWARM_CMS_FACTS_DATABASE_URL=postgresql://<aad-user>@<fqdn>:5432/<db>?sslmode=require` | Passwordless URL for CMS + facts pools. The factory installs an AAD token callback (`https://ossrdbms-aad.database.windows.net/.default`). |
| `PILOTSWARM_DB_AAD_USER=<csi-uami-display-name>` | Postgres AAD admin role name = CSI UAMI display name. Used to build `aadUser` in the factory. |
| `DATABASE_URL=postgresql://<bootstrap-pwd-user>:<pwd>@<fqdn>:5432/<db>` | **Still password-based.** Used only by duroxide, whose `JsPostgresProvider.connect()` has no token-callback hook. CMS+facts ignore it in MI mode. |

`deploy.mjs` composes `AZURE_STORAGE_ACCOUNT_URL` from the
`BLOB_CONTAINER_ENDPOINT` Bicep output, and composes
`PILOTSWARM_CMS_FACTS_DATABASE_URL` + `PILOTSWARM_DB_AAD_USER` from
`POSTGRES_FQDN` + `POSTGRES_AAD_ADMIN_PRINCIPAL_NAME`.

### Bicep-side identity wiring

- **Storage** (`storage.bicep`) grants *Storage Blob Data Contributor*
  on the session blob container scope to the CSI UAMI principal.
- **Postgres** (`postgres.bicep`) enables AAD auth alongside password
  auth and assigns the CSI UAMI as primary AAD admin
  (`flexibleServers/administrators` resource keyed by principal object ID,
  display-name surfaced as the role name).

Both reuse the same CSI UAMI federated to the worker's KSA, so a single
identity covers KV → SPC, blob, and Postgres access.

### Hybrid Postgres rationale

Duroxide's `JsPostgresProvider.connect(databaseUrl)` only accepts a URL
string and has no token-callback hook upstream. The deploy path takes
the **hybrid** approach until a duroxide PR lands:

- **CMS + facts** → AAD via `pg-pool-factory.ts` (`buildPgPoolConfig`)
- **Duroxide store** → password URL (`DATABASE_URL`), bicep-managed,
  rotated like any other bootstrap admin password

Per `Duroxide Bugs` in `.github/copilot-instructions.md`, this is a
deliberate, user-approved compromise — not a workaround that should
spread elsewhere.

## Model providers (LLM catalog)

The worker reads `model_providers.json` at startup to discover which
LLM endpoints + models are available. In the bicep-deploy path the
canonical catalog lives at
[`deploy/gitops/worker/base/model_providers.json`](../gitops/worker/base/model_providers.json)
and is mounted into the pod via a kustomize-generated ConfigMap
(`copilot-worker-model-providers`) at `/app/config/model_providers.json`.
`PS_MODEL_PROVIDERS_PATH` is set on the deployment so the runtime picks
it up.

> **Legacy `scripts/deploy-aks.sh` is unaffected.** It still bakes
> `deploy/config/model_providers.ghcp.json` into the Docker image and
> reads it from `/app/.model_providers.json`.

### Built-in providers

The base catalog supplies three classes of providers:

| Provider | Auth | Source of secret/endpoint |
|---|---|---|
| `ghcp` (GitHub Copilot) | `GITHUB_TOKEN` (KV → SPC) | Static endpoint `https://api.githubcopilot.com` |
| `anthropic` (direct) | `ANTHROPIC_API_KEY` (KV → SPC, optional, sentinel-tolerant) | Static endpoint `https://api.anthropic.com` |
| `azure-foundry`, `azure-foundry-router` | `AZURE_OAI_KEY` (KV → SPC) | `__FOUNDRY_ENDPOINT__` placeholder, substituted at staging from the `FOUNDRY_ENDPOINT` Bicep output |

Foundry is **opt-in per stamp**. When `FOUNDRY_ENABLED=false`:
- `foundry.bicep` is skipped and no Foundry account is created.
- `auto-secrets-sentinel.bicep` writes the `__PS_UNSET__` sentinel into
  the `azure-oai-key` KV secret so the SPC mount still succeeds.
- The placeholder remains unresolved in the staged catalog; the worker's
  catalog loader silently drops the Foundry providers (their `apiKey:
  env:AZURE_OAI_KEY` resolves to the stripped sentinel → undefined).

### Enabling Foundry

1. `npm run deploy:new-env -- <name> --foundry-enabled y` — prompts you
   to populate `deploy/envs/local/<name>/foundry-deployments.json` with
   the deployment list. The scaffolder writes a starter array; the
   stdout banner lists common entries to copy in (gpt-5 family,
   gpt-4o, etc.). The file is parsed by `az` as a `--parameters
   foundryDeployments=@<file>` value, so it must be valid JSON.
2. Run `--steps bicep` for `base-infra`. `foundry.bicep` provisions one
   `Microsoft.CognitiveServices/accounts` (kind=AIServices) per stamp,
   declares each entry as a child `accounts/deployments` resource, and
   writes the account key to KV as `azure-oai-key` via co-located
   `listKeys()` (no separate auto-secrets module). The endpoint is
   surfaced to the env map as `FOUNDRY_ENDPOINT`.
3. Re-run `--steps manifests`. The placeholder
   `__FOUNDRY_ENDPOINT__/openai/v1` is rewritten to the real Foundry
   endpoint URL (trailing slash collapsed). Flux reconciles; the
   worker's catalog now has live Foundry providers.

### Per-stamp catalog overrides

To diverge from the base catalog for a single stamp, drop a kustomize
overlay patch on the `copilot-worker-model-providers` ConfigMap in
`deploy/gitops/worker/overlays/<overlay>/`. Keep the placeholder in the
patched JSON if you still want endpoint substitution; drop it if you
hard-code the URL.

> Phase 2 (SDK Entra-mode) and Phase 3 (Foundry-hosted Claude) are
> tracked in [`docs/proposals/foundry-entra-mode-auth.md`](../../docs/proposals/foundry-entra-mode-auth.md)
> and [`docs/proposals/foundry-hosted-claude.md`](../../docs/proposals/foundry-hosted-claude.md).
> Until those land, Foundry uses key auth and Claude is direct-Anthropic.

## Cross-references

- EV2 / production path: [`docs/deploying-to-aks-ev2.md`](../../docs/deploying-to-aks-ev2.md)
- Imperative engineer-smoke path: [`docs/deploying-to-aks.md`](../../docs/deploying-to-aks.md)
- Spec / plan / as-built record: [`.paw/work/oss-deploy-script/`](../../.paw/work/oss-deploy-script/)
