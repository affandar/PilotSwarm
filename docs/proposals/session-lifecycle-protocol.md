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
Crucially, **it never consults the snapshot store** — even when a perfectly
good snapshot exists, the missing-local-state path rebuilds from nothing.

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
checkpoint(sessionId, {expectedVersion}) → {version, contentHash}
    Persist the tar iff stored version == expectedVersion; new version =
    expectedVersion + 1. CAS mismatch is a loud failure — it means another
    writer advanced the session (split-brain fence).

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

### 3.2 Turn commit (replaces the interval checkpoint)

```
runTurn completes
  → orchestration yields session.checkpoint({expectedVersion: state.snapshotVersion})
      (scheduled on the current GUID — the owner tars its own files)
  → activity: tar, compress, CAS write, update local marker
  → returns {version}
  → orchestration records state.snapshotVersion = version   (deterministic, replayed)
```

Not best-effort: a checkpoint failure surfaces with the same retry policy as
a `runTurn` failure, because after this change it *is* the durability of the
turn. A CAS failure specifically means some other execution wrote the session
— the orchestration re-validates through the hydrate path rather than
overwriting.

Cost: measured 140 ms on a 23.6 MB session dir with the PG store (whole-file
brotli-4), and the tar is built without destroying the live session. That is
the per-turn tax, paid once per turn instead of a 763 ms dehydrate + 112 ms
hydrate per wake.

### 3.3 runTurn self-validation (lossy → lossless)

`runTurn`'s input gains `expectedSnapshotVersion`, sourced deterministically
from orchestration state. On activity start:

1. **Marker == expected** → warm start. Zero store I/O — the common case
   costs nothing new.
2. **Marker missing or ≠ expected** (lease migrated, pod restarted, stale
   files) → `hydrate(sessionId, {localVersion})`: fetch exactly the expected
   state, overwrite local. Lossless.
3. **Store empty** → today's fresh-session replay, now confined to sessions
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
on GUID *g* → marker reads 9 → warm start → turn runs → checkpoint CAS 9→10 →
idle-hold re-armed. Store I/O: one compressed write (~0.5 MB measured).

**Watcher cron cycle (10 min wait, tier 2).** Turn → checkpoint v→v+1 → hold
with a 600 s timer → fire → `runTurn(v+1)` on the same GUID, same worker,
warm. Per cycle: one write, zero reads, zero tar/untar, zero prompt tax.
Today the same cycle is: dehydrate (upload + local delete) → GUID rotation →
hydrate (download + unpack) → resume-context prompt wrapper.

**Worker crash mid-hold.** Heartbeats stop → duroxide reclaims the key in
≤30 s → next event routes `runTurn(v10)` to worker B → marker missing →
hydrate v10 → lossless resume. Nothing is lost: the last committed turn was
checkpointed. A crash *mid-turn* retries `runTurn` under duroxide's activity
retry; the new worker hydrates v10 (post-turn-9 state) and re-executes the
turn from its durable input.

**Deploy.** Terminating pods stop heartbeating; every held session is
claimable in ≤30 s; new pods hydrate on demand at the exact committed
version. No dehydrate storm on the way down (state was already durable —
today's rollout days move ~14 GB), and no lossy replays (G1 closed).
A graceful preStop can optionally issue tier-3 releases to smooth the
transition, but correctness does not depend on it.

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

### 3.7 Delta summary

| Event | Today (1.0.56) | New |
|---|---|---|
| Turn completes | Nothing durable (`checkpointInterval = -1`) | CAS checkpoint — one write |
| Wait ≤ 29 s | Live | Live (unchanged) |
| Wait 29 s – 30 min | Dehydrate + rotate; hydrate on fire | Hold: zero store I/O |
| Interactive lull | Dehydrate 60 s after last turn | Hold up to 30 min, then release (no upload) |
| Worker crash | Lossy fresh replay | Hydrate last turn commit — lossless |
| Deploy | Mass dehydrate/hydrate churn + some lossy handoffs | ≤30 s reclaim + hydrate on demand |
| `wait_on_worker` > 5 min | Silent affinity loss (G3) | Real hold ≤ 30 min via raised idle timeout |
| Stale local files | Silently resumed (G4) | Version mismatch → hydrate forward |

I/O envelope for the waldemort watcher fleet: today ~3.7 GB/day of ingress
from three active watchers; under the new protocol, one compressed write per
turn (~0.5 MB × ~300 turns/day ≈ **150 MB/day**) and near-zero reads. The PG
store's phase-1 numbers assume exactly this write pattern.

### 3.8 Configuration

| Knob | Layer | Today | New |
|---|---|---|---|
| `dehydrateThreshold` | orchestration input | 29 s | Kept as the tier-1/tier-2 boundary (wait mechanics only; no storage meaning) |
| `idleTimeout` | orchestration input | 60 s | Becomes `holdWindow`; default 1800 s; reset on any session activity |
| `checkpointInterval` | orchestration input | -1 (off) | Retired — checkpoint is the turn commit |
| `sessionIdleTimeoutMs` | duroxide runtime | 300 000 | `holdWindow` + margin (e.g. 2 100 000) |
| `maxSessionsPerRuntime` | duroxide runtime | 10 | Sized to memory (~50, telemetry-tuned) |
| session lock timeout | duroxide (fixed) | 30 s | Unchanged — the crash-reclaim bound |

### 3.9 Rollout

1. **Store first.** Version/CAS contract ships in the store layer
   (blob: metadata + ETag CAS; PG: native). Legacy version-less writes
   (from 1.0.56 executions' dehydrates) are accepted as unconditional
   writes that bump the version — old and new writers coexist.
2. **Workers next.** Activity-side self-validation and marker handling are
   orchestration-version-agnostic; a worker that receives no
   `expectedSnapshotVersion` behaves exactly as today.
3. **Orchestration last**, as **1.0.57** in the versioned registry. Running
   executions keep 1.0.56 semantics until they complete; new sessions get
   the new protocol. No migration step, no coordination window.

### 3.10 Open questions

- **Whale checkpoints.** A 150 MB session dir makes the per-turn checkpoint
  expensive; answers are tar excludes (audit what bloats those workspaces)
  and the store's phase-2 CDC chunking, which turns each checkpoint into a
  delta. The protocol is unchanged either way.
- **Checkpoint/next-turn overlap.** The session manager already serializes
  per-session operations (`_withSessionLock`); a queued user message arriving
  during checkpoint waits ≤ the checkpoint duration (~140 ms measured).
  If that ever matters, the checkpoint tar can be snapshotted synchronously
  and uploaded async — at the cost of a small durability window; not
  proposed initially.
- **Hold-window sizing.** 30 min is a guess balancing worker memory against
  hydrate frequency; `session.hydrated` event rates before/after will show
  whether it should be per-agent (watchers vs interactive) rather than
  global.
