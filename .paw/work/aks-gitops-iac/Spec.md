# Feature Specification: AKS GitOps IaC (Production Deploy Path)

**Branch**: feature/aks-gitops-iac  |  **Created**: 2026-04-22  |  **Status**: Draft
**Input Brief**: Add a production-grade IaC + GitOps deployment path for PilotSwarm on AKS, modeled on `postgresql-fleet-manager`, using FLUX + Kustomize + Azure Storage artifact buckets + EV2 with SDP, side-by-side with the existing `scripts/deploy-aks.sh` path.

## Overview

Today PilotSwarm deploys to AKS via `scripts/deploy-aks.sh` — a bash-driven
imperative flow that creates a Kubernetes secret from local `.env.remote`
values, builds and pushes the worker image, sed-patches the namespace in
flat manifests, and runs `kubectl apply`. This is fine for a single engineer
targeting a single dev cluster, but it cannot meet the operational bar needed
for running PilotSwarm as a production service: there is no safe multi-region
rollout, no managed identity-only secret delivery, no drift reconciliation,
no declarative infrastructure, and no audited release artifact.

This work adds a **second, additive deployment path** that brings PilotSwarm
to the same operational bar that `postgresql-fleet-manager` has in production.
The new path is declarative end-to-end: Azure infrastructure (AKS, ACR,
PostgreSQL, Storage, Key Vault, Flux) is provisioned by Bicep; application
manifests are authored as Kustomize bases with per-environment overlays;
rollouts are orchestrated by EV2 against Azure's managed Safe Deployment
Practices stage map; and the running cluster reconciles its desired state
by pulling Kustomize bundles from an Azure Storage blob container via the
`microsoft.flux` AKS extension. Secrets reach pods exclusively via Azure Key
Vault and the Secrets Store CSI driver — no human-created Kubernetes
secrets in the production path.

The existing `scripts/deploy-aks.sh` flow, the current `deploy/k8s/*.yaml`
manifests, and `docs/deploying-to-aks.md` are not modified. They remain the
supported path for engineer-driven smoke clusters. The new artifacts live in
a parallel tree under `deploy/` so both paths can coexist indefinitely.

Because PilotSwarm is a single Node.js repository with one mandatory
deployable (the worker) and one optional deployable (the portal), the new
path adopts the fleet-manager patterns that deliver operational value and
deliberately skips patterns that only exist because fleet-manager is a
multi-service .NET product (microservice generator, DACPAC extension,
MSBuild `.proj` packaging, per-service PostgreSQL stamps). These
simplifications are captured as explicit assumptions below.

## Objectives

- Enable production-quality rollouts of PilotSwarm to AKS with managed Safe
  Deployment Practices (staged, health-gated, rollback-capable) (Rationale:
  bash-script-driven deploys cannot meet production SLA, auditability, or
  multi-region requirements).
- Make the running cluster's desired state declarative and
  continuously reconciled, so that drift heals automatically and every
  deployed version is traceable to a specific artifact bundle (Rationale:
  `kubectl apply` is one-shot and leaves no audit trail; FLUX pulls are
  deterministic and reconcile on a fixed cadence).
- Deliver runtime secrets exclusively through managed identity + Azure Key
  Vault in the production path, eliminating `kubectl create secret` from
  the release process (Rationale: human-created secrets in a release script
  are a security and operational liability).
- Provide a ServiceGroup definition that can be registered with the EV2
  dev-test flow, so engineers can smoke-test a rollout end-to-end before
  shipping to production (Rationale: prod EV2 rollouts must be
  pre-validated; a dev-test loop is the accepted Microsoft pattern).
- Preserve the existing `scripts/deploy-aks.sh` + flat `deploy/k8s/`
  deployment path unchanged, so current engineer workflows are not
  disrupted (Rationale: explicit intake constraint — additive only).
- Adopt the postgresql-fleet-manager patterns that transfer to a
  single-service Node.js repo, and drop the ones that exist only because
  the reference is multi-service .NET (Rationale: explicit intake
  guidance on simplifications).

## User Scenarios & Testing

### User Story P1 — Release Operator Ships a New Worker Version to Production

Narrative: A release operator wants to ship a new PilotSwarm worker image
to all production regions with staged rollout, bake-time gating, and
automatic rollback if health checks fail. The operator bumps the service
version, kicks the production pipeline, and watches SDP progress through
each region without manually running any `kubectl` or `az` commands.

Independent Test: Starting from a clean EV2 ServiceGroup registration, an
operator can trigger a rollout that (a) uploads a Kustomize bundle to the
per-stage Azure Storage container, (b) waits for FLUX to reconcile it on
all target clusters, (c) verifies the rollout is healthy before advancing
to the next stage, and (d) requires no human kubectl interaction.

Acceptance Scenarios:
1. Given a PR merged to `main` with a new worker version, when the prod
   pipeline runs, then a signed EV2 rollout artifact is produced and
   registered against the Azure-managed SDP stage map.
2. Given an EV2 rollout in flight, when the operator views the rollout in
   the EV2 portal, then they can see per-region stage progress, bake
   timers, and health-check status surfaced by the managed stage map.
3. Given a rollout that fails health checks in a canary stage, when SDP
   triggers the rollback path, then no subsequent stage begins and the
   operator is notified.
4. Given a completed rollout, when the operator inspects an AKS cluster,
   then the running worker pods match the Kustomize overlay that was
   uploaded to blob for that stage.

### User Story P1 — Engineer Smoke-Tests a Manifest Change via Dev-Test EV2

Narrative: An engineer changes a Kustomize overlay value (e.g., image tag,
replica count, ConfigMap entry) and wants to validate it end-to-end on a
real EV2 rollout before raising a PR against `main`. They use the
dev-test EV2 flow to execute a rollout against a dev subscription without
affecting production.

Independent Test: From a SAW (or a machine with the dev service
connection), an engineer can run a helper command that builds the current
branch's Kustomize bundle, registers it against the dev ServiceGroup,
triggers a test rollout, and confirms the change reconciled on a dev
AKS cluster — all without touching the prod pipeline.

Acceptance Scenarios:
1. Given an uncommitted change to `overlays/dev/.env` or a base manifest,
   when the engineer invokes the dev-test helper, then a dev ServiceGroup
   rollout is triggered against a dev subscription.
2. Given a dev rollout completes, when the engineer inspects the dev AKS
   cluster, then FLUX has reconciled the new bundle and the pods reflect
   the change.
3. Given a dev rollout fails validation, when the engineer re-runs the
   helper after a fix, then a new artifact is packaged and the rollout
   can be retriggered without manual ServiceGroup re-registration.

### User Story P1 — Cluster Reconciles Desired State Continuously

Narrative: After an EV2 rollout uploads a new manifest bundle to blob,
the AKS cluster should converge on the new desired state within a bounded
time window without any further operator action. If someone manually
mutates a Kubernetes resource that FLUX owns, the cluster should revert
it on the next reconcile cycle.

Independent Test: An operator can upload a new Kustomize bundle to the
service's blob container and, within the published reconcile window,
observe the cluster state change accordingly. Manual `kubectl edit` on a
FLUX-managed resource is observed to revert on the next cycle.

Acceptance Scenarios:
1. Given a new manifest bundle is uploaded to the blob container, when
   the FLUX reconcile interval elapses, then the cluster state matches
   the new bundle.
2. Given an operator runs `kubectl edit` on a FLUX-managed Deployment,
   when the next reconcile cycle runs, then the manual change is
   reverted.
3. Given FLUX is installed via the AKS extension, when the cluster
   restarts or scales, then reconciliation resumes automatically with
   no external bootstrap.

### User Story P2 — Platform Engineer Provisions a New Region

Narrative: A platform engineer is asked to bring PilotSwarm online in a
new Azure region. They add the region to the ServiceGroup configuration,
run the BaseInfra rollout, and the region becomes a valid target for the
next production release — without hand-written kubectl, az CLI, or
portal operations.

Independent Test: Adding a single new region entry to the configuration
data and running the BaseInfra EV2 rollout results in a fully provisioned
region-scoped environment (AKS with FLUX, ACR, PG, Storage, AKV, UAMIs,
VNet, all role assignments) that is ready to receive an application
rollout.

Acceptance Scenarios:
1. Given a new region added to the ServiceGroup configuration, when the
   BaseInfra rollout runs, then all required Azure resources are
   provisioned in that region with correct RBAC wiring.
2. Given a newly provisioned region, when the application ServiceGroup
   rollout runs against it, then the worker and portal pods start and
   reach ready state without further manual steps.
3. Given a region that was previously provisioned, when the BaseInfra
   rollout runs again with no changes, then no resources are recreated
   or modified (idempotent).

### User Story P2 — Secrets Reach Pods via Key Vault Only

Narrative: The production deploy path must not require any operator to
create Kubernetes secrets by hand. All application secrets (database
connection string, GitHub token, model provider keys, storage connection
string) live in Azure Key Vault and are materialized into pods at runtime
via the Secrets Store CSI driver using managed identity.

Independent Test: After a full production rollout, no `kubectl create
secret` command has run at any point in the pipeline or shell extensions,
and pods receive their secrets via a `SecretProviderClass`-mounted
volume (or synced Secret) backed by Azure Key Vault.

Acceptance Scenarios:
1. Given a production rollout, when the full shell-extension + EV2 log
   is audited, then no invocation of `kubectl create secret` appears.
2. Given a worker pod started from a production rollout, when its
   environment is inspected, then secret values originate from a
   Key-Vault-backed `SecretProviderClass`.
3. Given a secret is rotated in Key Vault, when the CSI driver's
   rotation interval elapses, then pods see the new value (either by
   volume update or restart, per chosen rotation mode).

### User Story P2 — Existing `deploy-aks.sh` Path Keeps Working

Narrative: Engineers who currently use `scripts/deploy-aks.sh` to target
a personal or team dev cluster must see no behavioural change from this
work. Their workflow continues to use flat `deploy/k8s/*.yaml`, the
`kubectl create secret` flow, and the sed-based namespace patching.

Independent Test: Running `./scripts/deploy-aks.sh` against a dev
cluster before and after this work produces functionally identical
outcomes (same resources created, same secrets, same image tag behavior).

Acceptance Scenarios:
1. Given this work is merged, when an engineer runs
   `./scripts/deploy-aks.sh` with no flags, then the script behavior
   matches its pre-change behavior.
2. Given this work is merged, when an engineer runs
   `./scripts/reset-local.sh remote`, then its behavior matches its
   pre-change behavior.
3. Given this work is merged, when a user reads
   `docs/deploying-to-aks.md`, then the content accurately reflects
   the existing `deploy-aks.sh` path (the new IaC path is documented
   separately and cross-linked but the existing doc is not rewritten
   to mandate the new path).

### User Story P3 — Local Validation of Manifests and Bicep

Narrative: Before pushing changes, an engineer can validate the Kustomize
output and Bicep templates locally, catching syntactic and structural
errors without relying on a pipeline round-trip.

Independent Test: A documented command set lets the engineer render the
final Kustomize YAML for each environment overlay and compile all Bicep
modules, with clear success/failure output.

Acceptance Scenarios:
1. Given the new IaC tree, when the engineer runs the documented
   Kustomize render command for an overlay, then a valid set of
   Kubernetes manifests is produced with no errors.
2. Given the new IaC tree, when the engineer runs the documented Bicep
   build command, then all modules compile to ARM without errors.
3. Given a typo in an overlay patch, when the engineer runs the
   render command, then the error surfaces locally rather than only
   at rollout time.

### Edge Cases

- **FLUX cannot reach the blob container** (network / RBAC regression):
  FLUX must surface the error clearly; existing pods continue running
  on their last-reconciled state; no silent partial deploys.
- **Blob upload partially fails mid-rollout**: the bundle must be
  uploaded atomically-enough that FLUX never sees a half-written state
  (either use a prefix + pointer, or rely on the `upload-batch`
  overwrite semantics of the reference).
- **Secret rotation in Key Vault during a rollout**: pods must either
  pick up new values via CSI rotation or be restarted by the rollout;
  no stale-secret indefinite state.
- **Region added to configuration but BaseInfra not yet deployed**:
  the application rollout must fail fast with a clear message, not
  proceed against a half-provisioned region.
- **Two parallel rollouts touch the same blob container**: the later
  one must be serialized or rejected; the reference's EV2 serialization
  at the ServiceGroup level is the expected behavior.
- **Existing workers in an old namespace are still consuming the same
  database** (the "Runaway Deployments" scenario already documented in
  `docs/deploying-to-aks.md`): the new path must surface this risk in
  its documentation and ideally enforce a consistent namespace.
- **The `scripts/deploy-aks.sh` path and the new EV2 path target the
  same cluster at the same time**: at minimum, the documentation must
  call this out; behavioural guardrails (e.g., namespace divergence,
  label-based ownership) must be designed so both paths do not fight.

## Requirements

### Functional Requirements

- FR-001: The new path MUST provision PilotSwarm's Azure infrastructure
  (AKS cluster with the `microsoft.flux` extension, ACR, Azure Database
  for PostgreSQL, Azure Storage account with per-service manifest
  containers, Azure Key Vault, user-assigned managed identities, VNet,
  all required RBAC) via declarative Bicep, invoked by an EV2
  infrastructure rollout. (Stories: P1-Regions, P1-Release)
- FR-002: The new path MUST author all PilotSwarm Kubernetes manifests
  as a Kustomize base plus one overlay per environment (at minimum
  `dev` and `prod`), with environment-specific values carried in an
  `.env` file per overlay and applied via `configMapGenerator` +
  `replacements`. (Stories: P1-Release, P3-LocalValidation)
- FR-003: The new path MUST use EV2 shell extensions executed in
  Azure Container Instances to (a) upload the worker and portal
  container tarballs to the per-region ACR, and (b) mutate the
  overlay `.env` with EV2-bound values and upload the resulting
  Kustomize bundle to the service-specific Azure Storage manifest
  container. No shell extension MAY call `kubectl apply`. (Stories:
  P1-Release)
- FR-004: The running AKS cluster MUST pull Kustomize bundles from
  its assigned Azure Storage manifest container via the
  `microsoft.flux` AKS extension configured with an `AzureBlob`
  source and kubelet-managed-identity authentication; no Git
  credentials, PATs, webhooks, or Flux image-automation controllers
  are used. (Stories: P1-Reconciliation)
- FR-005: Runtime secrets MUST reach pods exclusively via the Azure
  Key Vault Provider for Secrets Store CSI Driver, backed by a
  per-stage Azure Key Vault. The pipeline, EV2 shell extensions, and
  rollout tooling MUST NOT invoke `kubectl create secret` or
  otherwise write Kubernetes `Secret` resources containing runtime
  credential values. (Stories: P2-SecretsViaKV)
- FR-006: Container image tag substitution MUST flow through the
  EV2 scope-binding → `.env` mutation → Kustomize `replacements`
  chain; no out-of-band image-tag mutation (e.g., separate Flux
  image-automation controller, pipeline-time manifest patching).
  (Stories: P1-Release)
- FR-007: EV2 rollouts MUST use Azure's managed Safe Deployment
  Practices stage map (`Microsoft.Azure.SDP.Standard`), with the
  `rolloutType`, `overrideManagedValidation`, and `icmIncidentId`
  knobs available as pipeline-level parameters. (Stories:
  P1-Release)
- FR-008: A ServiceGroup MUST be registerable with EV2's dev-test
  flow (equivalent to fleet manager's `ev2-deploy-dev.ps1`
  pattern), so engineers can trigger a rollout against a dev
  subscription from a SAW or authorized developer workstation
  without touching the production pipeline. (Stories: P1-DevTest)
- FR-009: The new path MUST add new files only (under paths such as
  `deploy/bicep/`, `deploy/ev2/`, `deploy/kustomize/`,
  `deploy/scripts/`, `.pipelines/`, and `docs/`). It MUST NOT modify
  or delete `scripts/deploy-aks.sh`, `scripts/reset-local.sh`,
  `scripts/deploy-portal.sh`, any file under `deploy/k8s/**`,
  `deploy/Dockerfile.worker`, `deploy/Dockerfile.portal`,
  `deploy/Dockerfile.starter`, or `docs/deploying-to-aks.md`.
  (Stories: P2-ExistingPathPreserved)
- FR-010: A documented local-validation command set MUST render the
  Kustomize output for each overlay and compile all Bicep modules,
  such that structural errors surface before pushing. (Stories:
  P3-LocalValidation)
- FR-011: The new path MUST provision the Azure Storage *container*
  used by PilotSwarm for session blob storage (today not created by
  any code path) as part of the BaseInfra Bicep, so session
  dehydration works without manual portal bootstrap. (Stories:
  P1-Regions)
- FR-012: PilotSwarm's database migration behavior MUST NOT be
  altered by this work: migrations continue to run at worker
  startup via `cms-migrator`/`facts-migrator` with their existing
  advisory-lock semantics. No separate migration Job is introduced.
  (Stories: P1-Release, P2-ExistingPathPreserved)
- FR-013: The new path MUST produce a documented, self-contained
  pipeline definition (OneBranch-compliant, matching the reference
  repo's CI + prod pipeline shape) that consumes the worker and
  portal images and the EV2 ServiceGroup package. (Stories:
  P1-Release)
- FR-014: Every environment overlay MUST express its target
  namespace, image registry, image name, and workload-identity
  client IDs through the `.env` + replacements chain; no
  environment-specific value may be hard-coded in a base manifest.
  (Stories: P1-Release, P1-Regions)
- FR-015: The new path MUST publish documentation at
  `docs/deploying-with-ev2.md` (or equivalent) that describes the
  new flow end-to-end, cross-links to `docs/deploying-to-aks.md`,
  and clearly labels which path to use when. (Stories:
  P2-ExistingPathPreserved)

### Key Entities

- **BaseInfra ServiceGroup**: The EV2 ServiceGroup that provisions
  per-region Azure infrastructure shared by all PilotSwarm
  deployables (AKS, ACR, PG, Storage, AKV, UAMIs, VNet, FLUX
  extension, FluxConfig for the PilotSwarm manifest container).
- **Application ServiceGroup**: The EV2 ServiceGroup that uploads
  the worker + portal container images and the Kustomize bundle to
  a region. Single ServiceGroup for both deployables; not split per
  deployable.
- **Manifest Bundle**: A zipped tree containing Kustomize base +
  overlays, uploaded by EV2 to the `pilotswarm-manifests` blob
  container. Replaces the current flat `deploy/k8s/` at the
  production tier.
- **Overlay**: A Kustomize overlay under
  `deploy/kustomize/overlays/<env>/` containing an `.env` (mutated
  by EV2 at rollout time), a `kustomization.yaml` with
  `configMapGenerator` + `replacements`, and any
  environment-specific patches.
- **SecretProviderClass**: Per-overlay declaration of which AKV
  secrets the CSI driver materializes into the pod, and the
  managed identity used to fetch them.

### Cross-Cutting / Non-Functional

- The new path MUST use the same `docker buildx --platform
  linux/amd64` convention currently enforced for AKS images (see
  `.github/copilot-instructions.md`, "Docker / AKS Build
  Convention").
- All Bicep modules MUST be idempotent (re-running the BaseInfra
  rollout on an unchanged configuration results in no resource
  modifications).
- Reconcile latency after a successful EV2 upload MUST be bounded
  and configurable via the `fluxConfigurations` sync interval.
- The new path MUST NOT require any changes to the existing
  `docs/deploying-to-aks.md` or the existing `deploy/k8s/*.yaml`
  files.

## Success Criteria

- SC-001: A full production EV2 rollout can be triggered from the
  new pipeline and completes successfully, with the managed SDP
  stage map advancing through all configured regions, without any
  operator running `kubectl` during the rollout. (FR-001, FR-003,
  FR-007, FR-013)
- SC-002: After a successful rollout, every running worker pod in
  every target region is running the exact container image tag
  specified by the EV2 build version, as verified by inspecting
  `kubectl get deployment -o yaml` image fields across regions.
  (FR-006, FR-014)
- SC-003: FLUX reconciliation latency from blob upload to cluster
  desired-state match is within a published bound (defaulting to
  the 120-second reference-repo cadence, configurable per
  environment). (FR-004)
- SC-004: A documented dev-test EV2 rollout can be triggered by an
  engineer from a SAW or authorized workstation, completing a full
  dev ServiceGroup rollout without touching the prod pipeline.
  (FR-008)
- SC-005: A full pipeline + production rollout can be completed
  with zero `kubectl create secret` invocations anywhere in the
  audited execution trace. (FR-005)
- SC-006: Running `./scripts/deploy-aks.sh` against a dev cluster
  after this work produces functionally identical resource state
  to running it before this work (same namespace, same manifests,
  same secret shape). (FR-009, US P2-ExistingPathPreserved)
- SC-007: A documented local command renders valid Kustomize
  output for every overlay and compiles every Bicep module without
  error. (FR-010)
- SC-008: The blob container used for PilotSwarm session
  dehydration is created automatically by the BaseInfra rollout in
  a fresh region (no manual Azure portal operation required).
  (FR-011)
- SC-009: A newly added region in the ServiceGroup configuration
  can be brought from zero to a functioning PilotSwarm environment
  by running the BaseInfra rollout followed by the application
  rollout, with no manual kubectl or az CLI steps. (FR-001,
  FR-013)

## Assumptions

- **FLUX source = Azure Blob, not Git**: The new path adopts the
  reference repo's `sourceKind: AzureBlob` FluxConfig pattern
  verbatim. Although the user intake said "FLUX + GitOps", the
  reference repo does not use a Git source — it uploads rendered
  Kustomize bundles to an Azure Storage container and FLUX polls
  that container every 120s. This matches the intake's
  accompanying "storage buckets" requirement and avoids
  PAT/webhook/Git-ACL management. Rationale: literal fidelity to
  the reference pattern + simpler operational surface.
- **Single ServiceGroup for worker + portal**: Both deployables
  ship together in one EV2 rollout, not split into per-deployable
  ServiceGroups. Rationale: PilotSwarm is a single Node.js repo
  with tightly coupled worker/portal versions; per-deployable
  service groups would add ceremony without operational benefit.
- **Managed SDP stage map (`Microsoft.Azure.SDP.Standard`)**:
  The new path uses the same managed stage map as the reference
  repo. Concrete bake times and canary percentages are owned by
  the stage map, not the repo. Rationale: avoids maintaining
  custom SDP schedules; matches Microsoft-internal best practice.
- **No microservice generator, no MSBuild `.proj`, no DACPAC
  extension**: These reference-repo patterns exist because
  fleet-manager is multi-service .NET with SQL-schema services;
  they do not apply to a single-service Node repo. Rationale:
  intake guidance on simplifications.
- **No Azure Front Door / GlobalInfra**: PilotSwarm's portal is a
  single-region ingress today. A GlobalInfra service group with
  Front Door + WAF is deferred until multi-region portal becomes
  a goal. Rationale: intake guidance on simplifications + avoids
  premature cost.
- **Migrations run at worker startup, unchanged**: The existing
  advisory-lock-based migration runner in `cms-migrator` /
  `facts-migrator` continues to handle schema changes. No
  separate migration `Job` is introduced. Rationale: the existing
  mechanism is already safe across concurrent workers and
  introducing a Job would add coordination complexity with no
  clear win.
- **No changes to `.model_providers.json` contract**: Model
  provider configuration continues to load from the existing
  path. The EV2 `.env` mechanism may carry provider API keys, but
  the JSON catalog itself is not relocated. Rationale: out of
  scope for this work; risk of accidental breakage to a
  gitignored local file is explicitly called out in
  copilot-instructions.md.
- **Known target cluster, single initial region**: PilotSwarm's
  current AKS target is `toygres-aks` in `westus3` (referenced in
  `scripts/reset-local.sh` and `deploy/k8s/portal-ingress.yaml`).
  The new path ships with `westus3` as the only production region
  in the initial configuration; additional regions are added via
  the `Configuration/ServiceGroup/*.Configuration.json`
  Geographies mechanism (per the reference repo pattern).
  Rationale: start narrow; the pattern scales.
- **Single dev environment name**: The initial overlay set is
  `dev` + `prod`. An `int` or `canary` layer can be added later
  by copying the overlay template. Rationale: minimum viable set
  for establishing the pattern.
- **Dockerfile locations unchanged**: `deploy/Dockerfile.worker`
  and `deploy/Dockerfile.portal` remain at their current paths
  and are consumed by both the old and new deployment paths.
  Rationale: changing file paths would perturb the existing
  `deploy-aks.sh` flow, which is explicitly out of scope.
- **OneBranch pipeline template applies**: The new pipeline is
  assumed to fit the OneBranch Official template used by the
  reference repo. Full validation of tenant-specific requirements
  (e.g., service connection names, agent pools) is an operational
  prerequisite surfaced in documentation but not gated by this
  work.

## Scope

### In Scope

- New Bicep tree for BaseInfra (AKS, ACR, PG, Storage, AKV, UAMIs,
  VNet, FLUX extension, FluxConfig for the PilotSwarm manifest
  container), idempotent and region-parameterized.
- New Kustomize tree for worker + portal: a base derived
  (copied, not replacing) from the current `deploy/k8s/*.yaml`, plus
  `overlays/dev/` and `overlays/prod/` each with an `.env`,
  `kustomization.yaml` (with `configMapGenerator` + `replacements`),
  and a `SecretProviderClass`.
- New EV2 ServiceGroup for BaseInfra and a single Application
  ServiceGroup covering worker + portal, wired to the managed SDP
  stage map and configured for a single initial region
  (`westus3`).
- Vendored copies of the reference repo's `UploadContainer.sh`,
  `DeployApplicationManifest.sh`, and `GenerateEnvForEv2.ps1`
  shell-extension scripts, adapted for the PilotSwarm single-service
  shape.
- New CI + prod pipeline YAMLs (OneBranch Official pattern) that
  build the worker/portal images, package the EV2 ServiceGroup, and
  drive `Ev2RARollout@2` with the managed SDP stage map.
- New dev-test helper script that registers and triggers an EV2
  dev rollout (analog to fleet-manager's `ev2-deploy-dev.ps1`).
- New documentation at `docs/deploying-with-ev2.md` describing the
  full flow and cross-linking to `docs/deploying-to-aks.md`.
- Automatic creation of the PilotSwarm session blob container in
  BaseInfra Bicep (filling the current bootstrap gap in
  `blob-store.ts`).

### Out of Scope

- Any modification, deprecation, or behavior change to
  `scripts/deploy-aks.sh`, `scripts/reset-local.sh`,
  `scripts/deploy-portal.sh`, `deploy/k8s/*.yaml`, any
  `deploy/Dockerfile.*`, or `docs/deploying-to-aks.md`.
- A GlobalInfra / Azure Front Door layer.
- Per-deployable ServiceGroups (one ServiceGroup covers both
  worker and portal).
- A Kubernetes Job for database migrations (migrations continue to
  run at worker startup).
- A Flux image-automation controller (image tags flow through the
  EV2 → `.env` → Kustomize `replacements` chain).
- A Git-source FluxConfig variant (only Azure Blob is supported).
- Microservice generator tooling (not applicable to a single-repo
  Node product).
- DACPAC extension (no DACPAC in PilotSwarm).
- Provisioning of the `scripts/deploy-aks.sh` dev cluster itself
  (that cluster's lifecycle is engineer-managed and out of scope).
- Onboarding to Geneva telemetry (can be added in a follow-up; the
  BaseInfra Bicep leaves room for it but does not ship it in this
  work).
- Migration of *existing* production traffic from the bash-script
  path to the new EV2 path. The two paths coexist; cutover is an
  operational decision separate from this work.

## Dependencies

- **EV2 tenant onboarding**: Service connection for the production
  deploy, dev-test service connection, and any SAW registrations
  must exist before the new path can be used end-to-end. This
  work produces the artifacts; tenant onboarding is a
  prerequisite.
- **Azure subscription(s)**: At least one subscription is required
  per environment (dev, prod). The BaseInfra rollout assumes
  subscription-scope permission.
- **`microsoft.flux` AKS extension availability**: The new path
  depends on the Azure-provided `microsoft.flux` extension; any
  Azure-side availability or feature changes affect this work.
- **Azure Key Vault Provider for Secrets Store CSI Driver (AKS
  addon)**: The `azureKeyvaultSecretsProvider` addon must be
  enabled on every target AKS cluster.
- **OneBranch pipeline infrastructure**: The production pipeline
  assumes OneBranch-compliant build and release agents and the
  `Ev2RARollout@2` task.
- **Existing `docs/deploying-to-aks.md` path**: The new path does
  not replace the existing path; both are documented side-by-side.

## Risks & Mitigations

- **Risk**: Two deploy paths may create conflicting state if both
  target the same cluster simultaneously (e.g., an engineer runs
  `deploy-aks.sh` while an EV2 rollout is in flight).
  **Mitigation**: Documentation explicitly calls out the conflict;
  the new path uses a distinct namespace or label ownership model
  where practical; engineer guidance is "pick one path per
  cluster."
- **Risk**: FLUX blob-pull latency creates operator confusion
  when an EV2 rollout reports "success" but the cluster hasn't
  reconciled yet. **Mitigation**: Documentation clearly states
  the blob-pull model and the expected reconcile window; the
  DeployApplicationManifest shell extension can optionally wait
  for reconciliation as a post-upload health gate (matching the
  reference's pattern if present; otherwise added as a
  PilotSwarm simplification).
- **Risk**: Secrets-Store CSI + AKV integration mismatches (e.g.,
  wrong UAMI, wrong tenant, missing RBAC) cause silent pod-mount
  failures that only surface at pod start. **Mitigation**: The
  BaseInfra Bicep provisions the UAMI and RBAC as one unit; the
  `SecretProviderClass` references are validated via the local
  Kustomize render; a smoke-test in the dev overlay validates
  the chain before prod.
- **Risk**: Adding a new path without removing the old one
  creates long-term maintenance overhead (two ways to do the
  same thing, easy to drift). **Mitigation**: Assumption is
  explicit that the paths coexist indefinitely per the intake;
  documentation clearly labels which path to use; a follow-up
  work item can reevaluate consolidation once the new path is
  operationally proven.
- **Risk**: The reference repo uses .NET and MSBuild for EV2
  ServiceGroup packaging; a Node-only equivalent must exist or
  be invented. **Mitigation**: Use a pipeline
  `ArchiveFiles@2`/`zip` task plus a plain bash/PowerShell packer
  instead of `.proj`. Structural validation moves from "does the
  .proj build" to "does `kustomize build` succeed" and explicit
  EV2 token presence checks.
- **Risk**: The session blob container bootstrap change
  (FR-011 / SC-008) subtly changes an undocumented current
  behavior (where the container had to exist prior to first
  worker run). **Mitigation**: The new path provisions the
  container in BaseInfra; the existing path is unaffected
  because `blob-store.ts` runtime code is not modified.
- **Risk**: OneBranch / EV2 tenant specifics cause the new
  pipeline YAML to be non-portable to the PilotSwarm tenancy.
  **Mitigation**: Ship a parameterized pipeline and document the
  required tenant-specific values; allow the first end-to-end
  rollout to be operator-assisted.

## References

- Issue: none (direct user intake)
- Research: `.paw/work/aks-gitops-iac/SpecResearch.md`
- Reference repo: `C:\Repos\postgresql-fleet-manager`
  - `src/Deploy/**`
  - `docs/Microservice-Hosting-Pattern-Generalization-Guide.md`
  - `docs/Production-Deploy.md`
  - `docs/Ev2DevTestDeployment.md`
- Existing PilotSwarm deploy surface:
  - `scripts/deploy-aks.sh`
  - `scripts/reset-local.sh`
  - `deploy/k8s/**`
  - `docs/deploying-to-aks.md`
  - `.github/copilot-instructions.md` (Docker / AKS Build Convention,
    Deployable Surface sections)
