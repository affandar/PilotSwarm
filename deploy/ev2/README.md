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
│   ├── bicep/                       Subscription-scope Bicep (Phase 2).
│   └── Ev2InfraDeployment/          EV2 ServiceGroup — Bicep-only.
│       ├── serviceModel.json
│       ├── rolloutSpec.json
│       ├── scopeBinding.json
│       └── Parameters/{dev,prod}.deploymentParameters.json
│
├── BaseInfra/                       Per-region Azure resources (AKS, ACR, KV, AppGW, …).
│   ├── bicep/                       RG-scope Bicep (Phase 3).
│   └── Ev2InfraDeployment/          EV2 ServiceGroup — consumes GlobalInfra outputs.
│       ├── serviceModel.json
│       ├── rolloutSpec.json
│       ├── scopeBinding.json
│       └── Parameters/{dev,prod}.deploymentParameters.json
│
├── Portal/                          Portal service — AFD origin + PLS wiring + manifests.
│   ├── bicep/                       Per-region Portal Bicep (Phase 4).
│   ├── Ev2AppDeployment/            Single ServiceGroup combining Portal service infra
│   │                                (ARM: AFD origin/route + PLS approval) and the
│   │                                3-step app rollout. Ordered via rolloutSpec
│   │                                `dependsOn`: PortalServiceInfra → UploadContainer
│   │                                → GenerateEnvForEv2 → DeployApplicationManifest.
│   └── ev2-deploy-dev.ps1           Dev-loop helper (stages working tree + `az rollout start`).
│
├── Worker/                          Worker service — no Azure resources, app-only.
│   ├── Ev2AppDeployment/            Same 3-step rollout as Portal; manifests → worker-manifests container.
│   └── ev2-deploy-dev.ps1           Dev-loop helper.
│
└── Common/
    ├── bicep/                       Verbatim reference modules (Phase 4).
    └── scripts/                     Shell extensions used by app rollouts.
        ├── UploadContainer.sh           Copy image into per-region ACR.
        ├── DeployApplicationManifest.sh Render Kustomize + upload bundle to manifest blob container.
        └── GenerateEnvForEv2.ps1        Populate overlay `.env` from EV2 scope-binding env vars.
```

## Rollout order (per Application ServiceGroup)

1. `PortalServiceInfra` (Portal only) — ARM/Bicep step deploys AFD origin +
   route and Private Link endpoint approval. Worker has no service infra
   step and skips straight to step 2.
2. `UploadContainer.sh` — push image to the per-region ACR.
3. `GenerateEnvForEv2.ps1` — write the overlay `.env` from EV2 scope-binding tokens.
4. `DeployApplicationManifest.sh` — `kubectl kustomize` the overlay and upload
   the rendered bundle to the deployable's manifest blob container (FluxConfig
   on AKS reconciles from there).

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
* Dev-loop helper scripts (`ev2-deploy-dev.ps1`) stage the working tree
  into a temp `--service-group-root` so uncommitted changes can be
  deployed without a push.
