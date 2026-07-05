# Session Lifecycle Protocol: Checkpoint, Affinity, Hydrate/Dehydrate

Status: proposal (2026-07-04)
Companion: [postgres-blob-store.md](./postgres-blob-store.md) — the storage
backend. This document defines the *protocol* (when state moves, who owns it,
how staleness is detected); the store doc defines *where the bytes live*. The
protocol is backend-agnostic: it runs over Azure Blob or Postgres, though the
PG store implements its contract natively.

---

## 1. The moving parts

Four layers cooperate to run a durable session. Naming them precisely matters
because the protocol is exactly the choreography between them.

**Copilot SDK session (the expensive state).** A process-local directory
(`sessionStateDir/<sessionId>/`: `events.jsonl`, `session.db`, workspace
files) plus a live in-memory SDK session object, on exactly one worker at a
time. Rebuilding it from nothing loses conversation history; moving it means
tar + transfer + resume.

**Session snapshot store (`SessionStateStore`).** `dehydrate` (tar → persist →
**delete local dir**), `hydrate` (fetch → unpack, replacing local dir),
`checkpoint` (tar → persist, **local files kept**), `exists`, `delete`.
Implementations: Azure Blob, filesystem, and (proposed) Postgres.

**Duroxide sessions (lease-based worker affinity).**
`ctx.scheduleActivityOnSession(name, input, key)` routes every activity
carrying the same key to one worker. Mechanics, from the duroxide-pg provider:

- A `sessions` row (`session_id`, `worker_id`, `locked_until`,
  `last_activity_at`) is claimed atomically inside `fetch_work_item`; an
  unclaimed key is claimed by whichever worker fetches first.
- The owner renews a **30 s lock** by heartbeat (fixed; not exposed to Node).
  A crashed owner's sessions are reclaimable within ≤30 s.
- A healthy owner deliberately stops renewing after
  **`session_idle_timeout` = 300 s** of no activity on the key (exposed to
  Node as `sessionIdleTimeoutMs`). Unpin latency = idle timeout + up to one
  lock timeout, so ~5.5 min.
- **`max_sessions_per_runtime` = 10** (exposed) caps concurrently owned keys.
- `workerNodeId` is one identity shared by all concurrency slots of a
  runtime, so any slot on a pod serves that pod's sessions.
- **There is no session-level fencing.** Stale *completions* are blocked per
  work item (lock tokens) and per orchestration (`execution_id` dedup), but
  nothing at the duroxide layer stops a worker holding stale *local files*
  from serving a freshly scheduled activity if the key routes back to it.

**Durable session orchestration (`durableSessionOrchestration`, latest
1.0.56).** Owns the protocol. `state.affinityKey` is a GUID (initially the
sessionId). A session proxy (`createSessionProxy(ctx, sessionId, affinityKey,
config)`) schedules every session-scoped activity — `runTurn`, `hydrate`,
`dehydrate`, `checkpoint` — on that key. Holding affinity = keeping the GUID.
Breaking affinity = `state.affinityKey = yield ctx.newGuid()` + recreating the
proxy; the old key's duroxide row simply decays.

---

## 2. Current protocol (v1.0.56)

### 2.1 Turn execution

`runTurn` is scheduled on `affinityKey`. On the worker, `getOrCreate` resolves
session state in order: in-memory session → resume from local files → **else
fresh-session replay**. The last arm (`session-proxy.ts:860`) records a
`session.lossy_handoff` CMS event
(`recoveryMode: "fresh_session_replay"`), injects a system message telling
the LLM a worker restart lost its state, and starts from `turnIndex: 0`.

Note what is *absent* from that chain: the snapshot store. The worker never
loads from storage on its own — the only load in the whole protocol is the
orchestration-scheduled `hydrate` activity (§2.3), which runs *before*
`runTurn`, gated purely by the orchestration's `needsHydration` flag. So
"resume from local files" covers two cases indistinguishably: the session
never left this worker, or a hydrate activity just unpacked the tar here.
And when the flag and reality disagree — the orchestration believes
`needsHydration = false` but the worker holding the key has no files — the
one load path has already been skipped, and `runTurn` falls through to
fresh replay even when a perfectly good snapshot exists.

### 2.2 After the turn: the wait plan

The LLM ends a turn with `completed`, `wait(seconds)`, `cron`, `cron_at`, or
`input_required`. For known waits, `planWaitHandling` (wait-affinity.ts)
decides:

```
shouldDehydrate            = blobEnabled && seconds > dehydrateThreshold   // default 29 s
preserveAffinityOnHydrate  = shouldDehydrate && preserveWorkerAffinity     // LLM opt-in: wait_on_worker
resetAffinityOnDehydrate   = shouldDehydrate && !preserveAffinityOnHydrate
```

- **Wait ≤ 29 s:** stay live. Orchestration timer; files and SDK session stay
  on the worker; the duroxide lease survives (29 s < 5 min idle unpin).
- **Wait > 29 s:** `dehydrateForNextTurn(reason, resetAffinity)`
  (lifecycle.ts:147): skip if already dehydrated; otherwise the `dehydrate`
  activity runs **on the current GUID** (the owner has the files): destroy
  the in-memory session → tar → upload → delete the local dir. Then
  `needsHydration = true` and, unless the LLM asked `wait_on_worker`, the
  GUID is rotated immediately.
- **No wait (interactive lull):** publish `idle`, arm an **idle timer,
  default 60 s** (`idleTimeout`, state.ts:236). A user prompt inside the
  window cancels it (queue.ts:365). If it fires:
  `dehydrateForNextTurn("idle")` with rotation (turn.ts:1184). So every
  interactive session is fully dehydrated one minute after its last turn.

### 2.3 Resume

On the next event (user message, timer fire), `needsHydration` gates the turn
(turn.ts:278): the GUID is rotated **a second time** unless
`preserveAffinityOnHydrate`, the proxy is recreated, and a `hydrate` activity
is scheduled on the new key. Whichever worker duroxide picks downloads and
unpacks the tar; `runTurn` follows on the same key and resumes from the local
files. The resumed prompt is wrapped with a visible
`[SYSTEM: The session was dehydrated and has been rehydrated on a new
worker…]` context note — every dehydrate cycle spends prompt tokens telling
the model about plumbing.

### 2.4 Checkpoints (existing machinery, effectively off)

`maybeCheckpoint` (lifecycle.ts:190) uploads a snapshot without deleting
local files, gated on `checkpointInterval >= 0` — **default -1, so it never
runs** — and failures are swallowed (best-effort try/catch). The only other
checkpoint is a pre-destroy safety checkpoint inside the session manager's
dehydrate, which protects against `destroy()` wedging, not against crashes.

### 2.5 What actually holds affinity

The GUID is only as sticky as the duroxide lease behind it. A key with no
activity for ~5.5 min unpins, after which the *same GUID* is claimable by any
worker. The orchestration is never told. Two consequences:

- `wait_on_worker` preserves the GUID across a long wait, but for any wait
  beyond ~5.5 min the wake-up `runTurn` lands on an arbitrary worker — which
  has no local files. Preserved affinity on long waits is theater.
- `dehydrateForNextTurn` itself can land on a worker without files (owner
  died, lease expired). The dehydrate activity then returns a `lossyHandoff`
  result (lifecycle.ts:170): the orchestration sets `needsHydration = false`
  — *nothing was stored* — and the next turn silently fresh-replays. State
  is lost without any crash at turn time.

### 2.6 Cost profile (measured, waldemort fleet)

Every idle fire and every >29 s wait is a full tar round trip: ~250–320
dehydrate/hydrate pairs and 2.3–6.2 GB/day of blob ingress on a steady day;
~1.8–2.9k pairs and ~14 GB on a rollout day. On the turn-latency path, a real
23.6 MB watcher tar costs 763 ms to dehydrate and 112 ms + unpack to hydrate
(medians, in-pod). Details in the store doc.

### 2.7 Gaps

- **G1 — Durability gap.** State is durable only at dehydrate. A worker crash
  mid-turn, during a live wait, or inside the 60 s idle window loses
  everything since the previous dehydrate. Deploys amplify this.
- **G2 — Lossy recovery despite existing snapshots.** The missing-state path
  in `runTurn` fresh-replays instead of hydrating from the store, because the
  orchestration believes `needsHydration = false` and the activity layer
  never checks the store on its own.
- **G3 — Affinity theater past ~5.5 min.** Preserved GUIDs outlive their
  duroxide lease silently (§2.5).
- **G4 — No staleness detection.** `getOrCreate` trusts whatever local files
  it finds. If a preserved key unpins, another worker serves turns, and the
  original worker later reclaims the key, it resumes *stale* files — silent
  state regression. Rotation-by-default masks this today; long
  `wait_on_worker` waits open it.
- **G5 — Maximal churn.** Rotate-by-default + 29 s threshold + 60 s idle
  timer means the fleet pays a full tar cycle per watcher wake and per
  interactive lull, even when the same warm worker would have served the next
  turn. Plus a per-cycle LLM prompt tax (§2.3).
- **G6 — No ordering primitive.** Snapshot metadata carries a content sha but
  no version: nothing can tell "local files are behind the store" from
  "ahead of the store," and blob writes are last-writer-wins.
- **G7 — Shutdown is a crash with extra steps.** The container entrypoint's
  SIGTERM handler calls `worker.stop()`, not the existing
  `gracefulShutdown()`: the duroxide runtime gets
  `PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS` (default **5 s**) to finish, then
  every in-flight task is aborted, and held sessions are not dehydrated on
  the way down. The worker Deployment sets no `terminationGracePeriodSeconds`
  (k8s default 30 s) and no preStop hook. Any turn longer than 5 s dies
  mid-flight on every deploy — each one an instance of G1.

---

## 3. New protocol

Four principles, each fixing a class of gaps:

- **P1 — Durable at every turn boundary.** Checkpoint is part of turn commit,
  not an optional interval. (G1)
- **P2 — Warm by default.** Local files, the live SDK session, and the
  affinity GUID survive waits and idle windows up to a hold window; releasing
  is the exception. (G5, G3)
- **P3 — The store is the versioned source of truth; local state is a
  cache.** Workers self-validate against an expected version carried in
  activity inputs, and may drop their cache at any time without coordination.
  (G2, G4, G6)
- **P4 — Dehydrate = release.** It stops being the durability mechanism
  (checkpoint is) and becomes "free the worker."

### 3.1 Store contract (the protocol's half of the interface)

The store gains a **monotonic per-session version** and compare-and-swap
writes. (Implementation — PG schema, blob ETag fallback — belongs to the
store doc; the protocol only needs these semantics.)

```
checkpoint(sessionId, {expectedVersion, turnKey?, resultMeta?})
        → {version, contentHash}
    Persist the tar iff stored version == expectedVersion; new version =
    expectedVersion + 1. turnKey (execution id + turn index) and a bounded
    resultMeta are stored alongside the tar. On CAS mismatch the store
    returns the stored {version, turnKey} so a retrying writer can tell
    "my prior attempt already committed" (same turnKey — idempotent success)
    from "another execution advanced the session" (split-brain fence — loud
    failure).

hydrate(sessionId, {localVersion?}) → {status:"warm"}
                                    | {status:"hydrated", version}
                                    | {status:"empty"}
    If localVersion equals the stored version, transfer nothing ("warm").
    Otherwise fetch + unpack and report the version now on disk.

release-time verify (optional): if the local content sha equals the stored
    contentHash, a drain-time write is elided entirely.
```

The worker records the version in a marker file inside the session dir
(e.g. `.snapshot-version`), written on every successful checkpoint and
hydrate. That marker is the local half of every comparison below. The sha
survives only for integrity checks and drain-time no-op elision — **ordering
is the version's job** (G6).

### 3.2 Atomic turn commit (replaces the interval checkpoint)

A tempting design is a separate `checkpoint` activity scheduled after
`runTurn`. It has a fatal window: the turn's completion is durable in
duroxide history (and its output already delivered to the user) while the
post-turn state exists only on one worker's disk. A crash there strands v_N
forever — the checkpoint retry lands on a worker with no files and cannot
manufacture it (§3.7, W2). So the commit is folded into the tail of the
`runTurn` activity itself:

```
runTurn activity:
  1. execute the LLM turn            (side effects happen here)
  2. tar + compress the session dir
  3. store.checkpoint(sessionId, {expectedVersion, turnKey, resultMeta})
  4. update local version marker, clear the turn sentinel (§3.3)
  5. return {result, version}        ← ONE durable activity completion
```

From the orchestration's perspective, turn completion and state durability
are the same event: `state.snapshotVersion = version` is recorded from the
same completion that carries the turn result. No observable state exists in
which the turn "happened" but its snapshot doesn't.

The `turnKey` (execution id + turn index, deterministic) makes the commit
idempotent across activity retries: if the worker dies *after* the CAS lands
but *before* duroxide records the activity completion, the retry finds the
store at expectedVersion + 1 bearing its own turnKey and returns the stored
`resultMeta` without re-executing the turn. A mismatch with a foreign
turnKey remains the split-brain fence.

Cost: measured 140 ms on a 23.6 MB session dir with the PG store (whole-file
brotli-4), added to the tail of each turn — versus a 763 ms dehydrate +
112 ms hydrate per wake today. Coupling: a store outage now fails turns
loudly (with the turn's own retry policy) instead of accumulating silently
undurable state; today's dehydrate path already had this coupling.

### 3.3 runTurn self-validation (lossy → lossless)

`runTurn`'s input gains `expectedSnapshotVersion`, sourced deterministically
from orchestration state. The activity also maintains a **turn sentinel** — a
file (e.g. `.turn-in-progress`) written at turn start and removed only by
step 4 of the commit — marking the local dir as mid-mutation. On activity
start:

1. **Sentinel present** → a prior attempt died mid-turn *on this worker*.
   The local dir is dirty (half a turn applied) even though its marker still
   reads the pre-turn version — a naive marker check would warm-start on
   corrupt state. Treat local as untrusted → hydrate clean.
2. **Marker == expected, no sentinel** → warm start. Zero store I/O — the
   common case costs nothing new.
3. **Marker missing or ≠ expected** (lease migrated, pod restarted, stale
   files) → `hydrate(sessionId, {localVersion})`: fetch exactly the expected
   state, overwrite local. Lossless. If the store reports
   expectedVersion + 1 under this turn's own turnKey, the previous attempt
   already committed — return its stored result (§3.2), don't re-run.
4. **Store empty** → today's fresh-session replay, now confined to sessions
   that have never committed a turn.

This one check closes G2 and G4 simultaneously: a stale worker can only
hydrate *forward*, never resume backward, and its stray late checkpoint (from
an obsolete execution) fails CAS at the store. Duroxide's own sessions spec
prescribes exactly this shape — the activity detects missing process-local
state and the application rehydrates — which v1.0.56 approximates with the
lossy path; this makes it the real thing.

### 3.4 Wait policy: three tiers

`planWaitHandling` keeps its shape; the middle tier changes meaning.

| Tier | Window | Action |
|---|---|---|
| 1 — live | ≤ `dehydrateThreshold` (29 s) | Unchanged: orchestration timer, everything stays hot. |
| 2 — **checkpoint-hold** | 29 s → `holdWindow` (default 30 min) | **No dehydrate.** State is already durable from turn commit. Local files, SDK session, and GUID all kept; `needsHydration = false`. On wake, `runTurn` fires directly on the same GUID → same worker, warm start. Self-validation (§3.3) covers the case where the lease was lost anyway. |
| 3 — release | > `holdWindow`, drain, eviction | Destroy in-memory session, delete local dir, rotate GUID. **No upload** — the store already holds the committed state (optionally verify sha, then delete). Next event hydrates wherever duroxide places it. |

The **idle timer becomes the hold window**: its duration changes from 60 s to
`holdWindow`, and it fires a *release*, not a dehydrate-upload. The existing
cancel-on-activity machinery (queue.ts:365) already implements the "any
session activity resets the idle clock" rule — each turn re-arms the timer.

`wait_on_worker` becomes redundant below `holdWindow` (holding is the
default) and remains ineffective above it by design (tier 3 rotates). It is
kept as an accepted no-op for prompt compatibility and can be retired from
the tool surface later.

The rehydration prompt wrapper (§2.3) now only appears when a session
genuinely moved — a real signal instead of routine noise.

### 3.5 Duroxide alignment

The protocol holds affinity at the app layer; the duroxide lease must outlive
it or the hold is fiction (G3):

- **`sessionIdleTimeoutMs`: 300 000 → `holdWindow` + margin** (35 min for a
  30 min hold). Cheap: idle renewal is one batched heartbeat UPDATE per
  runtime, and crash reclaim is governed by the *lock* timeout, which does
  not change.
- **`maxSessionsPerRuntime`: 10 → sized to worker memory/disk.** A warm hold
  costs the session dir on disk plus the SDK session in memory; ~50 is a
  reasonable starting point for current pods, with telemetry to tune.
- **Lock timeout stays 30 s** (not tunable from Node, and shouldn't change):
  long affinity for healthy workers, ≤30 s failover for dead ones.
- **`workerNodeId` unchanged** (already one identity per pod). A restarted
  pod that reclaims its old keys holds no files — self-validation hydrates.

### 3.6 The protocol in action

**Warm interactive turn (common case).** User message → `runTurn(expected v9)`
on GUID *g* → no sentinel, marker reads 9 → warm start → turn runs and
commits CAS 9→10 in its tail → idle-hold re-armed. Store I/O: one compressed
write (~0.5 MB measured).

**Watcher cron cycle (10 min wait, tier 2).** Turn commits v→v+1 → hold
with a 600 s timer → fire → `runTurn(v+1)` on the same GUID, same worker,
warm. Per cycle: one write, zero reads, zero tar/untar, zero prompt tax.
Today the same cycle is: dehydrate (upload + local delete) → GUID rotation →
hydrate (download + unpack) → resume-context prompt wrapper.

**Worker crash mid-hold.** Heartbeats stop → duroxide reclaims the key in
≤30 s → next event routes `runTurn(v10)` to worker B → marker missing →
hydrate v10 → lossless resume. Nothing is lost: every completed turn was
committed. Crashes *mid-turn* and *post-CAS* are walked through in §3.7
(W1/W2).

**Deploy.** SIGTERM triggers the drain sequence (§3.8): in-flight turns
finish and commit, warm sessions are released without uploads, leases lapse.
New pods hydrate on demand at the exact committed version. No dehydrate
storm on the way down (state was already durable — today's rollout days move
~14 GB), and no lossy replays (G1, G7 closed). Correctness never depends on
the drain: a pod killed outright is just the crash case above.

**Stale worker (the regression case).** Worker A held files at v5; its lease
lapsed; worker B served turns to v9; the GUID later routes back to A.
`runTurn(expected 9)` → marker 5 → hydrate 9 → overwrite. If A had a stray
checkpoint queued from the old execution, its CAS on `expectedVersion 5`
fails against the stored 9. Both directions of G4 are closed.

**Long idle.** The hold-window timer fires → release (verify sha, delete
local, rotate GUID) → session costs nothing anywhere until the next event,
which hydrates on any worker.

**Worker under pressure (eviction).** Because local state is a cache (P3), a
worker may destroy + delete any held session *without telling the
orchestration*: the next `runTurn` self-validates and hydrates. LRU eviction
becomes a purely local decision — no protocol message exists for it because
none is needed.

### 3.7 Data-loss and duplication windows, honestly

The new protocol does not make loss impossible; it makes the windows
enumerable. Calling each one out:

**W1 — Mid-turn crash: side effects are at-least-once.** A turn is not a
transaction. By the time a worker dies mid-turn, the LLM may already have
acted — tool calls executed, CMS events recorded, messages sent, commits
pushed — but nothing advanced the version: the commit (§3.2) never ran, so
neither the local marker nor the store moved past v_N−1. The retry
re-executes the turn from its durable input on top of clean v_N−1 state.
*Session state* rewinds precisely; *the world* does not. Recovery differs by
where the retry lands:

- **Different worker:** no local files → hydrate v_N−1 → clean re-execution.
  The only artifact of the first attempt is its external side effects,
  possibly now duplicated.
- **Same worker** (process survived and duroxide retries locally, or the pod
  restarted with disk intact under the same `workerNodeId`): the local dir
  is **dirty** — mutated by the half-executed turn — while the marker still
  reads v_N−1. Without protection this warm-starts on half-applied state,
  which is worse than either losing or duplicating the turn. The turn
  sentinel (§3.3 rule 1) makes this case detect as untrusted and hydrate
  clean v_N−1, converging with the different-worker path.

Duplicated external side effects are inherent to at-least-once activity
retry — unchanged from today. Tools with hard external effects need their
own idempotency; that is out of scope for this protocol.

**W2 — Between turn end and state commit.** The reason §3.2 is atomic. In a
two-activity design (runTurn, then checkpoint) there is a window where the
turn's completion is durable — the user has seen its output — but v_N lives
only on the dead worker's disk; a checkpoint retry elsewhere finds no files
and cannot manufacture it. The session would permanently forget a turn whose
output was delivered: user-visible amnesia, the worst loss mode. Folding the
CAS into the `runTurn` activity removes the window structurally — no durable
"turn completed" record can exist without its snapshot. The residual case, a
crash between the CAS landing and duroxide recording the activity
completion, is duplication-shaped, not loss-shaped, and the turnKey check
(§3.3 rule 3) resolves it by returning the already-committed result instead
of re-running.

**W3 — Sessions that never committed.** A crash during the very first turn
finds the store empty and falls back to fresh-session replay — W1 with
nothing to hydrate. Today's lossy path survives only here, confined to
turn #1.

**W4 — Store unavailable at commit time.** The commit retries with the turn;
a prolonged store outage fails turns loudly rather than accumulating
silently undurable state. Deliberate trade: the store joins the CMS on the
critical path.

Gone entirely, relative to §2.7: loss of committed turns on crash (G1),
fresh replays despite existing snapshots (G2), and silent stale resumes
(G4).

### 3.8 Graceful drain

Today's shutdown is gap G7: `stop()` gives in-flight turns 5 s, then aborts
them, and never releases sessions. The replacement sequence, on SIGTERM from
the platform (AKS pod termination, scale-down, node maintenance):

```
1. Stop fetching     runtime.shutdown(drainBudgetMs) sets duroxide's
                     shutdown flag; dispatch slots finish their current
                     item and claim nothing new.
2. Finish in-flight  Running turns run to completion; their atomic
                     commits land as part of the activity (§3.2).
3. Release           For each warm session: verify sha (elide the no-op
                     write — every completed turn is already committed, so
                     this is deletes only), destroy in-memory, delete
                     local dir.
4. Exit              Anything still leased lapses within ≤30 s.
```

Wiring: the container entrypoint's SIGTERM handler switches from `stop()` to
`gracefulShutdown()`, whose dehydrate-everything body becomes
release-everything under P4; `PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS` becomes
the drain budget, sized to the longest turn worth waiting for (suggest
600 s); `terminationGracePeriodSeconds` on the worker Deployment must exceed
it (k8s default is 30 s — today the platform kills the pod long before a
long turn could finish even if the app waited).

If the budget expires, duroxide aborts the stragglers — crash semantics,
which under this protocol are lossless for every committed turn; the aborted
turn itself is W1. **Graceful drain is therefore a latency and
side-effect-duplication optimization, not a correctness requirement** — the
safety story never depends on the platform honoring its grace period.

Upstream nicety (duroxide): `runtime.shutdown()` sleeps the full timeout
before aborting leftovers instead of returning as soon as in-flight work
completes; early-exit would shave minutes off rollouts but changes nothing
semantically.

### 3.9 Delta summary

| Event | Today (1.0.56) | New |
|---|---|---|
| Turn completes | Nothing durable (`checkpointInterval = -1`) | Atomic in-activity commit — one CAS write |
| Wait ≤ 29 s | Live | Live (unchanged) |
| Wait 29 s – 30 min | Dehydrate + rotate; hydrate on fire | Hold: zero store I/O |
| Interactive lull | Dehydrate 60 s after last turn | Hold up to 30 min, then release (no upload) |
| Worker crash | Lossy fresh replay | Hydrate last turn commit — lossless (W1: side effects at-least-once) |
| In-flight turn at deploy | Aborted after 5 s → lossy | Runs to completion within drain budget |
| Deploy | Mass dehydrate/hydrate churn + lossy handoffs | Drain: commit + release; stragglers ≤30 s reclaim |
| `wait_on_worker` > 5 min | Silent affinity loss (G3) | Real hold ≤ 30 min via raised idle timeout |
| Stale local files | Silently resumed (G4) | Version mismatch → hydrate forward |
| Dirty files after mid-turn crash | Silently resumed | Turn sentinel → hydrate clean |

I/O envelope for the waldemort watcher fleet: today ~3.7 GB/day of ingress
from three active watchers; under the new protocol, one compressed write per
turn (~0.5 MB × ~300 turns/day ≈ **150 MB/day**) and near-zero reads. The PG
store's phase-1 numbers assume exactly this write pattern.

### 3.10 Configuration

| Knob | Layer | Today | New |
|---|---|---|---|
| `dehydrateThreshold` | orchestration input | 29 s | Kept as the tier-1/tier-2 boundary (wait mechanics only; no storage meaning) |
| `idleTimeout` | orchestration input | 60 s | Becomes `holdWindow`; default 1800 s; reset on any session activity |
| `checkpointInterval` | orchestration input | -1 (off) | Retired — the commit lives inside `runTurn` |
| `sessionIdleTimeoutMs` | duroxide runtime | 300 000 | `holdWindow` + margin (e.g. 2 100 000) |
| `maxSessionsPerRuntime` | duroxide runtime | 10 | Sized to memory (~50, telemetry-tuned) |
| session lock timeout | duroxide (fixed) | 30 s | Unchanged — the crash-reclaim bound |
| `PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS` | worker env | 5 000 | Drain budget (e.g. 600 000) |
| `terminationGracePeriodSeconds` | k8s worker Deployment | unset (30 s) | Drain budget + margin |
| SIGTERM handler | container entrypoint | `stop()` — aborts in-flight | `gracefulShutdown()` — drain (§3.8) |

### 3.11 Rollout

1. **Store first.** Version/CAS contract ships in the store layer
   (blob: metadata + ETag CAS; PG: native). Legacy version-less writes
   (from 1.0.56 executions' dehydrates) are accepted as unconditional
   writes that bump the version — old and new writers coexist.
2. **Workers next.** Activity-side self-validation, sentinel/marker
   handling, and the drain entrypoint switch (§3.8) are
   orchestration-version-agnostic; a worker that receives no
   `expectedSnapshotVersion` behaves exactly as today.
3. **Orchestration last**, as **1.0.57** in the versioned registry. Running
   executions keep 1.0.56 semantics until they complete; new sessions get
   the new protocol. No migration step, no coordination window.

### 3.12 Open questions

- **Whale commits.** A 150 MB session dir makes the per-turn commit
  expensive; answers are tar excludes (audit what bloats those workspaces)
  and the store's phase-2 CDC chunking, which turns each commit into a
  delta. The protocol is unchanged either way.
- **`resultMeta` size.** Turn results can be large (long assistant replies);
  the store's meta column needs a cap, with the retry path falling back to a
  synthetic "turn was committed by a prior attempt" result when truncated —
  or results stay out of the store entirely and the retry path re-delivers
  only status, not content. Needs a decision at implementation time.
- **Drain budget vs. very long turns.** Turns can exceed any reasonable
  grace period. Draining doesn't need to wait for all of them (an aborted
  turn is W1 — safe, just duplicated side effects on retry); the budget
  choice is purely how much side-effect duplication vs. deploy speed to
  trade.
- **Hold-window sizing.** 30 min is a guess balancing worker memory against
  hydrate frequency; `session.hydrated` event rates before/after will show
  whether it should be per-agent (watchers vs interactive) rather than
  global.
