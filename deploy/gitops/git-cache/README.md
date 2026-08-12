# PilotSwarm git-cache DaemonSet (AKS git-hydration data plane)

Node-local **bare-mirror maintainer** for the AKS git-hydration design
(`SqlOrchestrationPlatform/docs/AKS-GIT-HYDRATION.md`, §5). One pod per node
keeps a fresh `git --mirror` of a single repo on the node's disk
(`hostPath: /mnt/pilotswarm-git-cache`), so PilotSwarm worker pods later
materialize a working tree by **local reference-clone**, never a network clone.

This is the **data plane only** (the mirror + readiness gating). Worker pods,
per-repo node-pool autoscaling, and the balloon/standby buffer (§6) are separate.

## What's here (URL-free by design)

| File | Purpose |
|---|---|
| `base/configmap-fetch-loop.yaml` | The maintainer script (`fetch-loop.sh`). Clone → gate node → hourly `fetch --prune`, GC off. Contains **no repo URL**. |
| `base/daemonset.yaml` | Generic DaemonSet with `__TOKENS__`. **Not directly applyable** — instantiated per repo by the deploy scripts. |
| `base/namespace.yaml` | Shared `pilotswarm` namespace (also hosts the git-repo-worker DaemonSets; components differ by name + `app.kubernetes.io/component` label). |
| `base/rbac.yaml` | ServiceAccount + `ClusterRole`/binding granting `get/list/patch` on **nodes** (for the self taint/label). |

> **Why no URLs here:** the target ADO repo URLs must not be persisted in this
> GitHub repo. The concrete per-repo values (URLs, PAT, node provisioning) live
> in the ADO deployment repo:
> `SQL-AI-Marketplace/SqlOrchestrationPlatform/Admin/PilotSwarm/git-hydration/`.

## How a repo gets a mirror

1. **Provision a labeled, pre-tainted node pool** (~5 nodes) for the repo:
   - label `pilotswarm.io/git-cache-repo=<repo>` (so the DaemonSet lands),
   - taint `pilotswarm.io/cache-not-ready=true:NoSchedule` (so workers stay off
     until the mirror is ready).
2. **Instantiate** the DaemonSet by substituting the `__TOKENS__` in
   `base/daemonset.yaml` from a per-repo `.env`, then `kubectl apply`. The
   deploy `apply.ps1` (ADO repo) does this.
3. Each node's pod clones the mirror once (**heavily logged + timed**), writes a
   `.ready` sentinel, then **self-patches its node**: removes the
   `cache-not-ready` taint and adds `pilotswarm.io/git-cache-<repo>=ready`.
4. Steady state: `git fetch --prune` every `FETCH_INTERVAL_SECONDS` (default
   3600) + jitter, with `gc.auto=0` (append-only mirror).

## Observability (what the logs show)

Every line is `<ISO-8601 UTC>Z [git-hydration] [<repo>] [<node>] …`. Key markers:

```
… ==== INITIAL CLONE starting ====
… cloning --mirror <url> -> /mnt/git-cache/<repo>.git
… ==== INITIAL CLONE COMPLETE in 137s (size=2.3G) ====
… cleared node taint pilotswarm.io/cache-not-ready (workers may now schedule)
… entering fetch loop: interval=3600s jitter<=300s gc.auto=0
… fetch #1 starting (git fetch --prune)
… fetch #1 COMPLETE in 4s
```

Tail a repo's mirrors:

```
kubectl -n pilotswarm logs -l pilotswarm.io/git-cache-repo=<repo> -f --prefix
```

## Tunables (env on the DaemonSet)

| Env | Default | Meaning |
|---|---|---|
| `FETCH_INTERVAL_SECONDS` | `3600` | Steady-state fetch cadence. |
| `FETCH_JITTER_SECONDS` | `300` | Max random add-on per cycle (herd control). |
| `CACHE_ROOT` | `/mnt/git-cache` | In-pod mount of the node hostPath. |
| `CACHE_NOT_READY_TAINT_KEY` | `pilotswarm.io/cache-not-ready` | Startup taint the daemon clears. |
| `ADO_PAT` | _(optional secret)_ | PAT for private clones; injected via `http.extraHeader`, never logged. |
