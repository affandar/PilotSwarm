# aks-gitops-iac — As-Built Reference

Audience: future maintainers auditing what Phases 1–6 actually delivered
for the new EV2 + GitOps deploy path. User-facing guide is
[`docs/deploying-to-aks-ev2.md`](../../../docs/deploying-to-aks-ev2.md).

## Phase-by-phase file inventory

### Phase 1 — Kustomize trees

Worker (`deploy/gitops/worker/`):

- `base/namespace.yaml` — `copilot-runtime` Namespace.
- `base/service-account.yaml` — `copilot-runtime-worker` SA with
  Workload Identity annotation (templated via replacement).
- `base/deployment.yaml` — Worker Deployment. Single-token `__IMAGE__`
  placeholder; `imagePullPolicy: IfNotPresent`; no `acr-pull`
  imagePullSecret.
- `base/secret-provider-class.yaml` — AKV CSI `SecretProviderClass`
  producing Secret `copilot-worker-secrets` with one `objectName` per
  runtime flag from `scripts/deploy-aks.sh`.
- `base/kustomization.yaml` — Resources + base configMapGenerator
  (placeholder literals) + replacements fan-out rules.
- `overlays/dev/.env` — EV2-rendered values (committed file is
  comments-only).
- `overlays/dev/kustomization.yaml` — `behavior: merge` overlay.
- `overlays/prod/.env`, `overlays/prod/kustomization.yaml` — prod overlay.

Portal (`deploy/gitops/portal/`):

- `base/service-account.yaml`, `base/role.yaml`, `base/role-binding.yaml`
  — `pilotswarm-portal` SA + log-reader Role/RoleBinding.
- `base/deployment.yaml` — Portal Deployment (container name `portal`,
  `__IMAGE__` placeholder).
- `base/service.yaml` — ClusterIP Service.
- `base/ingress.yaml` — `ingressClassName: azure-application-gateway`
  Ingress with AGIC backend-hostname / health-probe-hostname
  annotations.
- `base/secret-provider-class.yaml` — AKV CSI SPC producing
  `pilotswarm-portal-secrets`.
- `base/kustomization.yaml` — Resources + configMapGenerator +
  replacements (including 4-field PORTAL_HOSTNAME fan-out).
- `overlays/{dev,prod}/.env`, `overlays/{dev,prod}/kustomization.yaml`
  — overlays.

Shared:

- `deploy/gitops/.gitignore` — ignore rendered preview dirs.
- `deploy/gitops/validate.sh` — runs `kubectl kustomize` across every
  overlay and fails on non-zero exit or leftover `placeholder` tokens.

### Phase 2 — GlobalInfra Bicep

`deploy/ev2/GlobalInfra/bicep/`:

- `main.bicep` — Subscription-scope entry point; creates the control-plane
  RG and deploys AFD profile + WAF policy.
- `frontdoor-profile.bicep` — AFD Premium profile + default endpoint.
- `frontdoor-waf-policy.bicep` — WAF policy (Detection / Prevention)
  with managed-rule baseline + security-policy association.
- `parameters/dev.bicepparam`, `parameters/prod.bicepparam` — env-specific
  values (WAF mode, resource prefix, region).

### Phase 3 — BaseInfra Bicep

`deploy/ev2/BaseInfra/bicep/`:

- `main.bicep` — RG-scope entry; composes the modules below; publishes
  outputs consumed by Worker + Portal App SGs.
- `vnet.bicep` — VNet + subnets (AKS, AppGW, Private Link).
- `aks.bicep` — AKS with `microsoft.flux` extension,
  `azureKeyvaultSecretsProvider` addon, OIDC issuer, Workload Identity,
  AGIC addon, kubelet UAMI with ACR pull.
- `acr.bicep` — Per-region ACR (AcrPull granted to AKS kubelet MI).
- `postgres.bicep` — Azure DB for PostgreSQL Flexible Server.
- `storage.bicep` — Storage account + `copilot-sessions` container
  (session dehydration) + `worker-manifests` + `portal-manifests`
  containers (Flux sources).
- `keyvault.bicep` — AKV for runtime secrets.
- `uami.bicep` — UAMIs for worker + portal.
- `uami-federation.bicep` — Federated Identity Credentials;
  portal SA subject default `pilotswarm-portal` (fix vs. Phase 3 plan
  draft that said `copilot-runtime-portal`).
- `application-gateway.bicep` — AppGW with private frontend IP +
  `PrivateLinkConfiguration` on that frontend.
- `flux-config.bicep` — Two `Microsoft.KubernetesConfiguration/fluxConfigurations`
  resources (`manifest-worker`, `manifest-portal`) pointing at the two
  blob containers.
- `parameters/dev.bicepparam`, `parameters/prod.bicepparam`.

### Phase 4 — Portal AFD + Private Link wiring

`deploy/ev2/Common/bicep/` (copied verbatim from postgresql-fleet-manager):

- `frontdoor-origin-route.bicep` — registers a per-region AFD origin +
  route against the profile created by GlobalInfra; origin is
  Private-Link-targeting the AppGW's `PrivateLinkConfiguration`.
- `approve-private-endpoint.bicep` — `deploymentScript` that calls
  `az network private-endpoint-connection approve` for the auto-created
  pending connection on the AppGW side.

`deploy/ev2/Portal/bicep/`:

- `main.bicep` — invokes both Common modules; outputs `BackendHostName`
  (consumed by `__PORTAL_HOSTNAME__` scope binding on Portal App SG),
  `PrivateLinkServiceId`, `RouteName`, `ApprovedPrivateEndpointCount`.
- `parameters/dev.bicepparam`, `parameters/prod.bicepparam`.

### Phase 5 — EV2 ServiceGroups + shell extensions + dev helpers

Shell extensions (`deploy/ev2/Common/scripts/`):

- `UploadContainer.sh` — pulls image from holding ACR, retags, pushes
  to per-region ACR. Idempotent.
- `GenerateEnvForEv2.ps1` — reads `__TOKEN__`-substituted environment
  variables set by EV2 and writes them as `KEY=VALUE` lines into the
  overlay `.env`. Also composes `IMAGE=<acr>/<name>:<tag>` because
  Kustomize replacements cannot compose sources.
- `DeployApplicationManifest.sh` — runs `kubectl kustomize <overlay>` and
  `az storage blob upload-batch --overwrite` to the target manifest
  container. Idempotent.

EV2 ServiceGroup definitions (each has `serviceModel.json`,
`rolloutSpec.json`, `scopeBinding.json`, `Parameters/{dev,prod}.deploymentParameters.json`):

- `deploy/ev2/GlobalInfra/Ev2InfraDeployment/` — Bicep only.
- `deploy/ev2/BaseInfra/Ev2InfraDeployment/` — Bicep only; consumes
  GlobalInfra outputs.
- `deploy/ev2/Worker/Ev2AppDeployment/` — 3 shell steps; Worker SG owns
  no Bicep. Additional rollout parameter files:
  `UploadContainer.Linux.Rollout.json`,
  `GenerateEnvForEv2.Linux.Rollout.json`,
  `DeployApplicationManifest.Linux.Rollout.json`.
- `deploy/ev2/Portal/Ev2InfraDeployment/` — Bicep (AFD origin/route +
  PL approval).
- `deploy/ev2/Portal/Ev2AppDeployment/` — 3 shell steps identical shape
  to Worker, plus the same `*.Linux.Rollout.json` triad.

Dev-loop helpers:

- `deploy/ev2/Worker/ev2-deploy-dev.ps1` — stages working tree + overlay
  into temp service-group-root, invokes `az rollout start`.
- `deploy/ev2/Portal/ev2-deploy-dev.ps1` — same, for Portal.

Other:

- `deploy/ev2/README.md` — high-level map of the EV2 tree.

### Phase 6 — Pipelines (OneBranch Official)

`.pipelines/`:

- `ci.yml` — PR-merge CI: test gate → `docker buildx build --platform
  linux/amd64` for worker + portal → push to holding ACR with
  `:$(Build.BuildId)` → publish EV2 rollout artifacts.
- `pr.yml` — OneBranch NonOfficial PR gate.
- `release-globalinfra.yml` — Prod release invoking `Ev2RARollout@2`
  against GlobalInfra SG.
- `release-baseinfra.yml` — Prod release for BaseInfra SG.
- `release-worker.yml` — Prod release for Worker App SG.
- `release-portal.yml` — Single pipeline, **two gated stages**
  (Infra → App) for Portal SG.
- `shared/onebranch-pool.yml` — Shared pool template.

## EV2 scope-binding tokens (complete list)

Data type legend: **string** unless noted; **uuid** = GUID; **int** =
integer.

### Worker (`deploy/ev2/Worker/Ev2AppDeployment/scopeBinding.json`)

| Token | Source | Consumer | Type | Example |
|---|---|---|---|---|
| `__REGION_NAME__` | `$config(regionName)` | rollout env | string | `westus3` |
| `__REGION_SHORT_NAME__` | `$config(regionShortName)` | rollout env | string | `wus3` |
| `__RESOURCE_GROUP_NAME__` | `$azureResourceGroup()` | rollout env | string | `pilotswarm-wus3-rg` |
| `__RESOURCE_PREFIX__` | `$config(resourcePrefix)` | naming | string | `pilotswarm` |
| `__STAMP__` | `$stamp()` | naming | string | `01` |
| `__ROLLOUT_TENANTID__` | `$config(TenantId)` | AKV SPC `tenantId` | uuid | `72f988bf-…` |
| `__IMAGE_NAME__` | `$config(workerImageName)` | `.env` IMAGE composition | string | `copilot-runtime-worker` |
| `__IMAGE_TAG__` | `$config(workerImageTag)` | `.env` IMAGE composition | string | `20250101.1` |
| `__NAMESPACE__` | `$config(workerNamespace)` | `.env` NAMESPACE → metadata.namespace | string | `copilot-runtime` |
| `__MANIFEST_CONTAINER_NAME__` | literal `worker-manifests` | DeployApplicationManifest.sh | string | `worker-manifests` |
| `__DEPLOYMENT_OVERLAY_PATH__` | `$config(workerOverlayPath)` | GenerateEnv + DeployManifest | string | `deploy/gitops/worker/overlays/prod` |
| `__SOURCE_ACR_LOGIN_SERVER__` | `$config(sourceAcrLoginServer)` | UploadContainer.sh (holding ACR) | string | `pilotswarmholding.azurecr.io` |
| `__ACR_LOGIN_SERVER__` | BaseInfra output `acrLoginServer.value` | `.env` IMAGE composition → Deployment image | string | `pilotswarmwus301.azurecr.io` |
| `__KV_NAME__` | BaseInfra output `keyVaultName.value` | SPC `keyvaultName` | string | `pilotswarmwus301kv` |
| `__BLOB_CONTAINER_ENDPOINT__` | BaseInfra output `blobContainerEndpoint.value` | runtime config | string | `https://pilotswarmwus301sa.blob.core.windows.net/copilot-sessions` |
| `__AKS_CLUSTER_NAME__` | BaseInfra output `aksClusterName.value` | kubectl context | string | `pilotswarmwus301aks` |
| `__APPLICATION_GATEWAY_NAME__` | BaseInfra output `applicationGatewayName.value` | Portal Infra | string | `pilotswarmwus301appgw` |
| `__PRIVATE_LINK_CONFIGURATION_NAME__` | BaseInfra output `privateLinkConfigurationName.value` | Portal Infra | string | `pls-portal` |
| `__WORKLOAD_IDENTITY_CLIENT_ID__` | `$config(workerWorkloadIdentityClientId)` | SPC `clientID` + SA annotation | uuid | `11111111-…` |
| `__AZURE_TENANT_ID__` | `$config(TenantId)` | SPC `tenantId` | uuid | `72f988bf-…` |
| `__DEPLOYMENT_STORAGE_ACCOUNT_NAME__` | composed `$config(resourcePrefix)$config(regionShortName)$stamp()sa` | DeployApplicationManifest.sh target | string | `pilotswarmwus301sa` |

### Portal (`deploy/ev2/Portal/Ev2AppDeployment/scopeBinding.json`)

Superset of Worker tokens, with these differences / additions:

| Token | Source | Consumer | Type | Example |
|---|---|---|---|---|
| `__IMAGE_NAME__` | `$config(portalImageName)` | `.env` IMAGE | string | `pilotswarm-portal` |
| `__IMAGE_TAG__` | `$config(portalImageTag)` | `.env` IMAGE | string | `20250101.1` |
| `__NAMESPACE__` | `$config(portalNamespace)` | `.env` NAMESPACE | string | `copilot-runtime` |
| `__MANIFEST_CONTAINER_NAME__` | literal `portal-manifests` | DeployApplicationManifest.sh | string | `portal-manifests` |
| `__DEPLOYMENT_OVERLAY_PATH__` | `$config(portalOverlayPath)` | DeployApplicationManifest.sh | string | `deploy/gitops/portal/overlays/prod` |
| `__WORKLOAD_IDENTITY_CLIENT_ID__` | `$config(portalWorkloadIdentityClientId)` | SPC + SA annotation | uuid | `22222222-…` |
| `__PORTAL_HOSTNAME__` | Portal Infra output `BackendHostName.value` | 4 ingress fields (rule host, tls host, AGIC backend-hostname annotation, AGIC health-probe-hostname annotation) | string | `pilotswarm-portal-wus3.z01.azurefd.net` |

### Portal Infra (`deploy/ev2/Portal/Ev2InfraDeployment/scopeBinding.json`)

| Token | Source | Consumer | Type |
|---|---|---|---|
| `__RESOURCE_NAME__` | composed `$config(resourcePrefix)$config(regionShortName)$stamp()` | Bicep param | string |
| `__SSL_CERTIFICATE_DOMAIN_SUFFIX__` | `$config(sslCertificateDomainSuffix)` | AFD cert | string |
| `__APPROVAL_MANAGED_IDENTITY_ID__` | `$config(approvalManagedIdentityId)` | PL approval deploymentScript | string |
| `__APPLICATION_GATEWAY_NAME__` | BaseInfra output | AFD origin target | string |
| `__PRIVATE_LINK_CONFIGURATION_NAME__` | BaseInfra output | AFD origin PL target | string |
| `__FRONT_DOOR_PROFILE_NAME__` | GlobalInfra output | origin/route parent | string |
| `__FRONT_DOOR_PROFILE_RESOURCE_GROUP__` | GlobalInfra output | cross-RG reference | string |
| `__FRONT_DOOR_ENDPOINT_NAME__` | GlobalInfra output | route attachment | string |

### BaseInfra (`deploy/ev2/BaseInfra/Ev2InfraDeployment/scopeBinding.json`)

| Token | Source | Type |
|---|---|---|
| `__REGION_NAME__`, `__REGION_SHORT_NAME__`, `__RESOURCE_GROUP_NAME__`, `__RESOURCE_PREFIX__`, `__STAMP__`, `__ROLLOUT_TENANTID__` | config / EV2 built-ins | string / uuid |
| `__RESOURCE_NAME_PREFIX__` | composed `$config(resourcePrefix)$config(regionShortName)$stamp()` | string |
| `__FRONT_DOOR_PROFILE_NAME__` | GlobalInfra output | string |
| `__FRONT_DOOR_PROFILE_RESOURCE_GROUP__` | GlobalInfra output | string |
| `__SSL_CERTIFICATE_DOMAIN_SUFFIX__` | `$config(sslCertificateDomainSuffix)` | string |
| `__WAF_MODE__` | `$config(wafMode)` | string |

### GlobalInfra (`deploy/ev2/GlobalInfra/Ev2InfraDeployment/scopeBinding.json`)

| Token | Source | Type |
|---|---|---|
| `__REGION_NAME__` | `$config(regionName)` | string |
| `__RESOURCE_GROUP_NAME__` | `$azureResourceGroup()` | string |
| `__RESOURCE_PREFIX__` | `$config(globalResourcePrefix)` | string |
| `__ROLLOUT_TENANTID__` | `$config(TenantId)` | uuid |
| `__WAF_MODE__` | `$config(wafMode)` | string |

## Four-ServiceGroup flow

```
                             ┌──────────────────────────┐
                             │ OneBranch CI (ci.yml)    │
                             │  - test gate             │
                             │  - docker buildx         │
                             │    --platform            │
                             │    linux/amd64           │
                             └─────────┬─────────┬──────┘
                                       │         │
           push :$(Build.BuildId)      │         │  publish EV2 artifacts
                                       ▼         ▼
                          ┌─────────────────────────────┐
                          │  Holding ACR                │   (EV2 rollout
                          │  pilotswarmholding.azurecr  │    spec + bicep
                          │                             │    + kustomize
                          └─────────────────────────────┘    bundles)
                                       │
                                       ▼
           ┌───────────────────────────────────────────────────────┐
           │  EV2 (Ev2RARollout@2, Azure-managed SDP stage map)    │
           └─────────┬────────────┬─────────────┬────────────┬─────┘
                     │            │             │            │
                     ▼            ▼             ▼            ▼
           ┌────────────┐  ┌────────────┐  ┌──────────┐  ┌───────────────┐
           │ GlobalInfra│  │ BaseInfra  │  │ Worker   │  │ Portal        │
           │ (Bicep,    │  │ (Bicep,    │  │ (App     │  │ Infra (Bicep) │
           │  sub scope)│  │  RG scope) │  │  only)   │  │  → App (3 sh) │
           └─────┬──────┘  └─────┬──────┘  └────┬─────┘  └───────┬───────┘
                 │ outputs       │ outputs      │                │
                 │ (AFD profile, │ (ACR, KV,    │                │
                 │  WAF)         │  AppGW, PLS, │                │
                 └───────────────┤  Storage,    │                │
                                 │  AKS, Flux)  │                │
                                 └──────┬───────┘                │
                                        │                        │
                                        │                        ▼
                                        │        ┌─────────────────────────┐
                                        │        │ Portal Infra outputs    │
                                        │        │ BackendHostName →       │
                                        │        │   __PORTAL_HOSTNAME__   │
                                        │        └─────────────┬───────────┘
                                        │                      │
                     Worker App rollout ▼                      ▼ Portal App rollout
                   ┌────────────────────────────────────────────────────┐
                   │  Shell extensions                                  │
                   │  1. UploadContainer.sh                             │
                   │     holding ACR ─────────► per-region ACR          │
                   │  2. GenerateEnvForEv2.ps1                          │
                   │     tokens ─────────────► overlay/.env             │
                   │  3. DeployApplicationManifest.sh                   │
                   │     kubectl kustomize ──► manifest blob container  │
                   │                           (worker-manifests /      │
                   │                            portal-manifests)       │
                   └────────────────┬───────────────────────────────────┘
                                    │ Flux polls (interval 120s)
                                    ▼
                              ┌───────────────┐
                              │  AKS cluster  │
                              │  FluxConfig   │
                              │  reconciles   │
                              │  → Pods       │
                              └───────────────┘
```

## Replacement fan-out tables

See the tables in
[`docs/deploying-to-aks-ev2.md`](../../../docs/deploying-to-aks-ev2.md#replacement-tables).
Both tables are sourced directly from
`deploy/gitops/worker/base/kustomization.yaml` and
`deploy/gitops/portal/base/kustomization.yaml`.

## Design decisions / deviations log

- **`IMAGE` is a single composed token, not three sources.** Kustomize
  `replacements` cannot concatenate multiple source fields into one
  target string. We compose `<acr>/<name>:<tag>` upstream in
  `GenerateEnvForEv2.ps1`, and leave `IMAGE_NAME`, `IMAGE_TAG`, and
  `ACR_LOGIN_SERVER` in the ConfigMap for downstream consumers.
- **Portal SA name `pilotswarm-portal` (not `copilot-runtime-portal`).**
  Phase 3's initial draft of `uami-federation.bicep` used
  `copilot-runtime-portal` as the FIC subject; the actual ServiceAccount
  in `deploy/k8s/portal-*` and `deploy/gitops/portal/base/service-account.yaml`
  is `pilotswarm-portal`. Fixed in Phase 3 by making
  `pilotswarm-portal` the default in the UAMI federation module.
- **camelCase EV2 JSON filenames** (`serviceModel.json`,
  `rolloutSpec.json`, `scopeBinding.json`). Matches the fleet-manager
  ecosystem convention for shared EV2 tooling; overrides the Phase 5
  plan text that used PascalCase.
- **Single Portal release pipeline with two gated stages.** The plan
  initially suggested two release pipelines (Portal-Infra,
  Portal-App). A single `release-portal.yml` with sequential stages is
  simpler to approve (one SDP stage map, cross-stage dependencies
  expressed natively) and matches fleet-manager's structure.
- **`docker buildx build --platform linux/amd64` for CI builds.** The
  repo convention (documented in root copilot instructions) requires
  `buildx` + explicit platform flag because development happens on
  macOS ARM64 but AKS nodes are AMD64 Linux. We explicitly chose this
  over `onebranch.pipeline.imagebuildinfo@1` to stay consistent with
  `scripts/deploy-aks.sh` and `deploy/Dockerfile.*` semantics.
- **No Private DNS zones / private endpoints for PG / KV / ACR / Storage
  data-plane.** Spec FR-001 scopes the private-link requirement to the
  AFD → AppGW path only. Data-plane resources remain public-endpoint
  with firewall / RBAC / Workload Identity authentication, matching
  the imperative path. Future hardening is tracked as out-of-scope
  follow-up.
- **AppGW listens HTTP on :80; no SSL cert wiring on AppGW.** AFD
  Premium terminates TLS at the edge and reaches the AppGW via Private
  Link. Putting a cert on AppGW as well would double cert management
  without adding a security layer.
- **`GenerateEnvForEv2.ps1` as its own rollout step.** Fleet-manager
  embeds this logic inside `DeployApplicationManifest.sh`. We split it
  into a dedicated step so the rendered `.env` is a visible shell-step
  output (easier to diagnose mismatches) and so rollout retries don't
  re-run UploadContainer unnecessarily.

## Deferred / onboarding FIXMEs

These values are placeholders in committed files and must be supplied
at EV2 onboarding time:

- **Service identifier GUIDs.** `Microsoft.PilotSwarm.Worker.Dev`,
  `Microsoft.PilotSwarm.Portal.Dev`, and the prod counterparts are
  placeholder service names in `ev2-deploy-dev.ps1` and the
  `rolloutSpec.json` files — they must be bound to real EV2 service
  identifiers during onboarding.
- **`HOLDING_ACR_LOGIN_SERVER`** — the `$config(sourceAcrLoginServer)`
  value in each App SG's `Parameters/*.deploymentParameters.json`.
- **`HOLDING_ACR_SERVICE_CONNECTION`** — ADO Service Connection name
  referenced in `.pipelines/ci.yml` for holding-ACR push. Not yet
  aligned with any concrete ADO project.
- **Pipeline-name alignment.** The four release pipeline YAML files
  define pipeline-display names that must be registered in the ADO
  project with matching Ev2 service identifier bindings before
  `Ev2RARollout@2` can execute.
- **`ServiceGroupOverride`** values in each `rolloutSpec.json` are
  fleet-manager defaults; confirm they match our service identifiers at
  onboarding.
- **SDP `StageMapName`.** The release pipelines invoke
  `Ev2RARollout@2` with the Azure-managed SDP stage map; the exact
  `StageMapName` (e.g. `Public_3StageValidation`) must be confirmed with
  the SDP owning team for the PilotSwarm service.
- **Default region.** Prod `bicepparam` files pin `westus3`. A
  multi-region expansion requires additional `Parameters/*.json`
  entries + new region rows in each release pipeline's stage list.
- **`approvalManagedIdentityId`.** The identity passed to
  `approve-private-endpoint.bicep` via the Portal Infra SG — must be
  granted Network Contributor on the AppGW as a one-time setup.
