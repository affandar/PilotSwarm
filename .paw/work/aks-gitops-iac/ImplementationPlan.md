# AKS GitOps IaC Implementation Plan

## Overview

Introduce a FLUX + GitOps + Kustomize + Azure Storage + EV2 deploy path
for PilotSwarm, modeled on `postgresql-fleet-manager`, **side-by-side**
with the existing imperative `scripts/deploy-aks.sh` flow. The new path
is composed of four independent EV2 ServiceGroups (GlobalInfra,
BaseInfra, Worker, Portal), fronted by Azure Front Door Premium + WAF
with portal traffic traversing Private Link to a private-link-ready
Application Gateway. All runtime configuration flows through a single,
deterministic chain: EV2 scope bindings → overlay `.env` →
`configMapGenerator` → Kustomize `replacements` → rendered manifest;
runtime secrets reach pods exclusively through Key Vault via the
AKS CSI driver. Existing `deploy/k8s/`, `deploy/Dockerfile.*`,
`scripts/deploy-aks.sh`, and `docs/deploying-to-aks.md` are
untouched.

## Current State Analysis

- **Imperative deploy today** (`scripts/deploy-aks.sh:1-221`): one K8s
  Secret `copilot-runtime-secrets` is rebuilt with ~25 literal flags
  (`:100-127`), `acr-pull` is re-minted from `az acr login
  --expose-token` (`:129-137`), `docker buildx build --platform
  linux/amd64 --push` for `copilot-runtime-worker` (`:187-193`), then
  `kubectl apply` + `rollout restart`. The portal manifests are applied
  out-of-band (not invoked by `deploy-aks.sh`).
- **K8s surface**: 3 files under `deploy/k8s/` (namespace, worker
  Deployment, portal SA+RBAC+Deployment+Service), plus
  `deploy/k8s/portal-ingress.yaml` using AKS App Routing / NGINX
  (`ingressClassName: webapprouting.kubernetes.azure.com`) + cert-manager
  + `keyvault-pilotswarm-portal-tls` and WebSocket-friendly annotations
  for `/portal-ws` (`packages/portal/server.js:204`).
- **Single-Secret env pattern**: both worker and portal use
  `envFrom: copilot-runtime-secrets` for every runtime variable —
  `DATABASE_URL`, `AZURE_STORAGE_*`, `LLM_*`, `PORTAL_AUTH_*`,
  `PORTAL_AUTHZ_*`, `GITHUB_TOKEN`. The full env matrix is catalogued
  in CodeResearch.md §2.
- **Inline DB migrations** under PG advisory lock
  (`packages/sdk/src/pg-migrator.ts`) run at worker startup for both
  CMS (`packages/sdk/src/cms.ts:445-452`) and Facts
  (`packages/sdk/src/facts-store.ts:153-159`). A migration Job is not
  needed and Spec FR-012 preserves this behavior.
- **Blob bootstrap**: `SessionBlobStore`
  (`packages/sdk/src/blob-store.ts:86-99`) assumes one container
  (default `copilot-sessions`) exists; it is not created by code. The
  imperative path relies on that container being pre-provisioned. No
  source change is needed — BaseInfra Bicep creates the container.
- **Reference repo** (`C:\Repos\postgresql-fleet-manager`): provides the
  canonical ServiceGroup shape, `Common/bicep/` modules,
  PlaygroundService ingress pattern (hostname → EV2 scopeBinding →
  overlay `.env` → ConfigMap → `replacements` into ingress), GlobalInfra
  (AFD + WAF) at subscription scope, and the AFD-over-Private-Link
  wiring with the documented `_e41f87a2_{appgw}_{plConfig}` PLS service
  id. Two files are copied verbatim:
  `src/Deploy/Common/bicep/frontdoor-origin-route.bicep` and
  `src/Deploy/Common/bicep/approve-private-endpoint.bicep`.

## Desired End State

A merged `feature/aks-gitops-iac` branch adding a new top-level
`deploy/` tree (under distinct subdirectories, no existing files
touched) that:

1. Produces a Kustomize base + dev/prod overlays per deployable that
   renders identical manifest behavior to the current `deploy/k8s/`
   set — except the portal ingress uses
   `ingressClassName: azure-application-gateway` with empty placeholder
   host/TLS fields filled by `replacements`, and secrets are mounted
   via `SecretProviderClass` instead of an imperatively-created Secret.
2. Provides three Bicep trees — GlobalInfra (subscription scope, AFD
   Premium + WAF + security policy), BaseInfra (per-region: AKS, ACR,
   PG, Storage with blob container, AKV, UAMIs, VNet + PL subnet,
   private-link-ready AppGW, FLUX extension + per-deployable
   FluxConfigs), and per-deployable service Bicep (AFD origin/route
   registration + auto-approval of pending PLS connection on AppGW).
3. Defines four EV2 ServiceGroups (`GlobalInfra`, `BaseInfra`,
   `Worker`, `Portal`), each with `RolloutSpec`, `ScopeBindings`,
   `Parameters/{env}.json`, and `Ev2AppDeployment/` (for App SGs)
   wired to Azure-managed SDP stage maps for a single initial prod
   region (`westus3`).
4. Vendors adapted copies of fleet-manager's `UploadContainer.sh`,
   `DeployApplicationManifest.sh`, and `GenerateEnvForEv2.ps1` shell
   extensions plus a per-app `ev2-deploy-dev.ps1` helper.
5. Adds five OneBranch pipeline lines — one CI (build + push worker +
   portal images), one prod line per ServiceGroup (GlobalInfra,
   BaseInfra, Worker, Portal) invoking `Ev2RARollout@2`.
6. Adds `docs/deploying-to-aks-ev2.md` as the canonical guide for the
   new path, cross-linked from `docs/deploying-to-aks.md` without
   altering that file's operational content.

**Verification approach**:
- Local: `kubectl kustomize deploy/gitops/{worker,portal}/overlays/{dev,prod}`
  renders successfully; `kubeconform` / `kubeval` passes; `az
  deployment sub what-if` / `az bicep build` succeeds for each Bicep
  tree; `az rollout validate` succeeds for each ServiceGroup.
- Functional: a dev-test EV2 rollout reconciles the cluster, and a
  full prod SDP rollout of GlobalInfra → BaseInfra → Worker + Portal
  brings up a region. `scripts/deploy-aks.sh` continues to succeed
  against a dev cluster with zero edits.

## What We're NOT Doing

- **No changes to existing deploy surface** (Spec FR-009, Out-of-Scope):
  `scripts/deploy-aks.sh`, `scripts/reset-local.sh`,
  `scripts/deploy-portal.sh`, `deploy/k8s/*.yaml`, `deploy/Dockerfile.*`,
  `docs/deploying-to-aks.md` — all untouched.
- **No combined ServiceGroup** — worker and portal ship independently
  (FR-016).
- **No migration Job** — migrations continue running inline at worker
  startup (FR-012).
- **No Flux image-automation controller** — image tags flow through
  EV2 → overlay `.env` → Kustomize `replacements` (FR-006).
- **No Git-source FluxConfig** — Azure Blob only (FR-004).
- **No Geneva telemetry onboarding** — BaseInfra leaves room but this
  work does not ship it.
- **No traffic cutover** — the two deploy paths coexist; moving
  production traffic from the bash path to EV2 is an operational
  decision separate from this work.
- **No provisioning of the bash-path dev cluster** — engineer-managed,
  out of scope.
- **No code changes to `blob-store.ts`**: the container is created in
  BaseInfra Bicep only (Spec FR-011, CodeResearch §6).
- **No `imagePullSecrets: acr-pull` Secret under GitOps**: the new
  path uses AKS kubelet MI with `AcrPull` role instead (CodeResearch
  Open Question 2). The imperative path continues to mint `acr-pull`
  via `scripts/deploy-aks.sh:129-137` — unchanged.
- **No Worker-specific Bicep**: the Worker deployable owns no Azure
  resources; its ServiceGroup invokes only shell extensions.

## Edge Cases — Accepted Operational Behavior

Each spec Edge Case has a designated handling strategy; these are not
phase-gating tests but documented behaviors the design relies on.

- **FLUX cannot reach manifest blob**: FluxConfig `kustomizations[0]`
  is configured with default 120s interval; the AKS extension retries
  with exponential back-off. Detection: `kubectl get fluxconfig -A`
  shows `ComplianceState=Non-Compliant`. Mitigation is operational
  (network/firewall) — no code path in this work traps it.
- **Partial blob upload during rollout**: `UploadContainer.sh` and
  `DeployApplicationManifest.sh` each use `az storage blob upload-batch
  --overwrite` (idempotent). A partial upload that is retried produces
  the same final blob. FLUX only reconciles fully uploaded bundles
  because the manifest container is a single blob per overlay.
- **Key Vault secret rotation mid-rollout**: SPC rotation is polled
  (`syncSecret: true` + rotationPollInterval 120s). Pods pick up
  rotated values on the next mount without a restart; runtime code
  must tolerate secret reload (consistent with current
  `copilot-runtime-secrets` behavior).
- **Region added but BaseInfra not yet deployed**: the Worker/Portal
  ServiceGroup rollout fails fast because
  `$serviceResourceDefinition(BaseInfraDefinition).action(deploy).outputs(…)`
  has no deployed instance in that region. EV2 surfaces this as a
  binding error, not a runtime crash.
- **Parallel rollouts on the same manifest container**: EV2 SDP stage
  map + Azure Storage lease semantics of `upload-batch` prevent lost
  updates: the last completed rollout wins, and FLUX reconciles to
  that state.
- **Coexistence of `scripts/deploy-aks.sh` and EV2 path on the same
  cluster**: both paths target the `copilot-runtime` namespace.
  **Operators MUST pick one path per cluster** (per
  Spec Assumption "Coexistence with `scripts/deploy-aks.sh`"). This is
  a documented operational rule, not a technical guard — Phase 7
  documents it prominently in `docs/deploying-to-aks-ev2.md`. The
  existing imperative path continues to work unchanged on its
  engineer-driven dev cluster (`toygres-aks`).

## Notes on Conventions

- **Directory naming**: new trees live under `deploy/gitops/` (Kustomize)
  and `deploy/ev2/` (Bicep + ServiceGroup definitions + shell
  extensions) — distinct top-level subdirectories. Spec FR-009's
  suggested paths (`deploy/kustomize/`, `deploy/bicep/`) are
  non-normative ("such as"); the flatter `deploy/gitops/` +
  `deploy/ev2/` split groups files by their lifecycle surface
  (cluster-facing vs EV2-facing) and keeps the existing `deploy/k8s/`
  + `deploy/Dockerfile.*` untouched.
- **`kubeconform`** is an **optional** local-validation dev
  dependency; it is installed per-developer (Phase 7 documents the
  install step). It is not added to `package.json`. Phase 1 and
  Phase 7 reference it as a developer aid — the repo's spec-mandated
  local validation (FR-010) is satisfied by `kubectl kustomize` and
  `az bicep build` alone; `kubeconform` is a non-blocking quality
  gate above that minimum.
- **CI test gate preserved**: Phase 6 CI runs the full test suite
  before any image build or push, matching the existing
  `scripts/deploy-aks.sh:141-154` pre-deploy gate.

## Phase Status

- [x] **Phase 1: Kustomize trees (worker + portal) with base + dev/prod overlays** — Author the GitOps-ready manifest trees so any cluster reconciling the blob bundles produces a pod-for-pod equivalent of today's imperative apply, with the portal switched to AGIC + SecretProviderClass.
- [x] **Phase 2: GlobalInfra Bicep (fleet-wide AFD + WAF)** — Provision the Azure Front Door Premium profile, endpoint, WAF policy (Prevention mode), and security-policy association at subscription scope.
- [x] **Phase 3: BaseInfra Bicep (per-region Azure resources)** — Provision AKS (with `microsoft.flux` and `azureKeyvaultSecretsProvider` addons), ACR, PG, Storage (with session blob container), AKV, UAMIs, VNet with dedicated PL subnet, private-link-ready Application Gateway, and per-deployable FluxConfigs pointing to the manifest storage account.
- [ ] **Phase 4: Portal AFD + Private Link wiring** — Vendor the two verbatim reference Bicep modules and invoke them from the Portal service Bicep to register a per-region AFD origin + route and auto-approve the pending PLS connection on the AppGW side.
- [ ] **Phase 5: Four EV2 ServiceGroups + shell extensions + dev-test helpers** — Define `ServiceModel.json`, `RolloutSpec.json`, `ScopeBindings.json`, `Parameters/{env}.json`, `Ev2AppDeployment/` for all four ServiceGroups (BaseInfra + the two App SGs consume shell extensions; GlobalInfra is Bicep-only), with Azure-managed SDP stage maps and `ev2-deploy-dev.ps1` per App SG.
- [ ] **Phase 6: Pipelines (OneBranch Official)** — One CI line (build + push worker + portal images to ACR) and four prod lines (one per ServiceGroup) driving `Ev2RARollout@2`.
- [ ] **Phase 7: Documentation** — Produce `docs/deploying-to-aks-ev2.md`, cross-link from `docs/deploying-to-aks.md`, write `Docs.md` (as-built reference), and update README/CHANGELOG if warranted.

## Phase Candidates

<!-- Empty — all in-scope items map to defined phases above. Future
     follow-ups (Geneva telemetry, traffic cutover) are explicitly
     out-of-scope per Spec. -->

---

## Phase 1: Kustomize trees (worker + portal) with base + dev/prod overlays

### Changes Required

- **`deploy/gitops/worker/base/`** (new directory):
  - `namespace.yaml` — copy of `deploy/k8s/namespace.yaml` (preserves
    `copilot-runtime` namespace + `app.kubernetes.io/name=pilotswarm`
    label).
  - `deployment.yaml` — copy of `deploy/k8s/worker-deployment.yaml`
    with the image reference replaced by a stable single-token
    placeholder `__IMAGE__` (FR-014: no env-specific value in base).
    The full `<acr>/<name>:<tag>` reference is composed by EV2 at
    rollout (Phase 5 `GenerateEnvForEv2.sh` builds `IMAGE=` from
    `ACR_LOGIN_SERVER` + `IMAGE_NAME` + `IMAGE_TAG` scope bindings)
    because Kustomize `replacements` cannot concatenate multiple
    source fields into one target string. The individual tokens
    remain in the overlay ConfigMap for downstream Phase 3/5 use.
    `imagePullPolicy: IfNotPresent` —
    paired with an immutable build-id tag produced by CI (FR-006,
    SC-002); this resolves the mutable-tag / `Always`-pull drift risk
    observed in CodeResearch §1, §3.
    **Must preserve** `replicas: 3`, spot toleration (`:26-30`),
    busybox initContainer (`:31-43`), `POD_NAME` downward API
    (`:49-52`), `emptyDir` volume (`:65-70`), resource
    requests/limits (`:58-64`) (CodeResearch §1, §3).
    **Intentional divergence from `deploy/k8s/worker-deployment.yaml`**:
    (1) drop `imagePullSecrets: acr-pull` (`:24-25`) — under GitOps
    ACR pull is authenticated via AKS kubelet managed identity with
    `AcrPull` role (provisioned in Phase 3); no reconciler mints the
    `acr-pull` Secret, so retaining it would cause `ImagePullBackOff`.
    (2) switch `envFrom: copilot-runtime-secrets` to
    `envFrom: copilot-worker-secrets` — this Secret is synthesized by
    the worker's own `SecretProviderClass` below; the portal has its
    own SPC + Secret (`pilotswarm-portal-secrets`) to avoid two SPCs
    racing on a shared Secret name (per-deployable ownership).
  - `secret-provider-class.yaml` — new `SecretProviderClass` (AKV CSI
    driver) that mirrors every key today written to
    `copilot-runtime-secrets` by `scripts/deploy-aks.sh:100-127`, with
    `secretObjects` producing a K8s Secret named
    `copilot-worker-secrets`. One `objectName` entry per literal flag
    in `deploy-aks.sh`. The Secret is materialized only at pod mount
    time by the CSI driver (no imperative `kubectl create secret`
    ever runs — FR-005 satisfied by construction).
  - `kustomization.yaml` — lists the resources above; declares
    `configMapGenerator` producing `worker-env` with **typed
    placeholder defaults** (e.g. `placeholder.azurecr.io/<name>:placeholder`,
    `copilot-runtime` for `NAMESPACE`, zero UUIDs for identity fields)
    so `kubectl kustomize` succeeds even without an overlay override
    (required by `validate.sh`). Declares `replacements` rules from
    the ConfigMap into `deployment.yaml`, the ServiceAccount
    annotation, and the SecretProviderClass parameters.

- **`deploy/gitops/worker/overlays/{dev,prod}/`** (new directory per
  env):
  - `.env` — key/value file with `IMAGE=`, `IMAGE_TAG=`,
    `ACR_LOGIN_SERVER=`, `IMAGE_NAME=`, `NAMESPACE=`, `ACR_NAME=`,
    `KV_NAME=`, `WORKLOAD_IDENTITY_CLIENT_ID=`, `AZURE_TENANT_ID=`,
    and any per-env knobs (FR-014 full fan-out). In the committed
    repo the file holds **comment-only** content — no key=value pairs
    — so the base's typed placeholder defaults render under
    `validate.sh` and no environment-specific literal lands in git.
    EV2 writes the real key=value pairs at rollout (Phase 5
    `GenerateEnvForEv2.sh` from EV2 scope-binding tokens).
  - `kustomization.yaml` — references `../../base`, declares
    `configMapGenerator` (merge behavior over the base's) from
    `.env`. Fan-out replacements live in the **base** (shared across
    overlays): `IMAGE` into `spec.template.spec.containers[0].image`,
    `NAMESPACE` into every resource's `metadata.namespace`, and
    `WORKLOAD_IDENTITY_CLIENT_ID` into the ServiceAccount's
    `azure.workload.identity/client-id` annotation and the
    SecretProviderClass `spec.parameters.clientID`.
  - `.gitignore` — ensures no accidental committed secrets.

- **`deploy/gitops/portal/base/`** (new directory):
  - `service-account.yaml`, `role.yaml`, `role-binding.yaml` — split
    out from `deploy/k8s/portal-deployment.yaml:1-47` (one resource
    per file per Kustomize idiom).
  - `deployment.yaml` — copy of `deploy/k8s/portal-deployment.yaml:49-93`
    with image placeholder; **adds** `readinessProbe` +
    `livenessProbe` on `GET /api/health` port 3001 (CodeResearch §8);
    keeps `PORTAL_TUI_MODE=remote` +
    `PLUGIN_DIRS=/app/packages/cli/plugins`. **Intentional divergences
    from `deploy/k8s/portal-deployment.yaml`**: (1) drop
    `imagePullSecrets: acr-pull` (kubelet MI ACR auth, same rationale
    as worker); (2) switch `envFrom` to `pilotswarm-portal-secrets`
    (portal's own SPC-synthesized Secret). TLS is terminated at the
    ingress (AGIC reads cert from the AKV-synced Secret named in
    `ingress.yaml`); `TLS_CERT_PATH`/`TLS_KEY_PATH` are deliberately
    NOT set, so `packages/portal/server.js:23-33` runs in plain-HTTP
    mode behind the ingress (resolves CodeResearch Open Question 4).
  - `service.yaml` — copy of `:95-113` (ClusterIP 3001→3001).
  - `ingress.yaml` — **new shape**: `ingressClassName:
    azure-application-gateway` (AGIC v1 hyphenated class name) withempty `spec.rules[0].host`,
    `spec.tls[0].hosts[0]`, empty AGIC hostname annotations
    (placeholder-style per PlaygroundService), `spec.tls[0].secretName:
    pilotswarm-portal-tls` (hardcoded, stable identifier;
    cert material flows via SecretProviderClass in overlays).
    Annotations translated from CodeResearch §5:
    `appgw.ingress.kubernetes.io/ssl-redirect: "true"`,
    `appgw.ingress.kubernetes.io/backend-protocol: "http"`,
    `appgw.ingress.kubernetes.io/request-timeout: "3600"` (WebSocket
    long-lived sessions per CodeResearch §5 `/portal-ws`),
    `appgw.ingress.kubernetes.io/health-probe-path: "/api/health"`,
    `appgw.ingress.kubernetes.io/health-probe-port: "3001"`,
    `appgw.ingress.kubernetes.io/backend-hostname: "__PORTAL_HOSTNAME__"`,
    `appgw.ingress.kubernetes.io/health-probe-hostname: "__PORTAL_HOSTNAME__"`.
    The last two are Kustomize-replacement targets (Spec FR-014 +
    PlaygroundService parity); AGIC maps `request-timeout` onto the
    AppGW backend HTTP settings, covering the WebSocket long-lived
    session requirement without NGINX-specific upgrade/buffering
    directives (AGIC handles WS transparently via AppGW v2). (No
    cert-manager annotation — TLS material is sourced from AKV
    via SPC.)
  - `secret-provider-class.yaml` — one `SecretProviderClass`
    synthesizing the `pilotswarm-portal-secrets` Secret (every
    `PORTAL_AUTH_*`, `PORTAL_AUTHZ_*`, `DATABASE_URL`, etc. — see
    CodeResearch §2 for the portal env table). A second
    `SecretProviderClass` for the portal TLS cert synthesizes the
    Secret named in `ingress.yaml` (`pilotswarm-portal-tls`). Worker
    and portal SPCs synthesize **distinct Secret names** — no two SPCs
    ever target the same Secret, avoiding CSI driver ownership races.
  - `kustomization.yaml` — resources + `configMapGenerator` (`portal-env`)
    + `replacements` rule fanning `PORTAL_HOSTNAME` into 4 ingress
    fields (`spec.rules[0].host`, `spec.tls[0].hosts[0]`, and the
    two AGIC hostname annotations, per Spec FR-014 and
    PlaygroundService reference `overlays/prod/kustomization.yaml:95-119`).

- **`deploy/gitops/portal/overlays/{dev,prod}/`** (new directory per
  env):
  - `.env` — keys: `IMAGE_TAG=`, `PORTAL_HOSTNAME=`,
    `ACR_LOGIN_SERVER=`, `IMAGE_NAME=`, `NAMESPACE=`, `ACR_NAME=`,
    `KV_NAME=`, `WORKLOAD_IDENTITY_CLIENT_ID=` (FR-014 full
    fan-out). Values blank in-repo.
  - `kustomization.yaml` — `../../base` + overlay configMapGenerator
    + overlay replacements (IMAGE_TAG → image, PORTAL_HOSTNAME base
    rule is defined in base, overlay only overrides ConfigMap data).
  - Both `dev` and `prod` overlays use the same AFD+PL ingress
    topology (FR-017 applies to every environment — there is one AFD
    profile per env provisioned by GlobalInfra, and the portal is
    always fronted by it). Dev and prod differ only in values
    (hostname, image tag, AKV name, ACR name) and in WAF mode
    (GlobalInfra parameters may set WAF to Detection in dev and
    Prevention in prod — that knob lives in GlobalInfra Phase 2, not
    here). **No public AppGW listener for portal traffic in any
    environment.**

- **Local validation script** (new): `deploy/gitops/validate.sh` —
  runs `kubectl kustomize` + `kubeconform` per overlay. Documented in
  Phase 7.

### Success Criteria

#### Automated Verification

- [ ] Build: `kubectl kustomize deploy/gitops/worker/overlays/dev` exits 0 and produces ≥4 documents (Namespace, Deployment, SecretProviderClass, others).
- [ ] Build: `kubectl kustomize deploy/gitops/worker/overlays/prod` exits 0.
- [ ] Build: `kubectl kustomize deploy/gitops/portal/overlays/dev` exits 0 and includes the AGIC-class Ingress.
- [ ] Build: `kubectl kustomize deploy/gitops/portal/overlays/prod` exits 0.
- [ ] Schema: `kubeconform -summary` passes on all four rendered sets (optional developer aid — non-blocking, per Spec FR-010).
- [ ] Existing path unchanged: `git diff main -- scripts/deploy-aks.sh deploy/k8s/ deploy/Dockerfile.worker deploy/Dockerfile.portal docs/deploying-to-aks.md` is empty.

#### Manual Verification

- [ ] Diff rendered `deploy/gitops/worker/overlays/prod` against `deploy/k8s/worker-deployment.yaml` — only the image tag, Secret source (SPC vs imperative), and absence of any removed imperative fields differ.
- [ ] Confirm portal ingress renders `ingressClassName: azure-application-gateway` in both overlays.
- [ ] Confirm `PORTAL_HOSTNAME` placeholder fans into exactly the 4 ingress fields (`spec.rules[0].host`, `spec.tls[0].hosts[0]`, `appgw.ingress.kubernetes.io/backend-hostname`, `appgw.ingress.kubernetes.io/health-probe-hostname`) (PlaygroundService parity).
- [ ] **SC-006 behavioral check**: Before merging, snapshot the rendered Secret + manifests produced by `scripts/deploy-aks.sh` against the dev cluster (dry-run or recorded apply). After merging, re-run and confirm byte-equivalent Secret names, manifest content, and namespace — no change in imperative-path behavior.
- [ ] **WebSocket / `/portal-ws` probe** (deferred to Phase 4/7 dry-run): once a dev cluster + AFD pair is live, establish a WebSocket connection through AFD → AppGW (AGIC) → portal pod on `/portal-ws` and verify the connection stays open for at least 60 seconds carrying duplex frames (covers the 3600s `request-timeout`, exercises AppGW v2's built-in WS support). If this test fails, revisit the AGIC annotation set.

---

## Phase 2: GlobalInfra Bicep (fleet-wide AFD + WAF)

### Changes Required

- **`deploy/ev2/GlobalInfra/bicep/main.bicep`** (new) — subscription
  scope, mirrors `C:\Repos\postgresql-fleet-manager\src\Deploy\GlobalInfra\bicep\main.bicep`:
  - Parameters: `frontDoorProfileName`, `frontDoorEndpointName`,
    `wafPolicyName`, `resourceGroupName`, `location` (AFD is global
    so `location: global`).
  - Creates resource group.
  - Invokes `frontdoor-profile.bicep` (AFD Premium + endpoint).
  - Invokes `frontdoor-waf-policy.bicep` (WAF policy, OWASP managed
    ruleset). **Mode is parameterized**: `Detection` for dev,
    `Prevention` for prod, set via `parameters/{env}.bicepparam`.
  - Creates `Microsoft.Cdn/profiles/securityPolicies` associating WAF
    to `/*` on the endpoint.
  - Outputs: `frontDoorProfileName`, `frontDoorEndpointName`,
    `frontDoorProfileResourceGroup`, `frontDoorEndpointHostName`.
- **`deploy/ev2/GlobalInfra/bicep/frontdoor-profile.bicep`** (new) —
  adapted from reference.
- **`deploy/ev2/GlobalInfra/bicep/frontdoor-waf-policy.bicep`** (new) —
  adapted from reference.
- **`deploy/ev2/GlobalInfra/bicep/parameters/dev.bicepparam`,
  `prod.bicepparam`** (new).

### Success Criteria

#### Automated Verification

- [ ] `az bicep build --file deploy/ev2/GlobalInfra/bicep/main.bicep` exits 0.
- [ ] `az deployment sub validate --location westus3 --template-file deploy/ev2/GlobalInfra/bicep/main.bicep --parameters @deploy/ev2/GlobalInfra/bicep/parameters/dev.bicepparam` exits 0 against a test subscription.
- [ ] `az deployment sub what-if …` against a clean subscription shows AFD profile, endpoint, WAF policy, and security policy being created; no other resources.

#### Manual Verification

- [ ] WAF policy mode matches the env parameter (`Detection` for dev, `Prevention` for prod).
- [ ] Security policy path pattern is `/*`.
- [ ] Profile tier is `Premium_AzureFrontDoor` (required for Private Link).

---

## Phase 3: BaseInfra Bicep (per-region Azure resources)

### Changes Required

- **`deploy/ev2/BaseInfra/bicep/main.bicep`** (new) — resource-group
  scope. Parameters include `resourceNamePrefix`, `region`,
  `frontDoorProfileName`, `frontDoorProfileResourceGroup`,
  `sslCertificateDomainSuffix`. Composes:
  - **`aks.bicep`** — AKS cluster with `microsoft.flux` and
    `azureKeyvaultSecretsProvider` addons (FR-004, Dependencies).
    Managed identity for kubelet so ACR pull works without an
    `imagePullSecrets` Secret under GitOps (CodeResearch Open
    Question 2; resolution: kubelet MI auth).
  - **`vnet.bicep`** — VNet with subnets for AKS, AppGW, and a
    **dedicated Private Link subnet** (CodeResearch §1 / Spec FR-001).
  - **`application-gateway.bicep`** — Standard_v2/WAF_v2 AppGW with
    `privateLinkConfigurations` block referencing the PL subnet,
    private frontend IP bound to the PL config. Adapted verbatim from
    `C:\Repos\postgresql-fleet-manager\src\Deploy\BaseInfra\bicep\application-gateway.bicep:270-309`.
    Outputs `applicationGatewayName`, `privateLinkConfigurationName`,
    `privateLinkConfigurationId`.
  - **`acr.bicep`** — Azure Container Registry (Basic SKU for dev,
    Premium for prod). Role assignment: AKS kubelet MI gets
    `AcrPull`.
  - **`storage.bicep`** — Storage Account with two blob containers:
    (1) `copilot-sessions` (fills the FR-011 gap observed in
    `packages/sdk/src/blob-store.ts:86-99`, CodeResearch §6); (2) a
    separate manifest container per deployable (`worker-manifests`,
    `portal-manifests`) for FLUX to reconcile from.
  - **`postgres.bicep`** — Azure Database for PostgreSQL Flexible
    Server. No schema creation (inline migrations at worker startup
    handle it, FR-012).
  - **`keyvault.bicep`** — Azure Key Vault with `enableRbacAuthorization`,
    `enablePurgeProtection`. Role assignments: AKS CSI driver MI gets
    `Key Vault Secrets User` (FR-005).
  - **`uami.bicep`** — User-assigned managed identities (one for AKS
    kubelet, one for CSI SPC).
  - **`flux-config.bicep`** — `Microsoft.KubernetesConfiguration/fluxConfigurations`
    for each deployable (worker, portal) pointing its `kustomizations`
    entry at the corresponding blob container (`azureBlob` source
    kind) (FR-004). Default reconciliation interval 120s (Spec SC-003).
- **Parameters**: `parameters/{env}.bicepparam` per region.
- **Outputs**: `applicationGatewayName`,
  `privateLinkConfigurationName`, `acrLoginServer`, `keyVaultName`,
  `blobContainerEndpoint`, `aksClusterName`.

### Success Criteria

#### Automated Verification

- [ ] `az bicep build --file deploy/ev2/BaseInfra/bicep/main.bicep` exits 0.
- [ ] `az deployment group validate …` exits 0 against a test RG.
- [ ] `az deployment group what-if …` on a clean RG shows AKS, VNet (3 subnets), AppGW (with PL config), ACR, Storage (with `copilot-sessions` + 2 manifest containers), PG, AKV, and FluxConfigs being created.

#### Manual Verification

- [ ] AKS cluster has both `microsoft.flux` and `azureKeyvaultSecretsProvider` addons enabled.
- [ ] AppGW has a `privateLinkConfigurations` entry (otherwise AFD cannot connect via PL).
- [ ] Storage account has the session blob container named exactly `copilot-sessions` (default from `blob-store.ts:86`) — otherwise worker startup will fail container handle resolution.
- [ ] FluxConfig on cluster lists a source per deployable; source `kind` is `azureBlob`.

---

## Phase 4: Portal AFD + Private Link wiring

### Changes Required

- **`deploy/ev2/Common/bicep/frontdoor-origin-route.bicep`** (new) —
  **verbatim copy** of
  `C:\Repos\postgresql-fleet-manager\src\Deploy\Common\bicep\frontdoor-origin-route.bicep`
  (CodeResearch §9). Parameters include `frontDoorProfileName`,
  `frontDoorEndpointName`, origin group/origin/route names, backend
  hostname, PLS service id string, private-link location.
- **`deploy/ev2/Common/bicep/approve-private-endpoint.bicep`** (new) —
  **verbatim copy** of the reference module at the same path
  (CodeResearch §9). A `deploymentScript` resource that auto-approves
  the pending PLS connection request on the AppGW side.
- **`deploy/ev2/Portal/bicep/main.bicep`** (new) — resource-group
  scope. Parameters include
  `applicationGatewayName`, `privateLinkConfigurationName`,
  `frontDoorProfileName`, `frontDoorProfileResourceGroup`,
  `frontDoorEndpointName`, `region`, `sslCertificateDomainSuffix`.
  - Compute `var certificateSubject = '${resourceName}-${region}.${sslCertificateDomainSuffix}'`.
  - Output `BackendHostName string = certificateSubject` (surfaces
    via EV2 scope binding into overlay `.env` — Spec FR-014).
  - Compute the PLS service id string using the documented format:
    `/subscriptions/{sub}/resourceGroups/{appGwRg}/providers/Microsoft.Network/privateLinkServices/_e41f87a2_{applicationGatewayName}_{privateLinkConfigurationName}`
    (SpecResearch Q14b).
  - `module afdOrigin '../../Common/bicep/frontdoor-origin-route.bicep' = { scope: resourceGroup(frontDoorProfileResourceGroup, …) }`.
  - `module plApprove '../../Common/bicep/approve-private-endpoint.bicep' = { …, dependsOn: [ afdOrigin ] }`.
- **Worker ServiceGroup has no Bicep tree.** The Worker deployable
  owns no Azure resources beyond ACR image uploads. CI builds the
  image to a holding ACR (Phase 6); the Worker ServiceGroup's
  `RolloutSpec.json` (Phase 5) invokes only shell extensions — in
  order: `UploadContainer.sh` (re-push holding-ACR image to the
  per-region target ACR, per FR-003(a)) → `GenerateEnvForEv2.ps1`
  (populate overlay `.env` from EV2 scope-binding tokens) →
  `DeployApplicationManifest.sh` (render Kustomize + upload bundle
  to the worker manifest blob container, per FR-003(b)). FLUX then
  reconciles the bundle into the cluster. No
  `deploy/ev2/Worker/bicep/` directory is created.

### Success Criteria

#### Automated Verification

- [ ] `az bicep build --file deploy/ev2/Portal/bicep/main.bicep` exits 0.
- [ ] Diff shows `frontdoor-origin-route.bicep` and `approve-private-endpoint.bicep` are byte-for-byte identical to the reference source files (FR: verbatim copy).
- [ ] `az deployment group what-if` with mocked scope and PLS id shows a Front Door origin + origin group + route being created in the GlobalInfra RG, and no AppGW modification in the BaseInfra RG.

#### Manual Verification

- [ ] After a dry-run against a real cluster+AFD pair: AFD origin's `hostName`/`originHostHeader` equals the computed `certificateSubject`.
- [ ] AppGW portal Ingress, once rendered, has its `spec.rules[0].host` equal to the same value.
- [ ] `approve-private-endpoint.bicep` runs last and auto-approves exactly one pending PLS connection.
- [ ] **SC-011 public-listener inspection**: `az network application-gateway show --name <appgw> --resource-group <rg> --query 'httpListeners[?hostNames[?contains(@, \`<certificateSubject>\`)]].frontendIPConfiguration.id'` returns ONLY the private frontend IP configuration ID (no public frontend IP bound to the portal hostname). Additionally, `az afd origin show … --query 'sharedPrivateLinkResource.privateLinkLocation'` is non-empty and the PLS connection is in `Approved` state.

---

## Phase 5: EV2 ServiceGroups + shell extensions + dev-test helpers

### Changes Required

- **`deploy/ev2/GlobalInfra/`** (new):
  - `ServiceModel.json`, `RolloutSpec.json`, `ScopeBindings.json`,
    `Parameters/{dev,prod}.json`. Subscription-scope rollout.
    Bicep-only; no shell extensions.

- **`deploy/ev2/BaseInfra/`** (new):
  - `ServiceModel.json`, `RolloutSpec.json`, `ScopeBindings.json`,
    `Parameters/{dev,prod}.json`. Resource-group scope.

- **`deploy/ev2/Worker/`** (new):
  - `ServiceModel.json`, `RolloutSpec.json`, `ScopeBindings.json`
    (binds `__IMAGE_TAG__`, `__ACR_NAME__`, `__KV_NAME__` tokens),
    `Parameters/{dev,prod}.json`.
  - `Ev2AppDeployment/` — `scopeBinding.json` consuming the
    `BaseInfra` outputs (via
    `$serviceResourceDefinition(BaseInfraDefinition).action(deploy).outputs(…)`)
    for `acrLoginServer`, `keyVaultName`, and similar. Spec FR-014.

- **`deploy/ev2/Portal/`** (new):
  - Same shape as Worker, plus scope bindings for AFD config
    (`frontDoorProfileName`, `frontDoorProfileResourceGroup` via
    `$config(...)`) and `sslCertificateDomainSuffix` via
    `$config(...)` (per-env; SpecResearch Q14b).
  - Scope binding **also** consumes
    `$serviceResourceDefinition(PortalServiceInfraDefinition).action(deploy).outputs(BackendHostName.value)`
    into `__PORTAL_HOSTNAME__` (SpecResearch Q12b, FR-014).

- **`deploy/ev2/Common/scripts/`** (new):
  - `UploadContainer.sh` — adapted from fleet-manager. **Uploads the
    deployable's container tarball** (produced by CI and carried as
    an EV2 artifact) to the **per-region** ACR (FR-003(a)). Argv:
    `--source-tarball`, `--target-acr`, `--image-name`, `--image-tag`.
  - `DeployApplicationManifest.sh` — adapted. **Renders the
    Kustomize bundle** (`kubectl kustomize deploy/gitops/<deployable>/overlays/<env>`),
    after `GenerateEnvForEv2.ps1` has populated the overlay `.env`,
    and uploads the rendered bundle to the deployable's manifest
    blob container (FR-003(b)). Argv: `--overlay-path`,
    `--target-storage`, `--container-name`.
  - `GenerateEnvForEv2.ps1` — adapted. Reads EV2 scope-binding tokens
    (`__IMAGE_TAG__`, `__ACR_LOGIN_SERVER__`, `__IMAGE_NAME__`,
    `__NAMESPACE__`, `__WORKLOAD_IDENTITY_CLIENT_ID__`,
    `__PORTAL_HOSTNAME__`, …) from the environment and writes the
    overlay `.env` file before Kustomize renders.
  - **Rollout order** (per Application ServiceGroup `RolloutSpec.json`):
    `UploadContainer.sh` → `GenerateEnvForEv2.ps1` →
    `DeployApplicationManifest.sh`. Each Application ServiceGroup
    re-runs `UploadContainer.sh` at its own rollout, re-pushing the
    single holding-ACR image into the per-region ACR. This keeps the
    reference-repo's script-responsibility contract (`UploadContainer`
    ≡ container, `DeployApplicationManifest` ≡ manifests).
  - All three scripts must remain fleet-manager-compatible contracts
    (same argv shape) — simplifications (e.g., fewer deployable types,
    no DACPAC branch) permitted.

- **`deploy/ev2/Worker/ev2-deploy-dev.ps1`** and
  **`deploy/ev2/Portal/ev2-deploy-dev.ps1`** (new, per Application
  ServiceGroup):
  - Engineer helper mirroring fleet-manager's pattern.
  - **Supports uncommitted working-tree changes** (Spec P1
    user story, `Spec.md:117-132`): the script renders Kustomize
    from the local tree, stages the result plus the ServiceGroup
    directory into a temp artifact directory, and invokes
    `az rollout start --service-group-root <temp-dir> --rollout-spec
    RolloutSpec.json --parameters Parameters/dev.json` against a dev
    Service Connection. No push to the repo is required.
  - Documented prerequisites: `az`, `az-rollout` extension, dev-SC
    auth; documented side-effects: writes only to dev subscription.

- **`deploy/ev2/README.md`** (new) — points at
  `docs/deploying-to-aks-ev2.md` and includes the directory map.

### Success Criteria

#### Automated Verification

- [ ] `az rollout validate --service-name <svc> --rollout-spec deploy/ev2/<SG>/RolloutSpec.json --parameters deploy/ev2/<SG>/Parameters/dev.json` exits 0 for every ServiceGroup (dev), against EV2 CLI in a clean local state.
- [ ] JSON schema check: all `ServiceModel.json` / `RolloutSpec.json` / `ScopeBindings.json` parse via `jq`.
- [ ] Shell extensions lint cleanly via `shellcheck` (bash) and `PSScriptAnalyzer` (ps1).

#### Manual Verification

- [ ] A dev-test rollout from `ev2-deploy-dev.ps1 -ServiceGroup Worker` successfully places manifests in the worker manifest container and triggers FluxConfig reconcile; worker pods restart to the new image tag within 120s.
- [ ] Scope binding for `__PORTAL_HOSTNAME__` propagates: the produced overlay `.env` `PORTAL_HOSTNAME` value equals the deployed Portal Bicep's `BackendHostName` output.

---

## Phase 6: Pipelines (OneBranch Official)

### Changes Required

- **`.pipelines/ci.yml`** (new or extended — does not modify existing
  CI if any) — OneBranch Official CI pipeline:
  - Stage 1: `npm ci` + `npm run lint` + `./scripts/run-tests.sh`.
  - Stage 2: `docker buildx build --platform linux/amd64 -f deploy/Dockerfile.worker …` and similar for `deploy/Dockerfile.portal`, push to a **single holding ACR** (CI-only build registry; one per environment tier, set via pipeline variable `HOLDING_ACR_LOGIN_SERVER`) with an immutable tag `:${buildId}` (no `:latest` or rolling tags — SC-002 requires the exact tag to land in every region). The per-region target ACRs are NOT pushed by CI; `UploadContainer.sh` in each Application ServiceGroup re-pushes the holding-ACR image tarball to the target region's ACR at EV2 rollout time (FR-003(a)).
  - Produces `IMAGE_TAG` (= buildId) and `HOLDING_ACR_LOGIN_SERVER` as pipeline outputs for downstream release lines.

- **`.pipelines/release-globalinfra.yml`** (new) — OneBranch Official
  release:
  - Downloads `deploy/ev2/GlobalInfra/` as artifact.
  - `Ev2RARollout@2` task pointing at `RolloutSpec.json` + dev/prod
    parameters + managed SDP stage map.

- **`.pipelines/release-baseinfra.yml`** (new) — same shape, points at
  BaseInfra.

- **`.pipelines/release-worker.yml`** (new) — same shape, points at
  Worker. Consumes `IMAGE_TAG` from latest CI build.

- **`.pipelines/release-portal.yml`** (new) — same shape, points at
  Portal.

- **`.pipelines/shared/onebranch-pool.yml`** (new, small) — common
  pool/agent/template stanza extracted per repo conventions.

### Success Criteria

#### Automated Verification

- [ ] `az pipelines validate --yaml-path .pipelines/ci.yml` (or equivalent local schema check via `azure-pipelines-vscode` CLI) exits 0.
- [ ] Every release pipeline references `Ev2RARollout@2` with `sdpStageMap: managed`.
- [ ] Every pipeline sets `OneBranch` template inheritance (no self-hosted pool literals).

#### Manual Verification

- [ ] A CI run (from a PR) publishes worker + portal images to the holding ACR (set via `HOLDING_ACR_LOGIN_SERVER`) with the expected immutable build-id tag.
- [ ] A manual trigger of `release-globalinfra.yml` (dev parameters) successfully invokes EV2 and produces a visible rollout.

---

## Phase 7: Documentation

### Changes Required

- **`docs/deploying-to-aks-ev2.md`** (new) — canonical guide for the
  new path. Sections: architecture (four ServiceGroups + AFD edge
  diagram), prerequisites (EV2 onboarding, subscriptions, addons),
  local validation (`kubectl kustomize` + `az bicep build` + `az
  deployment sub what-if`), dev-test rollout
  (`ev2-deploy-dev.ps1 -ServiceGroup Portal -Environment dev`),
  production rollout (pipeline triggers, SDP stage map),
  troubleshooting (FluxConfig reconcile failures, AFD PLS approval
  hang, Kustomize `replacements` mismatches). Cross-link to
  `docs/deploying-to-aks.md` in the header, explicit note: "both
  paths are supported; this document does not deprecate the
  imperative path." Follow `paw-docs-guidance`.

- **`docs/deploying-to-aks.md`** — **not modified** (Out-of-Scope,
  Spec FR-009). No pointer edit, no "See also" line, no content
  change of any kind. Cross-linking from the new path lives in
  `docs/deploying-to-aks-ev2.md`'s header and in `docs/README.md` if
  one exists; the existing guide is not aware of the new path.

- **`.paw/work/aks-gitops-iac/Docs.md`** (new) — technical as-built
  reference. Includes every file added, every scope binding token and
  its source, the four-ServiceGroup flow diagram, and the
  `replacements` fan-out tables (worker + portal). Load
  `paw-docs-guidance` skill for conventions.

### Success Criteria

#### Automated Verification

- [ ] Markdown lint (`markdownlint docs/deploying-to-aks-ev2.md`) passes.
- [ ] All internal links in `docs/deploying-to-aks-ev2.md` resolve (`lychee` or equivalent).
- [ ] `docs/deploying-to-aks.md` diff against main is empty (zero content changes — strict add-only per Spec FR-009).

#### Manual Verification

- [ ] `docs/deploying-to-aks-ev2.md` local-validation section lists every command needed (copy-pasteable), states each command's expected exit code, and its "Prerequisites" subsection enumerates every CLI/tool (`az`, `kubectl`, `kustomize`, `kubeconform`, `markdownlint`) with install pointer.
- [ ] `Docs.md` covers every file added by Phases 1–6.
- [ ] The architecture diagram in `deploying-to-aks-ev2.md` shows the AFD → AppGW (Private Link) → AGIC Ingress → Pod path.

---

## References

- Issue: none (WorkflowContext.md Initial Prompt)
- Spec: `.paw/work/aks-gitops-iac/Spec.md` (17 FRs, 11 SCs, 4 ServiceGroups)
- Spec Research: `.paw/work/aks-gitops-iac/SpecResearch.md` (Q12b ingress; Q14 GlobalInfra; Q14b AFD+PL wiring)
- Code Research: `.paw/work/aks-gitops-iac/CodeResearch.md`
- Reference repo: `C:\Repos\postgresql-fleet-manager\src\Deploy\` (PlaygroundService, GlobalInfra, BaseInfra, Common)
- Canonical AKS guide (unchanged): `docs/deploying-to-aks.md`
