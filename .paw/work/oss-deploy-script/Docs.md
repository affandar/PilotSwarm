# OSS Node deploy orchestrator — As-built record (`Docs.md`)

This document captures the final state of the `deploy/scripts/` work
delivered under PAW work id `oss-deploy-script`. It complements
`Spec.md` (requirements) and `ImplementationPlan.md` (phased plan) by
recording what actually shipped and the key decisions made along the
way.

## Goal

Provide an OSS-friendly path that produces the **same outcome** as
`deploy/ev2/ev2-deploy-dev.ps1` (Bicep deployed → image in ACR →
substituted Kustomize manifests in the Flux Storage Bucket → rollout
verified) without any EV2 dependency. Coexists with — and never
replaces — `scripts/deploy-aks.sh` and the EV2 path.

## Final architecture

```
deploy/
├── envs/
│   └── dev.env                       # canonical env values (committed)
│   └── <env>.local.env               # personal/secret overrides (gitignored)
├── bicep-params/
│   └── *.params.template.json        # ${VAR} substituted before az deployment
└── scripts/
    ├── deploy.mjs                    # entrypoint
    ├── README.md                     # contributor docs
    └── lib/
        ├── common.mjs                # env loader, run(), assertCli, log
        ├── service-info.mjs          # SERVICE_IMAGE_INFO, MODULE_SCOPE
        ├── build-image.mjs           # docker build → docker save tarball
        ├── push-image.mjs            # oras cp tarball → ACR
        ├── render-params.mjs         # ${VAR} → params JSON
        ├── deploy-bicep.mjs          # az deployment {sub|group} create + output capture
        ├── substitute-env.mjs        # overlay .env rewrite (KEY=value form, fail-closed)
        ├── stage-manifests.mjs       # cp gitops/<svc>/ → staging, run substitute
        ├── publish-manifests.mjs     # az storage blob upload-batch (unrendered tree)
        └── wait-rollout.mjs          # kubectl rollout status + Flux Kustomization Ready
```

A root `package.json` `scripts.deploy` wrapper allows
`npm run deploy -- worker dev`. No new npm dependencies.

## Key decisions

| Topic | Decision | Rationale |
|---|---|---|
| Language | Node.js, stdlib-only, ESM `.mjs` | Multi-platform out of the box; repo is already Node; zero install. |
| Subprocess invocation | `spawnSync` with `shell: false` and explicit argv | Avoids cross-platform shell-quoting bugs (Windows / macOS / Linux). |
| Image transport | `docker save` tarball + `oras cp` to ACR | Parity with the EV2 `UploadContainer` step; no daemon-side ACR push. |
| Manifest format on the wire | **Unrendered** Kustomize tree uploaded to Flux Storage Bucket | Flux runs `kustomize build` in-cluster — no need to pre-render. (Resolved planning Q1.) |
| `.env` substitution | Strict matcher `^[A-Z_][A-Z0-9_]*=` rewrites only existing keys; fails closed with sorted summary | Mirrors EV2's `Update-EnvFileFromParametersJson` semantics; avoids partial-write footguns. |
| Bicep params | `${VAR}` JSON templates rendered by `render-params.mjs` | No `bicepparam`, no `--parameters key=value` mashing; reviewable JSON output. |
| Bicep output capture | Named outputs re-injected into the in-process env map | Lets `--steps bicep,manifests` work in one invocation without seeding ACR/KV manually. (Resolved planning Q6.) |
| Per-service identity | `deploy.mjs` maps `PORTAL_WORKLOAD_IDENTITY_CLIENT_ID` → `WORKLOAD_IDENTITY_CLIENT_ID` for the portal service before substitute | The Portal overlay shares the key name with Worker; this preserves EV2 scope-binding semantics on the OSS side. |
| Namespace | `pilotswarm` (literal) | EV2 scope binding produced this string at parameter-replace time; OSS path treats whatever is in the rendered overlay `.env` as authoritative. (Resolved planning A-11.) |
| No zip on the wire | The EV2 zip was an EV2 transport artifact; OSS uploads files directly via `az storage blob upload-batch --overwrite` | Removes a moving part with no functional difference for Flux. |
| Rollout verify | `kubectl rollout status deployment/<svc>` → `kubectl wait kustomization/<svc> -n flux-system --for=condition=Ready` → live `image` `endsWith(":<tag>")` check | Catches Flux racing back to a stale revision (CodeResearch Q5). |
| Production guard | `--allow-prod` required for `<env>=prod` | FR-018; prevents accidental prod runs. |
| Coexistence | No edits to `scripts/deploy-aks.sh`, `scripts/reset-local.sh`, `deploy/ev2/**`, or `deploy/gitops/**` source overlays | All work additive under `deploy/scripts/`, `deploy/envs/`, `deploy/bicep-params/`, plus a single `package.json` wrapper script and a cross-reference paragraph in `docs/deploying-to-aks-ev2.md`. |

## Per-service Flux ownership (post-final-review refactor)

The original implementation had `BaseInfra/storage.bicep` create three
manifest containers (`copilot-sessions`, `worker-manifests`,
`portal-manifests`) and `BaseInfra/main.bicep` create both the worker
and portal `Microsoft.KubernetesConfiguration/fluxConfigurations`
resources. Final review surfaced two issues with that shape:

1. The single shared Flux container would be re-claimed by whichever
   service deployed last, racing on a single Flux source.
2. It diverged from the `postgresql-fleet-manager` playgroundservice
   reference where each per-deployable service owns its own Flux
   source in its own bicep.

The refactor moved per-service Flux assets out of `BaseInfra` and into
each service's bicep:

| Asset | Owner |
|---|---|
| Storage account | `deploy/ev2/BaseInfra/bicep/storage.bicep` |
| `copilot-sessions` container (session blob) | `deploy/ev2/BaseInfra/bicep/storage.bicep` |
| Account-scope `Storage Blob Data Reader` for AKS kubelet UAMI | `deploy/ev2/BaseInfra/bicep/storage.bicep` |
| `microsoft.flux` extension on AKS | `deploy/ev2/BaseInfra/bicep/aks.bicep` |
| `worker-manifests` container | `deploy/ev2/Worker/bicep/main.bicep` (NEW) |
| Worker Flux configuration | `deploy/ev2/Worker/bicep/main.bicep` (NEW) |
| `portal-manifests` container | `deploy/ev2/Portal/bicep/main.bicep` |
| Portal Flux configuration | `deploy/ev2/Portal/bicep/main.bicep` |
| Shared `flux-config.bicep` module | `deploy/ev2/Common/bicep/flux-config.bicep` (moved from BaseInfra) |

Account-scope blob-data-reader on the kubelet UAMI means new
per-service containers automatically inherit access — no per-container
role assignment needed.

### EV2 Worker InfraDeployment phase

EV2 Worker previously had no infra deploy phase (it was app-only). The
refactor adds a `WorkerServiceInfra` step to
`deploy/ev2/Worker/Ev2AppDeployment/rolloutSpec.json` that runs the new
bicep before `UploadContainer`. Mirrors Portal exactly:

```
WorkerServiceInfra (deploy bicep) → UploadContainer → DeployApplicationManifest
```

`Worker/service.json` `bicepMain` now points at
`Worker/bicep/main.bicep`; `armTemplateOut` at the gitignored
`Worker/Ev2AppDeployment/Templates/Worker.deploymentTemplate.json` that
`ev2-deploy-dev.ps1` regenerates via `az bicep build`.

### OSS-side wiring shifts

| Before | After |
|---|---|
| `SERVICE_TO_MODULES.worker = ['BaseInfra']` | `['BaseInfra', 'Worker']` |
| Single `manifestsContainerName` BaseInfra output mapped to a per-service env key (`_WORKER`/`_PORTAL`) with deploy.mjs picker logic | Each service's bicep emits its own `manifestsContainerName` output → one shared alias `manifestsContainerName → DEPLOYMENT_STORAGE_CONTAINER_NAME`; deploy.mjs picker reverted (each invocation is service-scoped) |
| EV2 Portal `deploymentParameters.json`: 9 params | + `storageAccountName`, `aksClusterName`, `environment` |
| EV2 Worker `deploymentParameters.json`: did not exist | Created with `storageAccountName`, `aksClusterName`, `environment` |

## End-to-end bring-up (`all` aggregate)

Single virtual service that drives the canonical EV2-equivalent sequence
in one invocation:

```
globalinfra → baseinfra → worker → portal
```

(Mirrors `deploy/ev2/services.json` `infraOrder` + service order.)

```bash
node deploy/scripts/deploy.mjs all dev                       # full bring-up
node deploy/scripts/deploy.mjs all dev --steps bicep         # infra-only refresh
node deploy/scripts/deploy.mjs all dev --steps manifests,rollout  # app-only redeploy
```

**Implementation notes:**

- `ALL_SEQUENCE` and `ALL_MODE_MODULES` live in `deploy/scripts/lib/service-info.mjs`.
- Single shared env Map across the sequence so Bicep outputs from earlier
  services (e.g. `ACR_LOGIN_SERVER`, `DEPLOYMENT_STORAGE_ACCOUNT_NAME`)
  cascade forward to later services.
- Each service in `all` mode deploys only its own Bicep module — dependencies
  (e.g. BaseInfra) were already deployed by an earlier item in the same
  invocation, so we don't redundantly re-apply them. Single-service
  invocations (`worker dev`) keep the safer `SERVICE_TO_MODULES` order
  that redeploys dependencies.
- `--steps` is intersected with `defaultPipelineFor(service)` per item so
  app-only steps (`manifests,rollout`) cleanly skip infra services rather
  than failing on missing overlays.

## Tests

Stdlib-only unit tests for the two trickiest pieces of the orchestrator
ship with the script:

| Suite | What it covers |
|---|---|
| `deploy/scripts/test/substitute-env.test.mjs` | `KEY_LINE_RE` rewrite rules; comments/blanks/non-`UPPER_SNAKE` lines pass-through; fail-closed sorted summary on unresolved keys (EC-3); empty/null/undefined treated as unresolved; CRLF-tolerant. |
| `deploy/scripts/test/alias-map.test.mjs` | Explicit `OUTPUT_ALIAS` overrides; post-refactor `manifestsContainerName → DEPLOYMENT_STORAGE_CONTAINER_NAME` (and assertion that the pre-refactor `_WORKER`/`_PORTAL` aliases are gone); default `camelCase → UPPER_SNAKE` rule including ALL-CAPS acronyms and digit boundaries. |
| `deploy/scripts/test/all-mode.test.mjs` | `ALL_SEQUENCE` matches EV2 `services.json` infraOrder; `ALL_MODE_MODULES` deploys exactly one module per service (no redundant BaseInfra redeploys); `validateService` accepts the virtual `all` aggregate; `--steps` intersection with `defaultPipelineFor(service)` so app-only steps cleanly skip infra services. |

Run via `npm run test:deploy-scripts` (no new npm dependencies — uses
`node:test` + `node:assert`).

## Phase ledger

| Phase | Commit | Summary |
|---|---|---|
| 1 | `ff8051b` | Skeleton — `deploy.mjs` arg parsing, `common.mjs` env loader + `run()`, preflight (Azure login + sub match + prod guard), `--steps noop` works on Windows + macOS. |
| 2 | `3c6de9d` | Image lifecycle — `docker save` tarball + `oras cp` to ACR; service-aware skip for non-image services. |
| 3 | `f414ae4` | Bicep — `${VAR}` template substitute + `az deployment create` per `MODULE_SCOPE` + named-output capture. |
| 4 | `d4908ba` | Manifests — `substitute-env.mjs` (fail-closed) + `stage-manifests.mjs` + `publish-manifests.mjs` (no zip). Per-service workload identity remap added in same phase. |
| 5 | `04fa420` | Rollout — `wait-rollout.mjs` waits for Deployment + Flux Kustomization, asserts `endsWith(":<tag>")` against live image. |
| 6 | *(this commit)* | Docs — `deploy/scripts/README.md`, cross-reference paragraph in `docs/deploying-to-aks-ev2.md`, this `Docs.md`. |

## Coexistence matrix (final)

| Path | State after this work |
|---|---|
| `scripts/deploy-aks.sh` | Untouched. Still the engineer-smoke path documented in `docs/deploying-to-aks.md`. |
| `scripts/reset-local.sh` | Untouched. |
| `deploy/ev2/**` | Untouched. The EV2 production path documented in `docs/deploying-to-aks-ev2.md` works as before. |
| `deploy/gitops/**` (source overlays) | Untouched. The OSS `manifests` step copies the source tree into a staging directory and substitutes the overlay `.env` *only inside the staging copy*. |
| `deploy/scripts/**` | New. OSS-friendly equivalent of the EV2 path. |
| `deploy/envs/**` | New. Source-of-truth env files (committed) + optional `.local.env` (gitignored) for personal overrides. |
| `deploy/bicep-params/**` | New. `${VAR}`-templated parameter JSONs rendered by `render-params.mjs`. |
| `docs/deploying-to-aks-ev2.md` | One paragraph added near the top cross-referencing the OSS path. No other changes. |
| `docs/deploying-to-aks.md` | Untouched (engineer-smoke doc, per SC-008). |

## Out-of-scope (deferred)

- GitHub Actions / OIDC wrapper around `deploy.mjs`.
- Migration of `deploy/ev2/**` into a parent (private) repo.
- Replacement of `scripts/deploy-aks.sh`.
- Federated identity for CI deploy.
- Secrets management (KV bootstrap, postgres rotation) — same TODO as the EV2 path.

## References

- Spec: [`Spec.md`](./Spec.md)
- Plan: [`ImplementationPlan.md`](./ImplementationPlan.md)
- Code research: [`CodeResearch.md`](./CodeResearch.md)
- Workflow context: [`WorkflowContext.md`](./WorkflowContext.md)
- Contributor docs: [`deploy/scripts/README.md`](../../../deploy/scripts/README.md)
- EV2 path docs: [`docs/deploying-to-aks-ev2.md`](../../../docs/deploying-to-aks-ev2.md)
- Imperative path docs: [`docs/deploying-to-aks.md`](../../../docs/deploying-to-aks.md)
