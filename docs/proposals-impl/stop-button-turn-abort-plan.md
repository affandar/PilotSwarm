# Stop Button / Turn Abort Plan

## Goal

Add a user-visible `Stop` action that aborts the currently executing LLM turn mid-flight for a session without completing, cancelling, deleting, or resetting the session itself. The session should return to an idle/ready state and accept the next prompt normally.

Non-negotiable requirement: Stop must interrupt the in-flight Copilot SDK request while `ManagedSession.runTurn()` is still awaiting that request. Any design that waits for `ManagedSession.runTurn()` to finish before handling Stop defeats the purpose and is not acceptable.

This document describes a single design, all within the existing session orchestration: **`processPrompt` races the `runTurn` activity against a dedicated stop signal (`ctx.race`), and when the stop wins, the same orchestration schedules a same-affinity `abortTurn` activity** that interrupts the warm `ManagedSession` on the worker. The dropped `runTurn` future doubles as a built-in backstop interrupt via duroxide's drop-cancellation. There is no second/helper orchestration and no session-orchestration `stop_turn` command in the `messages` queue. Rejected shapes are recorded in "Rejected Alternatives".

## Verified Runtime Facts

Verified against the code on 2026-07-01. These are the constraints the design is built on.

1. **The session orchestration is blocked while a turn runs — today.** `processPrompt` parks on `turnResult = yield runtime.session.runTurn(...)` (`packages/sdk/src/orchestration/turn.ts:334`). Commands are handled by `handleCommand` only from `drain()` / `sweepMessagesBeforePromptDispatch` (`packages/sdk/src/orchestration/queue.ts`), which do not run during a turn. Stop therefore requires restructuring this yield into a race; a `stop_turn` command in the `messages` queue would not be seen until the turn ends.

2. **Race losers are actively cancelled, not ignored.** When a durable future loses a `ctx.race` and is dropped, duroxide emits `ActivityCancelRequested` and cancels the work item via lock-steal (`duroxide/src/runtime/replay_engine.rs:1113-1132`). The running activity's lock renewal fails within one renewal interval (~5s at `workerLockTimeoutMs: 10_000`), its cancellation token fires, and `activityCtx.isCancelled()` flips. The `runTurn` activity already polls this every 2s and calls `session?.abort?.()` (`packages/sdk/src/session-proxy.ts:1607-1615`). JS-binding proof: `../sdks/duroxide-node/__tests__/races.test.js` ("races timer vs activity — timer wins, activity cooperatively cancels"). Two consequences: (a) racing `runTurn` against the general `messages` queue is unsound — any message would kill the turn; the raced signal must be a **dedicated stop channel**; (b) the drop itself is a working (if slow, ~2–7s) interrupt — the design's backstop.

3. **Dropping a `dequeueEvent` task is benign and is an established pattern.** The drain loop races `ctx.dequeueEvent("messages")` against timers on every iteration and drops the loser (`queue.ts:200-230`); no message is consumed by a dropped dequeue. Racing `runTurn` against a `dequeueEvent` on a stop queue therefore costs nothing on the common (turn-wins) path.

4. **Same-affinity activities run concurrently — under two conditions.** Duroxide dispatches two activities with the same affinity key concurrently on the owning worker **iff** the runtime has a stable `workerNodeId` **and** a free worker slot. Peer-test evidence: `../duroxide/tests/session_e2e_tests.rs::test_two_slots_serve_same_session_concurrently` and its serializing counterpart `test_ephemeral_same_session_serialized`. Empirical probe in this repo, run 2026-07-01:

   ```bash
   node --env-file=.env scripts/probe-duroxide-session-affinity-concurrency.mjs --postgres
   ```

   ```text
   provider: postgres
   workerCount: 6
   attempts: 5
   workerConcurrency: 32
   orchestrationConcurrency: 16
   maxSessionsPerRuntime: 64
   stableWorkerNodeId: true
   sameWorkerCount: 5
   concurrentCount: 5
   sameWorkerAllAttempts: true
   concurrentAllAttempts: true
   ```

   The second same-affinity activity consistently lands on the same runtime identity as the long-running activity and starts while it is still executing. This is what makes `abortTurn` a *fast* (sub-second) interrupt; when the conditions fail, the drop-cancellation backstop (Fact 2) still interrupts.

5. **Duroxide has no external API to cancel a single in-flight activity.** The admin API is orchestration-level only. `isCancelled()` triggers are exactly: dropped race futures (available to us — Fact 2) and lock expiry from worker death/restart (the absolute last resort). Nothing else.

6. **`ManagedSession.abort()` today unwinds as a *completed* turn.** The Copilot SDK fires `session.idle` after an abort (`packages/sdk/src/managed-session.ts:1856`) and `runTurn()` falls through to `return { type: "completed", content: finalContent ?? "(no response)" }` (`managed-session.ts:2034`). A distinct `stopped` classification is mandatory or the completion machinery runs (`writeLatestResponse("(no response)")`, parent notify, cron re-arm).

7. **`runTurn()` settles only on `session.idle`.** The `turnComplete` promise resolves exclusively from the `session.idle` subscription (`managed-session.ts:1857-1863`). The hang escalation (edge E3) must be able to settle the turn from inside `ManagedSession`; it cannot rely on `disconnect()` emitting anything.

8. **The `{ type: "cancelled" }` activity return skips CMS writeback.** `session-proxy.ts:1936` returns before `completeTurnWriteback` — no `session.turn_completed`, CMS state left as-is. On the stop path the orchestration must own the authoritative CMS/event bookkeeping (§7), because the aborted activity may unwind through this path when the backstop (not `abortTurn`) delivered the abort.

9. **Control tools also call `abort()` legitimately.** The `wait` / `ask_user` tools end a turn early by pushing a `pendingAction` and aborting; `runTurn()` checks `turnState.pendingActions` before the completed fallback (`managed-session.ts:1983`). Stop classification must be explicitly ordered against this.

10. **Warm sessions and the run-turn lock live in `SessionManager`.** Warm map: `private sessions = new Map<string, ManagedSession>()` (`packages/sdk/src/session-manager.ts:167`). The `runTurn` activity holds `withRunTurnLock` for the entire turn (`session-proxy.ts:866`) — the abort primitive must bypass it.

11. **The Copilot SDK abort primitive is real.** Probe run 2026-07-01:

    ```bash
    node --input-type=module -e 'import { CopilotSession } from "@github/copilot-sdk"; const calls = []; const connection = { sendRequest: async (method, params) => { calls.push({ method, params }); return { ok: true }; } }; const session = new CopilotSession("probe-session", connection, process.cwd()); console.log("hasAbort", typeof session.abort); await session.abort(); console.log(JSON.stringify(calls)); if (calls.length !== 1 || calls[0].method !== "session.abort" || calls[0].params.sessionId !== "probe-session") process.exit(1);'
    ```

    Result: `hasAbort function`, `[{"method":"session.abort","params":{"sessionId":"probe-session"}}]`. `ManagedSession.abort()` wraps it (`managed-session.ts:2047`).

12. **Deployment identity.** `packages/sdk/examples/worker.js` sets `workerNodeId` from `POD_NAME || os.hostname()`, and the AKS worker manifest supplies `POD_NAME`. The CLI's embedded workers set `workerNodeId: local-${index}` (`packages/cli/src/embedded-workers.js:36`). Local tests constructing `PilotSwarmWorker` directly must set `workerNodeId` explicitly to get the fast-path concurrency.

13. **Queues and command responses.** duroxide queues are arbitrary names via `client.enqueueEvent(instanceId, queueName, data)`; messages survive continue-as-new. The command-response pattern (orchestration writes a KV response, client polls `getCommandResponse(sessionId, cmdId)` — `management-client.ts:1645`) is the existing mechanism for returning results to callers. CMS `session_events.event_type` is free-form TEXT — new event types need no migration.

## UX Contract

- Show a `Stop` button in the session action strip when the selected session is actively running a turn. This includes **system sessions** — they run turns through the same orchestration/`runTurn` machinery and are stoppable exactly like user sessions.
- Disable or hide `Stop` when the selected row is a group/container row, a completed/deleted session, or not currently running.
- Clicking `Stop` should:
  - immediately show a transient `stopping` state to avoid duplicate clicks;
  - record a durable stop request;
  - abort the live Copilot turn mid-flight;
  - leave the session selected;
  - return the session to `idle` after the turn unwinds;
  - add a visible transcript/system event such as `Turn stopped by user.`
- The call returns a concrete outcome, surfaced to the user: `stopped`, `stop_forced`, `no_active_turn`, or `timeout`. If the turn already ended, Stop is an idempotent no-op reported as `No active turn to stop`, with no lifecycle state change.
- Stop targets **the in-flight turn only**. It does not drain queued prompts (the existing `cancelPending` tombstone mechanism covers those) and does not touch child sessions.

## Design

Everything happens in the existing session orchestration. The client enqueues a stop event on a **turn-scoped stop queue**; `processPrompt` races the in-flight `runTurn` activity against a dequeue on that queue; when the stop wins, the orchestration schedules the same-affinity `abortTurn` activity (it owns `state.affinityKey`) and then performs the authoritative stop bookkeeping.

```
UI (portal/TUI)
  └─ transport.stopSessionTurn(sessionId)
       └─ PilotSwarmManagementClient.stopSessionTurn()
            reads CMS: state + active_turn_index N  (no turn running → return no_active_turn)
            enqueueEvent(orchId, `stopTurn.${N}`, { id, reason, requestedAt })
            polls command-response KV for id → outcome

session orchestration (processPrompt, restructured):
  publishStatus("running")
  turnTask = session.runTurn(...)                    // affinitized activity, turnIndex = N
  stopTask = ctx.dequeueEvent(`stopTurn.${N}`)       // dedicated, turn-scoped channel
  race = yield ctx.race(turnTask, stopTask)

  ── race.index === 0 (turn finished — the common path) ──────────────
  stopTask is dropped (benign for dequeues, Fact 3)
  handleTurnResult(result) exactly as today

  ── race.index === 1 (stop wins) ────────────────────────────────────
  turnTask future is dropped → duroxide begins drop-cancellation of the
      runTurn work item (BACKSTOP interrupt: isCancelled → session.abort, ~2–7s)
  outcome = yield ctx.scheduleActivityOnSession("abortTurn",
      { sessionId, expectedTurnIndex: N, reason }, state.affinityKey)
      │  FAST interrupt: lands on the owning worker, concurrent with the
      │  unwinding runTurn (Fact 4); sets stop marker; session.abort();
      │  waits (bounded) for the turn to unwind; escalates if it doesn't
  authoritative bookkeeping in the orchestration:
      recordSessionEvent(turn_stopped | turn_stop_noop, system.message)
      updateCmsState(idle)
      writeCommandResponse(id → outcome)
      iteration++, retryCount = 0; resume interrupted timers / re-arm cron
      publishStatus("idle") via the shared idle path
```

Key properties:

- **One orchestration.** No helper orchestration, no affinity discovery problem — `state.affinityKey` is in scope at the race site.
- **Two interrupts, one mechanism owns the state.** The fast path is `abortTurn` (sub-second when Fact 4's conditions hold); the dropped `runTurn` future is a guaranteed backstop (~2–7s) that works even with `workerNodeId` unset or all slots busy. Either way the turn's SDK request is aborted mid-flight; the **orchestration** — not the activity — owns the durable stop bookkeeping, because the activity's return value is discarded once the future is dropped (Fact 8).
- **Turn-scoped stop queues make stale stops structurally harmless.** A stop event on `stopTurn.5` can never resolve turn 6's race. This matters because *any* event winning the race kills the live turn (the drop is irreversible — a payload guard cannot un-drop the future), so the channel itself must be scoped to the turn it may kill.

### 1. Management API

```ts
stopSessionTurn(sessionId: string, opts?: { reason?: string; timeoutMs?: number }):
    Promise<{ outcome: "stopped" | "stop_forced" | "no_active_turn" | "timeout"; turnIndex?: number; detail?: string }>
```

- Reject group/container rows client-side (no transport call). System sessions are valid targets.
- Read the session row from CMS. If state is not an active-turn state or `active_turn_index` is null → return `no_active_turn` without enqueueing anything.
- `enqueueEvent(orchId, "stopTurn." + activeTurnIndex, { id: uuid, reason, requestedAt })`.
- Poll the existing command-response KV (`getCommandResponse`) for `id` with a bounded timeout (~30s default). On timeout return `{ outcome: "timeout" }` — if the turn ended between the CMS read and the enqueue, the event rots unread in a dead queue (harmless, see E2) and no response will ever appear; the UI should refresh session state rather than assume failure.

Touch points: `packages/sdk/src/management-client.ts`, `packages/sdk/src/types.ts`, `packages/cli/src/node-sdk-transport.js`, `packages/portal/src/runtime.js`, `packages/portal/src/browser-transport.js`.

### 2. Active-turn index in CMS

The client needs the in-flight turn index to address the turn-scoped queue:

- In the `runTurn` activity's existing pre-turn writeback (`session-proxy.ts:1740`), also persist `active_turn_index` (= `input.turnIndex`). `completeTurnWriteback` clears it.
- CMS migration: one nullable `active_turn_index INTEGER` column (or extend the writeback stored procedure's payload).

No affinity key needs to be persisted — the orchestration schedules `abortTurn` itself.

Touch points: `packages/sdk/src/cms.ts`, `packages/sdk/src/cms-migrations.ts`, `packages/sdk/src/session-proxy.ts`.

### 3. `processPrompt` restructure — the race

The core change, in `packages/sdk/src/orchestration/turn.ts`:

```ts
publishStatus(runtime, "running", { iteration: state.iteration + 1 });
const turnTask = runtime.session.runTurn(prompt, promptIsBootstrap, state.iteration, {...});
const stopTask = ctx.dequeueEvent(`stopTurn.${state.iteration}`);
const race: any = yield ctx.race(turnTask, stopTask);

if (race.index === 1) {
    yield* handleTurnStopped(runtime, race.value, prompt, cycleOrigin);   // §7
    return;
}
// race.index === 0 — existing paths, unchanged:
const turnResult = race.value;   // feeds the existing try/catch + handleTurnResult flow
```

Notes:

- The queue name is derived from `state.iteration`, which is replay-deterministic and survives continue-as-new; the race and its winner are recorded in history, so replay is deterministic.
- Error handling: today `yield runTurn` can throw (retry machinery in the surrounding `try/catch`). **The duroxide-node select bridge flattens activity failures into their raw error string** (`make_select_future`: `Ok(v) => v, Err(e) => e`) instead of throwing into the generator — so the race path must detect a non-TurnResult value on `race.index === 0` and re-throw it (`normalizeRacedTurnValue`) to reach the existing `runTurn.throw` / `turn.result.error` retry paths. Only the `index === 1` branch is new behavior.
- On the common path (turn wins), the dropped `stopTask` dequeue is benign (Fact 3) and no stop event is consumed.
- If the same turn index is retried after a transport error (CAN with the same `state.iteration`), a stop event enqueued during the first attempt still targets `stopTurn.N` — and will stop the retry attempt. That is correct semantics: the user asked to stop turn N.

This changes the yield shape of every turn → **new orchestration version** (§8).

### 4. Worker abort primitive

```ts
// SessionManager — LOCK-BYPASSING by design. Never call _withSessionLock here:
// runTurn holds it for the whole turn; taking it would serialize Stop behind the turn.
async abortWarmSessionTurn(sessionId: string, opts: {
    expectedTurnIndex?: number; reason: string;
}): Promise<{ outcome: "stopped" | "stop_forced" | "no_active_turn"; turnIndex?: number }>
```

Behavior:

1. `this.sessions.get(sessionId)` — missing/not warm → `no_active_turn`.
2. No active turn on the `ManagedSession` (§5), or `expectedTurnIndex` mismatch → `no_active_turn`. (With turn-scoped queues a wrong-turn hit should be impossible; the guard is belt-and-braces.)
3. Set the stop marker (`stopRequest = { reason, requestedAt }`) **before** calling `managed.abort()`, so the unwind classification can never miss it.
4. `managed.abort()` → SDK `session.abort` RPC. (Idempotent with the backstop's `session.abort` from the `isCancelled` poll — whichever lands first wins, the second is a no-op RPC.)
5. Wait up to `STOP_UNWIND_GRACE_MS` (~8s) for the active turn to clear → `stopped`. This bounded wait is also what guarantees the run-turn lock is free again before the orchestration proceeds to any next prompt.
6. Escalation if the SDK never fires `session.idle` (Fact 7): `managed.forceSettleTurn(reason)` — resolve the turn's completion promise directly (we own the resolver) — then best-effort `copilotSession.disconnect()` and invalidate the warm session (existing machinery, `session-proxy.ts:1778`) so the next turn recreates it cleanly → `stop_forced`.

Registered as the `abortTurn` activity in `registerActivities` (`session-proxy.ts`), scheduled by the session orchestration with `ctx.scheduleActivityOnSession("abortTurn", input, state.affinityKey)`.

Touch points: `packages/sdk/src/session-manager.ts`, `packages/sdk/src/managed-session.ts`, `packages/sdk/src/session-proxy.ts`.

### 5. `ManagedSession`: active-turn tracking + stop classification

No active-turn state exists today; add it:

- `activeTurn: { turnIndex: number; startedAt: number } | null` — set at `runTurn()` entry (turn index threaded from the activity's `input.turnIndex`), cleared in a `finally`.
- `stopRequest: { reason: string; requestedAt: number } | null` — set by `abortWarmSessionTurn`, cleared in the same `finally`.
- `forceSettleTurn(reason)` — resolves the current turn's `turnComplete` promise (store the resolver when constructing it) for the E3 escalation.

Classification order in `runTurn()`'s unwind — this ordering is load-bearing:

1. **`stopRequest` set → return `{ type: "stopped", reason, events: collectedEvents }`** — checked **before** `turnState.pendingActions`. If Stop races the model calling `wait()`/`ask_user` (both also abort the SDK turn, Fact 9), user intent wins; without this ordering the Stop would be silently swallowed into a durable timer.
2. Existing `pendingActions` dispatch (wait / input_required / spawn_agent / ...).
3. Existing completed / error fallbacks. In the `catch` paths (send error, forced settle/disconnect), `stopRequest` set → classify as `stopped` rather than `error`.

If the **backstop** delivered the abort (drop-cancellation → `isCancelled` poll → `session.abort()`) before `abortTurn` set the marker, the unwind takes the activity's existing `cancelled` flag path and returns `{ type: "cancelled" }` with no writeback (Fact 8) — which is fine, because on the stop path the orchestration owns the bookkeeping (§7) and the activity's return value is discarded either way.

This is single-process JavaScript: `abortTurn` and the in-flight `runTurn` interleave on the event loop while `runTurn` awaits the network, so marker visibility needs no synchronization.

Touch points: `packages/sdk/src/managed-session.ts`, `packages/sdk/src/types.ts` (new `TurnResult` variant).

### 6. `runTurn` activity writeback for `stopped`

In `session-proxy.ts`'s post-turn writeback, for the case where the turn unwinds with the stop marker while the activity is still live:

- Add `stopped: "idle"` to the `statusMap` (`session-proxy.ts:1942`) and run the **full** `completeTurnWriteback` with `resultType: "stopped"` (do not reuse the early-return `cancelled` path).
- Best-effort only: on the stop path this activity's future has been dropped, so its writeback may or may not run before the orchestration's authoritative `updateCmsState(idle)` (§7). Both write `idle`; either order converges. Partial transcript output is preserved regardless — the per-event CMS writes from `onEvent` already landed while the turn ran.

### 7. Orchestration stop handling — `handleTurnStopped`

New generator in `packages/sdk/src/orchestration/turn.ts`, run when the stop wins the race. The orchestration is the **authoritative** writer here (the aborted activity's writeback is best-effort, Fact 8 / §6):

- `outcome = yield ctx.scheduleActivityOnSession("abortTurn", { sessionId, expectedTurnIndex: state.iteration, reason }, state.affinityKey)` — awaited, so the turn has unwound (or been force-settled) and the run-turn lock is free before the loop continues.
- `yield recordSessionEvent`: `session.turn_stopped` (or `session.turn_stop_noop` if the abort no-opped because the backstop or a control tool already ended the turn) + a visible `system.message` `"Turn stopped by user."`.
- `yield updateCmsState(sessionId, "idle")`.
- `writeCommandResponse` for the stop event's `id` → the client's polled outcome (existing KV response mechanism, Fact 13).
- State bookkeeping: `state.iteration++` (the turn ran and consumed context), `state.retryCount = 0`, `state.config.turnSystemPrompt = undefined`.
- **Skip**: `writeLatestResponse`, parent `CHILD_UPDATE` notification, forgotten-timer nudge.
- **Keep**: resume `interruptedWaitTimer` / `interruptedCronTimer`, re-arm `cronSchedule` / `cronAtSchedule`, else fall through to the idle timer + `maybeCheckpoint` — same scheduling behavior as a completed turn. Stopping a turn must not silently kill a recurring session's schedule (edge E9); stopping the schedule is what `Terminate`/`cancel` is for.

### 8. Versioning

The race changes the yielded action sequence of every turn: freeze `1.0.55`, ship as `1.0.56` (`orchestration-version.ts`, `orchestration-registry.ts`, frozen copy of the orchestration dir). The registry routes existing sessions to their frozen versions; no resets needed.

## How the Race Handles the `runTurn` Activity

This section is the heart of the design.

**Common path — turn wins the race.** `race.index === 0`; the result feeds the existing `handleTurnResult` flow untouched. The losing `stopTask` dequeue is dropped — an established, benign pattern (Fact 3): no event is consumed, nothing is cancelled that matters.

**Stop path — stop wins the race.** Two things happen to the in-flight `runTurn` activity, deliberately redundant:

1. **Drop-cancellation (backstop, guaranteed).** Yielding past the race drops the `turnTask` future; duroxide cancels the work item via lock-steal; the activity's `isCancelled()` poll (2s) fires `session.abort()` and the turn unwinds as `{ type: "cancelled" }`. Worst-case latency ≈ lock-renewal detection (~5s) + poll (2s) + SDK unwind. This path needs **no** worker concurrency, no free slot, no `workerNodeId` — it is internal to the duroxide runtime and always works.
2. **`abortTurn` (fast path).** Scheduled by the same orchestration on `state.affinityKey`, it lands on the owning worker and — when Fact 4's conditions hold (stable `workerNodeId`, free slot) — runs *concurrently* with the still-unwinding `runTurn`: sets the stop marker, calls `session.abort()` immediately (sub-second), and waits bounded time for the unwind so the orchestration doesn't proceed while the run-turn lock is still held.

The two interrupts are idempotent with each other (`session.abort` twice is harmless; marker-setting is a plain field write). Interleavings:

- `abortTurn` lands first (normal): marker set → SDK aborted → unwind classifies `stopped` → activity does its best-effort `stopped` writeback → `abortTurn` returns `stopped`.
- Backstop fires first (slots busy / no `workerNodeId`): the poll's `session.abort()` unwinds the turn as `cancelled` (no writeback); `abortTurn` then finds no active turn → returns `no_active_turn`. The orchestration records `turn_stopped` bookkeeping regardless — the user's stop *did* stop the turn, just via the slow lane.
- Turn completes at the same instant the stop wins: the race winner is recorded in history and is authoritative for the orchestration; the completed result is discarded (its future was dropped). The turn's transcript events and possibly a `completed` writeback already landed in CMS — the orchestration still records the stop bookkeeping and sets `idle`. Cosmetic edge: the latest-response KV is not updated with that final content (E12).
- `runTurn` never unwinds at all → E3 escalation inside `abortTurn`.

**Why the raced channel is turn-scoped.** Once a race resolves, the dropped turn future cannot be un-dropped — *whatever* wins the race kills the turn. A payload check ("is this stop meant for me?") happens too late by construction. So staleness must be prevented at the channel level: the queue name `stopTurn.${iteration}` guarantees an event can only ever win the race of the turn it targeted. A stop for a finished turn sits forever in a queue nothing reads (bounded garbage: one tiny event per too-late click; see E2).

**Interaction with the messages queue.** Unchanged. User prompts, child updates, and commands arriving mid-turn continue to sit in `messages` until the post-turn drain — they are never raced against the turn and can never kill it.

## Rejected Alternatives

Recorded so they are not re-proposed. Evaluated against the code and duroxide semantics on 2026-07-01.

- **`stop_turn` command in the `messages` queue, handled by `handleCommand`.** Cannot work mid-turn: commands are only drained between turns (Fact 1).
- **Racing `runTurn` against the general `messages` queue.** Race losers are actively cancelled (Fact 2); any routine mid-turn message — child updates, queued prompts — would abort the LLM turn. Unsound.
- **A single shared (non-turn-scoped) stop queue.** A stale stop event enqueued while idle would win the *next* turn's race and kill it; no payload guard can help because the drop is irreversible. Turn-scoped queue names eliminate the hazard structurally; a pre-turn sweep of a shared queue was the weaker alternative.
- **A separate helper/stop orchestration scheduling `abortTurn`.** Works, but adds a second orchestration, an affinity-key discovery mechanism (CMS persistence), and a second command surface — all to deliver a signal the session orchestration can receive itself via the race. Rejected for operational and conceptual simplicity: one orchestration owns the session, including stopping it.
- **Drop-cancellation alone (no `abortTurn`).** Functional but slow (~2–7s to reach `session.abort`) and it classifies the unwind as `cancelled` with no writeback, pushing all bookkeeping onto the orchestration anyway. Kept as the backstop, not the primary.
- **Relying on duroxide activity cancellation as an externally triggered interrupt.** No such API exists (Fact 5).

## Edge Conditions and Failure Modes

**E1. `abortTurn` gets serialized after `runTurn` (fast path unavailable).** Causes: `workerNodeId` unset (strict same-session serialization), or all worker slots busy. The stop still works: the dropped-future backstop aborts the turn in ~2–7s (Fact 2); `abortTurn` then runs post-unwind, finds no active turn, and returns `no_active_turn` — which the orchestration still records as a successful stop (`turn_stopped`), since the race already decided the turn's fate. Degradation is latency-only. Worker startup should still warn when `workerNodeId` is unset, and `PILOTSWARM_WORKER_CONCURRENCY` sizing matters (E8), but a misconfigured environment no longer ships a non-functional button.

**E2. Stop arrives when no turn is running (or just as one ends).** The client's CMS pre-check returns `no_active_turn` without enqueueing in the common case. In the race window (turn ends between the CMS read and the enqueue), the event lands in `stopTurn.N` for a turn that has already finished — nothing ever dequeues it; it is inert garbage (one small event per late click; if this ever matters, a post-turn best-effort drain of the turn's own stop queue can be added). The client's response poll times out → `timeout`, and the UI refreshes to the true state. A *queued* prompt that hasn't started is untouched — Stop targets the in-flight turn; un-sending queued prompts is the existing `cancelPending` tombstone facility.

**E3. `runTurn` does NOT return after the abort.** If the SDK never fires `session.idle` (hung stream, wedged connection), neither `session.abort()` nor the backstop's abort unwinds the turn (Fact 7) — and duroxide cannot cancel the activity from outside (Fact 5). The escalation is worker-local, inside `abortTurn`:
   - grace wait (~8s) for the normal unwind →
   - `forceSettleTurn(reason)`: resolve the turn's completion promise directly inside `ManagedSession` (we own the resolver; do not depend on `disconnect()` emitting events) →
   - stop marker classifies the unwind as `stopped`, keeping the connection-closed retry/lossy-handoff machinery out of it →
   - best-effort `disconnect()` + warm-session invalidation so the next turn recreates the Copilot session →
   - `abortTurn` returns `stop_forced`.
   Because the orchestration awaits `abortTurn`, it proceeds only after the settle. The hung activity work item itself unwinds via the drop-cancellation it already received; the absolute backstop for a fully wedged process remains worker restart → lock expiry → redelivery.

**E4. Worker dies around the stop.** In-memory stop marker dies with the worker. The orchestration's race already resolved durably in favor of the stop, so on replay/redelivery the orchestration continues from the stop branch: it schedules `abortTurn` (fresh worker → `no_active_turn`) and completes the bookkeeping. The dropped `runTurn` work item is not redelivered as live work (it was cancel-requested). Net: the stop survives worker death; only sub-second-old partial transcript events could be lost with the worker.

**E5. Stop races a `wait()` / `ask_user` control-tool abort.** Both abort the same SDK turn within milliseconds. If the stop won the orchestration race, the turn's fate is sealed regardless of what the control tool intended — the pending wait/input action is discarded with the dropped result, and marker-first classification (§5) keeps the activity's unwind consistent. If the turn's `wait` result won the race instead, the stop event stays unread in `stopTurn.N` (inert, E2) and the wait proceeds; the user sees the session waiting and can stop the *next* turn. No ambiguous middle state exists — the race winner is authoritative.

**E6. Stop during retry backoff.** After a failed turn, the orchestration is not racing — it is sleeping on a durable retry timer in `drain()`. No turn is in flight; the client's CMS check returns `no_active_turn` (`active_turn_index` cleared), while the UI shows an error/retrying session the user "can't stop". Out of scope for v1. Natural follow-up: during backoff the orchestration *is* draining `messages`, so a conventional `stop_turn` command handled by `handleCommand` (clear pending retry prompt, go idle) covers it — v1.1, separate version bump. Note also §3: a stop enqueued for turn N *before* the failure will stop N's retry attempt when it re-races — correct.

**E7. Double stop / concurrent stops.** Only the first event on `stopTurn.N` can win the race; subsequent events on the same queue are never dequeued (inert). Duplicate `abortTurn`/abort calls are idempotent. The second click's client call either pre-checks to `no_active_turn` or times out — the UI's transient `stopping` state makes this rare.

**E8. Slot starvation.** With `workerConcurrency: 2`, concurrent long turns from other sessions can delay `abortTurn` dispatch for minutes. Consequence is bounded by E1: the backstop still stops the turn in ~2–7s; only the fast path and the `abortTurn`-reported outcome are delayed (the orchestration waits on `abortTurn`, so the command response — not the abort — is what the user waits for). Mitigations: raise `PILOTSWARM_WORKER_CONCURRENCY` (turns are IO-bound; the probe ran at 32), document sizing, and keep the client-side response timeout honest.

**E9. Sessions with schedules or interrupted timers.** A stopped turn re-arms `cronSchedule`/`cronAtSchedule` and resumes `interruptedWaitTimer`/`interruptedCronTimer` exactly like a completed turn (§7). Stopping a cron-fired turn skips that cycle's remaining work but never kills the schedule.

**E10. Child sessions.** Stop does not cascade — decided, not a follow-up: children keep running, tracking metadata is untouched, and buffered child updates are delivered on the parent's next turn (they sat in `messages`, which the race never touches). To stop a child's turn, select the child and stop it directly.

**E11. Context accounting on stopped turns.** The discarded turn result means `state.contextUsage` is not updated from that turn's events and `maybeSummarize` doesn't see it. Acceptable drift for v1 (the next completed turn corrects it); worth a code comment.

**E12. Stop wins against an already-completed turn.** The turn's transcript events (and possibly a `completed` writeback) are already in CMS, but the orchestration discards the result: `writeLatestResponse` is skipped, so the latest-response KV still shows the previous turn while the transcript shows the new content, and the parent is not notified. Cosmetically imperfect, semantically safe — the user asked to stop and the session is idle. Selectors read the transcript, so the portal chat still shows the content.

## Events and State

- With no helper orchestration, the first durable trace is the race resolution: the orchestration records `session.turn_stopped` (unconditional, with the `abortTurn` outcome in an `interrupt` field) and the visible `system.message` `"Turn stopped by user."` in `handleTurnStopped`. There is no separate `turn_stop_noop` event — a stop that reaches the orchestration *did* stop the turn; a stop that doesn't (idle session) is rejected client-side and never becomes durable. If a pre-abort breadcrumb is wanted, the management client can `recordSessionEvent(turn_stop_requested)` via CMS directly before enqueueing — optional.
- `session.turn_completed` with `resultType: "stopped"` — best-effort from the activity writeback when the fast path classified the unwind (§6). Selectors must key off `session.turn_stopped` (always present), not `turn_completed.resultType` (present only on the fast path).
- CMS state after a stop is `idle`, never `cancelled` — written authoritatively by the orchestration, best-effort by the activity; both converge.
- Schema/migration work: one `active_turn_index` column (§2).

## UI

Shared core:

- `UI_COMMANDS.STOP_TURN = "stopTurn"` in `packages/ui-core/src/commands.js`.
- Controller: resolve active session id; reject group/container rows (system sessions expose Stop like user sessions); dispatch transient `stopping` marker; `await transport.stopSessionTurn(sessionId, { reason: "Stopped by user" })`; surface the outcome (`no_active_turn` → status line "No active turn to stop"); refresh session detail/events.
- Selectors: `Stop` visible/enabled when derived status is `running` (same signal that drives the "Working" indicator today).

Portal (`packages/ui-react/src/web-app.js`): `Stop` in the session action strip, visually separated from `Terminate`. Native TUI: start with the action in the session pane/help modal; add a keybinding only if a non-conflicting key exists (update `docs/keybindings.md` and `.github/skills/pilotswarm-tui/SKILL.md` if so).

Do not ship the UI before the backend path exists.

## Tests

SDK/orchestration integration under `packages/sdk/test/local/stop-turn.test.js`, wired into `scripts/run-tests.sh` and the `test:local` script:

1. **Stops a running turn mid-flight; session reusable.** Blocking test tool; wait for `session.turn_started`; `stopSessionTurn`; assert outcome `stopped`, CMS `idle` (not `cancelled`/`completed`/`failed`), `session.turn_stopped` recorded; then a second prompt completes normally.
2. **Turn-wins path is unaffected.** Normal turns complete with the race in place: assert `handleTurnResult` behavior, event ordering, and that no stop-queue residue affects subsequent turns (run several turns back-to-back).
3. **Stale stop cannot kill a later turn.** Enqueue a stop for turn N after N completed; run turn N+1; assert N+1 completes normally and the stale event is never consumed.
4. **Idempotent after completion.** `stopSessionTurn` on an idle session → `no_active_turn` from the CMS pre-check, no state regression; a subsequent prompt completes.
5. **Backstop-only interrupt (fast path unavailable).** Simulate `abortTurn` delay/serialization (e.g. `workerNodeId` unset or saturated slots); assert the turn is still aborted via drop-cancellation within the renewal+poll budget, orchestration records `turn_stopped`, session idle and reusable.
6. **Abort reaches the SDK before the run-turn lock is released.** Instrumented `ManagedSession.abort()`; lock-holding turn; `abortWarmSessionTurn` lands while the lock is held; a lock-taking implementation must fail this test.
7. **Same-affinity concurrency probe (environment gate).** Long-running session-affined activity; schedule a second same-key activity mid-flight; assert overlap with stable `workerNodeId` and serialization without it. (`scripts/probe-duroxide-session-affinity-concurrency.mjs` is the standalone version.)
8. **Stop vs `wait()` collision.** Model calls `wait()` as Stop wins the race → no durable timer armed, session idle, `turn_stopped` recorded.
9. **Hang escalation.** Fake Copilot session that never fires `session.idle` after abort → `forceSettleTurn` → outcome `stop_forced`, no retry machinery, warm session invalidated, next prompt recreates the session and completes.
10. **Children unaffected.** Stop a parent turn; children alive, metadata intact, buffered child updates delivered on the parent's next turn.
11. **Cron survival.** Stop a cron-fired turn; assert the schedule re-arms and the next cron fire still happens.
12. **SDK abort primitive contract.** Keep the `CopilotSession.abort()` → `session.abort` RPC unit probe against SDK drift.
13. **System session stop.** Stop a running system-agent turn; same semantics — session idle and reusable, schedule/loop survives, no restart disposition triggered.

UI/controller: running session exposes `Stop`; idle hides it; click calls `transport.stopSessionTurn` once; `no_active_turn` and error outcomes surface without clearing the session. Portal smoke: long turn → Stop → button shows stopping → session returns to idle → chat usable.

## Rollout

- New orchestration version `1.0.56` (freeze `1.0.55`) — the race changes every turn's yield sequence. The registry routes existing sessions to their frozen versions; no resets.
- CMS migration for `active_turn_index`.
- `workerNodeId` is already set in AKS (`POD_NAME`) and the CLI (`local-${index}`); add a startup warning for unset deployments (fast path degrades to backstop latency) and keep test 7 as the environment gate.
- Raise/document `PILOTSWARM_WORKER_CONCURRENCY` sizing (E8).
- Backend first, UI second.

## Decisions (2026-07-01)

- **Recursive stop: no.** Stop never cascades to children (E10); stop a child by selecting it directly.
- **Summarization: no.** Stopped turns are recorded as durable events only; they do not feed session summaries.
- **System sessions: yes.** Stop is exposed for system sessions exactly like user sessions — same orchestration, same `runTurn` machinery, same semantics (test 13). Restart dispositions remain a separate, more drastic action.
- **Backstop latency: accepted as-is.** The ~2–7s drop-cancellation lane (lock-renewal detection + 2s `isCancelled` poll) needs no tuning for v1.
- **In-flight tools: deferred.** Tool-level kill semantics (an aborted turn may leave a spawned shell process running server-side) tracked in `TODO.md`, not in this design.

## Follow-Ups

- **Retry-backoff stop (E6):** add a drain-time `stop_turn` command to `handleCommand` so users can stop a session that is sleeping between error retries — v1.1, separate version bump.
