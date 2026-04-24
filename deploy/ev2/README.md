# PilotSwarm EV2 ServiceGroups

This tree defines the four EV2 ServiceGroups used to deploy PilotSwarm
to AKS via GitOps (Flux reconciling Kustomize bundles from blob storage):
two shared-infrastructure SGs (`GlobalInfra`, `BaseInfra`) and one SG per
service (`Worker`, `Portal`).

For the full operator guide see
[`docs/deploying-to-aks-ev2.md`](../../docs/deploying-to-aks-ev2.md)
(added in Phase 7).

## Directory map

```
deploy/ev2/
├── GlobalInfra/                     Fleet-wide Azure resources (AFD + WAF).
│   ├── service.json                 Self-contained manifest (indexed from services.json).
│   ├── bicep/                       Subscription-scope Bicep (Phase 2).
│   └── Ev2InfraDeployment/          EV2 ServiceGroup — Bicep-only.
│       ├── serviceModel.json
│       ├── rolloutSpec.json
│       ├── scopeBinding.json
│       ├── version.txt              Artifacts version passed to New-AzureServiceRollout.
│       ├── Configuration/
│       │   ├── configurationSettings.json                                Service-scope $config source.
│       │   └── ServiceGroup/Microsoft.PilotSwarm.GlobalInfra.{Dev,Prod}.Configuration.json
│       │                                                                 Per-env $config source (resolved via $serviceGroup()).
│       └── Parameters/GlobalInfra.deploymentParameters.json              ARM params consumed by serviceModel.
│
├── BaseInfra/                       Per-region Azure resources (AKS, ACR, KV, AppGW, …).
│   ├── service.json                 Self-contained manifest.
│   ├── bicep/                       RG-scope Bicep (Phase 3).
│   └── Ev2InfraDeployment/          EV2 ServiceGroup — consumes GlobalInfra outputs.
│       ├── serviceModel.json
│       ├── rolloutSpec.json
│       ├── scopeBinding.json
│       ├── version.txt
│       ├── Configuration/
│       │   ├── configurationSettings.json
│       │   └── ServiceGroup/Microsoft.PilotSwarm.BaseInfra.{Dev,Prod}.Configuration.json
│       └── Parameters/BaseInfra.deploymentParameters.json
│
├── Portal/                          Portal service — AFD origin + PLS wiring + manifests.
│   ├── service.json                 Self-contained manifest.
│   ├── bicep/                       Per-region Portal Bicep (Phase 4).
│   └── Ev2AppDeployment/            Single ServiceGroup combining Portal service infra
│       │                            (ARM: AFD origin/route + PLS approval) and the
│       │                            2-step app rollout. Ordered via rolloutSpec
│       │                            `dependsOn`: PortalServiceInfra → UploadContainer
│       │                            → DeployApplicationManifest.
│       ├── version.txt
│       ├── Configuration/
│       │   ├── configurationSettings.json
│       │   └── ServiceGroup/Microsoft.PilotSwarm.Portal.{Dev,Prod}.Configuration.json
│       └── Parameters/Portal.deploymentParameters.json + *.Linux.Rollout.json
│
├── Worker/                          Worker service — no Azure resources, app-only.
│   ├── service.json                 Self-contained manifest.
│   └── Ev2AppDeployment/            Same 2-step rollout as Portal; manifests → worker-manifests container.
│       ├── version.txt
│       ├── Configuration/
│       │   ├── configurationSettings.json
│       │   └── ServiceGroup/Microsoft.PilotSwarm.Worker.{Dev,Prod}.Configuration.json
│       └── Parameters/*.Linux.Rollout.json
│
├── services.json                    Root index: fleet-wide defaults + pointers
│                                    to each service's self-contained manifest.
├── ev2-deploy-dev.ps1               Unified dev-loop helper (see below).
└── .staging/                        Gitignored; per-invocation staging roots.
│
└── Common/
    ├── bicep/                       Verbatim reference modules (Phase 4).
    ├── Parameters/
    │   └── DeployApplicationManifest.parameters.json  Shared overlay-substitution table; copied
    │                                                  into each service's staged `Parameters/` and
    │                                                  rewritten by per-service scope-binding at
    │                                                  artifact-upload time.
    └── scripts/                     Shell extensions used by app rollouts (verbatim
        │                            from postgresql-fleet-manager; stable/mature).
        │                            Staged into each service's SG root as zips by
        │                            `ev2-deploy-dev.ps1 :: New-DeployPackages`:
        │                              - UploadContainer.zip              (UploadContainer.sh)
        │                              - DeployApplicationManifest.zip    (DeployApplicationManifest.sh
        │                                                                  + GenerateEnvForEv2.ps1)
        │                              - manifests.zip                    (service gitops tree:
        │                                                                  base/ + overlays/<env>/)
        ├── UploadContainer.sh           `wget` the image tarball via EV2-minted SAS URL,
        │                                `oras cp` the OCI layout into the target ACR.
        ├── DeployApplicationManifest.sh Download manifests.zip + parameters JSON, dot-source
        │                                GenerateEnvForEv2.ps1 to rewrite overlay `.env` values,
        │                                `az storage blob upload-batch` into the deployable's
        │                                manifest container, 2-min sleep for ACI log flush.
        └── GenerateEnvForEv2.ps1        Library: `Update-EnvFileFromParametersJson` substitutes
                                         values for keys already present in the overlay `.env`
                                         (missing JSON keys preserve existing .env value; extra
                                         JSON keys are ignored).
```

## Rollout order (per Application ServiceGroup)

1. `PortalServiceInfra` (Portal only) — ARM/Bicep step deploys AFD origin +
   route and Private Link endpoint approval. Worker has no service infra
   step and skips straight to step 2.
2. `UploadContainer.sh` — EV2 mints a SAS URL for `ContainerImages/<image>.tar.gz`,
   `wget` downloads it, `az acr login --name $DEPLOYMENT_ACR_NAME`, then
   `oras cp --from-oci-layout` pushes the image into the per-region ACR.
3. `DeployApplicationManifest.sh` — downloads `manifests.zip` (service gitops
   tree) and the per-service scope-tag-bound `DeployApplicationManifest.parameters.json`,
   dot-sources `GenerateEnvForEv2.ps1` to rewrite the overlay `.env`
   placeholder values, uploads the entire `manifests/` directory to the
   deployable's blob container (FluxConfig on AKS reconciles from
   `overlays/<env>/` relative to the container root).

## Dependencies

* `BaseInfra` depends on `GlobalInfra` (AFD profile + WAF).
* `Portal` depends on `BaseInfra` and `GlobalInfra` (consumes AppGW + AFD outputs).
* `Worker` depends on `BaseInfra`.

## ServiceGroup granularity

We use **one ServiceGroup per service** (Worker, Portal), not per Infra/App
split. This mirrors the `postgresql-fleet-manager` PlaygroundService pattern:
service-specific ARM deploys and app rollout steps live in a single
`Ev2AppDeployment/` tree and are ordered via rolloutSpec `dependsOn`.
Shared infrastructure (`GlobalInfra`, `BaseInfra`) remains in its own
ServiceGroups because it is consumed by both services.

## Notes

* Filenames use **camelCase** (`serviceModel.json`, `rolloutSpec.json`,
  `scopeBinding.json`) to match the postgresql-fleet-manager convention for
  ecosystem compatibility with shared EV2 tooling. The Phase 5 plan text
  used PascalCase; camelCase takes precedence here.
* `Templates/` directories are not checked in — Bicep is compiled to ARM
  JSON by the OneBranch pipeline (Phase 6) before the rollout artifact
  is uploaded.
* **Unified dev-loop helper** `deploy/ev2/ev2-deploy-dev.ps1` handles all
  four SGs via `-Service {GlobalInfra|BaseInfra|Worker|Portal}` driven
  by `deploy/ev2/services.json`. It uses the internal EV2 PowerShell
  cmdlets (`Register-AzureServiceArtifacts` + `New-AzureServiceRollout`
  from `AzureServiceDeployClient.ps1`) — **not** `az rollout start`.
  Improvements over the postgresql-fleet-manager reference:
  - Service manifests replace the hardcoded `ValidateSet` + switch
    statement. Each service is self-contained: per-service config lives
    in `deploy/ev2/<Service>/service.json` alongside its SG tree, and
    the root `services.json` is a thin index (fleet-wide defaults +
    pointers). Adding a service = drop `<Name>/service.json` + add one
    line to the root index; no script change.
  - Staging root lives at `deploy/ev2/.staging/<service>-<stamp>/`
    inside the repo (gitignored) instead of `%TEMP%`, so failed runs
    are easy to inspect.
  - Optional `-DeployInfra` fans out to GlobalInfra → BaseInfra → the
    selected service (fleet-manager parity).
  - Optional `-BuildImage` builds the image locally with
    `docker buildx build --platform linux/amd64 --load`, then
    `docker save` + gzip → stages it into the SG artifact at
    `ContainerImages/<image>.tar.gz` (official EV2 pattern; the
    UploadContainer shell extension downloads the tar via an
    EV2-minted SAS URL and uses `oras cp` to push to the target ACR).
  See
  [`docs/deploying-to-aks-ev2.md`](../../docs/deploying-to-aks-ev2.md#dev-test-rollout)
  for setup and usage.
* `$config(...)` tokens in each `scopeBinding.json` resolve against the
  SG's `Configuration/` tree: `configurationSettings.json` (service
  scope) merged with `ServiceGroup/<env-qualified-name>.Configuration.json`
  (per-env scope, selected via the `$serviceGroup()` macro). This mirrors
  the postgresql-fleet-manager PlaygroundService pattern.
* `version.txt` at each SG root holds the `ArtifactsVersion` passed to
  `New-AzureServiceRollout`; the OneBranch pipeline bumps it at release
  time.
* `Templates/*.deploymentTemplate.json` files are Bicep→ARM build
  outputs — gitignored and regenerated by the helper (`az bicep build`)
  or the pipeline before EV2 registration.
