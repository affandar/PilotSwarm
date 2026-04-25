# Common/Parameters

Shared rollout-parameter assets that are **identical across every
PilotSwarm app ServiceGroup** (Worker, Portal, …). They contain only
`__TOKEN__` placeholders resolved by each service's own
`scopeBinding.json`, so there is no benefit to keeping per-service
copies.

The unified dev-loop helper (`deploy/ev2/ev2-deploy-dev.ps1`,
function `New-DeployPackages`) copies these files into each staged
ServiceGroup's `Parameters/` directory at packaging time, so EV2 sees
them at the path `serviceModel.json` expects (`rolloutParametersPath`).

| File | Used by | Notes |
|---|---|---|
| `UploadContainer.Linux.Rollout.json` | `serviceModel.json` → `*UploadContainerDefinition` | Wraps `Common/scripts/UploadContainer.sh` (zipped at packaging into `UploadContainer.zip`). |
| `DeployApplicationManifest.Linux.Rollout.json` | `serviceModel.json` → `*DeployApplicationManifestDefinition` | Wraps `Common/scripts/DeployApplicationManifest.sh` + `GenerateEnvForEv2.ps1` (zipped at packaging into `DeployApplicationManifest.zip`). |

## Per-service substitution table

`DeployApplicationManifest.parameters.json` is **per-service** (not
shared) — it lives under each service's
`<Service>/Ev2AppDeployment/Parameters/DeployApplicationManifest.parameters.json`.
Each service owns its own env-substitution surface so Worker and
Portal can evolve their `.env` keys independently. The file is
referenced by `__APPLICATION_MANIFEST_PARAMETERS_FILE__` in
`DeployApplicationManifest.Linux.Rollout.json`, uploaded as a SAS
asset with `enableScopeTagBindings: true` so EV2 substitutes the
inner `__TOKEN__`s from the service's own `scopeBinding.json` before
`GenerateEnvForEv2.ps1` rewrites the overlay `.env` files.

If you need a service-specific variant of one of the *shared* files
above, drop a service-local copy under that service's
`Ev2AppDeployment/Parameters/` directory; the staging step copies the
service tree first, then only fills in shared files that are missing —
**only do this if you actually need the divergence**, and remove it
again as soon as the shared template can carry the change.

