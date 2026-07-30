# Worker Registry — Fleet Identity, Health, and Desired-State Convergence

> **Status:** Proposal (rev 4 — worker-scoped directives, placement invariants)
> **Date:** 2026-07-30
> **Scope:** a first-class CMS registry of workers (identity, heartbeat, health, actual-state) plus a scoped desired-state channel (`fleet_directives`, resolvable fleet-wide, per pool, or per worker) that workers and external actuators converge against. Generalizes the agent-packages epoch/heartbeat machinery (migrations 0038/0039). **Workers are substrate-neutral and uniformly ephemeral** — AKS pods today, VMs and user laptops later — with substrate variation expressed only in metadata and in which directive domains a worker consumes, never in the lifecycle model or schema.

## Direction this serves

The fleet will span **AKS clusters, VMs, and users' laptops**. That forces four commitments the design must make now, cheaply, rather than retrofit:

1. **A worker is not a deployment technology.** The core row and protocol carry nothing Kubernetes-shaped. Substrate facts are descriptive JSON, never load-bearing.
2. **Gone-ness is ONE model.** To PilotSwarm every worker is ephemeral: it is either heartbeating or it is gone. A VM worker may *happen* to stay present for months — the registry does not treat it differently. **The registry records presence, not enrollment**: a laptop that sleeps is pruned like any silent worker and simply re-registers on wake (identity is a cheap string; registration is idempotent). If a durable "known devices" inventory is ever wanted, that is a separate enrollment concern layered above, never a second liveness mode inside the registry.
3. **Desired state differs by segment, and so does what a worker can consume.** Every worker should serve the same agent-package catalog, but laptops don't share AKS's model-provider keys, and a `worker-image` instruction is meaningless to a VM. Directives need scoping, and each worker declares which domains it consumes — variation lives in that declaration and in the metadata blob, both of which are expected to differ per deployment technology.
4. **Some directives can't be self-actuated.** A worker can install an agent package; it cannot replace its own container image. The channel must distinguish *worker-actuated* domains from *externally-actuated* ones where the worker only reports the actual.

Two principles carry over unchanged from rev 1: this is **not session leasing** — duroxide keeps all work arbitration (affinity, claiming, crash reclaim; `workerTagFilter` remains the routing mechanism, the registry only *describes*) — and the heartbeat pattern proven live by 0038/0039 (wholesale row upsert, recency-window liveness, self-prune, epoch doorbells) is the foundation, not something new.

## Design

Two tables, one round-trip; the heartbeat is the convergence poll.

### `workers` — one row per worker, substrate-neutral

```sql
workers (
    worker_node_id TEXT PRIMARY KEY,     -- pod name / hostname / laptop id — just a string
    pool           TEXT NOT NULL DEFAULT 'default',   -- directive targeting + operator grouping
    phase          TEXT NOT NULL,        -- starting | ready | draining (worker-reported only)
    owner_provider TEXT,                 -- user-owned workers (laptops): the owning principal
    owner_subject  TEXT,
    registered_at  TIMESTAMPTZ NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL, -- the heartbeat; liveness = recency, uniformly
    info           JSONB NOT NULL,       -- identity, build, consumed domains (write-once)
    health         JSONB NOT NULL,       -- standard metrics, replaced every beat
    state          JSONB NOT NULL        -- actual-state per directive domain, replaced every beat
)
```

- **`info`**: `{ sdkVersion, orchestrationVersions[], consumes: ["agent-packages", "model-providers", …], capabilities: {enhancedFacts, graph, blobStore, modelProviderIds[]}, runtime: { substrate: "kubernetes"|"vm"|"process", ... } }`. **`consumes` declares which directive domains this worker acts on** — the per-substrate variation point for instructions: an AKS worker consumes `agent-packages` + `model-providers` (and *reports* against externally-actuated `worker-image`); a laptop build might consume a narrower set. Drift is evaluated per worker only over its declared domains — a worker is never "behind" on a domain it doesn't consume. `runtime` holds substrate color — k8s namespace/node, VM os/arch, laptop hostname — purely descriptive and expected to differ per deployment tech. For containerized workers `info.image` `{ref, digest}` is the fleet-truth half of image control.
- **`health`** (every beat; a last-known snapshot, deliberately **not** a time series — OTel owns history): `{ uptimeS, rssBytes, heapUsedBytes, eventLoopDelayP99Ms, activeSessions, orchestrationSlots: {busy,total}, workerSlots: {busy,total} }`.
- **`state`**: per-domain actuals keyed by directive domain — `{ "agent-packages": {epoch, installed{...}}, "model-providers": {hash}, "worker-image": {digest} }`. `agent_worker_state` folds in here verbatim.
- **Liveness — one model for every substrate**: display-live within ~90s of a beat; rows silent > 1h are pruned (exactly 0039). Disappearance is unremarkable *by definition* — a rolled pod, a decommissioned VM, and a sleeping laptop all just stop appearing, and a returning worker re-registers idempotently under the same id. No offline states, no per-class retention, no second liveness mode. `phase` stays worker-reported (`starting`/`ready`/`draining` — `gracefulShutdown` beats `draining`, making deploys and clean shutdowns observable during their last minutes of presence).
- **`owner_*`**: laptop workers register under their user's principal — the fleet page groups them ("Affan's laptop"), and later policy (visibility, what such workers may serve) has an anchor. Infra workers leave it NULL.

Workers declare `pool`, `consumes`, and owner at registration from config/env (`PILOTSWARM_WORKER_POOL`, defaults: AKS deploy sets `aks-default`, `pilotswarm local` sets `local`, a future laptop join flow sets `laptop` + owner).

### `fleet_directives` — desired state, scoped fleet-wide, per pool, or per worker

```sql
fleet_directives (
    domain         TEXT NOT NULL,        -- 'agent-packages' | 'model-providers' | 'worker-image' | …
    pool           TEXT NOT NULL DEFAULT '*',
    worker_node_id TEXT NOT NULL DEFAULT '*',   -- '*' = no worker specialization
    PRIMARY KEY (domain, pool, worker_node_id),
    epoch      BIGINT NOT NULL,          -- bumped on every desired-state mutation of THIS row
    actuation  TEXT NOT NULL DEFAULT 'worker',  -- worker | external (uniform per domain by convention)
    desired    JSONB NOT NULL,           -- small payload or doorbell-only ({} + truth elsewhere)
    updated_at TIMESTAMPTZ NOT NULL,
    updated_by TEXT
)
```

- **Resolution — three levels, union with precedence.** Per domain, a worker's contributing rows are `(domain, '*', '*')` (fleet), `(domain, its-pool, '*')` (pool), and `(domain, '*', its-worker-id)` (worker — canonical form for worker-scoped rows). The effective `desired` is the **shallow-merge union** of the three, more specific overriding on conflicting keys: worker > pool > fleet. The effective **epoch is the SUM of contributing rows' epochs** — each row's epoch is monotonic, so the sum changes on any contributing bump (max would miss coincidentally-equal bumps). The heartbeat returns the merged result per domain `(domain, epoch, actuation, desired)`; workers key convergence on the combined epoch and never see the level structure. No label-selector algebra — fleet/pool/worker is the whole hierarchy, human-legible.
- **Worker-scoped rows may outlive their worker** — deliberately. Directives are desired state, not messages: a laptop that re-registers tomorrow under the same id reacquires its worker-scoped rows. Operators manage them; a later GC can sweep rows whose worker has been absent for weeks.
- **Actuation**:
  - `worker` — the worker converges in-process and reports `state[domain]` (agent-packages, model-providers, log-level, feature flags).
  - `external` — the worker **cannot** act (image swaps, VM re-provisioning); an external actuator reconciles the substrate while workers merely report actuals. Workers skip external domains entirely.
- **Forward-compat protocol rule**: workers **ignore domains they don't handle**. A heterogeneous fleet has version skew forever; unknown domains must be inert, never errors.
- Adding a capability to the fleet = INSERT a directive row. Never a schema change.

### The one round-trip

```sql
cms_worker_heartbeat(p_worker_node_id, p_pool, p_phase,
                     p_owner_provider, p_owner_subject, p_info, p_health, p_state)
    RETURNS TABLE(domain TEXT, pool TEXT, epoch BIGINT, actuation TEXT, desired JSONB)
```

Upserts the row (info/pool/owner on insert; health/state/phase/updated_at always), applies the uniform prune, and returns the worker's effective directive set — the merged fleet/pool/worker resolution above, one row per domain. Worker-side, a small `WorkerRegistrar` owned by `PilotSwarmWorker` runs register → initial converge-all → `ready` → beat loop, dispatching changed epochs to pluggable domain handlers; `gracefulShutdown` sends a final `draining` beat. The protocol is **transport-neutral by shape**: v1 rides the proc (workers hold store creds today — and near-term remote/laptop workers will simply run with real credentials too), and the same operation lands verbatim as a portal op (`POST /api/v1/workers/heartbeat`) when credential-less remote workers arrive.

**Filed for later — the credential-less remote worker:** the clean end-state is a **duroxide proxy provider that rides the Web API** — an implementation of the existing duroxide storage-provider seam (`duroxideStorageProviders` is already a registry) whose backend is authenticated portal endpoints instead of Postgres: work-item fetch/ack, timers, and history proxied over HTTP, with CMS/facts/blob access riding the Web surfaces that already exist for clients. Duroxide's poll-based dispatch tolerates the added latency, the provider interface is the narrow waist that makes it a drop-in, and the missing piece is worker identity tokens (the same auth track the heartbeat op needs). Nothing to build now; the seam is named so nothing grows across it.

## Specialization worked example: AKS image control

The substrate specialization the design must eventually carry, end to end:

1. Operator deploys (Admin console Deploy button, or `psctl app push --deploy` per [app-manifest-and-image-deploy](./app-manifest-and-image-deploy.md)) → writes `fleet_directives('worker-image', 'aks-default')` with `desired: {ref, digest}`, `actuation: 'external'`, epoch bump. The directive row *is* the active-manifest pointer that proposal stored bespokely.
2. The **actuator** — the portal-side `DeployProvider` (`pilotswarm-azure`) — reconciles: patches the AKS Deployment to the digest-pinned ref. (Lesson already learned live: the MCP deployment is digest-pinned and `rollout restart` re-pulls the old digest; an actuator that *sets* images is the correct shape, not restarts.)
3. Workers report `info.image.digest` every beat (from `/etc/pilotswarm-app.json` or injected env).
4. The fleet page renders, per pool: desired digest vs each worker's actual → rollout progress, stragglers, drift — the "Fleet Truth" section of the image-deploy proposal, materialized on generic machinery.
5. VM/laptop pools simply have no `worker-image` row. Their future equivalent is a *worker-actuated* `worker-update` domain (self-download + restart) or a notify-the-owner flow — same channel, different domain and actuation.

## Future: capability-aware placement (recorded now, built later)

The stated direction: worker tags will eventually **restrict agents and tools to certain pools + owners**, pools will **advertise capabilities**, and an LLM mid-session will be able to *ask to be rescheduled* onto a pool with the capabilities or privileges its task needs. None of that is built now — but the present design must not preclude it. Four invariants, all already satisfied, are therefore promoted to guarantees this proposal will not break:

1. **Pool and owner are stable, worker-declared identities present on every registry row.** They are the future tag alphabet: when placement lands, a worker's duroxide claim tags derive mechanically from `(pool, owner)`; a session reschedule is then just a tag change on its work — claimed only by matching workers. Nothing today writes competing tag semantics.
2. **Capabilities are honestly worker-reported in `info.capabilities` and aggregate per pool without new schema.** A pool's advertisement is derived from its live workers — the *intersection* of their capability sets is what a pool can guarantee (union shows what it might offer). `list_pools` (portal/MCP, and eventually a session tool) is a read over the registry, nothing more.
3. **Placement constraints attach to the things being placed, not to this registry.** Agent/package manifests and tool metadata are open JSONB/frontmatter — a future `placement: { pools, capabilities }` field slots in without touching workers or directives; enforcement happens at create/reschedule validation, which maps constraints to tags.
4. **The registry describes; duroxide enforces; relocation already exists.** Reschedule = validate → set the session's tag → dehydrate; any eligible worker rehydrates (the blob-relocation path in production today). The registry never arbitrates — the boundary that keeps this proposal out of the scheduler business is exactly the boundary that makes the scheduler buildable later.

The one genuine prerequisite this surfaces early: capability-restricted pools only work if their workers can reach the session state (store/blob) — which for laptops is the credential-less transport track above. The two future features converge on the same seam, which is a good sign it is the right seam.

## Folding agent packages in (first tenant)

| Today (0038/0039) | Registry home |
|---|---|
| `agent_worker_state` row | `workers.state["agent-packages"]` (payload unchanged) |
| `agent_registry_state.epoch` | `fleet_directives('agent-packages', '*')` — one catalog fleet-wide by default; a pool override row is available the day laptops need a restricted set |
| `cms_agent_registry_bump()` / `_epoch()` | shims over the directive row during transition |
| Worker's 20s epoch poll | the registrar beat; `refreshAgentPackages` becomes the `agent-packages` domain handler |
| `cms_list_agent_worker_state` | `cms_list_workers` with a compat projection (UI fleet adoption switches a field path) |

No user-visible change: same ~20s convergence, same liveness display, same prune for the (ephemeral) AKS fleet. Immediate free wins: `get_system_status` reports real worker counts with phase/health (fixes the "0 workers on AKS" wart); model-catalog drift becomes visible (worker-reported hash vs portal's); the admin console gains a Workers surface grouped by pool with per-domain drift flags (actual epoch ≠ desired epoch for > N beats ⇒ stuck, with the domain's own error from `state`).

## Substrate profiles at a glance

| | AKS pod | VM | Laptop |
|---|---|---|---|
| `pool` | `aks-default` (per cluster) | `vm-<fleet>` | `laptop` |
| liveness | live ≤90s, prune 1h — **identical for all three**; a silent worker is gone, a returning one re-registers | ← | ← |
| `owner` | — | — | the user |
| `info.consumes` | agent-packages, model-providers | agent-packages, model-providers (+ future worker-update) | possibly narrower (e.g. agent-packages only) |
| `worker-image` | external-actuated; worker reports actual | not consumed | not consumed |
| transport | proc (store creds) | proc or Web API | Web API (future track) |

## Migration plan

1. **0040** — `workers` + `fleet_directives` (with the full domain/pool/worker key from day one); `cms_worker_heartbeat` / `cms_list_workers` / `cms_fleet_directive_bump` / `cms_get_fleet_directives`; seed `('agent-packages','*','*')` from `agent_registry_state.epoch`; re-point the 0038 bump/epoch procs at it (shims — mixed fleets stay safe: old workers keep the 0038 paths, new workers heartbeat, both write compatible truth).
2. **Worker registrar** — absorb the agent-packages timer; health collection (`process.memoryUsage`, `perf_hooks.monitorEventLoopDelay`, session/slot counts); pool/consumes/owner from config; `draining` on graceful shutdown.
3. **Read-side** — portal/MCP/UI onto `cms_list_workers`; `get_system_status` from the registry; Workers admin surface.
4. **0041** — drop `agent_worker_state` + `agent_registry_state` once the fleet is upgraded.

The image-control actuator (the `DeployProvider` wiring) ships with the image-deploy proposal, not here — this proposal only guarantees the directive row and the actual-state reporting it needs.

## Resolved decisions

- **Pool naming** — free-form strings with conventions. No pools table unless pools ever grow policy of their own.
- **Enrollment inventory** — later, if ever; layered above the registry, never a second liveness mode. Not a concern now.
- **Worker-scoped directives** — in from day one via the `worker_node_id` dimension (union with fleet/pool, worker precedence on conflict) rather than a v2 mailbox.
- **Remote workers** — near-term they run with real credentials; the credential-less path is the filed duroxide Web-API proxy provider (above), gated on worker identity tokens.

## Open questions

- **One-shot operations** — worker-scoped *directives* are desired state; imperative one-shots (dump diagnostics now) don't fit the epoch model and would need a consumed-on-read mailbox if ever wanted.
- **Pool capability advertisement details** — intersection for guarantees is the proposal; whether the UI also shows the union ("some workers here can…") is a display call for when `list_pools` is built.
- **Directive merge depth** — shallow key-level merge is specified; revisit only if a domain genuinely needs deep merging (none foreseen — keep payloads flat).
- **Laptop trust envelope** — user-owned workers executing shared agent-package code, and serving whose sessions, is the deferred security track; the registry records owner + capabilities + consumed domains so that track has ground truth. Enforcement stays in duroxide tags and create/reschedule validation.
- **Health depth** — keep it glanceable; resist becoming a metrics store.
