# Solving Git Repo Hydration on AKS

*Working design note. Explores how PilotSwarm workers materialize large
user-specified (ADO) git enlistments fast on Kubernetes. Defines an MVP built on
per-repo warm pools over a **DaemonSet node-local cache**, and keeps the richer
variants (shared multi-repo cache, faster node seeding, delta snapshots) as
future work.*

---

## 1. The problem

A coding session operates on a **user-specified repo** — often a large ADO
enlistment (multi-GB, deep history). Three moments pay a latency tax today:

1. **Cold activation** — a new session's first turn needs the repo present in
   its working directory. A full `git clone` of a large enlistment is minutes.
2. **Re-activation on another pod** — PilotSwarm's snapshot is a *git-blind
   whole-directory tar* that rename-replaces the session dir. The repo (its
   `.git` + working tree) rides inside that tar, so hydration downloads a
   multi-GB blob before the session can resume. For big repos the **snapshot
   itself is the slow path**, not just clone.
3. **Fan-out** — N parallel sub-agent sessions on the same repo would each pay
   the clone independently.

ADO pipelines dodge (1) with **VHD caching**: the agent VM boots with the base
enlistment already on a cached disk, so a run does a small delta sync, not a
full clone. We want the AKS equivalent. That is the bar this note is trying to
hit.

---

## 2. The core invariant

> **A job never clones.** By the time a pod accepts a job, the repo working tree
> is already materialized; starting the job = `git fetch` (small delta) +
> `git checkout <ref>` (branch pointer / commit switch).

The clone cost is **frontloaded onto standby pods in the background**, before any
job, and taken off every job's critical path. For that to hold, standby pods
must be **pre-warmed for a specific repo** — so the MVP is **per-hot-repo warm
pools**: an operator configures which repos get warm pools; jobs for anything
else fall back to a cold clone (slower, acceptable).

---

## 3. MVP topology & decisions

- **1 pod per session tree.** A whole session tree (root + sub-agents) runs in
  one pod. Strong cross-tree isolation; single-tenant node.
- **One checkout per tree, single writer.** The root session owns the one
  materialized working tree; sub-agents share it read-only (or workspace writes
  are serialized). **No git worktrees, no per-sub-agent isolation yet.** The one
  capability deferred is *parallel, code-mutating* sub-agents.
- **Tear-down-and-replace** on completion (no recycle/clean yet) — cleanest
  isolation; the frontloading property still holds because a replacement standby
  pre-clones in the background.
- **PAT credentials** to clone as the creator (refresh-backed OAuth broker
  deferred). See §9.
- **Per-repo warm pools** for configured hot repos; cold clone for the rest —
  realized as a **DaemonSet node-local cache + per-repo node pools** (§5).

---

## 4. Lifecycles

### A. Standby pod setup (frontloaded, before any job)
```
1. Pool controller: "keep N ready pods for repo R."
2. New standby pod boots →
   a. clone/materialize R's working tree from the cache   ← the expensive step, paid HERE
   b. git fetch → checkout default branch (repo at a known good base)
   c. signal READY  (only now is it eligible for jobs)
   d. begin polling/leasing jobs tagged repo=R
```
The clone is on the pod's startup path, off every job's critical path.

### B. Cache stays fresh (continuous)
A **warmer** keeps R's cached copy (bare mirror / bundle) current on a cron, so a
new standby pod clones a near-current tree and only fetches a small delta —
standby warm-up stays cheap.

### C. Session creation → job start (fast path)
```
1. createSession { repositories:[{ url:R, ref:X, cloneAs:owner }] }
2. Session enqueued as a durable job, tagged repo=R, ref=X
3. Repo-affinity lease routes it to a READY standby pod warmed for R
4. Pod claims it → repo already present →  git fetch (delta) + git checkout X
5. Pod flips standby→busy, runs the session (workingDirectory = the checkout)
   └─ claiming DEPLETED the pool →
6. Pool controller starts a replacement standby pod (pre-clones in background)
```
Steps 1–4 to a running turn are **seconds**, because step 4 is a pointer switch,
not a clone.

### D. Completion
Session ends → pod is **torn down and replaced** by a fresh standby (cleanest
isolation for 1:1 / single-tenant). The replacement pre-clones in the background,
so the ready buffer refills without any job waiting. Recycle-with-`git clean` is
a later optimization.

---

## 5. Cache plane — DaemonSet node-local mirror + per-repo node pools

The "cache" referenced in §4 is concretely a **node-local git mirror maintained
by a DaemonSet**, so pod materialization is a *local file copy*, not a network
clone. The system splits into two independently-deployed planes:

- **Data plane (rarely redeployed).** A generic **repo-fetching DaemonSet** —
  one pod per node — keeps a bare mirror fresh on the node's disk at
  `/mnt/git-cache/<repo>` (a `hostPath` / node-local PV). It `git fetch`es
  deltas from ADO on a cron. The mirror is **read-only to workers** and outlives
  the DaemonSet pod (the PV/hostPath survives pod restarts and image redeploys —
  only a genuinely empty node disk triggers a reseed).
- **Compute plane (redeploy freely).** **Worker pods** co-located on the same
  nodes. Each pod `git clone --reference /mnt/git-cache/<repo> --dissociate`
  into its **own pod-private working tree**, checks out the base, signals READY,
  and polls the durable store. On claim: `git fetch` (delta, usually served from
  the local mirror) + `git checkout <ref>` → running in **seconds**. Because the
  cache lives in a separate lifecycle, redeploying the worker image never evicts
  it — new pods re-warm with a node-local copy, not an ADO clone.

### Parameterizing the daemon per repo (A, B, …)

A DaemonSet runs one pod template on every node it targets, so a single object
can't fetch different repos on different nodes. The generic daemon is a
**parameterized template** instantiated **once per repo**:

| Concept | Repo A | Repo B |
|---|---|---|
| Node pool (labeled) | `pool-a` (`repo=a`, ~5 nodes, autoscaler) | `pool-b` (`repo=b`, ~5 nodes, autoscaler) |
| DaemonSet instance | daemon `REPO_URL=A`, `nodeSelector: repo=a` | daemon `REPO_URL=B`, `nodeSelector: repo=b` |
| Worker Deployment | `nodeSelector: repo=a`, leases `repo=A` jobs | `nodeSelector: repo=b`, leases `repo=B` jobs |

One pool per **repo**, not per branch: the mirror holds all branches, so any
session on repo A is just a different `checkout` pointer served from the same
node cache. Templating (Helm/Kustomize: one base, a values file per hot repo)
keeps this to a small config per repo.

### Shared vs. private state on a node

| State | Scope | Writer | Collision risk |
|---|---|---|---|
| Node mirror (`/mnt/git-cache/<repo>`) | shared by all pods on the node | **only the DaemonSet** | none — workers only read |
| Worker working tree (`/work`) | **pod-private** (emptyDir / per-pod PV) | that one pod | none — separate `.git`, separate lock files |

Distinct session trees are separate pods with separate pod-private trees, so
their git mutations never collide. Two rules keep it that way: **working trees
are pod-private** (never on the shared `hostPath`), and clones use
**`--dissociate`** so a worker never depends on the continuously-updating
mirror's objects surviving a repack/GC.

### Mirror refresh & worker isolation

The DaemonSet keeps the mirror current with a **continuous in-container fetch
loop** (jittered `git fetch --prune` on a short interval) — *not* a `CronJob`,
which schedules cluster-wide, not one-per-node. Freshness is a latency
optimization, never a correctness requirement: the worker's claim-time `fetch` +
`checkout` makes the ref exact no matter how stale the mirror is.

A constantly-fetching mirror periodically triggers **`git gc --auto`**
(repack/prune) on itself. That — not the additive `fetch` — is what could pull
objects out from under a borrowing checkout. Two rules neutralize it:

- **Workers clone with `--dissociate`**
  (`git clone --reference /mnt/git-cache/<repo> <url> --dissociate`, or a
  `--no-hardlinks` clone straight from the mirror path). The worker copies the
  objects it needs into its own pod-private repo, so it is self-contained and
  immune to anything the mirror does afterward. Avoid a bare `--reference`
  (leaves an `alternates` pointer) or a default hardlinked local clone.
- **`git config gc.auto 0` on the mirror** keeps it append-only, closing even
  the tiny "clone racing a repack" window. The mirror slowly accumulates loose
  objects; a controlled repack is deferred to a staggered maintenance window
  (§6).

### Caveats of the per-repo-pool model

- **Hard capacity partitioning:** repo A's nodes can't absorb a repo B spike.
  Per-pool autoscalers help; the shared multi-repo node cache (§10) removes the
  rigidity at a per-node disk cost.
- **New-node warm-up:** a pool scaling 5→6 gives the new node an empty disk that
  must seed before its workers are useful (full ADO clone in v0; blob seed-pack
  / CSI snapshot later — §10). Keep a buffer or pre-scale.
- **Node resource contention** (not correctness): M co-located working trees
  share the node's CPU / IO / disk. Bound with `ephemeral-storage` + CPU
  requests so the scheduler caps pods-per-node.

---

## 6. Standby node buffer & readiness gating (1:1 exclusive-node model)

When each worker pod gets an **exclusive node** (1 pod ↔ 1 node), the standby
buffer is a buffer of **pre-seeded nodes**. Two things must hold: keep ~N warm
nodes ready ahead of demand, and never let a worker land on a node that is still
seeding.

### Keeping ~N warm nodes ahead of demand (balloon overprovisioning)

The cluster autoscaler is **reactive** — it only adds nodes for *pending* pods,
so it never pre-warms empty nodes "just in case." Force a buffer with
**low-priority balloon (pause) pods**:

- A `PriorityClass` with **negative** priority ("overprovision"); workers use a
  normal/high priority.
- A balloon `Deployment` of N pause pods, each requesting ~a whole node's
  allocatable → with 1:1, one balloon holds one node. The autoscaler keeps N
  nodes up to host them; each node's DaemonSet seeds it → **N warm nodes**.
- A real worker (higher priority) **preempts** a balloon → lands on an
  already-seeded node in seconds. The evicted balloon goes pending → autoscaler
  provisions a replacement → DaemonSet seeds it → buffer returns to N.

Off-the-shelf options: the `cluster-overprovisioner` Helm chart, or
Karpenter / AKS node-autoprovisioning paired with the same pause-pod trick.

### Readiness gating — don't schedule onto a still-warming node

A freshly provisioned node has an empty disk and its DaemonSet is mid-seed. Gate
it with a **startup taint** plus a **ready label the DaemonSet adds once seeded**.
A taint is node-side and default-deny; pod affinity alone is opt-in and weaker;
and a DaemonSet readiness probe does **not** block *other* pods from scheduling.

1. Pool boots pre-tainted:
   `--node-taints pilotswarm.io/cache-not-ready=true:NoSchedule` (present from
   node registration → no race).
2. The **DaemonSet tolerates** the taint, seeds the mirror, then **patches its
   own node** to add label `pilotswarm.io/git-cache-<repo>=ready`
   (node name via downward API `spec.nodeName`; RBAC: `patch` on `nodes`).
   "Seeded" = initial mirror materialized, not necessarily fully fresh.
3. **Workers** carry a **toleration** for `cache-not-ready` **and** a required
   nodeAffinity on `pilotswarm.io/git-cache-<repo>=ready` → they cannot schedule
   until the label appears, and non-cache pods (no toleration) never land here.
4. Make the **cluster autoscaler aware of the startup taint** so pending workers
   still trigger pool scale-up.

> **AKS constraint (verified 2026-08, cluster pskchtest-aks).** A taint set on a
> node pool via `--node-taints` is **pool-managed and cannot be removed
> in-cluster**: the `aks-node-validating-webhook.azmk8s.io` rejects any taint
> deletion (even by cluster-admin, even by the node's own ServiceAccount) with
> *"attempting to delete a taint configured on aks node pool"*. Removal is only
> possible via `az aks nodepool update --node-taints ""`. **Therefore the
> readiness model on AKS is: the startup taint is a PERMANENT hard gate (only
> cache-aware pods that tolerate it ever schedule on these nodes), and the
> `git-cache-<repo>=ready` LABEL — which the daemon *can* add — is the readiness
> signal that gates worker scheduling via required nodeAffinity.** The daemon
> still attempts taint removal best-effort and logs an honest "taint retained"
> note when the webhook blocks it. If a removable startup taint is truly needed,
> provision the pool WITHOUT `--node-taints` and apply the taint out-of-band with
> `kubectl taint` (unmanaged taints are removable), accepting a small
> boot→taint race.

Label = the selector and the signal the buffer controller counts; taint = the
hard gate. (Optional belt-and-suspenders: a worker initContainer that waits on a
`.ready` sentinel file — but with exclusive nodes, prefer the taint so a waiting
pod never occupies a whole VM.)

### Buffer controller

A small controller (or KEDA on a custom metric) keeps **seeded-idle nodes ≥ N**
by sizing the balloon replica count. It counts nodes that are `<repo>=ready`
**and** idle (no worker) **and** not in maintenance — so it backfills around
in-flight seeding and any maintenance window.

### Recycle the pod, keep the seeded node

Because the **cache (node, read-only mirror)** and the **working tree (pod
`emptyDir`)** are separate, session end does **not** require destroying the node.
Tear down only the **pod** — its `emptyDir` tree is discarded (clean isolation
for the next session) while the node's seeded mirror survives. The next worker
reference-clones a fresh tree from the intact cache → **no re-seed**. Reserve
whole-node teardown for **scale-down** when demand falls.

Consequences:

- **Seeding is demand-proportional**, and only on *net node growth* — it falls
  to ~0 when demand is flat or falling (freed nodes fold back into the balloon
  buffer already seeded).
- The only standing cost is the **N idle buffer VMs** (the deliberate price of
  "ready ASAP") — flat, not runaway. Trim off-hours or run standby on Spot.
- The only real risk is **burst latency**: a spike draining all N warm nodes at
  once makes the next session wait for provision + seed — a transient latency,
  addressed by buffer sizing and fast seed (blob pack / CSI snapshot, §10),
  never a runaway bill.

### Maintenance windows (deferred)

Routine `git fetch` runs **in place** — additive, safe for concurrent
clones/checkouts, no cordon needed. Only destructive `gc`/`repack` needs a node
out of rotation; when that path is built, do it by **dropping the readiness
label** (not a full cordon), **staggered** so only a small `maxUnavailable` of
nodes leave the buffer at once, with the buffer controller topping up the rest.

---

## 7. Components that need to exist

| # | Component | Responsibility |
|---|---|---|
| 1 | **Repo Cache Warmer** | Continuously maintain a fresh cached copy (bare mirror / bundle) of each hot repo; the source for fast pod materialization. |
| 2 | **Standby Pool Controller** | Per-repo pools; keep N *ready* pods; replenish on depletion (KEDA-style autoscale on ready-buffer depth). |
| 3 | **Job Queue + Repo-Affinity Lease** | Durable session/job queue (existing CMS / duroxide) extended with `repo`/`ref` tags and affinity routing to a warmed pod. |
| 4 | **Workspace Materializer** | Pod-side logic: at **standby** → clone + checkout base; at **claim** → `fetch` + `checkout <ref>`. (The `prepareWorkspace` activity.) |
| 5 | **Readiness signal** | A pod advertises READY only after its repo is materialized, so the lease never routes a job to a not-yet-warm pod. |
| 6 | **Credential provider** | Creds to clone/fetch as the creator. MVP = user/deployment **PAT**; refresh-backed OAuth broker deferred. |
| 7 | **Session Runtime** | Existing PilotSwarm worker running the session, `workingDirectory` = the pre-materialized checkout. |

> **1:1 exclusive-node realization:** the Standby Pool Controller (2) and
> Readiness signal (5) become a **node** buffer — balloon overprovisioning +
> startup-taint gating + a seeded-idle buffer controller (§6).

---

## 8. Correctness & concurrency (MVP)

- **Materialization is a durable activity** (`prepareWorkspace(sessionId)`), not
  orchestration-generator code (it is I/O). Durable + retryable; completion is
  recorded so replay never re-clones.
- **Exact-SHA guarantee:** always `fetch` then `checkout` the specific ref at
  claim time. The pre-warmed base may be slightly stale; the delta makes it
  exact. The warm tree is trusted for *speed*, never for *correctness*.
- **Single-writer workspace:** the tree's one checkout is mutated by the root
  session only; parallel code-mutating sub-agents are deferred (see §10).
- **Readiness gating:** jobs only land on pods that have signalled a
  materialized repo, so a job never blocks on a clone.

---

## 9. Cloning as the session creator (MVP: PAT)

Repos are private ADO enlistments, cloned **as the session's creator**:

- **Per-user credential**, encrypted at rest in `users` (same slot/precedent as
  `users.github_copilot_key`). Session config carries only a reference
  (`cloneAs = ownerUserId`), never the secret — shared-write viewers drive the
  session without seeing the owner's credential.
- **MVP = user-stored ADO PAT.** Long-lived, so no refresh machinery; the worker
  (a trusted direct-mode subsystem) reads it and clones/fetches. A deployment
  service PAT is an even simpler bootstrap where all hot repos share an org.
- **Token never touches disk/argv/logs** — injected via a git credential helper,
  discarded after the operation.
- The **warmer** also needs a credential to keep a private repo's mirror fresh;
  use a deployment/service identity for the shared cache, and per-user creds
  only for the exact-ref fetch/checkout at claim time.

Deferred to GA: **delegated OAuth with a refresh-backed token broker** (MSAL
confidential client mints short-lived per-user ADO tokens on demand) so very
long sessions never strand on an expired token, and users don't manage PATs.

---

## 10. Future work (explicitly out of MVP)

Listed roughly in the order we'd add them.

1. **Per-session workspace isolation** (unlocks parallel, code-mutating
   sub-agents). Smallest-first: per-child **copy / reference-clone** →
   **`git worktree`** (shared object store, independent trees) → **overlayfs
   CoW** for very large trees. Slots in behind the existing per-session
   `workingDirectory` seam — child sessions just point at a different path.
2. **Shared multi-repo node cache (remove per-repo-pool rigidity).** §5 pins one
   repo per node pool. A node-local cache holding **several** repos lets generic
   worker pods land on any node and reference-clone whichever repo a job needs —
   decoupling "warm" (node count) from "busy" (elastic pods) and letting idle
   capacity for repo A absorb a repo B spike. Adds herd control (PG advisory
   lock) on cache population and pushes toward fewer, fatter node pools.
3. **Faster node seeding (NOT native to AKS — must be built).** When a fresh
   node's disk is empty (scale-up, recycle), avoid a full ADO clone. The
   steady-state DaemonSet fetch is always delta-only; this only speeds the
   empty-disk case and keeps ADO egress flat (bounded by #repos × churn, not
   node churn). Options, least-custom-code first:
   - **(a) CSI VolumeSnapshot** — provision the node's cache PV from a
     periodically-refreshed Azure Disk snapshot of a warm mirror. Azure does the
     bulk hydration at the storage layer; you run a re-snapshot CronJob + a small
     git delta on the node. Most "native," least byte-moving code.
   - **(b) Blob seed-pack** — a single central seeder writes a `git bundle` to
     Azure Blob; a node initContainer pulls it in-region (fast, ~no egress) and
     fetches only a tiny ADO delta. Most portable; the most custom glue (seeder
     CronJob + consumer initContainer + pack versioning). Can reuse the existing
     `blob-store.ts` Azure Blob wiring.
   - **(c) Pre-baked node image (VHD)** — the mirror baked into the node image
     for the hottest, slow-changing repos (see item 9). Zero runtime seeding;
     heavy to rebuild/keep fresh.

   None of these is a managed AKS feature — the storage/mount/init primitives
   (Blob, Blob CSI, VolumeSnapshot, initContainers) are native, but the
   seed-pack *lifecycle* is app code you write and operate.
4. **Kill the fat snapshot.** A git-aware `VersionedSnapshotStore` strategy that
   stores `{ url, baseSha, workingTreeDelta, nonRepoFiles }` instead of a
   whole-dir tar. Re-activation re-materializes the base from cache and applies
   only the session's edits — snapshots shrink from **GB → edits-only**, and
   re-activation hits the same warm cache as cold activation. Also resolves the
   "snapshot rename-replaces the dir and clobbers a pre-clone" collision.
5. **Repo-affinity scheduling at cluster scale.** Advertise which nodes hold
   which repos; prefer placing both jobs and standby pods onto already-warm
   nodes so "ready" always means "clone-fast."
6. **Generic (non-per-repo) standby pool.** Lazy materialization at claim time
   from the shared node cache, for the long tail of repos that don't justify a
   dedicated warm pool.
7. **Recycle-with-clean** instead of tear-down-and-replace, once workspace reset
   (`git clean -fdx` + base checkout) is proven leak-free — reuses the warm
   working tree across sessions on a node.
8. **OAuth token broker** (see §9) — refresh-backed per-user ADO tokens.
9. **Pre-baked node image / premium-disk mount** — the true VHD-cache analog for
   the very hottest repos: the base enlistment is already on the node at boot.

---

## 11. Cost & latency intuition

| Approach | Cold-start latency | Idle cost | Scales with |
|---|---|---|---|
| Full clone per activation | minutes | none | — (unusable UX) |
| **Per-repo warm pool (MVP)** | seconds (fetch + checkout) | standby pods per hot repo | # hot repos × buffer |
| Shared node cache + elastic pods (future) | seconds (ref-clone + delta) | low (cache disk + small buffer) | demand + hotness |
| Pre-baked node image (future) | ~instant | medium (image/disk mgmt) | hot-repo set |

The MVP trades some idle cost (standby pods per hot repo) for the simplest thing
that delivers the invariant: **job start = branch switch, never a clone.** The
future node-cache work reduces idle cost by sharing warmth across pods and across
sessions on a node.

---

## 12. Failure modes (MVP)

- **No ready pod for R** (buffer drained faster than replenish) → job waits for
  a standby to finish warming, or falls back to a cold clone on a generic pod.
  Mitigate by sizing the buffer to arrival rate.
- **Credential failure** (bad/expired PAT) → clone/fetch fails; session surfaces
  an auth error. (OAuth broker later removes the expiry class.)
- **Ref not in the warm base** (brand-new branch) → the claim-time `fetch`
  retrieves it; worst case a slightly larger fetch, never a full clone.
- **Pod/node loss** → the tree reschedules; a fresh pod warms from the cache. No
  correctness impact — the checkout is regenerable.
- **Warmer stale/down** → standby pods clone a slightly older base and fetch a
  larger delta; degraded speed, not correctness.

---

## 13. Answering the original question directly

- **Do we keep pods constantly warming on repos?** Yes — the **MVP** keeps
  per-repo pools of standby pods that pre-clone and stand ready. (A later phase
  moves warmth into shared node caches so pods can stay generic and elastic.)
- **Ever-growing?** No — bound it two ways: a **standby buffer per hot repo**
  sized to arrival rate, and the set of **hot repos** an operator opts in. The
  warm set tracks demand and configured hotness, never the full repo catalog.
- **Net effect:** cold clone (minutes) → `fetch` + `checkout` (seconds) — the
  AKS equivalent of ADO's VHD caching, with a simple, isolated 1-pod-per-tree
  execution model.
