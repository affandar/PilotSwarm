# Snapshot Consistency: Store-Wins — retiring the version fence

Status: **proposed.** Context: one production incident (a session permanently
bricked after a user stop) and one shipped mitigation (the `"stopped"`-commit
skip) that narrows the window but cannot close it. This doc analyzes why the
current protocol produces the failure class, and proposes replacing it.
Self-contained for engineers/LLM agents.

---

## 0. TL;DR

Turns commit versioned snapshots of the session dir to a store (Azure Blob in
prod, filesystem in tests). Today the orchestration carries an
`expectedVersion` in duroxide history and every commit is CAS-fenced against
it. When a user **stops** a long turn, the abandoned activity can still commit —
store at `N+1`, orchestration convinced of `N`, every later turn failing the
fence, **session bricked until operator surgery**. That happened in production.

The proposal is not more fencing — it is deleting the belief that can be wrong:

> **The snapshot is a cache of the model's memory, not a ledger.** The systems
> of record (CMS events, facts, artifacts) never pass through this path. A
> cache needs two parties (local dir ↔ store), not three. And between those
> two, **the store wins**: local files are valid only while they match the
> store's `(version, content hash)`; a worker that falls behind — or loses a
> publish race — goes quietly stale and rehydrates on its next turn.

The whole protocol:

1. **Warm fast path** — local marker matches the store's
   `(version, content hash)` → keep the warm session. Anything else (mismatch,
   dirty sentinel, no local) → hydrate from store.
2. **Turn idempotency** — a re-dispatched turn (drain / lock-steal / crash
   retry) that finds its own `turnKey` in the store adopts the stored result
   and never re-runs the body. This fires on every deploy; without it, drains
   double-run turns.
3. **One-shot conditional publish** — commit writes `base+1` conditioned on the
   **ETag captured by the preamble's probe** (the same read that established
   `base`). One HEAD per turn, one conditional PUT. Any commit landing anywhere
   between my preamble and my PUT fails the `If-Match`: 412 → don't publish,
   sentinel stays dirty, next turn rehydrates whatever won. The condition
   exists only to keep version numbers unique, so "same version" always means
   "same content" among conforming writers (§5.1).

**Control flow stays quiet; telemetry gets loud.** Every non-publish and every
anomaly emits a CMS event — `session.snapshot_unpublished { reason }`,
`session.snapshot_regressed`, `session.snapshot_lineage_jump` — all
fire-and-forget and never load-bearing: an event that fails to write never
fails a turn, and no event can refuse a hydration.

Removed from the shipped system: `expectedVersion` as a turn input, the
CAS-as-fence and its `SnapshotConflictError` retry loops, the zombie-duplicate
fence, and the store-behind/store-ahead case analysis. Worst case moves from
*bricked session* to *the model forgets one turn (and an event says so)* — and
every currently-bricked session **self-heals on its next turn**.

Ships as **one release, two layers**: activity/store changes take effect for
all in-flight sessions immediately (inputs unchanged ⇒ no replay hazard), and a
new orchestration version in the same deploy drops the dead field as sessions
continue-as-new onto it.

---

## 1. The system today

Model: one deterministic duroxide orchestration per session drives turns; each
turn is a `runTurn` activity on a worker holding a warm Copilot CLI session;
the session-state dir is tarred and committed to the snapshot store after each
turn.

Local protocol files: `.ps-snapshot-version` (**marker**: "these files
represent store version N") and `.ps-turn-inprogress` (**sentinel**: "dir
mid-mutation"; cleared only by a successful publish or a hydrate; excluded from
tars, so a hydrated dir is always clean).

### 1.1 Version-bearing entities

| # | Where | What |
|---|---|---|
| 1 | `state.snapshotVersion` (duroxide history) | what the control plane believes is committed; passed to each turn as `expectedVersion` |
| 2 | Store committed version | the authority. FS store: `meta.json` rename is the commit point (`session-store.ts:448`), serialized by a `cas.lock` mkdir lock. Blob store: `psver`/`psturnkey`/`pssha` in the snapshot blob's metadata, written atomically with content by single-shot Put Blob under ETag conditions (`blob-store.ts:465`) |
| 3 | marker on worker disk | cache pointer, reconciled by the preamble |

### 1.2 Current algorithm

Orchestration (`processPrompt`, `orchestration/turn.ts`):

```
turnKey = ctx.newGuid()
turnTask = runTurn(prompt, iteration, { snapshot: { expectedVersion, turnKey }, … })
stopTask = ctx.dequeueEvent(stopTurnQueue[iteration])
race     = ctx.race(turnTask, stopTask)

if race == STOP:                               # handleTurnStopped (turn.ts:485)
    yield abortTurn(reason, stoppedIteration)  #   best-effort; failure caught+ignored
    record turn_stopped; CMS -> idle
    iteration++                                #   snapshotVersion NOT touched
    return

if activity threw:  retry same iteration, SAME turnKey

# clean completion — the only adoption site:
if typeof result.snapshotVersion == "number":
    state.snapshotVersion = result.snapshotVersion
iteration++; handleTurnResult(result); continueAsNew(…)
```

Activity (`runTurn` → `session-lifecycle.ts`):

```
pre = runTurnPreamble(expectedVersion, turnKey):
    store.turnKey == mine (committed)          → recoverAlreadyCommitted (skip body+commit)
    store.version > expected, foreign turnKey  → throw SnapshotConflictError  # the fence
    store.version < expected                   → proceed from store (storeBehindExpected)
    else                                       → base = warm | hydrated | fresh

writeTurnSentinel(turnKey)
body = executeTurnBody()                       # LLM + tools

committed = runTurnCommit(baseVersion, body):
    if body.type == "stopped": skip CAS, leave sentinel, return base   # SHIPPED MITIGATION
    CAS: store == base            → write base+1
         store == base+1, my key → alreadyCommitted (adopt winner)
         else                     → throw SnapshotConflictError

return { ...body, snapshotVersion: committed.version }
```

## 2. The incident

Production AKS deployment, long-running watcher session:

- `session.turn_stopped {turnIndex: 377}` at time T.
- ~1 min later, looping forever across executions: `Snapshot CAS conflict:
  expected 169, found 170`.
- `session.affinity_released {snapshotVersion: 169}` while the store held 170.

Root cause: the user's stop won the orchestration's `ctx.race`, so the
orchestration discarded the turn and moved on (`iteration++`, expected stays
169) — but duroxide race losers keep running by design, and the abandoned
`runTurn` activity finished its body and committed → store 170. Every
subsequent turn presented `expectedVersion 169` against a store at 170 under a
foreign turnKey → fence → activity error → retry with the same stale 169 →
permanent loop. No self-healing path exists.

## 3. Why the current model cannot be patched

### 3.1 The shipped mitigation and its remaining windows

The shipped skip refuses the commit when the body result classifies as
`"stopped"`. Correct for the common case (regression-tested), but the
classification is decided by *which signal reaches the activity first*, and
three windows remain:

- **The cancelled loser.** Stop's fast path misses (affinity lost / no warm
  session / turn-index mismatch); the duroxide backstop cancels the activity;
  the body unwinds as `{type:"cancelled"}` — and the commit runs. Same brick.
- **The completed loser.** The body settles a moment before the stop wins the
  race; result `{type:"completed"}` — commit runs. This is "user stops just as
  the turn finishes," common in practice.
- **The late landing.** The abandoned turn's commit doesn't have to land before
  the next turn starts. Next turn's preamble sees a clean store at `N`,
  proceeds; the zombie commits `N+1` mid-body; the next turn's own commit then
  conflicts, errors, retries — and the retry's preamble hits the fence. The
  session burned a full turn (side effects included) *and* bricked.

And the skip cannot be widened: worker **drain** and **lock-steal** also
classify as `"cancelled"`, and those commits are *required* — their re-dispatch
reuses the same turnKey and depends on `alreadyCommitted` idempotency to avoid
double-running the body. The activity cannot distinguish stop-cancelled from
drain-cancelled from where it stands. **Classification is a proxy for
abandonment, and the proxy lies.**

### 3.2 The three jobs of the version check

The per-turn check bundles three different jobs; only one earns its keep:

| Job | Mechanism | Fires on | Verdict |
|---|---|---|---|
| 1. Turn idempotency — "did *this turn* already commit?" | `turnKey` match | every deploy-time drain, every crash retry | **Keep.** Routine, cheap, prevents double-running bodies. |
| 2. Control-plane agreement — "does the store match what the orchestration believes?" | `expectedVersion` in duroxide history + CAS | user stops a long turn | **Delete.** The belief lives in immutable history; one missed update = permanent divergence. This is the job that bricks sessions. |
| 3. Fork detection — "did a foreign writer touch the store?" | CAS conflict → loud fence | split-brain, restored stores | **Delete as an error, keep as a signal.** The store is simply authoritative; a worker that disagrees rehydrates — and an event records that it happened. |

Job 2 is the root problem: it adds a *third party* to the reconcile, and that
party's belief is stored somewhere that cannot be edited. Every failure above
is a way for that belief to go stale. Patching it requires making abandonment
explicit in the store (Appendix B, alternative 4) — workable, but heavyweight
for a system whose snapshot is not the system of record. Delete the invariant
instead, and the failure class is unrepresentable.

## 4. Principles

1. **The snapshot is a cache, not a ledger.** CMS events, facts, and artifacts
   are the durable record and never pass through this path.
2. **Two parties, not three.** Reconcile local dir ↔ store only. The
   orchestration holds no version belief; nothing it thinks can wedge the data
   plane.
3. **The store wins.** Local state is valid only while it matches the store's
   `(version, content hash)`. Behind, ahead, torn, race-lost, or
   content-swapped — all the same answer: rehydrate. One recovery lane for
   every anomaly.
4. **Publish once, fail non-fatally, record loudly.** A commit is a single
   write conditioned on the ETag captured when the preamble established `base`
   — so "nobody committed since the state my body ran on" and "this write is
   atomic" are the *same* check, minted at the same instant. If it fails,
   someone newer owns the store: don't fight, don't error — stay stale, let
   the next turn rehydrate, and **emit a loss event** so the discard is
   operator-visible.
5. **A committed turn is never re-run.** turnKey idempotency survives — the one
   check that prevents routine double execution.
6. **Stop is best-effort.** Keep the cheap `"stopped"`-skip; an abandoned turn
   that publishes first simply becomes history, and one that publishes second
   loses the race and evaporates. (Any correct design ends here: work that
   durably committed cannot be un-happened, only superseded.)
7. **Checks strengthen, never gate.** Content-identity validation and anomaly
   events may only ever cause a rehydrate or a log — never refuse an adoption,
   never fail a turn. Anything that can refuse a write or block a hydration is
   a fence, and fences are what this design removes.

## 5. The design

### 5.1 Why the publish is conditional, and why the warm check validates content

**The condition (conforming writers).** The reconcile's only primitive is
comparing the marker to the store, and its warm fast path ("match → trust
local") is sound only if *equal identity ⇒ identical content*. Unconditional
writes break that: two racers based on `v` can both publish "v+1" with
different content; whichever PUT lands last silently owns the number, and a
worker whose marker says `v+1` will warm-continue on content that no longer
matches the store — an **invisible fork** that no later check can see, because
every comparison reports "in sync." The ETag condition's one job is making
version numbers unique names for states. It prevents blindness, not loss.

**The content hash (rule-breaking writers).** The ETag governs writers that go
through the conditional-publish path. It does nothing about a writer that
doesn't: an operator restoring a backup *over the same version number* (live
blob at 12 is corrupted; restore a clean 12), a manual PUT, an older tool.
After such a write, a version-only warm check passes (`12 == 12`) and the
worker keeps its own, different 12 — then republishes over the repair. So the
warm check validates `(version, content hash)`: the marker records the sha of
the content it last published or hydrated, and the preamble compares it to the
store's `pssha` from the same probe. **Two cached string compares — no hashing
at preamble time, no extra round trip** (publish already computes the sha,
`blob-store.ts:543`; the probe already returns it). This is textbook cache
validation, and per principle 7 it can only ever cause a hydrate — for
*adoption* there is nothing to validate: the store is authoritative and
hydration is unconditional.

### 5.2 Orchestration (per turn) — unchanged code, one dead field

```
turnKey  = ctx.newGuid()
turnTask = runTurn(prompt, iteration, { snapshot: { expectedVersion, turnKey }, … })
             # frozen orchestration versions still send expectedVersion; the
             # worker ignores it. The new version (same release) drops the field.
stopTask = ctx.dequeueEvent(stopTurnQueue[iteration])
race     = ctx.race(turnTask, stopTask)

if race == STOP:
    yield abortTurn(reason, stoppedIteration)   # best-effort body abort, as today.
                                                # No store writes. Whatever the
                                                # abandoned turn does, store-wins
                                                # absorbs it (§6).
    record turn_stopped; CMS -> idle; iteration++
    return

if activity threw: retry same iteration, same turnKey
                                                # a retry can no longer meet a
                                                # fence — the preamble always
                                                # converges (hydrate or adopt)

if typeof result.snapshotVersion == "number":
    if result.snapshotVersion != state.snapshotVersion + 1:
        emit session.snapshot_lineage_jump      # someone else published in the
             { from: state.snapshotVersion,     # gap (zombie, foreign writer) —
               to: result.snapshotVersion }     # observability only, never gates.
                                                # (New orchestration version; can
                                                # also be derived CMS-side.)
    state.snapshotVersion = result.snapshotVersion   # telemetry mirror only
iteration++; handleTurnResult(result); continueAsNew(…)
```

### 5.3 Activity (`runTurn`)

```
# input: prompt, turnKey, turnIndex            (expectedVersion ignored / removed)

runTurnPreamble:
    probe = probeSnapshot()                    # one HEAD: version, turnKey, sha, ETag

    if probe.turnKey == turnKey:               # ── keeper: idempotency ──
        hydrate probe; return stored result    # my commit already landed (drain,
                                               # crash retry, lost PUT response):
                                               # adopt it, NEVER re-run the body

    if probe.version < marker.version:         # store went BACKWARD (restore or
        emit session.snapshot_regressed        # data loss) — inherently anomalous.
             { marker: marker.version,         # Record it; then fall through and
               store: probe.version }          # hydrate anyway: the store wins.

    if sentinel dirty or no local dir          # torn / race-lost / fresh worker
       or marker.version != probe.version      # ── store wins: any mismatch ──
       or marker.sha != probe.sha:             #    incl. same-version content swap
        hydrate store                          #    (rule-breaking restore, §5.1) —
        base = probe.version                   #    cache validation, two string
    else:                                      #    compares, hydrate-only (P7)
        use local (warm)                       # exact (version, sha) match: the
        base = marker.version                  # only case that trusts local files

    baseETag = probe.ETag                      # the atomicity token for the commit,
                                               # minted by the SAME read that decided
                                               # base — carried through the turn.
                                               # (On the hydrate branch, take the
                                               # ETag of the GET that actually
                                               # downloaded the content.)

writeTurnSentinel(turnKey)                     # dir is now "mid-mutation"
body = executeTurnBody()                       # LLM + tools (unchanged)

runTurnCommit:
    if body.type == "stopped":                 # shipped guard, kept: most stops
        emit session.snapshot_unpublished      # never publish; sentinel stays
             { reason: "stopped", turnIndex,   # dirty. Intentional discard —
               turnKey, base }                 # dashboards split on reason.
        return unpublished

    PUT snapshot { psver: base+1, psturnkey: turnKey, psidx: turnIndex,
                   pssha: contentHash }
        conditions: If-Match(baseETag)         # the PREAMBLE's ETag: the predicate
                                               # ("nobody committed since the state
                                               # my body ran on") and its atomicity
                                               # are one check, because the token
                                               # was minted with base itself.
                                               # If-None-Match:* when the store was
                                               # empty at preamble — the fresh-chain
                                               # "worker copy is truth" case
    on success:  writeMarker(base+1, contentHash); clearSentinel
                 return { version: base+1 }
    on 412:      emit session.snapshot_unpublished
                      { reason: "superseded", turnIndex, turnKey, base }
                 return unpublished            # ANY commit since my preamble —
                                               # they own the store. Give up.
    on other:    throw                         # ordinary activity error; duroxide
                                               # retries; preamble reconverges

# "unpublished": sentinel stays dirty and the marker is untouched, so the NEXT
# turn on this worker takes the mismatch branch and force-rehydrates whatever
# won. The turn's result still returns to the orchestration (CMS keeps the
# transcript); only the model's in-snapshot memory of it is lost — and the
# snapshot_unpublished event says so. All events here are fire-and-forget: a
# failed event write logs a warning and NEVER fails the turn (P7).

return { ...body, ...(published ? { snapshotVersion: base+1 } : {}) }     # telemetry
```

That is the entire protocol: **one HEAD per turn (the preamble's), one
conditional PUT, and a 412 means give up** — losing the race means someone
newer owns the store, and the correct response is to stop writing. FS store:
identical semantics with `version == base` checked inside `withCasLock` at
publish time (the lock plays the ETag's role).

The three local mechanisms each answer one question, with no overlap:
**turnKey** — did this turn already land? **marker (version, sha) vs. store** —
is my cache the same state as the store? **sentinel** — is my cache a state at
all, or mid-edit? (The sentinel is what keeps the warm fast path honest when
the store *didn't* move: a stopped or crashed body leaves marker == store with
dirty files; without the sentinel, the next turn would warm-continue on a
half-turn and bake it into the store.)

### 5.4 The incident and the races, replayed

```
The incident (the brick):
  stopped turn's late commit lands: store 169 → 170.
  turn 378 preamble: marker 169 ≠ store 170 → hydrate 170 → run → publish 171.
  Orchestration sees 169 → 171: emits snapshot_lineage_jump — the zombie's
  write is on the record. No fence, nothing to reconcile. Already-bricked
  sessions self-heal the same way.

Abandoned turn vs. live next turn (any interleaving — one rule):
  whichever PUT lands first wins; the other's If-Match(preamble ETag) fails
  → 412 → snapshot_unpublished{superseded} → gives up.
  live turn wins  → the abandoned content never exists. Stop stayed "discard". ✔
  zombie wins     → live turn goes stale; next turn rehydrates zombie state.
                    Its model-memory is lost (CMS transcript intact) — the one
                    accepted loss, §6 — and the event trail shows exactly which
                    turn was superseded. Versions never duplicate either way.
```

## 6. What we pay (the honest ledger)

| Scenario | Today | Proposed |
|---|---|---|
| Stop's abandoned turn races the next turn | next turn fences → **session bricked** (the incident) | exactly one publishes; the other worker goes stale and rehydrates. If the zombie won, **the model forgets one turn's conversation** (CMS transcript intact, facts unaffected) — recorded by `snapshot_unpublished` + `snapshot_lineage_jump` |
| Genuine split-brain / foreign writer | loud fence, manual reconcile | store is authoritative; disagreeing workers rehydrate. Divergence bounded to one unpublished turn, visible in the event trail |
| Operator restores an older snapshot | store-behind re-base at next preamble | same lane as any mismatch: workers rehydrate the restored state (`snapshot_regressed` recorded). A same-version content swap is also caught — marker sha ≠ store sha |
| Drain / lock-steal / crash retry / lost PUT response | idempotent via turnKey | **identical** (preamble adopt) |
| Crash mid-turn (torn dir) | sentinel → re-hydrate | **identical** |
| User stops a turn | discard if classified `"stopped"`, else brick risk | discard if classified `"stopped"` or if it loses the publish race; kept (visibly, harmlessly) only if it wins |

Mitigations already in the product for the loss row: facts/artifacts are the
ground truth agents re-read; the CMS transcript is untouched; and a session
whose in-model memory got mangled is what the Regenerate proposal
(`session-transcript-continue-as-new.md`) repairs.

## 7. Rollout — one release, two layers

Both layers ship together; they are one design, staged only by *where the code
runs*:

- **Layer 1 — activities/store (takes effect immediately, all sessions).**
  Implement §5.3: store-wins preamble with `(version, sha)` marker validation,
  one-shot conditional publish, the `snapshot_unpublished` /
  `snapshot_regressed` events; ignore incoming `expectedVersion`; remove the
  fence paths and `SnapshotConflictError` throws. Safe for in-flight sessions
  on frozen orchestration versions: activity *inputs* are unchanged and
  activity *results* are recorded in history, so replay is untouched — no
  nondeterminism. Marker migration is free: an old marker without a sha fails
  the new validation once → one extra hydrate per warm worker, after which the
  marker is rewritten in the new format. Every currently-bricked session
  self-heals on its next turn.
- **Layer 2 — new orchestration version (same deploy).** Drop
  `snapshot.expectedVersion` from the `runTurn` input, demote
  `state.snapshotVersion` to a telemetry mirror, emit
  `snapshot_lineage_jump` at the adoption site, delete dead plumbing. New
  sessions start on the new version; existing sessions **continue-as-new onto
  it** at their next CAN boundary, per the standard registry/latest-version
  mechanism. No DB reset: frozen versions stay registered and functional
  throughout.

## 8. Test plan

1. **Warm fast path:** marker `(version, sha)` == store → warm continue, no
   hydrate.
2. **Store wins on any mismatch:** store ahead; store restored *older*
   (asserts `snapshot_regressed` emitted); **same version, different content**
   (marker sha ≠ store sha — rule-breaking restore) forces hydrate; marker
   missing; sentinel dirty → all hydrate from store.
3. **Idempotency:** re-dispatched turn (same turnKey) adopts stored result;
   body not re-run. Covers drain, lock-steal, crash retry, and
   lost-PUT-response (fault-inject `store.commit.after-write` failure →
   duroxide retry → preamble adopt; no double publish).
4. **Give-up:** any commit landing between a turn's preamble and its PUT —
   store moves mid-body, and concurrent PUTs under fault injection
   (`store.commit.before-write`, both orders) — → 412, turn returns
   unpublished, sentinel dirty, exactly one publisher, versions stay unique,
   **`snapshot_unpublished{superseded}` emitted**; next turn on the losing
   worker rehydrates the winner. No error surfaced.
5. **Stop:** `"stopped"` body → unpublished with
   **`snapshot_unpublished{stopped}` emitted** (extends the existing
   regression test); the incident's fixture (store `N+1`, stale control-plane
   `N`) → next turn publishes `N+2` with zero intervention.
6. **Fresh chain:** store absent → publish via `If-None-Match:*`.
7. **Lineage jump (Layer 2):** turn returns `published != mirror+1` →
   `snapshot_lineage_jump{from,to}` emitted; adoption proceeds regardless.
8. **Events are never load-bearing:** fault-inject CMS event-write failure in
   every emission site above → warning logged, turn outcome unchanged.
9. **Layer split:** frozen-version orchestration (still sending
   `expectedVersion`) runs against the new worker unchanged; new-version CAN
   handoff drops the field.

## 9. Key files

- Layer 1: `packages/sdk/src/session-lifecycle.ts` (preamble/commit, event
  emission via `recordSessionEvent` — precedent: `session.snapshot_store_empty`
  at `session-proxy.ts:950`), `session-store.ts` (`withCasLock` publish check),
  `blob-store.ts` (one-shot conditional PUT; hydrate returns its GET ETag;
  `pssha` already computed at :543), `snapshot-protocol.ts` (marker gains sha),
  `session-proxy.ts` (`runTurn` plumbing).
- Layer 2: `packages/sdk/src/orchestration/turn.ts` (input construction,
  adoption site + lineage-jump emit), `orchestration/state.ts`, `types.ts`,
  `orchestration-version.ts`, `orchestration-registry.ts`.
- Tests: `packages/sdk/test/local/turn-lifecycle.test.js`, `stop-turn.test.js`,
  `fault-injection-live.test.js`.

---

## Appendix A — glossary

| Term | Meaning |
|---|---|
| marker (`.ps-snapshot-version`) | `{version, sha}`: "these local files are store version N with content hash S" — valid only when both match the store |
| sentinel (`.ps-turn-inprogress`) | "dir is mid-mutation" — cleared only by successful publish or hydrate; its presence forces rehydrate. Excluded from tars, so hydrated dirs are always clean |
| turnKey | deterministic per-turn GUID; equality with the store's `psturnkey` means "this turn already committed — adopt, don't re-run" |
| store-wins | the protocol: exact `(version, sha)` local match is warm; every other state rehydrates; publishes are one-shot, conditioned on the preamble's ETag |
| give up / unpublished | a commit whose `If-Match(preamble ETag)` failed — someone committed since this turn's base was read. It writes nothing, stays sentinel-dirty, emits `snapshot_unpublished`, and the next turn rehydrates |
| `snapshot_unpublished { reason }` | CMS event for every non-published turn snapshot: `stopped` (intentional discard) or `superseded` (lost the publish race). The loss signal |
| `snapshot_regressed` | CMS event: preamble saw the store at a *lower* version than the local marker (restore or data loss). Hydration proceeds regardless |
| `snapshot_lineage_jump` | CMS event (orchestration side): an adopted version ≠ mirror+1 — someone else published in the gap. Adoption proceeds regardless |

## Appendix B — alternatives considered

1. **Widen the classification skip** (add `"cancelled"`): breaks drain and
   lock-steal, whose `"cancelled"` commits are required for same-turnKey
   idempotency. Not completable — see §3.1.
2. **Await the race loser and adopt its version:** duroxide's `ctx.race`
   consumes both futures; re-yielding the loser's descriptor re-schedules the
   activity (verified by probe, 2026-04-24). No "await the remaining branch"
   primitive exists today.
3. **Reconcile probe in the stop path:** have `handleTurnStopped` probe the
   store and adopt a version that advanced under the stopped turn's key.
   Inherently racy (the probe must be ordered after a commit that may not have
   happened yet), and requires an orchestration version change to carry the
   adoption — all to defend an invariant the product doesn't need.
4. **Strict abandonment fencing in the store** (keep the CAS; on stop,
   atomically either *block* the abandoned turn's future commit or *accept*
   its already-landed one at the store's serialization point, and let later
   turns roll forward onto accepted commits): correct and classification-proof,
   and the right shape **if the snapshot ever becomes a system of record**
   (e.g. compliance transcripts). Rejected here for weight: several new store
   states and hooks plus a test matrix, to preserve a distinction (stop =
   guaranteed discard) that principle 6 (§4) shows is unkeepable at the commit
   boundary anyway.
5. **A duroxide cancel-and-drain primitive** (race returning an awaitable
   loser): attractive engine work, but it cannot fence a live-but-partitioned
   worker's eventual blob write — a store-side answer is needed regardless.
   Store-wins is that answer without new engine surface.
