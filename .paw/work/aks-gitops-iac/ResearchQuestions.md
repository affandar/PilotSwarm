# Research Questions — AKS GitOps IaC

**Work ID**: aks-gitops-iac
**Branch**: feature/aks-gitops-iac
**Issue URL**: none

## Agent Notes / Intake Context

- The goal is to add a new IaC + GitOps deployment path for PilotSwarm on AKS,
  modeled on `C:\Repos\postgresql-fleet-manager`, using **FLUX + GitOps,
  Kustomize with environment overlays and replacements, Azure Storage buckets
  for artifacts, and EV2 for rollout orchestration** (full EV2 with SDP,
  multi-region).
- Existing deployment mechanisms (`scripts/deploy-aks.sh`, `deploy/k8s/**`,
  `docs/deploying-to-aks.md`) must remain **untouched**. The new path is
  additive (side-by-side).
- PilotSwarm is a **Node.js single-repo** product (SDK + CLI + portal + sample
  apps in a PNPM/NPM workspace). The reference is a large **.NET
  multi-microservice** repo. Deliberate simplifications are welcome and will
  be captured as spec assumptions with rationale.
- User confirmed intent: "Match fleet manager's approach" for stage topology
  (Q2), GitOps source (Q3), IaC scope (Q4), secret management (Q5), and
  per-service overlay structure (Q6). All need concrete grounding from the
  reference repo before the spec can be completed.

## Internal System Questions — PostgreSQL Fleet Manager (Reference Repo)

The answers to these ground the "what patterns are we copying" portion of the
spec. Use `C:\Repos\postgresql-fleet-manager` as the source of truth. Cite
`file:line` for every concrete claim.

### Reference Architecture Overview
1. What is the overall shape of `src/Deploy/` in fleet manager? Enumerate the
   top-level subdirectories (e.g., `BaseInfra`, `GlobalInfra`, `Common`,
   `AIModelService`, `HelloWorldService`, `PlaygroundService`,
   `PostgreSQLFleetManager`) and describe the purpose of each in 1–2
   sentences with citations.
2. What is the high-level artifact and control flow from source code → ACR
   image → EV2 rollout → FLUX reconcile → pods running on AKS? Produce a
   labeled diagram + a prose walkthrough.

### EV2 Structure and Multi-Region Rollout
3. How is EV2 structured in fleet manager? For **one representative
   service** (recommend `AIModelService` or `PostgreSQLFleetManager`),
   enumerate:
   - ServiceModel.json / ServiceGroupRoot / RolloutSpec / RolloutParameters
     files and their roles
   - Scope bindings / parameter substitution mechanics
   - How EV2 "shells" / "stages" / "rollouts" are composed
4. What is the **exact stage / region list** used for a production rollout?
   (Answer Q2: "Mirror fleet manager's exact stage list.") Document the
   stages, their purpose, and the regions/clusters each targets.
5. How does EV2 invoke FLUX / Kustomize? Specifically:
   - Does EV2 run a shell extension that uploads a Kustomize bundle to a
     storage bucket and then pokes FLUX?
   - Or does EV2 apply manifests directly and FLUX reconciles on its own
     cadence?
   - Or a mix (e.g., EV2 uploads config, FLUX polls the bucket)?
   Cite the EV2 extension code and any helper scripts.
6. What Safe Deployment Practices (SDP) controls are baked in — bake times,
   health checks, rollback triggers, canary percentages?
7. How are secrets / service-principal identities passed to EV2 rollouts,
   and how does EV2 surface credentials to the in-cluster workload?

### GitOps Source / Storage Bucket Pattern
8. What does FLUX watch in fleet manager — a Git repo, an Azure Storage
   bucket (`OCIRepository` / `Bucket` source), or both? Cite the FLUX
   `GitRepository` / `Bucket` / `Kustomization` YAMLs.
9. If a storage bucket is used: how is the bucket populated (EV2 extension?
   CI pipeline? manual script?), what's the object layout, and how is FLUX
   authenticated to it (workload identity, SAS, connection string)?
10. Where do the Kustomize base + overlays physically live in the repo?
    Produce the directory tree for one representative service.
11. How are **environment files with replacements** implemented — Kustomize
    `configMapGenerator` with files, `replacements` transformers, envsubst
    helper scripts, or something else? Show a concrete example.
12. How is **image tag substitution** handled (EV2 writing a new tag into a
    Kustomize file? FLUX image automation controller? something else)?

### Supporting Azure Infrastructure (BaseInfra / GlobalInfra)
13. What does `src/Deploy/BaseInfra` provision? Enumerate resource types,
    IaC language (Bicep? ARM?), and how it's invoked (EV2 rollout? pipeline?).
14. What does `src/Deploy/GlobalInfra` provision and how does it differ from
    BaseInfra?
15. Specifically: how are **AKS cluster, ACR, Azure Database for PostgreSQL,
    Azure Storage, Azure Key Vault** provisioned in fleet manager? Which
    file(s), which rollout(s)?
16. How is the AKS cluster bootstrapped with FLUX itself (`flux bootstrap`?
    EV2 step that runs `flux install`? pre-baked addon via AKS extension?)?

### Secret Management
17. How are runtime secrets delivered to pods? (CSI driver with
    `SecretProviderClass`? External Secrets Operator? direct K8s `Secret`s
    managed by EV2?) Cite the `SecretProviderClass` YAMLs and any driver
    installation manifests.
18. How is pod → Key Vault auth established (workload identity federation?
    pod-identity v1? managed identity on the node pool)?
19. Where do the actual secret *values* come from (per-stage Key Vault
    populated by a separate secure pipeline? EV2 scope-binding from a
    service-principal vault?).

### Helper Scripts and Developer Loop
20. What helper scripts exist in fleet manager for the **developer /
    non-production** deployment loop (analog to PilotSwarm's
    `scripts/deploy-aks.sh`)? List them, their purpose, and the entry-point
    commands.
21. What is the **dev-test EV2** story (see `docs/Ev2DevTestDeployment.md`)
    — how do engineers smoke-test an EV2 rollout before production?
22. What **validation / linting / preview** tooling exists for Kustomize
    overlays, EV2 specs, and Bicep (e.g., `kustomize build`, `ev2 validate`,
    `bicep build`, pre-commit hooks)?

### Pipelines and CI/CD Wiring
23. What does `.pipelines/postgresql-fleet-manager-deployment-prod.yml`
    actually do end-to-end? Summarize the stages and how it connects to EV2.
24. How is the Docker image built and pushed to ACR in the production path?
    Is it built in CI and consumed by EV2, or built inside EV2 steps?
25. How does `continuous-deployment-dev.yml` differ from the prod pipeline —
    is it a lighter-weight path that still uses GitOps, or something
    else?

### Generalization Guidance From the Reference Repo Itself
26. What does `docs/Microservice-Hosting-Pattern-Generalization-Guide.md`
    say about adopting this pattern in another repo? Summarize the key
    points and any listed prerequisites.
27. What does `docs/Production-Deploy.md` say about the end-to-end
    production deploy flow? Summarize with citations.
28. What does the microservice generator (see `docs/Microservice-Generator-*.md`,
    `docs/microservice-generator-schema.json`) actually generate, and
    which portions of its output are deploy-related vs app-scaffolding?

## Internal System Questions — PilotSwarm (This Repo)

These ground the "what does the new path have to integrate with" portion of
the spec. Use `C:\Repos\PilotSwarm` as the source of truth.

### Current Deployment Mechanics
29. What does `scripts/deploy-aks.sh` actually do, step by step? Document
    every `kubectl`, `docker`, `az`, and `helm`-like call and what it
    targets.
30. What is the full content of `deploy/` in this repo? Produce a directory
    tree with a 1–2 sentence description per file.
31. Read `docs/deploying-to-aks.md` in full and summarize the prescribed
    manual path, including namespace, secrets, storage, image pull, and
    any caveats (e.g., the "WARNING: Runaway Deployments" section).
32. What environment variables and config files does the worker actually
    require at runtime (cite `packages/sdk/src/worker.ts`, any
    `Worker.start`-time validation)? What does the portal require?
33. What does `reset-local.sh remote` do and how does it relate to
    `deploy-aks.sh`?

### Deployable Surface
34. Enumerate every PilotSwarm deployable that could land on AKS (worker,
    portal, system agents, migration runners, any sidecars). For each,
    document: the container image, its Dockerfile, its runtime entrypoint,
    its K8s resource footprint in `deploy/k8s/**`, and its
    scaling/affinity expectations.
35. Which deployables are **stateless** vs stateful? Any that require
    persistent volumes, leader election, or session affinity?
36. What configuration does each deployable need that is environment-specific
    (e.g., `.model_providers.json`, `K8S_CONTEXT`, `K8S_NAMESPACE`, PG
    connection string, blob connection string)?

### Docker Image Build
37. How is the worker image built today? Where is the Dockerfile? What base
    image? Any multi-stage optimization?
38. What's the `docker buildx` AMD64 convention mentioned in
    `copilot-instructions.md`, and where is it enforced in the current
    scripts?
39. Is there a portal Dockerfile? A migration-runner Dockerfile? Enumerate
    all Dockerfiles in the repo.

### Database Migrations and Blob Store
40. How do CMS / Facts migrations run in the current AKS path — at
    worker startup, as a one-shot Job, or manually? Cite the code.
41. How is the Azure Storage container bootstrapped (created if missing)?
    Manual portal operation, or code in `blob-store.ts`?

### Configuration Shape for Overlays
42. What subset of `deploy/k8s/**` is environment-invariant vs
    environment-specific today? This drives the "base vs overlay" split.
43. Where does the current path inject env-specific values (cluster
    context, namespace, image tag, DB URL)? Cite `.env.remote.example`,
    `scripts/deploy-aks.sh`, and any inline `envsubst`.
44. What would need to change in `deploy/k8s/**` to make those manifests
    reusable as a **Kustomize base** (or do we fork them into a new
    `deploy/kustomize/` tree and leave the originals alone)?

## External / Context Questions (Optional)

45. (Optional) Does PilotSwarm have a currently-known target AKS cluster
    (prod or otherwise) that the new path should be able to target on day
    one? If so, what's the Entra/ARM tenancy?
46. (Optional) Are there any known Microsoft-internal compliance / SFI /
    1ES requirements that the production EV2 rollout must satisfy (e.g.,
    Geneva monitoring hookup, mandatory SDP bake times)? If the reference
    repo satisfies these, document where.

## Research Output Expectations

The researcher should produce `SpecResearch.md` with:
- One section per question above, numbered identically
- Every concrete claim cited `path:line` (e.g.,
  `src/Deploy/AIModelService/ServiceModel.json:42`)
- Diagrams in ASCII or mermaid where requested
- Explicit "Not found" where the answer genuinely isn't in the repos — no
  fabrication
- A short **"Patterns to copy vs simplify"** synthesis at the end that
  compares the reference patterns against PilotSwarm's shape, flagging
  candidate simplifications (e.g., single-service means one overlay tree,
  no microservice generator; Node means no Directory.Build.props
  infrastructure; etc.)
