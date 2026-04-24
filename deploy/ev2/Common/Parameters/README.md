# Common/Parameters

Shared rollout-parameter and substitution-table assets that are
**identical across every PilotSwarm app ServiceGroup** (Worker, Portal,
…). They contain only `__TOKEN__` placeholders resolved by each
service's own `scopeBinding.json`, so there is no benefit to keeping
per-service copies.

The unified dev-loop helper (`deploy/ev2/ev2-deploy-dev.ps1`,
function `New-DeployPackages`) copies these files into each staged
ServiceGroup's `Parameters/` directory at packaging time, so EV2 sees
them at the path `serviceModel.json` expects (`rolloutParametersPath`).

| File | Used by | Notes |
|---|---|---|
| `UploadContainer.Linux.Rollout.json` | `serviceModel.json` → `*UploadContainerDefinition` | Wraps `Common/scripts/UploadContainer.sh` (zipped at packaging into `UploadContainer.zip`). |
| `DeployApplicationManifest.Linux.Rollout.json` | `serviceModel.json` → `*DeployApplicationManifestDefinition` | Wraps `Common/scripts/DeployApplicationManifest.sh` + `GenerateEnvForEv2.ps1` (zipped at packaging into `DeployApplicationManifest.zip`). |
| `DeployApplicationManifest.parameters.json` | `DeployApplicationManifest.sh` (downloaded via SAS, scope-tag-bound) | Substitution table consumed by `GenerateEnvForEv2.ps1` to rewrite each overlay's `.env` placeholders. |

If you need a service-specific variant (different env vars, different
shell extension, etc.), drop a service-local copy under that service's
`Ev2AppDeployment/Parameters/` directory; `New-DeployPackages` copies
the shared files first, so a service-local copy will overwrite —
**only do this if you actually need the divergence**, and remove it
again as soon as the shared template can carry the change.
