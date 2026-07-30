# Worker Registry — Fleet Identity, Health, and Desired-State Convergence

> **Status:** Proposal
> **Date:** 2026-07-30
> **Scope:** a first-class CMS registry of workers (identity, heartbeat, health, actual-state) plus a generic desired-state channel (`fleet_directives`) workers converge against — generalizing the agent-packages epoch/heartbeat machinery (migrations 0038/0039) into infrastructure every fleet-shaped feature rides.

## Motivation

The agent-packages work built, for its own needs, the thing PilotSwarm has been missing repeatedly:

- **There was no worker registry at all.** Until 0038, no table knew a worker existed — `worker_node_id` appeared only as a stamp on `session_events`/`session_turn_metrics` rows. `get_system_status` counts portal-embedded workers and reports **0 on AKS** (a documented wart); fleet visibility is kubectl log tailing.
- **[app-manifest-and-image-deploy](./app-manifest-and-image-deploy.md) left "Fleet Truth" as an open question** — "is the existing worker heartbeat channel rich enough … or does this add a small registration table?" There was no channel; `agent_worker_state` is that table, but package-shaped.
- **Convergence channels are ad-hoc, one per feature.** Agent packages poll a registry epoch; model providers mtime-watch a ConfigMap file; image rollouts ride Kubernetes; nothing reconciles "what should this worker run" against "what it actually runs" in one place. (The waldemort deployments live with portal-vs-worker model-catalog drift for exactly this reason.)
- **The 0038/0039 pattern is proven live**: wholesale-upserted row per worker, heartbeat on every poll tick, display-side liveness window (~90s), self-pruning rows (1h), desired-state epoch, converge-then-report. Ephemeral pods handled without a fixed roster — pod names retire every rollout, and that's fine. Promote it; don't re-derive it per feature.

**Explicit non-goal:** this is *not* session leasing or scheduling. Session affinity, work claiming, and crash reclaim stay entirely in duroxide — the registry observes workers and carries configuration intent; it never arbitrates who runs a session.

## Design

Two tables and one round-trip. Workers heartbeat their identity/health/actual-state; the same proc call returns the desired-state epochs, so **the heartbeat is the convergence poll**.

### `workers` — one row per live worker

```sql
workers (
    worker_node_id TEXT PRIMARY KEY,          -- POD_NAME / hostname (ephemeral, that's fine)
    phase          TEXT NOT NULL,             -- starting | ready | draining
    registered_at  TIMESTAMPTZ NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL,      -- the heartbeat; liveness = recency window
    info           JSONB NOT NULL,            -- identity & build (set once at register)
    health         JSONB NOT NULL,            -- standard metrics (replaced every beat)
    state          JSONB NOT NULL             -- actual-state per domain (replaced every beat)
)
```

- **`info`** (write-once): `{ sdkVersion, orchestrationVersions: ["1.0.68", …], image?, hostname, pid, startedAt, capabilities: { enhancedFacts, graph, blobStore } }`. Answers "what build is this worker" — version-drift detection across a rollout becomes a query.
- **`health`** (every beat, last-known snapshot — deliberately *not* a time series; OTel remains the metrics pipeline): `{ uptimeS, rssBytes, heapUsedBytes, eventLoopDelayP99Ms, activeSessions, orchestrationSlots: {busy, total}, workerSlots: {busy, total} }`. Enough for the fleet page to show "this pod is hot"; anything deeper belongs in real observability.
- **`state`** (every beat): per-domain actual state, keyed by directive domain:
  `{ "agent-packages": { epoch, installed: {name: {semver, status, error?}} }, "model-providers": { hash, models }, "app-manifest": { digest? } }`.
  `agent_worker_state` folds in here verbatim — same payload, generic home.
- **Phases**: `starting` (registered, first convergence in flight), `ready`, `draining` (set by `gracefulShutdown` — deploys become *observable*: the fleet page shows pods draining instead of vanishing). "Gone" is not a phase; it's the prune (rows silent > 1h delete, exactly the 0039 rule) plus the display window (~90s).

### `fleet_directives` — desired state, one row per domain

```sql
fleet_directives (
    domain     TEXT PRIMARY KEY,   -- 'agent-packages' | 'model-providers' | 'app-manifest' | 'ops'
    epoch      BIGINT NOT NULL,    -- bumped by every mutation of `desired`
    desired    JSONB NOT NULL,     -- small domain payload, or a pointer to bigger truth
    updated_at TIMESTAMPTZ NOT NULL,
    updated_by TEXT
)
```

The generalization of `agent_registry_state`. `desired` stays small: for agent-packages it's `{}` (the registry tables are the truth; the epoch is the doorbell — exactly today's semantics). For model-providers it could carry `{ hash }` of the catalog; for app-manifest, the deployed manifest pointer. Domains are added by inserting a row — no schema change per feature.

Fleet-wide only in v1. Per-worker targeting (drain *this* pod, dump diagnostics) is a natural v2 — a `worker_directives` mailbox keyed `(worker_node_id, domain)` consumed on heartbeat — but no current feature needs it, and the ops it enables (drain) already have kubectl.

### The one round-trip

```sql
cms_worker_heartbeat(p_worker_node_id, p_phase, p_info, p_health, p_state)
    RETURNS TABLE(domain TEXT, epoch BIGINT, desired JSONB)
```

Upsert the worker row (info only on insert; health/state/phase/updated_at always), prune hour-silent rows, and return the current directives snapshot. The worker compares returned epochs against its per-domain locals and runs the changed domains' converge functions. One query per worker per ~20s replaces N per-feature polls; convergence latency stays one heartbeat interval.

Worker-side, this is a small `WorkerRegistrar` owned by `PilotSwarmWorker`:

```
start():   register (phase starting) → initial converge-all → phase ready → beat timer
beat:      collect health → heartbeat() → for each changed epoch: domainHandlers[domain]()
shutdown:  phase draining (final beat), best-effort
```

Domain handlers are registered pluggably; the agent-packages handler is today's `refreshAgentPackages` minus its own epoch read.

## Folding agent packages in (the sub-design)

The agent-packages machinery becomes the first tenant, mechanically:

| Today (0038/0039) | Registry home |
|---|---|
| `agent_worker_state` row | `workers.state["agent-packages"]` (same JSONB payload) |
| `agent_registry_state.epoch` | `fleet_directives['agent-packages'].epoch` |
| `cms_agent_registry_bump()` | `cms_fleet_directive_bump('agent-packages')` (agent-package mutation procs call it; `cms_agent_registry_epoch()` becomes a shim over the directive row during transition) |
| Worker 20s epoch poll (`_agentPackagesTimer`) | the registrar beat; `refreshAgentPackages` becomes the `agent-packages` domain handler |
| `cms_upsert_agent_worker_state` / `cms_list_agent_worker_state` | `cms_worker_heartbeat` / `cms_list_workers`; list proc keeps a compat projection so the admin UI's fleet-adoption read migrates by switching a field path (`worker.installed` → `worker.state["agent-packages"].installed`) |

Nothing user-visible changes: same ~20s convergence, same liveness window, same self-prune, same fleet-adoption display — the plumbing just stops being package-private. The UI's liveness constant and the prune interval move to one shared definition instead of two.

Immediate beneficiaries beyond packages:

- **`get_system_status` reports real worker counts** (live registry rows) instead of portal-embedded-only 0 — with phase and health attached. `get_fleet_overview` gains a `workers` axis.
- **Admin console → Workers** (or the inspector's nodes tab): per-worker rows — phase, uptime, sessions, slots, memory, versions, per-domain drift flags (actual epoch ≠ desired epoch for > N beats ⇒ "stuck" highlight, with the domain's error from `state`).
- **Model-providers drift becomes visible** (worker-reported catalog hash vs portal's), and later the ConfigMap mtime-watch can be replaced by a directive bump.
- **Image-deploy fleet truth** gets its ack channel for free when that proposal lands: workers put the manifest digest in `state["app-manifest"]`.

## Migration plan

1. **0040** — create `workers` + `fleet_directives`; `cms_worker_heartbeat` / `cms_list_workers` / `cms_fleet_directive_bump` / `cms_get_fleet_directives`; seed `fleet_directives['agent-packages']` from `agent_registry_state.epoch`; re-point `cms_agent_registry_bump`/`_epoch` at the directive row (shims — every 0038 mutation proc keeps working untouched). `agent_worker_state` stays but stops being written once workers upgrade.
2. **Worker registrar** — absorb the agent-packages timer; add health collection (`process.memoryUsage`, `perf_hooks.monitorEventLoopDelay`, SessionManager/session counts); phase transitions incl. `draining` in `gracefulShutdown`.
3. **Read-side migration** — portal transport, admin UI fleet adoption, MCP `list_agent_worker_state` → `cms_list_workers` projections; `get_system_status` worker count from the registry.
4. **0041 (cleanup)** — drop `agent_worker_state` and `agent_registry_state` once the fleet is upgraded (both shimmed until then; safe on mixed fleets).

Rolling-upgrade safety: old workers keep calling the 0038 upsert (still present) and polling the epoch shim; new workers heartbeat. Both write compatible truth; the UI reads the union during transition via the compat projection.

## Open questions

- **Heartbeat cadence vs. PG load** — 20s × fleet size is one tiny upsert+select per worker; even 100 workers is negligible. Worth a knob (`PILOTSWARM_WORKER_HEARTBEAT_MS`) but not worth batching.
- **Health depth** — the proposed set is deliberately shallow (fleet-page glanceable). Resist growing it into a metrics store; OTel owns history.
- **Per-worker directives (v2)** — mailbox table when a real consumer appears (targeted diagnostics dump is the likeliest first).
- **Directive payload size** — keep `desired` under ~10KB; bigger truths live in their own tables with the directive as doorbell (the agent-packages pattern).
- **Portal/TUI workers surface** — new admin tree section vs. enriching the inspector nodes tab; decide when building phase 3.
