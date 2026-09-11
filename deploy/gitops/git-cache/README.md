# PilotSwarm git-cache GitOps service

Node-local **bare-mirror maintainer** for the AKS git-hydration design
([`docs/architecture/aks-git-hydration.md`](../../../docs/architecture/aks-git-hydration.md),
§5). One pod per node
keeps a fresh `git --mirror` of a single repo on the node's disk
(`hostPath: /var/lib/pilotswarm-git-cache`), so PilotSwarm worker pods later
materialize a working tree by **local reference-clone**, never a network clone.

The GitOps tree is the **data plane** (mirror + readiness gating). The service's
Bicep module owns the fixed-size repository node pool and workload-identity
federation; worker pods and the balloon/standby buffer (§6) remain separate.

## What's here (URL-free by design)

| File | Purpose |
|---|---|
| `base/` | Shared ServiceAccount, node-patch RBAC, and SecretProviderClass. |
| `components/linux/` | Linux DaemonSet and `fetch-loop.sh` ConfigMap. |
| `components/windows/` | Windows DaemonSet using the platform worker image. |
| `components/replacements/` | Shared structured replacements sourced from the generated `git-cache-env` ConfigMap. |
| `overlays/linux/`, `overlays/windows/` | OS-specific composition. Their `.env` files are rendered by the deploy pipeline before Kustomize runs. |

> **Why no URLs here:** the target ADO repo URLs must not be persisted in this
> GitHub repo. Concrete per-repo values such as URLs, credentials, and node
> provisioning belong in the deployment or integration repository.

## How a repo gets a mirror

1. **Deploy** through the PilotSwarm CLI. The service Bicep creates or
   reconciles the repository's AKS node pool, applies the
   `pilotswarm.io/git-cache-repo=<repo>` label and permanent
   `pilotswarm.io/cache-not-ready=true:NoSchedule` isolation taint, and creates
   the instance-specific federated identity credential.
2. The CLI stages the shared GitOps tree and selects its Linux or Windows
   overlay through service metadata. Supply the
   deployment repository's base and stamp dotenv files as ordered
   `--env-overlay` inputs and set `--instance` to the same value as `REPO_NAME`.
   The overlay generates `git-cache-env`; Kustomize replacements apply
   repository identity, image, resource names, workload identity, Key Vault,
   host path, and rollout tuning to the generic resources.
3. Each node's pod clones the mirror once (**heavily logged + timed**), writes a
   `.ready` sentinel, then **self-patches its node**: adds
   `pilotswarm.io/git-cache-<repo>=ready`. It attempts to remove the
   `cache-not-ready` taint, but AKS retains pool-managed taints; the label is
   therefore the cache-readiness signal while the taint remains an isolation
   boundary.
4. Steady state: `git fetch --prune` every `FETCH_INTERVAL_SECONDS` (default
   3600) + jitter, with `gc.auto=0` (append-only mirror).

The service assumes the shared `pilotswarm` namespace and BaseInfra AKS/Key
Vault/workload identity already exist. It owns the repository-specific node
pool, federated credential, ServiceAccount, SecretProviderClass, node-patch
RBAC, and fetch-loop resources. Every resource and Flux inventory is
instance-qualified so one cache cannot prune another repository's resources.

## Observability (what the logs show)

Every line is `<ISO-8601 UTC>Z [git-hydration] [<repo>] [<node>] …`. Key markers:

```
… ==== INITIAL CLONE starting ====
… cloning --mirror <url> -> /mnt/git-cache/<repo>.git
… ==== INITIAL CLONE COMPLETE in 137s (size=2.3G) ====
… node labeled pilotswarm.io/git-cache-<repo>=ready (readiness signal for workers)
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
| `CACHE_ROOT` | `/mnt/git-cache` (Linux), `C:\git-cache` (Windows) | In-pod mount of the node hostPath. |
| `CACHE_NOT_READY_TAINT_KEY` | `pilotswarm.io/cache-not-ready` | Optional startup taint the daemon removes on a best-effort basis. |
| `ADO_PAT_FILE` | `/mnt/secrets-store/ado-pat` | CSI-mounted private-repository token; injected via `http.extraHeader`, never logged. |
