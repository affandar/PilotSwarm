# OSS Node deploy orchestrator (`deploy/scripts/`)

A multi-platform Node.js deploy driver for PilotSwarm on AKS that
**coexists with** — and never replaces — the existing paths:

| Path | What it is | When to use |
|---|---|---|
| `scripts/deploy-aks.sh` | Imperative bash script targeting an existing dev cluster (`docs/deploying-to-aks.md`). | Engineer smoke loop on a one-off cluster. |
| _enterprise deployment orchestrator_ (internal-only) | Enterprise-driven GitOps deploy (Bicep + Kustomize + Flux Storage Bucket). | Production rollouts via the enterprise deployment path. |
| **`deploy/scripts/deploy.mjs`** *(this README)* | OSS-friendly equivalent of the enterprise path, runnable from any contributor's box without the enterprise path. | Reproducing the GitOps deploy locally; future GitHub Actions wrapper. |

Same outcome as the enterprise path: Bicep deployed → image pushed to ACR →
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
`deploy/envs/local/<name>/.env`, scaffolded by `npm run deploy:new-env`
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
#    that the enterprise deployment manifests use:
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
are used by the enterprise path for ServiceGroup naming.

### First-time bring-up (`all`)

For an end-to-end deploy on a fresh subscription / cluster, use the `all`
aggregate. It runs the canonical enterprise-equivalent sequence
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
  --force-module <m>  Force-redeploy a single named Bicep module (e.g. portal,
                      pls-anchor). Repeatable. Lighter-touch than --force when
                      only one module needs to retry past its deploy marker
                      (e.g. recover from an out-of-band Bicep tweak or RBAC
                      propagation race).
  --help, -h
```

### Step matrix

| Step | What it does | Applies to |
|---|---|---|
| `noop` | Load env, run preflight (Azure login + subscription match), exit. | all |
| `build` | `docker build` the service image and `docker save` to a tarball under `deploy/.tmp/<svc>-<env>/`. | worker, portal |
| `push` | `oras cp` the tarball into the per-region ACR (no Docker daemon push). | worker, portal |
| `bicep` | Render `deploy/services/<Module>/bicep/<Module>.params.template.json` with `${VAR}` substitution from the env map, then `az deployment {sub|group} create`. Captures Bicep outputs back into the env map for downstream steps. | per-service module list |
| `seed-secrets` | Read seedable secrets (`GITHUB_TOKEN` + `ANTHROPIC_API_KEY`) from the loaded env map (set by `new-env` in `deploy/envs/local/<name>/.env`), `az keyvault secret set` each into the env's KV (writing `__PS_UNSET__` for any left blank). SPC mounts them into the worker pod; the runtime strips sentinel values at startup. See [Secrets & identity](#secrets--identity-bicep-deploy-path-only). | baseinfra |
| `manifests` | Substitute the overlay `.env` using the env map, stage the rendered `gitops/<svc>/` tree under `deploy/.tmp/<svc>-<env>/`, then `az storage blob upload-batch` the **unrendered** Kustomize tree to the Flux Storage Bucket. Flux reconciles the cluster from there. Worker / cert-manager / cert-manager-issuers each use a single `overlays/default` overlay (per-env values flow in via the staged `.env`); Portal overlays are keyed by `${EDGE_MODE}-${TLS_SOURCE}` (`overlays/afd-letsencrypt`, `overlays/afd-akv`, `overlays/private-akv` — `akv-selfsigned` shares the `private-akv` overlay). | worker, portal |
| `rollout` | `flux reconcile kustomization <svc>-<svc> -n flux-system --with-source` (forces the Bucket source to re-pull the just-uploaded blobs and the Kustomization to apply that revision), then `kubectl rollout status deployment/<svc>` in `NAMESPACE`, then verifies live `image` ends with the expected tag. | worker, portal |

The default pipeline (no `--steps`) is the full chain. For `baseinfra`
and `globalinfra` the chain ends at `bicep` (no app artifacts to roll
out).

## Env-file schema

Every deploy targets a personal local env at `deploy/envs/local/<name>/.env`
(the entire `local/` directory is gitignored). Local env files are
**standalone** — `deploy.mjs` reads them directly with no runtime cascade
onto a shared base file.

`deploy/envs/template.env` is a checked-in template consumed only by the
scaffolder (`npm run deploy:new-env`): it copies the template, substitutes
deployment-target keys, prompts for per-stamp secrets, and writes the
complete file under `local/<name>/.env`. Subsequent edits to `template.env`
affect only newly-scaffolded envs — never existing ones.

`dev` and `prod` are reserved labels used by the enterprise path for ServiceGroup
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
| `OBO_KEK_KID` | bicep (base-infra), manifests (worker + portal) | Un-versioned AKV key URL for the User OBO envelope KEK. Sourced from the `oboKekKid` bicep output (alias map) when `oboEnabled=true`; otherwise composed to the `__PS_UNSET__` sentinel and stripped at runtime. See [docs/operations/obo-kek-runbook.md](../../docs/operations/obo-kek-runbook.md). |
| `OBO_SMOKE_ENABLED`, `OBO_SMOKE_WORKER_APP_*`, `OBO_SMOKE_TEST_USER_UPN` | manifests (worker overlay only) | Optional OBO live-smoke harness toggle + per-stamp downstream-app config. Default `false`; when `true`, the worker registers the `obo.smoke.*` plugin tools. AKS uses workload-identity FIC (no `CLIENT_SECRET` in the overlay); local dev can set the secret out-of-band. **Never enable on production stamps.** See [docs/operations/live-smoke.md](../../docs/operations/live-smoke.md). |

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

## How `.env` substitution works (vs. The enterprise path)

| | Enterprise path | OSS path |
|---|---|---|
| Source | `*.Configuration.json` per service | `deploy/envs/local/<name>/.env` (standalone, scaffolded from `deploy/envs/template.env`) |
| Scope binding | the enterprise orchestrator injects subscription / region / IDs into the parameters JSON | `deploy/scripts/lib/common.mjs` resolves env file → JS Map |
| `.env` substitution | the enterprise param-substitution helper rewrites overlay `.env` from JSON params | `deploy/scripts/lib/substitute-env.mjs` rewrites overlay `.env` from the env map |
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

Stdlib-only unit tests cover the orchestrator's trickiest pieces (overlay
substitution rules, FR-022 Bicep-output alias map, deploy-marker hashing,
manifest publish atomicity, private-endpoint approval, and Dockerfile
lockfile enforcement).

```sh
npm run test:deploy-scripts
```

Test files live at `deploy/scripts/test/*.test.mjs` and run with the
built-in Node test runner (no new dependencies). The suite is gated on PRs
and pushes to `main` by `.github/workflows/deploy-scripts-tests.yml`
whenever `deploy/scripts/**`, `deploy/services/**/deploy.json`,
`deploy/services/**/bicep/**`, the worker/portal Dockerfiles, the root
package manifest/lockfile, or that workflow itself changes.

### Per-module redeploy controls

For one-off operator overrides, `--force-module <name>` on the deploy
orchestrator forces a single named module past its deploy marker for the
current invocation. Repeatable; lighter-touch than `--force` which
bypasses markers for every module.

### Manual verification protocol — private-endpoint approval

After landing the FR-015 hardening of
`deploy/services/common/bicep/approve-private-endpoint.bicep`, two
operator-driven checks should be run against a real AFD-fronted stamp:

1. **Idempotency**: re-run the deploy against an environment whose AFD
   private-endpoint is already Approved. The bicep deployment-script
   should exit 0 quickly via the idempotency pre-check (no polling). The
   portal module's deploy-marker matches on unchanged inputs, so the
   normal deploy is a no-op skip; use `--force-module portal` to actually
   re-run the approval bicep when verifying this.
2. **Minimum-role compatibility**: deploy from an identity holding only
   the documented minimum role assignment on the Application Gateway
   (Network Contributor scoped to the AppGw, no broader Reader). The
   `list_pe_connections` retry helper should not be exercised on the
   happy path; if it is, stderr will surface the underlying `az` error
   instead of being misclassified as "no pending connections".

If either check fails, the regression tests in `approve-pe.test.mjs`
should be extended to cover the new failure mode before re-attempting.

#### Note: AFD post-approval propagation delay

Approving the PE on the AppGw is necessary but **not sufficient** for the
AFD endpoint to start serving traffic. AFD does not continuously poll the
PE connection state — it only re-evaluates Private Link wiring as part
of each origin **deployment cycle**. If the PE is approved after AFD's
most recent cycle completed, AFD will not pick up the approval until its
next organic cycle, which the FAQ documents at
[**"up to 20 minutes" for a single configuration update**][afd-faq]
(back-to-back changes can extend to ~40 min). The Private Link how-to
adds: ["it can take a few minutes for the connection to be
established"][afd-pl-appgw] after approval. In practice we see
**15–30 minutes** end-to-end.

During that window the AFD endpoint returns AFD's default 404 HTML page
(consistent ~260 KB body, identical for `/`, `/api/health`, etc., with
an `x-azure-ref` response header). The AFD origin's
`sharedPrivateLinkResource.deploymentStatus` may also show `NotStarted`:
that field is a [documented read-only AFD edge-propagation state][afd-state-spec]
(values: `NotStarted`, `InProgress`, `Succeeded`, `Failed`), separate
from `provisioningState`, and it can persist as `NotStarted` even after
the endpoint becomes reachable — so it is not a reliable health signal.

Operator guidance:

- Confirm the PE on the AppGw shows `status=Approved,
  provisioningState=Succeeded`. If yes, the deploy did its job — wait.
- Re-test the AFD endpoint with `curl -i https://$AFD_HOSTNAME/api/health`
  after 15–30 minutes. A small-body `200` (no `x-azure-ref` header)
  confirms AFD has propagated.
- If still 404 after ~30 minutes, a no-op
  `az afd origin update … --enable-private-link true …` PUT against the
  origin re-triggers AFD's deployment cycle, which re-evaluates the
  now-Approved PE state. Re-running the bicep with `--force-module portal`
  is roughly equivalent.

[afd-faq]: https://learn.microsoft.com/en-us/azure/frontdoor/front-door-faq
[afd-pl-appgw]: https://learn.microsoft.com/en-us/azure/frontdoor/how-to-enable-private-link-application-gateway
[afd-state-spec]: https://github.com/Azure/azure-rest-api-specs/blob/main/specification/cdn/resource-manager/Microsoft.Cdn/Cdn/stable/2024-09-01/afdx.json

## Secrets &amp; identity (bicep-deploy path only)

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
them to `deploy/envs/local/<name>/.env` (gitignored — the entire
`deploy/envs/local/` directory is excluded by
`deploy/envs/.gitignore`). Seedable keys:

| Key | Why it's a secret | How it's used |
|---|---|---|
| `GITHUB_TOKEN` | Optional. Human-issued PAT, cannot be created at deploy time. When blank, the deploy writes the `__PS_UNSET__` sentinel into KV; users supply their own per-user GitHub Copilot key via the Admin panel instead. | Synced to KV → mounted into worker pod via SPC as `github-token` |
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
| `DATABASE_URL=postgresql://<bootstrap-pwd-user>:<pwd>@<fqdn>:5432/<db>` | Password URL kept available for the legacy `scripts/deploy-aks.sh` flow and as a fallback when MI is not configured. In MI mode the duroxide store ignores any password in this URL and authenticates via duroxide-node's native Entra path (`PostgresProvider.connectWithSchemaAndEntra`, duroxide-node ≥ 0.1.25). |

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

### Postgres auth rationale

In MI mode all three Postgres consumers — CMS, facts, and the duroxide
orchestration store — authenticate to Azure Database for PostgreSQL
Flexible Server via Microsoft Entra ID:

- **CMS + facts** → AAD via `pg-pool-factory.ts` (`buildPgPoolConfig`),
  using `DefaultAzureCredential` and pg's `password` callback.
- **Duroxide store** → AAD via `duroxide-provider-factory.ts`
  (`createDuroxidePostgresProvider`), which calls duroxide-node's
  `PostgresProvider.connectWithSchemaAndEntra`. Duroxide resolves its
  credential chain in Rust (WorkloadIdentity → ManagedIdentity →
  DeveloperTools).

`DATABASE_URL` (password URL) is kept alongside for the legacy
`scripts/deploy-aks.sh` flow; in MI mode the duroxide store ignores any
embedded password. Fully passwordless deployments may flip
`passwordAuth: 'Disabled'` on the Bicep `postgres.bicep` module and
drop the bootstrap admin password from Key Vault and the
SecretProviderClass once their deploy path is on duroxide-node ≥ 0.1.25
(pilotswarm-sdk ≥ 0.1.30).

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
| `ghcp` (GitHub Copilot) | `GITHUB_TOKEN` (KV → SPC, optional, sentinel-tolerant; per-user PAT via Admin overrides) | Static endpoint `https://api.githubcopilot.com` |
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

- Enterprise / production path: handled by an internal-only orchestrator (out of scope for this OSS repo)
- Imperative engineer-smoke path: [`docs/deploying-to-aks.md`](../../docs/deploying-to-aks.md)
- User OBO envelope KEK provisioning + rotation: [`docs/operations/obo-kek-runbook.md`](../../docs/operations/obo-kek-runbook.md)
- User OBO live-smoke harness (opt-in): [`docs/operations/live-smoke.md`](../../docs/operations/live-smoke.md)
- Spec / plan / as-built record: [`.paw/work/oss-deploy-script/`](../../.paw/work/oss-deploy-script/)
