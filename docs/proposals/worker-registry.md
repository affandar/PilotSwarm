# Worker Registry — Fleet Identity, Health, and Desired-State Convergence

> **Status:** Proposal (rev 2 — heterogeneous fleets)
> **Date:** 2026-07-30
> **Scope:** a first-class CMS registry of workers (identity, heartbeat, health, actual-state) plus a scoped desired-state channel (`fleet_directives`) that workers and external actuators converge against. Generalizes the agent-packages epoch/heartbeat machinery (migrations 0038/0039). **Workers are substrate-neutral by design** — AKS pods today, VMs and user laptops later — with substrate specializations (e.g. AKS image control) expressed as directive domains and pools, never as schema.

## Direction this serves

The fleet will span **AKS clusters, VMs, and users' laptops**. That forces four commitments the design must make now, cheaply, rather than retrofit:

1. **A worker is not a deployment technology.** The core row and protocol carry nothing Kubernetes-shaped. Substrate facts are descriptive JSON, never load-bearing.
2. **Lifetimes differ.** A pod's name retires every rollout (disappearance is routine); a VM is a long-lived individual (disappearance is an incident); a laptop is *intermittent* (lid closes nightly and the same identity returns tomorrow). One prune policy cannot serve all three.
3. **Desired state differs by segment.** Every worker should serve the same agent-package catalog, but laptops don't share AKS's model-provider keys, and a `worker-image` instruction is meaningless to a VM. Directives need scoping.
4. **Some directives can't be self-actuated.** A worker can install an agent package; it cannot replace its own container image. The channel must distinguish *worker-actuated* domains from *externally-actuated* ones where the worker only reports the actual.

Two principles carry over unchanged from rev 1: this is **not session leasing** — duroxide keeps all work arbitration (affinity, claiming, crash reclaim; `workerTagFilter` remains the routing mechanism, the registry only *describes*) — and the heartbeat pattern proven live by 0038/0039 (wholesale row upsert, recency-window liveness, self-prune, epoch doorbells) is the foundation, not something new.

## Design

Two tables, one round-trip; the heartbeat is the convergence poll.

### `workers` — one row per worker, substrate-neutral

```sql
workers (
    worker_node_id TEXT PRIMARY KEY,     -- pod name / hostname / laptop id — just a string
    pool           TEXT NOT NULL DEFAULT 'default',   -- directive targeting + operator grouping
    lifecycle      TEXT NOT NULL DEFAULT 'ephemeral', -- ephemeral | durable  → prune/offline policy
    phase          TEXT NOT NULL,        -- starting | ready | draining (worker-reported only)
    owner_provider TEXT,                 -- user-owned workers (laptops): the owning principal
    owner_subject  TEXT,
    registered_at  TIMESTAMPTZ NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL, -- the heartbeat
    info           JSONB NOT NULL,       -- identity & build (write-once at registration)
    health         JSONB NOT NULL,       -- standard metrics, replaced every beat
    state          JSONB NOT NULL        -- actual-state per directive domain, replaced every beat
)
```

- **`info`**: `{ sdkVersion, orchestrationVersions[], capabilities: {enhancedFacts, graph, blobStore, modelProviderIds[]}, runtime: { substrate: "kubernetes"|"vm"|"process", ... } }`. `runtime` holds substrate color — k8s namespace/node, VM os/arch, laptop hostname — purely descriptive. For containerized workers `info.image` `{ref, digest}` is the fleet-truth half of image control.
- **`health`** (every beat; a last-known snapshot, deliberately **not** a time series — OTel owns history): `{ uptimeS, rssBytes, heapUsedBytes, eventLoopDelayP99Ms, activeSessions, orchestrationSlots: {busy,total}, workerSlots: {busy,total} }`.
- **`state`**: per-domain actuals keyed by directive domain — `{ "agent-packages": {epoch, installed{...}}, "model-providers": {hash}, "worker-image": {digest} }`. `agent_worker_state` folds in here verbatim.
- **Lifecycle → liveness semantics** (the pod/VM/laptop split):
  - `ephemeral` (AKS pods): display-live within ~90s of a beat; rows silent > 1h are pruned (exactly 0039). Disappearance is unremarkable.
  - `durable` (VMs, laptops): rows are **kept** when silent and *displayed* as `offline (last seen …)`; pruned only after a long horizon (default 30 days, operator-deletable). A laptop that sleeps overnight keeps its identity, its metadata, and its place in the fleet page.
  - `phase` stays worker-reported (`starting`/`ready`/`draining` — `gracefulShutdown` beats `draining`, making deploys and clean laptop shutdowns observable); "offline" is *derived* from lifecycle + recency, never stored.
- **`owner_*`**: laptop workers register under their user's principal — the fleet page groups them ("Affan's laptop"), and later policy (visibility, what such workers may serve) has an anchor. Infra workers leave it NULL.

Workers declare `pool`, `lifecycle`, and owner at registration from config/env (`PILOTSWARM_WORKER_POOL`, defaults: AKS deploy sets `aks-default`, `pilotswarm local` sets `local`, a future laptop join flow sets `laptop` + owner).

### `fleet_directives` — desired state, scoped by pool

```sql
fleet_directives (
    domain     TEXT NOT NULL,            -- 'agent-packages' | 'model-providers' | 'worker-image' | …
    pool       TEXT NOT NULL DEFAULT '*',
    PRIMARY KEY (domain, pool),
    epoch      BIGINT NOT NULL,          -- bumped on every desired-state mutation of THIS row
    actuation  TEXT NOT NULL DEFAULT 'worker',  -- worker | external
    desired    JSONB NOT NULL,           -- small payload or doorbell-only ({} + truth elsewhere)
    updated_at TIMESTAMPTZ NOT NULL,
    updated_by TEXT
)
```

- **Resolution**: a worker's effective directive per domain is the `(domain, its-pool)` row if present, else `(domain, '*')`. The heartbeat returns the winning row (domain, pool, epoch, actuation, desired) so workers key convergence on `(domain)` and detect both epoch bumps and re-targeting. Two-level only — no label-selector algebra; pools are the segmentation primitive and stay human-legible.
- **Actuation**:
  - `worker` — the worker converges in-process and reports `state[domain]` (agent-packages, model-providers, log-level, feature flags).
  - `external` — the worker **cannot** act (image swaps, VM re-provisioning); an external actuator reconciles the substrate while workers merely report actuals. Workers skip external domains entirely.
- **Forward-compat protocol rule**: workers **ignore domains they don't handle**. A heterogeneous fleet has version skew forever; unknown domains must be inert, never errors.
- Adding a capability to the fleet = INSERT a directive row. Never a schema change.

### The one round-trip

```sql
cms_worker_heartbeat(p_worker_node_id, p_pool, p_lifecycle, p_phase,
                     p_owner_provider, p_owner_subject, p_info, p_health, p_state)
    RETURNS TABLE(domain TEXT, pool TEXT, epoch BIGINT, actuation TEXT, desired JSONB)
```

Upserts the row (info/pool/lifecycle/owner on insert; health/state/phase/updated_at always), applies the lifecycle-aware prune, and returns the worker's effective directive set. Worker-side, a small `WorkerRegistrar` owned by `PilotSwarmWorker` runs register → initial converge-all → `ready` → beat loop, dispatching changed epochs to pluggable domain handlers; `gracefulShutdown` sends a final `draining` beat. The protocol is **transport-neutral by shape**: v1 rides the proc (workers hold store creds today), and the same operation lands verbatim as a portal op (`POST /api/v1/workers/heartbeat`) when remote workers arrive — worker-over-Web-API auth is its own future track (laptops can't reach PG, as prod's firewall already demonstrates), and nothing here precludes it.

## Specialization worked example: AKS image control

The substrate specialization the design must eventually carry, end to end:

1. Operator deploys (Admin console Deploy button, or `psctl app push --deploy` per [app-manifest-and-image-deploy](./app-manifest-and-image-deploy.md)) → writes `fleet_directives('worker-image', 'aks-default')` with `desired: {ref, digest}`, `actuation: 'external'`, epoch bump. The directive row *is* the active-manifest pointer that proposal stored bespokely.
2. The **actuator** — the portal-side `DeployProvider` (`pilotswarm-azure`) — reconciles: patches the AKS Deployment to the digest-pinned ref. (Lesson already learned live: the MCP deployment is digest-pinned and `rollout restart` re-pulls the old digest; an actuator that *sets* images is the correct shape, not restarts.)
3. Workers report `info.image.digest` every beat (from `/etc/pilotswarm-app.json` or injected env).
4. The fleet page renders, per pool: desired digest vs each worker's actual → rollout progress, stragglers, drift — the "Fleet Truth" section of the image-deploy proposal, materialized on generic machinery.
5. VM/laptop pools simply have no `worker-image` row. Their future equivalent is a *worker-actuated* `worker-update` domain (self-download + restart) or a notify-the-owner flow — same channel, different domain and actuation.

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
| `lifecycle` | ephemeral | durable | durable |
| `owner` | — | — | the user |
| liveness | live ≤90s, prune 1h | offline badge, prune 30d | offline badge, prune 30d |
| `worker-image` | external-actuated | n/a (future `worker-update`, worker-actuated) | n/a (notify owner) |
| transport | proc (store creds) | proc or Web API | Web API (future track) |

## Migration plan

1. **0040** — `workers` + `fleet_directives`; `cms_worker_heartbeat` / `cms_list_workers` / `cms_fleet_directive_bump` / `cms_get_fleet_directives`; seed `('agent-packages','*')` from `agent_registry_state.epoch`; re-point the 0038 bump/epoch procs at it (shims — mixed fleets stay safe: old workers keep the 0038 paths, new workers heartbeat, both write compatible truth).
2. **Worker registrar** — absorb the agent-packages timer; health collection (`process.memoryUsage`, `perf_hooks.monitorEventLoopDelay`, session/slot counts); pool/lifecycle/owner from config; `draining` on graceful shutdown.
3. **Read-side** — portal/MCP/UI onto `cms_list_workers`; `get_system_status` from the registry; Workers admin surface.
4. **0041** — drop `agent_worker_state` + `agent_registry_state` once the fleet is upgraded.

The image-control actuator (the `DeployProvider` wiring) ships with the image-deploy proposal, not here — this proposal only guarantees the directive row and the actual-state reporting it needs.

## Open questions

- **Pool naming/ownership** — free-form strings with conventions, or a `pools` table with metadata? Start free-form; add the table when pools grow policy.
- **Laptop trust envelope** — user-owned workers executing shared agent-package code, and serving whose sessions, is the deferred security track; the registry deliberately only *records* owner + capabilities so that track has ground truth to build on. Routing restrictions stay in duroxide (`workerTagFilter`), with the registry describing tags, never enforcing them.
- **Remote worker transport/auth** — the Web-API heartbeat and worker identity tokens; a prerequisite for laptops, out of scope here beyond keeping the protocol shape transport-neutral.
- **Per-worker mailbox (v2)** — targeted directives (drain this pod, dump diagnostics) as `(worker_node_id, domain)` rows consumed on heartbeat, when a real consumer appears.
- **Health depth** — keep it glanceable; resist becoming a metrics store.
