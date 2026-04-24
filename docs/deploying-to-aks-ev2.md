# Deploying PilotSwarm to AKS via EV2 + GitOps

> **See also** [`docs/deploying-to-aks.md`](./deploying-to-aks.md) for the
> existing imperative script-driven path. **Both paths are supported; this
> document does not deprecate the imperative path.** Operators MUST pick
> one path per cluster — the two flows target the same `copilot-runtime`
> namespace and will step on each other if run concurrently.

This guide describes the GitOps-based production deploy path: per-region
Azure resources are provisioned by EV2 Bicep rollouts, rendered Kustomize
manifests are uploaded to Azure Blob Storage, and Flux on AKS reconciles
the cluster toward those blobs. No `kubectl apply` is ever run by a
human.

## Architecture

The GitOps path is composed of **four independent EV2 ServiceGroups**:

| ServiceGroup | Scope | Purpose |
|---|---|---|
| **GlobalInfra** | Subscription | Azure Front Door Premium profile + WAF policy + security policy (fleet-wide, one per environment). |
| **BaseInfra** | Resource Group (per region) | AKS + ACR + Azure DB for PostgreSQL + Storage + Key Vault + VNet + private-link-ready Application Gateway + `microsoft.flux` / CSI addons + per-deployable FluxConfigs. |
| **Worker** | Per region (app-only) | Pushes the worker image to the per-region ACR, renders the worker Kustomize overlay, uploads the manifest bundle to the `worker-manifests` blob container. Owns no Azure resources. |
| **Portal** | Per region (service infra + app, single SG) | Ordered single rollout (via `rolloutSpec.dependsOn`): (1) `PortalServiceInfra` — registers a per-region AFD origin + route and auto-approves the pending Private Link Service connection on the AppGW; (2–4) same 3-step app rollout as Worker, targeting `portal-manifests`. Matches the postgresql-fleet-manager PlaygroundService "EV2 at service granularity" pattern — infra and app live in the same SG and are serialized with `dependsOn`, not a multi-SG gate. |

### Traffic path

```
Client (browser / CLI)
   │   HTTPS
   ▼
┌───────────────────────────────────────────────────────────────┐
│ Azure Front Door Premium  (global, GlobalInfra ServiceGroup)  │
│   - WAF policy (Detection in dev, Prevention in prod)         │
│   - Custom domain + managed TLS cert                          │
└───────────────────────────────────────────────────────────────┘
   │   Private Link (AFD → origin; PLS auto-approved by
   │   Portal Service Infra step via approve-private-endpoint.bicep)
   ▼
┌───────────────────────────────────────────────────────────────┐
│ Application Gateway  (per region, BaseInfra ServiceGroup)     │
│   - Private frontend IP only (no public listener)             │
│   - PrivateLinkConfiguration attached to frontend             │
│   - HTTP :80 backend (AFD terminates TLS; AppGW does not)     │
└───────────────────────────────────────────────────────────────┘
   │   AGIC (Application Gateway Ingress Controller addon)
   ▼
┌───────────────────────────────────────────────────────────────┐
│ AKS cluster  (per region, BaseInfra ServiceGroup)             │
│                                                               │
│   Ingress (ingressClassName: azure-application-gateway)       │
│     └──► Service ──► Portal Pods / Worker Pods                │
│                                                               │
│   FluxConfig (manifest-worker)  ◄── worker-manifests blob     │
│   FluxConfig (manifest-portal)  ◄── portal-manifests blob     │
│                                                               │
│   Secrets: AKV CSI driver mounts via SecretProviderClass,     │
│            authenticated by Workload Identity (UAMI + FIC).   │
└───────────────────────────────────────────────────────────────┘
                        ▲
                        │  Flux pulls manifest bundles
                        │  (uploaded by Worker / Portal App
                        │  rollouts' DeployApplicationManifest.sh)
┌───────────────────────────────────────────────────────────────┐
│ Azure Storage account  (per region, BaseInfra ServiceGroup)   │
│   containers: worker-manifests, portal-manifests              │
└───────────────────────────────────────────────────────────────┘
```

### Configuration flow

Every environment-specific value flows through a single deterministic
chain:

```
EV2 scope binding
   → rolloutParameters env var         (__TOKEN__ substitution)
      → GenerateEnvForEv2.ps1          (writes overlay .env)
         → kustomize configMapGenerator (behavior: merge)
            → replacements              (fan out into manifests)
               → rendered YAML          (uploaded to manifest blob)
                  → Flux reconcile      (applied to cluster)
```

No environment-specific literal ever lands in git.

## Prerequisites

### Azure / EV2

- **EV2 onboarding.** Your service must be registered in the EV2 portal
  with at least one service identifier for each of GlobalInfra,
  BaseInfra, Worker, and Portal (dev and prod environments each).
- **Subscriptions.** One dev subscription and one prod subscription (may
  be the same tenant). Both must have quota for AKS, AppGW, AFD Premium,
  Azure DB for PostgreSQL Flexible Server, and Azure Storage.
- **Required AKS addons** (provisioned automatically by BaseInfra Bicep):
  - `microsoft.flux` extension
  - `azureKeyvaultSecretsProvider` addon (AKV CSI driver)
  - Workload Identity + OIDC issuer
  - AGIC (Application Gateway Ingress Controller) addon

### CLI tools

| Tool | Purpose | Install |
|---|---|---|
| `az` | Azure CLI for Bicep builds + `rollout start` | <https://learn.microsoft.com/cli/azure/install-azure-cli> |
| `az rollout` extension | EV2 dev-test rollouts | `az extension add --name rollout` |
| `kubectl` | Kustomize renders + local cluster inspection | <https://kubernetes.io/docs/tasks/tools/> |
| `kustomize` | Standalone kustomize (optional; `kubectl kustomize` suffices) | <https://kubectl.docs.kubernetes.io/installation/kustomize/> |
| `docker buildx` | Local image builds (CI does this normally; `buildx` for `--platform linux/amd64` on Apple Silicon) | <https://docs.docker.com/build/> |
| `kubeconform` | *(Optional)* Kustomize output validation against CRD schemas | <https://github.com/yannh/kubeconform> |
| `markdownlint` | *(Optional)* Docs lint | `npm install -g markdownlint-cli` |

## Repository layout

```
deploy/
├── ev2/
│   ├── README.md                          High-level map of the EV2 tree.
│   ├── GlobalInfra/                       Fleet-wide Azure resources.
│   │   ├── bicep/                           Subscription-scope Bicep + bicepparams.
│   │   └── Ev2InfraDeployment/              ServiceModel + RolloutSpec + ScopeBinding + Parameters.
│   ├── BaseInfra/                         Per-region Azure resources.
│   │   ├── bicep/                           Resource-group-scope Bicep modules.
│   │   └── Ev2InfraDeployment/
│   ├── Worker/                            Worker service (single SG, app-only — no service Bicep).
│   │   ├── Ev2AppDeployment/                3-step rollout (Upload → GenerateEnv → DeployManifest).
│   │   └── ev2-deploy-dev.ps1               Dev-loop helper (stages working tree).
│   ├── Portal/                            Portal service (single SG combining service infra + app).
│   │   ├── bicep/                           AFD origin/route + PLS approval (ARM template).
│   │   ├── Ev2AppDeployment/                4-step rollout (PortalServiceInfra → Upload → GenerateEnv → DeployManifest).
│   │   └── ev2-deploy-dev.ps1
│   └── Common/
│       ├── bicep/                           Verbatim fleet-manager modules
│       │                                    (approve-private-endpoint, frontdoor-origin-route).
│       └── scripts/                         Shell extensions.
│           ├── UploadContainer.sh             Copy image holding ACR → per-region ACR.
│           ├── DeployApplicationManifest.sh   Render Kustomize + upload bundle to blob.
│           └── GenerateEnvForEv2.ps1          Write overlay .env from scope-binding env vars.
└── gitops/
    ├── validate.sh                        Renders every overlay; non-zero on failure.
    ├── worker/
    │   ├── base/                            namespace, SA, Deployment, SPC, kustomization.
    │   └── overlays/{dev,prod}/             .env (EV2-rendered) + kustomization merge.
    └── portal/
        ├── base/                            SA, Role, RoleBinding, Deployment, Service,
        │                                    Ingress, SPC, kustomization.
        └── overlays/{dev,prod}/
```

## Local validation

Every command below is copy-pasteable from the repo root. All are
expected to exit `0`.

```bash
# Kustomize renders. Should emit ≥204 lines (worker) / ≥297 lines (portal)
# of valid YAML against the placeholder values in base/kustomization.yaml.
kubectl kustomize deploy/gitops/worker/overlays/dev
kubectl kustomize deploy/gitops/worker/overlays/prod
kubectl kustomize deploy/gitops/portal/overlays/dev
kubectl kustomize deploy/gitops/portal/overlays/prod

# One-shot validator (renders all four overlays, collects failures).
bash deploy/gitops/validate.sh

# Bicep compile checks — all three main.bicep files.
az bicep build --file deploy/ev2/GlobalInfra/bicep/main.bicep
az bicep build --file deploy/ev2/BaseInfra/bicep/main.bicep
az bicep build --file deploy/ev2/Portal/bicep/main.bicep

# bicepparam compile checks — all six bicepparam files.
az bicep build-params --file deploy/ev2/GlobalInfra/bicep/parameters/dev.bicepparam
az bicep build-params --file deploy/ev2/GlobalInfra/bicep/parameters/prod.bicepparam
az bicep build-params --file deploy/ev2/BaseInfra/bicep/parameters/dev.bicepparam
az bicep build-params --file deploy/ev2/BaseInfra/bicep/parameters/prod.bicepparam
az bicep build-params --file deploy/ev2/Portal/bicep/parameters/dev.bicepparam
az bicep build-params --file deploy/ev2/Portal/bicep/parameters/prod.bicepparam

# What-if against a dev subscription (requires `az login`).
az deployment sub what-if \
  --location westus3 \
  --template-file deploy/ev2/GlobalInfra/bicep/main.bicep \
  --parameters deploy/ev2/GlobalInfra/bicep/parameters/dev.bicepparam

az deployment group what-if \
  --resource-group <dev-rg> \
  --template-file deploy/ev2/BaseInfra/bicep/main.bicep \
  --parameters deploy/ev2/BaseInfra/bicep/parameters/dev.bicepparam
```

*Optional:*

```bash
kubectl kustomize deploy/gitops/worker/overlays/dev | kubeconform -strict -
markdownlint docs/deploying-to-aks-ev2.md
```

## Dev-test rollout

The per-deployable PowerShell helpers stage the current **working tree**
(committed or not) into a temp `--service-group-root` and invoke
`az rollout start` against a dev EV2 Service Connection. Uncommitted
changes are picked up — this is the primary inner-loop affordance.

```powershell
# Worker dev rollout
pwsh deploy/ev2/Worker/ev2-deploy-dev.ps1

# Portal dev rollout
pwsh deploy/ev2/Portal/ev2-deploy-dev.ps1
```

**Prerequisites**:

- `az` logged in with permission to trigger rollouts on the dev service
  identifier.
- `az extension add --name rollout` has been run.
- `kubectl` on `PATH` (the helper renders a local Kustomize preview
  into the staging directory for inspection).

**Side effects**:

- Writes to a new temp directory under `$env:TEMP` /
  `[IO.Path]::GetTempPath()` — no repo mutation, no commits, no pushes.
- Triggers a rollout in the dev EV2 subscription via the configured
  Service Connection.

**Tracking progress**:

- The helper prints the `az rollout start` command and rollout ID.
- In the Azure portal: **Express v2 (EV2) → Rollouts** (scoped to the
  dev service identifier). Each shell-extension step has its own log
  stream.
- `kubectl -n copilot-runtime get pods -w` after reconcile to watch
  Flux apply the uploaded manifest bundle.

## Production rollout

Production rollouts are driven by the OneBranch Official pipelines in
`.pipelines/`:

| Pipeline | Purpose |
|---|---|
| `ci.yml` | Runs on PR merge to `main`. Builds worker + portal images with `docker buildx build --platform linux/amd64`, pushes to the **holding ACR** with an immutable `:$(Build.BuildId)` tag, publishes EV2 rollout artifacts. |
| `release-globalinfra.yml` | Prod release for GlobalInfra. Invokes `Ev2RARollout@2` with the Azure-managed SDP stage map. |
| `release-baseinfra.yml` | Prod release for BaseInfra (per region). |
| `release-worker.yml` | Prod release for the Worker ServiceGroup. |
| `release-portal.yml` | Prod release for the Portal ServiceGroup (single pipeline, **one stage**; step ordering inside the rollout spec serializes Portal service infra before the app steps). |

### Full-deploy rollout order

```
GlobalInfra   →   BaseInfra   →   Worker                  (app)
                              →   Portal  (infra + app, ordered in rolloutSpec)
```

- **GlobalInfra** must complete first — it publishes the AFD profile
  name / resource group that BaseInfra and Portal consume via
  `$serviceResourceDefinition(GlobalInfraResourceDefinition).action(deploy).outputs(…)`.
- **BaseInfra** must complete before Worker or Portal — the service SGs read
  `acrLoginServer`, `keyVaultName`, `blobContainerEndpoint`,
  `aksClusterName`, `applicationGatewayName`, and
  `privateLinkConfigurationName` from BaseInfra outputs.
- **Worker** and **Portal** may run in parallel once BaseInfra succeeds.
- Inside **Portal**, the rolloutSpec's `dependsOn` chain serializes
  `PortalServiceInfra` → `UploadContainer` → `GenerateEnvForEv2` →
  `DeployApplicationManifest`. The app steps read `BackendHostName` from
  the `PortalServiceInfra` step's Bicep outputs.

### Triggering a prod rollout

1. In Azure DevOps, open the target release pipeline.
2. Create a new release and select the CI build to release.
3. Approve each SDP stage in the managed stage map. Azure-managed SDP
   will enforce the per-stage bake times and health signals
   automatically.

> **Never push without explicit user permission** — per repo policy,
> manual approval at each SDP stage is the hard gate.

## Troubleshooting

### FluxConfig reconcile failures

```bash
kubectl get fluxconfig -A
kubectl describe fluxconfig -n copilot-runtime manifest-worker
kubectl logs -n flux-system -l app.kubernetes.io/name=source-controller
kubectl logs -n flux-system -l app.kubernetes.io/name=kustomize-controller
```

Common causes:

- **Blob container empty / bundle not yet uploaded.** The BaseInfra
  rollout creates the FluxConfig before the first App rollout has
  uploaded a manifest bundle, so the first reconcile after cluster
  bring-up will be `Non-Compliant` until the App SG rolls out.
- **Storage account firewall blocks AKS egress.** Verify the AKS
  cluster VNet is allowed on the storage account.

### AFD Private Link approval hang

The Portal `PortalServiceInfra` step runs
`deploy/ev2/Common/bicep/approve-private-endpoint.bicep`, a
`deploymentScript` that calls `az network private-endpoint-connection
approve` against the AppGW's `PrivateLinkConfiguration`. If the
connection stays `Pending`:

- Confirm the `approvalManagedIdentityId` bicepparam value is populated
  and that identity has **Network Contributor** (or equivalent) on the
  Application Gateway resource.
- Re-run the Portal rollout; the step is idempotent, and any later
  steps (`UploadContainer`, `GenerateEnvForEv2`, `DeployApplicationManifest`)
  will re-run only after the infra step succeeds.

### Kustomize `replacements` mismatches

When an overlay `.env` is missing a token name or misspells it, Kustomize
**silently leaves the placeholder** in the rendered output — there is no
error. Symptoms: the pod pulls `placeholder.azurecr.io/...` or the
ingress rule host is `portal.placeholder.example.com`.

- Cross-reference the [replacement table](#replacement-tables) below
  against the overlay `.env` (rendered by `GenerateEnvForEv2.ps1`).
- Re-run `bash deploy/gitops/validate.sh` — it renders each overlay and
  flags common mismatches.
- `kubectl kustomize deploy/gitops/<deployable>/overlays/<env> | grep placeholder`
  — any match is a bug.

### AKV CSI SecretProviderClass mount failure

Symptom: pod stuck in `ContainerCreating` with `MountVolume.SetUp failed
for volume "secrets-store"`.

- Check the `ServiceAccount` annotation:
  ```
  kubectl -n copilot-runtime get sa copilot-runtime-worker -o yaml
  ```
  `azure.workload.identity/client-id` **must** match the UAMI clientID
  passed as `__WORKLOAD_IDENTITY_CLIENT_ID__`.
- Check the Federated Identity Credential on the UAMI. The `subject`
  must be exactly:
  - `system:serviceaccount:copilot-runtime:copilot-runtime-worker` (worker)
  - `system:serviceaccount:copilot-runtime:pilotswarm-portal` (portal)
- Check that each secret named in `objects` exists in the target Key
  Vault (name + version must resolve).

### Image pull failure (`ImagePullBackOff`)

`UploadContainer.sh` re-pushes the image from the holding ACR to the
per-region ACR at the start of every App rollout. If pods show
`ImagePullBackOff`:

- `az acr repository show-tags --name <per-region-acr>
  --repository copilot-runtime-worker` (or `pilotswarm-portal`) —
  confirm the expected `:$(Build.BuildId)` tag is present.
- Confirm the AKS kubelet UAMI has **AcrPull** on the per-region ACR
  (provisioned by BaseInfra Bicep).
- Under GitOps there is **no** `acr-pull` imagePullSecret — pull auth
  is via the kubelet managed identity only.

## Replacement tables

Both tables read top-to-bottom as `source ConfigMap key → target field(s)`.
Source is always the overlay's merged ConfigMap
(`worker-env` / `portal-env`). The overlay `.env` is rendered by EV2's
`GenerateEnvForEv2.ps1`.

### Worker

| Source key | Target kind | Target field(s) |
|---|---|---|
| `IMAGE` | `Deployment/copilot-runtime-worker` | `spec.template.spec.containers.[name=worker].image` |
| `NAMESPACE` | `Namespace` | `metadata.name` |
| `NAMESPACE` | `ServiceAccount/copilot-runtime-worker` | `metadata.namespace` |
| `NAMESPACE` | `Deployment/copilot-runtime-worker` | `metadata.namespace` |
| `NAMESPACE` | `SecretProviderClass/copilot-worker-secrets` | `metadata.namespace` |
| `WORKLOAD_IDENTITY_CLIENT_ID` | `SecretProviderClass/copilot-worker-secrets` | `spec.parameters.clientID` |
| `WORKLOAD_IDENTITY_CLIENT_ID` | `ServiceAccount/copilot-runtime-worker` | `metadata.annotations.[azure.workload.identity/client-id]` |
| `KV_NAME` | `SecretProviderClass/copilot-worker-secrets` | `spec.parameters.keyvaultName` |
| `AZURE_TENANT_ID` | `SecretProviderClass/copilot-worker-secrets` | `spec.parameters.tenantId` |

> `IMAGE` is composed by EV2 as `<ACR_LOGIN_SERVER>/<IMAGE_NAME>:<IMAGE_TAG>`
> inside `GenerateEnvForEv2.ps1`. Kustomize `replacements` cannot
> concatenate multiple sources into one target string, so the
> composition happens upstream.

### Portal

| Source key | Target kind | Target field(s) |
|---|---|---|
| `IMAGE` | `Deployment/pilotswarm-portal` | `spec.template.spec.containers.[name=portal].image` |
| `NAMESPACE` | `ServiceAccount/pilotswarm-portal` | `metadata.namespace` |
| `NAMESPACE` | `Role/pilotswarm-portal-log-reader` | `metadata.namespace` |
| `NAMESPACE` | `RoleBinding/pilotswarm-portal-log-reader` | `metadata.namespace`, `subjects.0.namespace` |
| `NAMESPACE` | `Deployment/pilotswarm-portal` | `metadata.namespace` |
| `NAMESPACE` | `Service/pilotswarm-portal` | `metadata.namespace` |
| `NAMESPACE` | `Ingress/pilotswarm-portal-ingress` | `metadata.namespace` |
| `NAMESPACE` | `SecretProviderClass` (portal) | `metadata.namespace` |
| `PORTAL_HOSTNAME` | `Ingress/pilotswarm-portal-ingress` | `spec.rules.0.host`, `spec.tls.0.hosts.0`, `metadata.annotations.[appgw.ingress.kubernetes.io/backend-hostname]`, `metadata.annotations.[appgw.ingress.kubernetes.io/health-probe-hostname]` |
| `WORKLOAD_IDENTITY_CLIENT_ID` | `SecretProviderClass` (portal) | `spec.parameters.clientID` |
| `WORKLOAD_IDENTITY_CLIENT_ID` | `ServiceAccount/pilotswarm-portal` | `metadata.annotations.[azure.workload.identity/client-id]` |
| `KV_NAME` | `SecretProviderClass` (portal) | `spec.parameters.keyvaultName` |
| `AZURE_TENANT_ID` | `SecretProviderClass` (portal) | `spec.parameters.tenantId` |

## Safety / scope

The following files and paths are **explicitly not modified by this
GitOps path** and remain the authoritative surface of the imperative
deploy flow described in [`docs/deploying-to-aks.md`](./deploying-to-aks.md):

- `scripts/deploy-aks.sh`
- `scripts/reset-local.sh`
- `scripts/deploy-portal.sh`
- `deploy/k8s/` (all YAML)
- `deploy/Dockerfile.worker`, `deploy/Dockerfile.portal`
- `docs/deploying-to-aks.md`

The GitOps path lives entirely under new top-level subdirectories
(`deploy/gitops/`, `deploy/ev2/`, `.pipelines/`). Both paths target the
same `copilot-runtime` namespace — operators must pick one per cluster.
