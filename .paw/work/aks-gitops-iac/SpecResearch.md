# Spec Research — AKS GitOps IaC

**Work ID**: aks-gitops-iac
**Purpose**: Ground the spec for adding a FLUX+Kustomize+EV2+Bicep GitOps deploy path to PilotSwarm, modeled on `postgresql-fleet-manager` (FM). This is research only — no design decisions, no fabrication.

Citations use `path:line`. FM paths are under `C:\Repos\postgresql-fleet-manager\`; PilotSwarm paths under `C:\Repos\PilotSwarm\`.

---

## Reference Architecture Overview

### Q1. Shape of `src/Deploy/` in fleet manager

Top-level subdirs under `src/Deploy/`:
- **`BaseInfra/`** — per-region Azure infra shared by all microservices (AKS, ACR, AKV, Storage, VNet, Redis, AppGateway, FluxExtension, Geneva FluxConfig). Bicep + EV2 subscription-scope rollout. See `src/Deploy/BaseInfra/bicep/main.bicep` and `src/Deploy/BaseInfra/Ev2InfraDeployment/serviceModel.json`.
- **`GlobalInfra/`** — region-agnostic resources (Azure Front Door + WAF policy). `src/Deploy/GlobalInfra/bicep/main.bicep`.
- **`Common/`** — shared Bicep modules (`flux-config.bicep`, `deployment-storage-container.bicep`) and the three canonical shell-extension scripts (`UploadContainer.sh`, `DeployApplicationManifest.sh`, `GenerateEnvForEv2.ps1`, plus `DeployDacpac.sh` for DB services). Copied into each service's Ev2 shell-extension zip at build.
- **`AIModelService/`, `HelloWorldService/`, `PlaygroundService/`, `PostgreSQLFleetManager/`** — four microservices, each with its own `Ev2AppDeployment/`, `bicep/`, `manifests/`, and MSBuild `.proj`. Each is a self-contained EV2 service group.
- **`scripts/`** — dev-loop PowerShell helpers (`deploy-dev.ps1`, `ev2-deploy-dev.ps1`, `Publish-DevDatabase.ps1`, `CreateDevAzureResources.ps1`).

### Q2. Artifact/control flow (source → running pod)

```mermaid
flowchart LR
  Dev[git push] --> CI[OneBranch CI\ncontinuous-integration-build.yml]
  CI -->|tar.gz per service\nonebranch.pipeline.imagebuildinfo@1| ART[Pipeline artifact]
  CI --> Nuget[Ev2 service group\nnupkg artifact]
  ART --> EV2[EV2 Rollout\nev2RARollout@2\nStageMap Microsoft.Azure.SDP.Standard]
  Nuget --> EV2
  EV2 -->|ARM sub-scope| BICEP[Bicep deploy\nper-region BaseInfra + service infra]
  EV2 -->|Shell/UploadContainer\nACI + oras cp| ACR[(Region ACR)]
  EV2 -->|Shell/DeployApplicationManifest\nGenerateEnvForEv2.ps1 + az blob upload-batch| BLOB[(Azure Blob\n${serviceName}-manifests\nprefix=overlays/prod)]
  BICEP --> FLUX[Flux fluxConfigurations\nsourceKind=AzureBlob\nsyncIntervalInSeconds=120\nkubelet identity auth]
  BLOB -.->|pull every 120s| FLUX
  FLUX -->|kustomize build overlays/prod| K8S[AKS pods]
  ACR -.->|kubelet pulls image| K8S
```

Prose: CI builds one `.tar.gz` docker image per service (`continuous-integration-build.yml:~90-180`) and the Ev2 `.nupkg`. The prod pipeline (`postgresql-fleet-manager-deployment-prod.yml:67-72`) consumes both via `Ev2RARollout@2` using `StageMap = Microsoft.Azure.SDP.Standard`. EV2 runs per region: first an ARM subscription-scope Bicep deployment, then three Shell extensions in ACI — `UploadContainer` (ORAS push tarball→ACR), `DeployDacpac` (PG dacpac, FM-specific), and `DeployApplicationManifest` (mutates `overlays/prod/.env`, zips `manifests/`, uploads to `${serviceName}-manifests` blob container). FLUX was already installed during BaseInfra and watches that blob container; it reconciles on its 120s cadence, independent of EV2. **EV2 never pokes FLUX — it writes the blob and returns.**

## EV2 Structure and Multi-Region Rollout

### Q3. EV2 structure — `PostgreSQLFleetManager` as the canonical example

Per-service Ev2 layout (`src/Deploy/PostgreSQLFleetManager/Ev2AppDeployment/`):
- **`serviceModel.json`** — `serviceGroup = Microsoft.PostgreSQL.FleetManager.$config(environment)`, depends on `Microsoft.PostgreSQL.MeruMicroservices.$config(environment)` (BaseInfra). `serviceResourceGroupDefinitions[0]` wires up four `serviceResourceDefinitions`: one ARM (`PostgreSQLFleetManagerInfraDefinition`, `deploymentLevel: Subscription`) + three Shell extensions (`DeployDacpacDefinition`, `LinuxContainerUploadDefinition`, `DeployApplicationManifestDefinition`). `src/Deploy/PostgreSQLFleetManager/Ev2AppDeployment/serviceModel.json:21-122`.
- **`rolloutSpec.json`** — `orchestratedSteps`: `PostgreSQLFleetManagerInfra` (ARM deploy) → parallel `DeployDacpac` + `LinuxContainerUpload` → `DeployApplicationManifest` (depends on both). `src/Deploy/PostgreSQLFleetManager/Ev2AppDeployment/rolloutSpec.json:28-58`.
- **`scopeBinding.json`** — two scope tags: `globalScope` (region-agnostic `__TOKEN__` replacements from configurationSettings) and `aksAppDeployScope` (per-region substitutions that use `$serviceResourceDefinition(X).action(deploy).outputs(Y.value)` to wire ARM outputs into shell-extension env vars).
- **`version.txt`** — rolled by CI.
- **`Configuration/configurationSettings.json`** — service-wide defaults.
- **`Configuration/ServiceGroup/Microsoft.PostgreSQL.FleetManager.Prod.Configuration.json`** — per-env settings with `Geographies[].Regions[].Settings` nesting for region-specific overrides (subscription keys, domain suffixes).
- **`Parameters/*Rollout.json`** — one per Shell extension; binds the `__TOKEN__`s consumed by the `.sh`/`.ps1` scripts.
- **`Parameters/*.deploymentParameters.json` + `Templates/*.deploymentTemplate.json`** — ARM params + template (Bicep compiled to ARM at build).
- **`PostgreSQLFleetManagerEv2.proj`** — MSBuild that `Copy`s `manifests/**` and `Common/scripts/*` into `obj/`, produces `DeployApplicationManifest.zip`, `UploadContainer.zip`, `DeployDacpac.zip`, `manifests.zip`, and packs the whole tree as an EV2-consumable nupkg.

Stages/shells/rollouts composition: one "rollout" = one ServiceGroup; one "stage" = one region (managed by the SDP stage map, not declared in-repo); one "shell" = one ACI-executed script wired via `rolloutParametersPath` to a parameters file with `__TOKEN__`s.

### Q4. Exact stage / region list for prod

FM uses **managed SDP**, not hand-rolled stages. The stage map is `Microsoft.Azure.SDP.Standard` (Azure-owned); bake times, canary % and health gates come from that map, not the repo. See `postgresql-fleet-manager-deployment-prod.yml:67-72` (`ev2ManagedSdpRolloutConfig`, with params `rolloutType`, `overrideManagedValidation`, `managedValidationOverrideDurationInHours` default 24, `icmIncidentId`).

**Region seeding** is done via a pipeline runtime parameter that seeds the `Select` EV2 input (initial region/stage picker). In the prod YAML the default seed is `regions(uksouth)` with options for `centralus`, `australiaeast`, `westus2`, `westus3`, `centraluseuap`, `eastus2euap`. The full list of available regions per env comes from each service's `Configuration/ServiceGroup/*.Configuration.json` — e.g. `Microsoft.PostgreSQL.AIModelService.Dev.Configuration.json:8-60+` enumerates ~20 regions grouped by Geography (Asia Pacific / Australia / etc.).

### Q5. How EV2 invokes FLUX / Kustomize

**EV2 never calls FLUX.** EV2 runs shell extensions that upload the Kustomize bundle to an Azure Blob container; FLUX polls that container on its own cadence and reconciles.

Mechanism in three steps:
1. **Upload**: `Common/scripts/DeployApplicationManifest.sh` runs inside an ACI shell extension. It logs in via MSI (`az login --identity`), calls `GenerateEnvForEv2.ps1` to mutate `overlays/prod/.env` with EV2-substituted values, then `az storage blob upload-batch --source manifests --destination ${serviceName}-manifests` to push the Kustomize tree to the service-specific blob container. (Path and container from the rollout parameters file.)
2. **Reconcile**: FLUX was installed during BaseInfra as the AKS extension `microsoft.flux` (`src/Deploy/BaseInfra/bicep/flux-system.bicep:1-60`). Per-service `Microsoft.KubernetesConfiguration/fluxConfigurations` resources are declared in `src/Deploy/Common/bicep/flux-config.bicep:18-46` with `sourceKind: AzureBlob`, `containerName: ${serviceName}-manifests`, `syncIntervalInSeconds: 120`, and `kustomizations` pointing at `deploymentOverlayPath` (e.g. `overlays/prod`).
3. **Auth**: FLUX → blob auth is **kubelet managed identity** (`flux-system.bicep:19-27`, role `Storage Blob Data Reader` on the storage account). Workload identity is commented out because the Flux Azure Blob Source Controller doesn't support WI yet (`flux-system.bicep:~37-95`).

### Q6. SDP controls (bake, health, canary, rollback)

Externalized to Azure's `Microsoft.Azure.SDP.Standard` stage map. In-repo controls are limited to:
- `ev2ManagedSdpRolloutConfig.rolloutType` — `normal`, `globaloutage`, or `emergency` (alters SDP velocity).
- `overrideManagedValidation: bool` with `managedValidationOverrideDurationInHours` (default 24) — allows bypassing SDP bake windows with IcM.
- `icmIncidentId` — required for overrides.

Cited at `.pipelines/postgresql-fleet-manager-deployment-prod.yml:67-72`. Concrete bake-time/canary-percentage values are **not in-repo** — they come from the managed stage map.

### Q7. Secrets / SPN identities passed to EV2

EV2 authenticates via **service connections** declared in the pipeline (`DevXEv2TestServiceConnection` for dev, a separate prod connection for the official pipeline — `.pipelines/continuous-deployment-dev.yml`, `postgresql-fleet-manager-deployment-prod.yml`). Each service connection resolves to an app registration whose appId is baked into the scope bindings as `__SERVICE_DEPLOY_MANAGED_IDENTITY_RESOURCE_ID__` (the UAMI used inside ACI shell extensions — `az login --identity`). App-registration artifacts are generated on a SAW and stored in `Buildout/AppRegistrations/<tenant>/*-app-creation-result.json`.

## GitOps Source / Storage Bucket Pattern

### Q8. What FLUX watches

**Azure Blob containers**, one per service. No Git source. `src/Deploy/Common/bicep/flux-config.bicep:22-30` — `sourceKind: 'AzureBlob'`, `azureBlob: { url: storageAccount.properties.primaryEndpoints.blob, containerName: '${serviceName}-manifests' }`. Authentication is kubelet identity (`flux-system.bicep:19-27`), not Git credentials.

### Q9. How the bucket is populated / layout / auth

- **Populated by**: EV2 shell extension `DeployApplicationManifest` (= `Common/scripts/DeployApplicationManifest.sh`) running `az storage blob upload-batch`.
- **Object layout**: the blob prefix mirrors the local `manifests/` tree — `base/**` + `overlays/prod/**`, with the entire Kustomize overlay uploaded flat. The container is `${serviceName}-manifests` (e.g. `aimodelservice-manifests`, `postgresqlfleetmanager-manifests`).
- **Reconcile path**: `kustomizations` entry in `flux-config.bicep:~35-45` sets `path: deploymentOverlayPath` (e.g. `overlays/prod`) so FLUX runs `kustomize build` on that subtree.
- **Auth**: Kubelet MSI with `Storage Blob Data Reader` assigned in `flux-system.bicep` via Bicep role assignment. No SAS or connection string.

The Geneva side uses the same pattern (cluster-scoped FluxConfig, `geneva-manifests` container) but is provisioned in BaseInfra, not per-service.

### Q10. Kustomize base + overlays physical layout (AIModelService)

```
src/Deploy/AIModelService/manifests/
├── base/
│   ├── kustomization.yaml
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── serviceaccount.yaml
│   └── (other base resources)
└── overlays/
    └── prod/
        ├── kustomization.yaml          # configMapGenerator + replacements
        ├── .env                         # MUTATED at EV2 time by GenerateEnvForEv2.ps1
        ├── deployment-patch.yaml        # prod-specific patches
        └── secretproviderclass.yaml     # CSI SecretProviderClass
```

`PostgreSQLFleetManager/manifests/overlays/prod/kustomization.yaml` is a concrete example: `namespace: postgresql-fleet-manager`, `namePrefix: postgresql-fleet-manager-`, `resources: [../../base, secretproviderclass.yaml]`, `configMapGenerator` from `.env`, `patches: [deployment-patch.yaml]`, and a block of `replacements` (cited below).

### Q11. Env-file replacements mechanism

Three-layer chain:
1. **EV2 scope binding**: `DeployApplicationManifest.parameters.json` contains lines like `CONTAINER_IMAGE=__ACR_NAME__.azurecr.io/__APP_IMAGE_NAME__:__BUILD_VERSION__`. At rollout time EV2 substitutes `__TOKEN__`s using `scopeBinding.json`.
2. **`.env` mutation**: `Common/scripts/GenerateEnvForEv2.ps1:1-73` reads the substituted JSON parameters and rewrites `overlays/prod/.env` line-by-line using regex `^(?<key>[^=]+)=(?<value>.*)$`. Runs inside the ACI shell extension just before blob upload.
3. **Kustomize transforms**: `configMapGenerator { name: config, envs: [.env] }` turns `.env` into a ConfigMap, then a `replacements:` transformer copies specific ConfigMap fields into Deployment / ServiceAccount / SecretProviderClass fields. Concrete example at `PostgreSQLFleetManager/manifests/overlays/prod/kustomization.yaml:32-92` wires `data.CLIENTID_OF_AZUREKEYVAULTSECRETSPROVIDER` → `SecretProviderClass.spec.parameters.userAssignedIdentityID`, `data.CONTAINER_IMAGE` → `Deployment.spec.template.spec.containers[name=container].image`, etc.

### Q12. Image tag substitution

Done via the same chain (no Flux image-automation controller):
- CI builds a tarball + emits `version.txt` (consumed via `rolloutSpec.json:8-13`, `buildSource.parameters.versionFile`).
- EV2 scopeBinding substitutes `__BUILD_VERSION__` → the version, and `__ACR_NAME__` → the per-region ACR.
- `UploadContainer.sh` ORAS-pushes the tarball to `${__ACR_NAME__}.azurecr.io/${__APP_IMAGE_NAME__}:${__BUILD_VERSION__}`.
- `.env` gets `CONTAINER_IMAGE=${__ACR_NAME__}.azurecr.io/${__APP_IMAGE_NAME__}:${__BUILD_VERSION__}`.
- Kustomize `replacements` rule (e.g. `PostgreSQLFleetManager/manifests/overlays/prod/kustomization.yaml:83-92`) writes that into `Deployment.spec.template.spec.containers[name=container].image`.

## Supporting Azure Infrastructure

### Q13. `BaseInfra/` — what it provisions

Subscription-scope Bicep (`src/Deploy/BaseInfra/bicep/main.bicep`), invoked via `src/Deploy/BaseInfra/Ev2InfraDeployment/serviceModel.json` (ServiceGroup `Microsoft.PostgreSQL.MeruMicroservices.Dev`/`.Prod`). Provisions:

- Resource group
- User-assigned managed identities (UAMI)
- ACR
- Storage account + containers (incl. `${serviceName}-manifests` and `geneva-manifests`)
- Private DNS zones
- Azure Cache for Redis Enterprise
- App Insights + Log Analytics Workspace
- VNet + subnets (incl. `__ACI_SUBNET_ID__` = `10.18.1.0/28` for EV2 shell extensions)
- Application Gateway (AGIC)
- AKS cluster
- Container Insights DCR
- Azure Key Vault (`BaseInfra/bicep/akv.bicep` with OneCertV2 issuers)
- All RBAC / role assignments
- `microsoft.flux` AKS extension (`BaseInfra/bicep/flux-system.bicep`)
- Geneva storage container + cluster-scoped `fluxConfigurations` resource

### Q14. `GlobalInfra/` vs BaseInfra

GlobalInfra is region-agnostic: Azure Front Door + WAF policy. See `src/Deploy/GlobalInfra/bicep/main.bicep`. It deploys once per environment. BaseInfra deploys per region and depends on GlobalInfra via the ServiceGroup dependency declared in BaseInfra's `serviceModel.json`.

### Q15. Where AKS / ACR / AKV / PG / Storage come from

All **provisioned in BaseInfra** (`BaseInfra/bicep/main.bicep`). PostgreSQL itself is provisioned **per-service** inside that service's Bicep (`AIModelService/bicep/main.bicep`, `PostgreSQLFleetManager/bicep/main.bicep`) — each service owns its own PG flexible-server stamp.

### Q16. How FLUX is installed onto AKS

`microsoft.flux` as an AKS extension declared in `BaseInfra/bicep/flux-system.bicep`. `autoUpgradeMinorVersion: false`, `version: fluxVersion` (default `1.16.12`), `useKubeletIdentity: true`. Not `flux bootstrap`, not a separate EV2 step — it's IaC.

## Secret Management

### Q17. How secrets reach pods

**Azure Key Vault Provider for Secrets Store CSI Driver** (`SecretProviderClass` CRD). Mounted as a volume on the Deployment and materialized into file paths and/or synced Kubernetes Secrets. See each service's `manifests/overlays/prod/secretproviderclass.yaml`. The CSI driver itself is installed as the AKS addon `azureKeyvaultSecretsProvider` (configured in BaseInfra; not a separate app manifest).

### Q18. Pod → AKV auth

**AKS secrets-store VM managed identity** (the AKS addon identity). The `SecretProviderClass` contains `useVMManagedIdentity: "true"` and `userAssignedIdentityID: <CLIENTID_OF_AZUREKEYVAULTSECRETSPROVIDER>`, populated via the `.env` → ConfigMap → Kustomize `replacements` chain (`PostgreSQLFleetManager/manifests/overlays/prod/kustomization.yaml:43-52`). Workload identity is used for the service account's *own* calls (ServiceAccount annotation `azure.workload.identity/client-id` set by replacement `kustomization.yaml:73-82`), but the KV fetch itself uses the addon VM MI.

### Q19. Where secret values come from

Per-stage AKV provisioned in BaseInfra (`BaseInfra/bicep/akv.bicep`) with OneCertV2 issuers for TLS certs. App secrets / SPN appIds originate from PS scripts run on a SAW that produce `Buildout/AppRegistrations/<tenant>/*-app-creation-result.json`; these get written into AKV (manual or one-shot) and then consumed via `SecretProviderClass`.

## Helper Scripts and Developer Loop

### Q20. Dev-loop scripts in FM

Under `src/Deploy/scripts/`:
- `deploy-dev.ps1` — minikube-based local loop + targeted Azure deploy.
- `ev2-deploy-dev.ps1` — `ValidateSet` of service names; builds, registers EV2 test rollout, triggers via `DevXEv2TestServiceConnection`.
- `Publish-DevDatabase.ps1` — DACPAC-publish helper.
- `CreateDevAzureResources.ps1` — bootstraps per-dev Azure resources.

### Q21. Dev-test EV2 story

`docs/Ev2DevTestDeployment.md` documents the SAW-based flow with PowerShell cmdlets: `Register-AzureServiceArtifacts`, `Test-AzureServiceRollout`, `New-AzureServiceRollout` with `StageMapName = Microsoft.Azure.SDP.Standard` (same stage map as prod). Engineers can smoke-test a single region and subscription before shipping.

### Q22. Validation / linting / preview tooling

Not found as a dedicated lint/validate pass in CI. MSBuild `.proj` packaging acts as a structural check (tokens must resolve for the zip to build). `kustomize build`, `ev2 validate`, and `bicep build` are **not** wired into the in-repo pipeline YAML. `docs/Microservice-Hosting-Pattern-Generalization-Guide.md` recommends manual `kustomize build overlays/prod` locally but doesn't automate it.

## Pipelines and CI/CD Wiring

### Q23. `postgresql-fleet-manager-deployment-prod.yml` end-to-end

OneBranch **Official CrossPlat** template. Consumes CI-produced artifacts (the Ev2 nupkg + per-service image tarballs). Single job runs `Ev2RARollout@2` with:
- `ServiceGroupRootFolder: $(Pipeline.Workspace)/.../Microsoft.PostgreSQL.FleetManager`
- `StageMapName: Microsoft.Azure.SDP.Standard`
- `ev2ManagedSdpRolloutConfig` (see Q6)
- `SelectRegions: regions(uksouth)` default (parameterizable)

Prod pipeline **per service** — there's a companion `postgresql-fleet-manager-deployment-prod-aimodelservice.yml` etc. (or equivalent service-specific file). Each prod pipeline line drives exactly one ServiceGroup rollout.

### Q24. Docker build & push

Image built in CI (`continuous-integration-build.yml`), not inside EV2. Uses `onebranch.pipeline.imagebuildinfo@1` (one task per service); output is compressed to `*.tar.gz` and stored as pipeline artifact. During EV2, the `UploadContainer.sh` shell extension ORAS-copies the tarball into the per-region ACR (`oras cp --recursive --from-oci-layout`). CI pushes to `meruacrdev1.azurecr.io` for the dev path.

### Q25. `continuous-deployment-dev.yml`

OneBranch **NonOfficial** template auto-triggered on `main`. Uses `DevXEv2TestServiceConnection` (not the prod SDP connection). Stages: `TEST_DevX_GlobalInfra` → `TEST_DevX_Microservices`. Uses the same EV2 + FLUX machinery (i.e. it is still a GitOps deploy), just with a dev subscription and `Microsoft.PostgreSQL.*.Dev` ServiceGroups.

## Generalization Guidance

### Q26. `Microservice-Hosting-Pattern-Generalization-Guide.md`

Explicit copy/customize recipes per pattern:
- Copy `Common/scripts/*` verbatim.
- Copy one reference service's `Ev2AppDeployment/` tree and rename tokens/service group.
- Stand up BaseInfra once per region-set; microservices plug into it.
- Keep `manifests/base` generic; put all env-specific values in `overlays/<env>/.env`.
- SDP stage map must be `Microsoft.Azure.SDP.Standard` for internal Azure services.

### Q27. `Production-Deploy.md`

Covers SAW/EV2 setup, service-connection registration, and the operator sequence: (1) bump `version.txt`, (2) CI builds nupkg + images, (3) open EV2 rollout from the released pipeline, (4) watch SDP bake through regions, (5) Geneva telemetry verification. (Full 380+ lines; only headings cited here.)

### Q28. Microservice generator

`docs/Microservice-Generator-Prompt-Template.md` + `docs/microservice-generator-schema.json` define an LLM-driven scaffolder that, given a JSON spec (service name, regions, AKV needs, PG needs), generates:
- App scaffolding (.NET project skeleton) — **not relevant** to PilotSwarm.
- Deploy scaffolding: `Ev2AppDeployment/`, `bicep/main.bicep`, `manifests/base/**`, `manifests/overlays/prod/{kustomization.yaml, .env, deployment-patch.yaml, secretproviderclass.yaml}`, the MSBuild `.proj`, pipeline YAMLs — **relevant**.

---

## PilotSwarm (This Repo)

### Q29. `scripts/deploy-aks.sh` step-by-step

`scripts/deploy-aks.sh` (full script, 221 lines). Uses `K8S_CONTEXT` / `K8S_NAMESPACE` from `.env.remote`.
- `:25-85` — arg parsing, env load, `kubectl` context resolution, test-gate unless `--skip-tests`.
- `:86` — `NAMESPACE="${K8S_NAMESPACE:-copilot-runtime}"`.
- `:~90-99` — scale worker deployment to 0 before DB reset.
- `:100-127` — `kubectl create secret generic copilot-runtime-secrets --from-literal=...` with `DATABASE_URL`, `GITHUB_TOKEN`, `AZURE_STORAGE_CONNECTION_STRING`, `PORTAL_AUTH_*`, many model keys; dry-run + apply.
- `:~130-170` — optional `node scripts/db-reset.js` (schema wipe) + blob reset.
- `:188-192` — `docker buildx build --platform linux/amd64 -f deploy/Dockerfile.worker -t $ACR/copilot-runtime-worker:latest --push .`.
- `:204-207` — `sed -e "s|namespace: copilot-runtime|namespace: $NAMESPACE|g"` applied to each `deploy/k8s/*.yaml` then `kubectl apply -f -`.
- `:~210-220` — `kubectl rollout restart deployment/copilot-runtime-worker` + `rollout status`.

No EV2, no FLUX, no Kustomize, no Bicep.

### Q30. `deploy/` directory

```
deploy/
├── Dockerfile.worker         # node:24-slim; copies /packages/sdk/dist + node_modules; ENTRYPOINT worker.js
├── Dockerfile.portal         # multi-stage: builds Vite bundle; runs server.js
├── Dockerfile.starter        # node:24-bookworm-slim "appliance" w/ postgres + sshd + supervisord
├── bin/
│   ├── start-worker.sh       # wait-for-db then node worker.js
│   ├── start-portal.sh
│   └── wait-for-db.sh
├── config/
│   ├── model_providers.ghcp.json
│   └── model_providers.local-docker.json
├── k8s/
│   ├── namespace.yaml                 # `copilot-runtime`
│   ├── worker-deployment.yaml         # 3 replicas, spot tolerations, emptyDir /home/node/.copilot, cpu:250m mem:1Gi
│   ├── portal-deployment.yaml         # singleton + RBAC for pod/log read; ClusterIP :3001
│   └── portal-ingress.yaml            # host `pilotswarm-portal.westus3.cloudapp.azure.com`, cert-manager letsencrypt
├── ssh/sshd_config                    # for starter image
└── supervisor/supervisord.conf        # for starter image
```

### Q31. `docs/deploying-to-aks.md`

Prescribes the manual path driven by `deploy-aks.sh`: create namespace (`copilot-runtime`), create `copilot-runtime-secrets` from env vars, apply `deploy/k8s/*.yaml`, build+push image with `docker buildx --platform linux/amd64`, `rollout restart`. Key sections read (lines 1-380):
- Architecture diagram (3-replica worker + singleton portal).
- **"WARNING: Runaway Deployments"** (prior incidents where `docker build` without `--platform` pushed arm64 images; hence the explicit `--platform linux/amd64` convention).
- `kubectl` config path, secret-refresh flow, spot tolerations rationale, scaling notes, db-reset flow.

### Q32. Worker runtime config

`packages/sdk/src/worker.ts`:
- `constructor(options: PilotSwarmWorkerOptions)` at `:130` — accepts `store`, `githubToken`, `blobConnectionString`, `blobContainer`, `sessionStateDir`, `modelProvidersPath`.
- `:37` — `DEFAULT_SESSION_STATE_DIR = path.join(os.homedir(), ".copilot", "session-state")`.
- `:135` — `effectiveSessionStateDir = options.sessionStateDir ?? DEFAULT_SESSION_STATE_DIR`.
- `:161` — `loadModelProviders(options.modelProvidersPath)`.
- `:268` `async start()` — kicks `runtime.start()` and initializes catalog + factStore.
- `:278` `await this._catalog.initialize()` — runs CMS migrations.
- `:285` `await this.factStore.initialize()` — runs Facts migrations.
- `:470` — `PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS` env read.
- `:814` — `throw new Error('Unsupported store URL: ${store}')`.

Env vars surfaced by the example worker (`packages/sdk/examples/worker.js:30-65`) that deploy-aks.sh wires into the K8s secret: `DATABASE_URL`, `GITHUB_TOKEN`, `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_CONTAINER` (default `copilot-sessions`), `SESSION_STATE_DIR`, `PS_MODEL_PROVIDERS_PATH` / `MODEL_PROVIDERS_PATH`, `PLUGIN_DIRS`, `LOG_LEVEL`, `POD_NAME`.

Portal requires: `DATABASE_URL`, and if `PORTAL_AUTH_PROVIDER=entra` then `PORTAL_AUTH_ENTRA_TENANT_ID` + `PORTAL_AUTH_ENTRA_CLIENT_ID` (validated at `scripts/deploy-portal.sh` lines near start; `PORTAL_AUTHZ_*` groups are optional).

### Q33. `reset-local.sh remote`

`scripts/reset-local.sh` drops duroxide/CMS/facts schemas, nukes `.tmp/`, and in `remote` mode also rebuilds+pushes the worker image and restarts the AKS rollout:
- `:33-38` — loads `.env.remote` when mode is `remote`.
- `:~196-197` — skips local FS cleanup in remote mode.
- `:245-276` — **"Rebuild and redeploy AKS workers"**: reads `K8S_CONTEXT`/`K8S_NAMESPACE`, `ACR_REGISTRY`, runs `docker buildx build --platform linux/amd64 ... --push`, `kubectl apply -f deploy/k8s/namespace.yaml`, `kubectl apply -f deploy/k8s/worker-deployment.yaml`, `kubectl rollout restart`, `rollout status --timeout=90s`.

So `reset-local.sh remote` is a subset of `deploy-aks.sh` (no test gate, no secret refresh, no portal) bolted onto a schema wipe.

## Deployable Surface

### Q34-36. Deployables

| Name | Image | Dockerfile | Entrypoint | K8s manifest | Footprint | Scale/Affinity |
|------|-------|-----------|-----------|--------------|-----------|----------------|
| Worker | `pilotswarmacr.azurecr.io/copilot-runtime-worker:latest` | `deploy/Dockerfile.worker` (node:24-slim single stage) | `node worker.js` | `deploy/k8s/worker-deployment.yaml` | 3 replicas, cpu:250m mem:1Gi, emptyDir `/home/node/.copilot`, spot tolerations | Stateless; dehydrates sessions to Blob; can run on spot |
| Portal | `pilotswarmacr.azurecr.io/pilotswarm-portal:latest` | `deploy/Dockerfile.portal` (multi-stage, Vite build in-image) | `node server.js` | `deploy/k8s/portal-deployment.yaml` + `portal-ingress.yaml` | Singleton, ClusterIP :3001, Ingress with cert-manager letsencrypt, RBAC for pod/log read | Stateless singleton (one replica) |
| Starter | `pilotswarmacr.azurecr.io/pilotswarm-starter:latest` | `deploy/Dockerfile.starter` (node:24-bookworm-slim + postgres + sshd + supervisord) | `supervisord` | **none** — not AKS-deployed | Dev-only "appliance" image | N/A |
| System agents | Run *inside the worker process* (no separate image) | — | — | — | Co-located with worker | — |
| Migration runner | **No dedicated image / Job**. Runs implicitly at worker startup via `catalog.initialize()` → `cms-migrator.runMigrations()` (`packages/sdk/src/cms-migrator.ts:21`) and `factStore.initialize()` (`facts-migrator.ts:19`). | — | — | — | — | Advisory-lock-safe across workers |

All deployables today are **stateless**; session state lives in Postgres + Azure Blob; local `emptyDir` is ephemeral cache. No PV, no leader election, no session affinity (sessions are pulled on demand by any worker via CMS).

Env-specific config per deployable:
- **Worker**: `DATABASE_URL`, `GITHUB_TOKEN`, `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_CONTAINER`, `SESSION_STATE_DIR`, `PS_MODEL_PROVIDERS_PATH`, model provider keys (`AZURE_MODEL_ROUTER_KEY`, `AZURE_FW_GLM5_KEY`, `AZURE_KIMI_K25_KEY`, `AZURE_OAI_KEY`, `ANTHROPIC_API_KEY`), `LOG_LEVEL`.
- **Portal**: `DATABASE_URL`, `PORTAL_AUTH_PROVIDER`, `PORTAL_AUTH_ENTRA_TENANT_ID`, `PORTAL_AUTH_ENTRA_CLIENT_ID`, optional `PORTAL_AUTHZ_ADMIN_GROUPS` / `PORTAL_AUTHZ_USER_GROUPS`.
- **Shared cluster config**: `K8S_CONTEXT`, `K8S_NAMESPACE` (used only by deploy scripts, not by pods themselves).

`.model_providers.example.json` is the shareable catalog template; the real `.model_providers.json` is gitignored. Providers include `github-copilot`, `azure-model-router`, `azure-fw-glm-5`, `azure-kimi`, `azure-openai`, with `apiKey: "env:AZURE_*_KEY"` references.

## Docker Image Build

### Q37. Worker image

Built via `docker buildx build --platform linux/amd64 -f deploy/Dockerfile.worker -t ... --push .` (`scripts/deploy-aks.sh:188-192`). `Dockerfile.worker` is single-stage `node:24-slim`, copies `packages/sdk/dist` + `node_modules`, ENTRYPOINT runs `worker.js`. No multi-stage build (portal does have multi-stage for the Vite build).

### Q38. `docker buildx --platform linux/amd64` convention

Mandated in `.github/copilot-instructions.md` (section "Docker / AKS Build Convention"). Enforced in-scripts at:
- `scripts/deploy-aks.sh:188-192`
- `scripts/reset-local.sh:263`
- `scripts/deploy-portal.sh` (same pattern; not cited line-by-line but follows convention).

Prevents arm64 images being pushed from macOS dev machines to AMD64 AKS nodes (→ `ImagePullBackOff`).

### Q39. All Dockerfiles

1. `deploy/Dockerfile.worker` — AKS worker.
2. `deploy/Dockerfile.portal` — AKS portal.
3. `deploy/Dockerfile.starter` — dev/sample "appliance" (not AKS).

No dedicated migration-runner Dockerfile.

## Migrations and Blob

### Q40. Migrations

Run at worker startup, **not as a K8s Job**:
- `packages/sdk/src/cms-migrator.ts:21` — `runMigrations(pool, schema, CMS_MIGRATIONS(schema), CMS_LOCK_SEED)`.
- `packages/sdk/src/facts-migrator.ts:19` — `runMigrations(pool, schema, FACTS_MIGRATIONS(schema), FACTS_LOCK_SEED)`.
- Invoked from `worker.ts:278` (`_catalog.initialize()`) and `worker.ts:285` (`factStore.initialize()`).
- `pg-migrator.ts:27` — shared advisory-lock-based runner (safe across concurrent workers).

Also invoked by the client / management client for completeness (`client.ts:401`, `management-client.ts:262`).

### Q41. Blob container bootstrap

**Not done in-code.** `packages/sdk/src/blob-store.ts:86-98` constructor only calls `BlobServiceClient.fromConnectionString(...).getContainerClient(containerName)` — no `createIfNotExists()`, no `ensure`/`bootstrap` method. A search for `createIfNotExists` across `blob-store.ts` returns zero hits. The container must be created out-of-band (manual portal op, `az storage container create`, or a future Bicep module).

## Configuration Shape for Overlays

### Q42. Env-invariant vs env-specific today

Scanning `deploy/k8s/*.yaml`:
- **Env-invariant** (would go in a Kustomize base): container/port names, resource requests/limits, tolerations, labels, selector logic, ServiceAccount skeleton, portal Service type, RBAC definitions.
- **Env-specific** (would go in overlays): `namespace: copilot-runtime` (sed-substituted), image tag (`:latest`), replica count (hard-coded 3), Ingress host `pilotswarm-portal.westus3.cloudapp.azure.com`, TLS secret name `keyvault-pilotswarm-portal-tls`, any cluster-specific cert-manager issuer, secret mount names.

Today these are **flat YAMLs with no overlay split** — all env-specific values are either hard-coded or sed-patched at apply time.

### Q43. Env injection points (current path)

Three mechanisms in play:
1. **`kubectl create secret generic copilot-runtime-secrets --from-literal=...`** at `scripts/deploy-aks.sh:100-127` — the *only* mechanism for actual runtime secrets/env. Secret is then volumeMounted/envFrom'd by pods.
2. **`sed -e "s|namespace: copilot-runtime|namespace: $NAMESPACE|g"`** at `scripts/deploy-aks.sh:204-207` — sole source of namespace override. No image-tag sed — `:latest` is literal.
3. **`.env` file loaded by shell** at `scripts/deploy-aks.sh:~40-60` from `.env.remote` — supplies `K8S_CONTEXT`, `K8S_NAMESPACE`, `ACR_REGISTRY`, `DATABASE_URL`, `AZURE_STORAGE_*`, etc. Shell scripts export and pass them into the secret.

There is **no `.env.remote.example`** file checked in (Q43 question presumes one; it does not exist — `Test-Path .env.remote.example` → False). The shareable template is `.env.example` (`.env.example:1-36`) with placeholders for all relevant keys plus commented-out blob + Entra lines. `.env.remote` itself is gitignored.

### Q44. What would change for Kustomize base

To make `deploy/k8s/*.yaml` reusable as a Kustomize base:
- Remove hardcoded `namespace: copilot-runtime` (let overlay set it via `namespace:` field).
- Remove `:latest` image tag; let overlay set it via `images:` or `replacements`.
- Remove cluster-specific Ingress host + TLS secret → overlay-only.
- Keep container spec, resource limits, tolerations, RBAC, ServiceAccount in base.
- Either refactor in place (breaking the current `deploy-aks.sh` sed flow) or fork into `deploy/kustomize/{base,overlays/<env>}/` and leave originals untouched (the intake requires the additive path).

Current base fields that will need `replacements` targets (mirroring FM): `Deployment.spec.template.spec.containers[name=worker].image`, `Ingress.spec.rules[0].host`, `Ingress.spec.tls[0].secretName`.

## External / Context

### Q45. Known target AKS cluster

`deploy/k8s/portal-ingress.yaml` references host `pilotswarm-portal.westus3.cloudapp.azure.com` and TLS secret `keyvault-pilotswarm-portal-tls`. `scripts/reset-local.sh:247` defaults `K8S_CONTEXT=toygres-aks` and `:259` `ACR_REGISTRY=toygresaksacr.azurecr.io`. This implies an existing **westus3** cluster (context `toygres-aks`, ACR `toygresaksacr`) is the current target. Entra tenancy: not explicitly documented in-repo; `.env.example:29-30` leaves `PORTAL_AUTH_ENTRA_TENANT_ID` as `<your-entra-tenant-id>`. "Not found in repo" for the explicit tenant GUID.

### Q46. SFI / 1ES / compliance

Not explicitly enumerated for PilotSwarm. In FM the prod pipeline is **OneBranch Official CrossPlat** (`postgresql-fleet-manager-deployment-prod.yml:1-20`) with `onebranch.pipeline.imagebuildinfo@1` + `Ev2RARollout@2` (1ES-compliant tasks). SDP via `Microsoft.Azure.SDP.Standard` stage map satisfies Azure-SDP requirement. Geneva telemetry is wired via BaseInfra (`flux-system.bicep` + `geneva-manifests` FluxConfig + `docs/Geneva-README.md` + `docs/HowTo-Add-New-Regions-Into-Geneva.md`). If PilotSwarm adopts the same EV2+OneBranch+SDP+Geneva chain verbatim it inherits those compliance guarantees. Other SFI-specific controls (managed identity-only, no secrets in code, mandatory OneBranch Official, ACR content trust) are **not called out in-repo** — "Not found" for explicit SFI gates.

---

## Patterns to Copy vs Simplify

### Copy as-is (high-value, low-friction)

1. **Three-shell EV2 extension model** — `UploadContainer` + `DeployApplicationManifest` (+ `DeployDacpac` for DB, omit for PilotSwarm). These scripts are product-independent; vendor them verbatim.
2. **Blob-pull FLUX source** (`sourceKind: AzureBlob`, 120s sync, kubelet identity). Simpler than Git-based GitOps: no PAT, no webhook, no image-automation controller. Matches the intake's "Azure Storage buckets for artifacts" requirement exactly.
3. **Kustomize base + `overlays/<env>/` with `configMapGenerator(.env) + replacements`**. Proven pattern; avoids templating engines. The `.env` is the only env-specific file that scope bindings need to mutate.
4. **Ev2 scope-binding → .env → ConfigMap → replacements** chain for env injection (image tag, workload-identity client IDs, AKV names). Keeps manifests deterministic for a given `.env`.
5. **`microsoft.flux` AKS extension via Bicep** (not `flux bootstrap`). IaC-native, no kubectl dependency at rollout time.
6. **`fluxConfigurations` Bicep resource** per deployable, `scope: namespace`.
7. **Managed SDP stage map** (`Microsoft.Azure.SDP.Standard`) + `ev2ManagedSdpRolloutConfig`. Zero bake-time code to maintain.
8. **Azure KV CSI Driver SecretProviderClass** with AKS addon VM MI for KV fetch; workload identity for ServiceAccount-scoped calls.

### Simplify for PilotSwarm

1. **No microservice generator**. PilotSwarm is single-repo, two deployables (worker, portal). Hand-author one `Ev2AppDeployment/` + one `bicep/main.bicep` + one `manifests/{base,overlays/prod}` tree. Skip the entire `docs/Microservice-Generator-*` scaffolding.
2. **Single service group** (`Microsoft.PilotSwarm.Runtime.<env>`) instead of one per microservice. Both worker + portal can live in a single ServiceGroup with two `serviceResourceDefinitions` or one combined manifests bundle.
3. **No `DeployDacpac` shell**. PilotSwarm migrations run at worker startup via `cms-migrator`/`facts-migrator`; no DACPAC. Drop that extension.
4. **No MSBuild `.proj`**. In a Node repo, replace the `.proj` packaging with a plain pnpm/bash script that zips `manifests/` + `Common/scripts/*` into the shell-extension package expected by EV2. Or use a pipeline `ArchiveFiles@2` task.
5. **No per-service PG stamp**. PilotSwarm uses one shared Postgres. Keep it in BaseInfra (or GlobalInfra) rather than per-service Bicep.
6. **No Azure Front Door** (Q14 GlobalInfra). PilotSwarm portal is a single AKS ingress today; Front Door is overkill unless multi-region portal is a goal.
7. **Starter image excluded from AKS path**. `Dockerfile.starter` stays as a dev appliance only.
8. **Blob container creation can be added to the new BaseInfra Bicep** (one-time), avoiding the current manual bootstrap gap in `blob-store.ts`.
9. **Initial region list can be a single region (e.g. `westus3`)** matching the known target cluster, then expand through the `Configuration/ServiceGroup/*.Configuration.json` `Geographies` array as adoption grows.
10. **Leave `scripts/deploy-aks.sh` + flat `deploy/k8s/**` untouched** (per intake) and fork into `deploy/kustomize/{base,overlays/<env>}/` + `deploy/ev2/` + `deploy/bicep/` for the new GitOps path. Side-by-side, additive.

### Key surprise / intake correction

The user intake described the reference as "FLUX + GitOps". The actual FM pattern is **FLUX with an Azure Blob `Bucket` source, not Git**. The repo's `manifests/` tree is the GitOps source-of-truth in the sense that it's what gets rendered, but FLUX itself never talks to Git — EV2 uploads a manifest bundle to a blob container and FLUX polls it every 120s. The spec should either (a) adopt this blob-pull pattern verbatim (recommended — it's what the intake seems to actually want given "Azure Storage buckets for artifacts") or (b) explicitly choose a Git-backed variant, which would mean departing from the reference and taking on PAT/webhook/ACL management. This choice should be made explicit in the spec.
