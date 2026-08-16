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
  **Across a session's lifetime that ref is pinned once at turn 0 and never
  moves** — see [§8.5](#85-git-state-durability--base-commit-pinning).
- **Single-writer workspace:** the tree's one checkout is mutated by the root
  session only; parallel code-mutating sub-agents are deferred (see §10).
- **Readiness gating:** jobs only land on pods that have signalled a
  materialized repo, so a job never blocks on a clone.

---

## 8.5 Git-state durability & base-commit pinning

§8's **Exact-SHA guarantee** ("always `fetch` then `checkout` the specific ref")
is correct for the *first* turn, but the ref it checks out is a **moving target**
across a session's lifetime. This section makes the working tree **durable** and
**stable** for the whole session, and is the concrete realization of the git-aware
`VersionedSnapshotStore` sketched in [§10 item 4](#10-future-work-explicitly-out-of-mvp)
("Kill the fat snapshot").

### 8.5.1 The moving-ref bug

The pod-side materializer (`git-repo-worker.js`) reconciles a session's tree on
every **cold** turn (a turn that lands on a pod where the tree is not already
resident). Today `resolveTargetRef()` returns either a configured enlistment ref
**or** re-resolves `symbolic-ref refs/remotes/origin/HEAD` — a **moving** ref —
and `reconcileEnlistment()` then does:

```
git fetch --prune
git rev-parse <ref>                 # ← re-reads live mirror HEAD every time
git checkout --force --detach <sha>
git reset --hard <sha>
```

So a session's base **tracks live mirror HEAD**, not a fixed point. Two hazards:

1. **Silent forward-jump.** `reset --hard` moves the tree to whatever the mirror
   now points at, with **no conflict marker** — in-flight session work on the old
   base is simply gone.
2. **Real corruption under durability replay.** Once we reapply a session's
   uncommitted edits as a patch (below), `git apply --3way` against a **moved**
   base is a genuine 3-way merge that can conflict or mis-apply. This is the
   "a major upstream change syncs to the pod and a massive merge conflict
   corrupts the resumed session" scenario.

### 8.5.2 The invariant: pin the base at turn 0

**A session's base commit is chosen once, at session create (turn 0), and never
moves unless the session explicitly advances it.**

- Turn 0 resolves the target ref **once**, `rev-parse`s it to a concrete `sha`,
  and **persists** it on the session row as `git_base_sha`.
- Every subsequent reconcile targets **the pinned sha**, never re-reading
  `origin/HEAD`. Reconcile becomes **idempotent**: replaying it lands the tree on
  the same commit every time.

Reconcile splits into two phases with different freshness rules:

| Phase | Operation | Freshness | Rationale |
|---|---|---|---|
| **A — object fetch** | `git fetch --prune` | **always latest** | Populating the local object store is harmless and keeps *explicit advance* cheap. Fetching objects never moves the working tree. |
| **B — working-tree checkout** | `checkout --force --detach <pinned>` + `reset --hard <pinned>` | **pinned only** | The tree is placed on the session's pinned base, regardless of how far the mirror has moved. |

The git-worker is thus *always reconciling objects to the latest mirror* (Phase A),
but *only ever checks out the session's pinned commit* (Phase B).

### 8.5.3 Where state lives

Two stores, split by ownership:

1. **Session-row scalars (CMS / Postgres, `sessions` table).** The durable pointer:
   - `git_base_sha`   — the pinned base commit (turn-0 capture).
   - `git_head_sha`   — the session branch tip (the session's own commits).
   - `git_branch`     — the session's working branch name.
   - `git_state_epoch`— monotonic counter; bumped on every dehydrate so hydrate
     can detect/ignore a stale blob set.
   These ride the same per-session scalar precedent as
   `users.github_copilot_key` — dedicated `cms_get_session_git_state` /
   `cms_set_session_git_state` procs, not a widening of the shared
   `cms_get_session` read shape.

2. **Working-tree delta blobs (Azure Blob, `copilot-sessions` container).**
   Platform-owned, **never pushed to the customer remote** — this is internal
   platform implementation, not the customer's branch history. Stable,
   overwrite-in-place keys (one set per session, no epoch fan-out):
   - `${sessionId}.git.bundle`    — `git bundle create` of `base..HEAD` (the
     session's committed work, as objects the target pod may not have).
   - `${sessionId}.git.patch`     — `git diff` of uncommitted tracked changes +
     a manifest of untracked files (the dirty working tree).
   - `${sessionId}.git.meta.json` — `{ baseSha, headSha, branch, epoch }`,
     the self-describing header the hydrate path validates against the session row.

### 8.5.4 Resume cases

| Case | Condition | Action |
|---|---|---|
| **Turn 0** | session create | Resolve ref once → pin `git_base_sha`; tree already at base; no blobs yet. |
| **Warm, same pod** | tree resident (`wasResident`) | **No reconcile.** The hook is gated on `!wasResident` (session-proxy `beforeRunTurn` call site) — the live tree is authoritative. |
| **Cold, cross-pod** | tree not resident | Full **hydrate** (below): Phase A fetch → Phase B checkout/reset to **pinned** base → replay committed work → replay uncommitted work. |

### 8.5.5 Dehydrate / hydrate protocol

**Dehydrate** (end of a cold-eligible turn, or on eviction) — capture, then persist:

```
1. git bundle create <bundle> <base_sha>..HEAD     # committed session work
2. git diff <tracked>            > <patch>          # uncommitted tracked edits
   (enumerate untracked → manifest, tar into patch/side-blob)
3. write meta.json { baseSha, headSha, branch, epoch+1 }
4. upload bundle, patch, meta   (overwrite-in-place)
5. UPDATE sessions SET git_head_sha, git_branch, git_state_epoch=epoch+1
```

Order matters: **blobs first, row last.** If the crash window hits between 4 and
5, hydrate sees a row epoch *older* than the blob and simply ignores the blob
(treats it as a not-yet-committed dehydrate). The row is the commit point.

**Hydrate** (cold acquisition, inside the `beforeRunTurn` hook):

```
1. read git_base_sha, git_head_sha, git_branch, git_state_epoch from session row
2. git fetch --prune                                   # Phase A (objects)
3. git checkout --force --detach <git_base_sha>        # Phase B (pinned tree)
   git reset --hard <git_base_sha>
4. if meta.epoch == row.epoch:                         # blob set is current
     git bundle unbundle <bundle>                      # committed objects
     git checkout -B <git_branch> <git_head_sha>       # session branch + commits
     git apply --3way <patch>                          # uncommitted edits
     restore untracked from manifest
   else: skip blobs (row is base-only; nothing uncommitted to replay)
```

Because the tree is reset to the **pinned** base before the patch is applied,
`apply --3way` is applying the session's own edits onto the session's own base —
a **no-op 3-way**, never a merge against moved upstream. That is what removes the
corruption class.

### 8.5.6 Explicit advance (the escape hatch) is transactional

A session may **choose** to move onto newer upstream (e.g. the user wants the
latest mirror, or a rebase). This is the *only* path that changes `git_base_sha`,
and it must be **all-or-nothing**:

```
1. fetch; identify new base N (e.g. current origin/HEAD)
2. merge/rebase session work onto N in the live tree
3. ── if conflicts ── surface to the agent/user; DO NOT persist anything.
      The session stays pinned to the old base; retry is safe & idempotent.
4. ── only after the merge is committed clean ──
      re-cut bundle (N..HEAD), re-diff uncommitted, bump epoch,
      UPDATE sessions SET git_base_sha = N, git_head_sha, git_state_epoch
      (all in one CMS write).
```

A half-advanced pointer is never persisted: either the session is fully on the
new base with matching blobs, or it is still fully on the old base. A merge
conflict during advance is a **recoverable, retryable** event, not corruption.

### 8.5.7 Base reachability & graceful degradation

The pinned base `B` must remain reachable in the pod's mirror:

- **Within a node's mirror lifetime** `--prune` drops *refs*, not *objects*, so
  `B` survives even after upstream moves.
- **A fresh mirror on a new node** re-fetches from origin and may lack `B` if it
  was orphaned upstream (force-push + upstream GC). Detect on hydrate
  (`git cat-file -e <B>` fails) and **degrade loudly**: re-seed the base to
  current `origin/HEAD`, emit a prominent warning trace, and treat it as an
  implicit advance (the session's committed work still replays from the bundle,
  which is self-contained).

### 8.5.8 Blob lifecycle & cleanup

The delta blobs are **lifecycle-driven, not TTL-driven** — a session paused for
weeks must hydrate perfectly, so blobs are **never** reaped on a timer.

⚠️ **Leak warning:** `blob-store.ts` `deleteAllEpochs()` is deliberately
**fail-closed** — it only removes names matching the epoch pattern (`.e*`) and
"leaves unparseable names alone." The git blobs (`${sessionId}.git.bundle`,
`.patch`, `.meta.json`) do **not** match that pattern, so they are **not** swept
by the existing epoch cleanup. They must be explicitly deleted in the session
`delete()` path (and any idle-session sweeper) or they leak indefinitely. Because
the keys are stable overwrite-in-place (no epoch fan-out), deletion is a fixed
three-key removal per session.

### 8.5.9 Non-default branch selection (`gitRef`)

By default a session pins its turn-0 base to the mirror's default branch tip
(`origin/HEAD`). A session may instead target **any branch, tag, or commit** of
the repo by supplying an optional **`gitRef`** at create time. This is the only
knob that changes *which commit* turn-0 pins — everything downstream (§8.5.2)
is unchanged: once pinned, the base never moves.

**End-to-end path.** `gitRef` rides the create request the same way `repo` does:

```
SubmitRequest(git_ref=…)                       # Python SDK
  → POST /sessions[/for-agent]  body.gitRef    # protocol.js declares it
  → runtime.js  validateGitRefParam(gitRef)     # trim, reject "..", GIT_REF_RE
  → NodeSdkTransport.createSession({…gitRef})   # forwarded, not dropped
  → client.ts  fullConfig.gitRef → durable input config.gitRef
  → git-repo-worker.js  beforeRunTurn: config.gitRef
  → resolveTargetRef(gitRef) → hydrateGitWorkspace({ targetRef })
  → turn-0 pin: rev-parse(targetRef) → git_base_sha
```

- **Validation** (`runtime.js validateGitRefParam`): trims, rejects `..`
  (path-traversal / ref-spec abuse), and enforces
  `GIT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/`. Unlike `repo`, `gitRef`
  is **free-form** (no allowlist) — any branch/tag/sha the mirror can resolve.
- **Ref normalization** (worker `normalizeRef`): `origin/*` and `refs/*` pass
  through as-is; a raw `[0-9a-f]{7,40}` SHA passes through; a **bare** name
  (`my-branch`) is qualified to `origin/my-branch` (the enlistment origin is the
  node-local git-cache mirror, so the branch must exist in the mirror).
- **Turn-0 only.** `gitRef` is consumed exactly once, at the base pin. Later
  turns reset to the stored `git_base_sha` and ignore `gitRef` entirely — a
  session cannot silently drift onto a moving branch tip. To move the base, use
  the explicit-advance escape hatch (§8.5.6).
- **Brand-new branch caveat.** The ref must be present in the node-local mirror
  at pin time. A branch created after the mirror's last refresh (per-repo
  refresh interval, §5) resolves only after the claim-time `fetch` picks it up —
  same failure mode as §12 "Ref not in the warm base."

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
   **The concrete base-pinning + dehydrate/hydrate realization of this is now
   specified in [§8.5](#85-git-state-durability--base-commit-pinning).**
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
10. **Efficient native Windows worker image build** (deferred — currently the
    fleet runs a **shared Linux image with PowerShell Core installed**, since
    pwsh runs natively on Linux and satisfies the "must run PowerShell" need).
    A native Windows container image is achievable but each build iteration is
    10–20 min (multi-GB servercore base pull, no official Node-on-servercore
    base, slow Windows layer file-churn) vs. ~3.5 min for the Linux image, so it
    was parked. The motivation (why we still want Windows) and the challenge
    findings are in
    [`../proposals/windows-worker-image-followup.md`](../proposals/windows-worker-image-followup.md).

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
