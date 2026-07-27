# Bug: Copilot `session.resume` can remain pending forever

**Filed:** 2026-07-26

**Severity:** High - durable sessions remain unavailable and queued messages accumulate

**Component:** `pilotswarm-sdk` session lifecycle (`SessionManager.getOrCreate` / Copilot SDK resume)

**Observed in:** Waldemort CHK, `pilotswarm-sdk` 0.5.23, orchestration 1.0.68, six AKS workers

---

## Summary

Two long-lived durable sessions became stuck in the portal's
`rehydrating` state. In both cases, versioned blob hydration completed and the
restored local session directory passed the lifecycle preamble. Execution then
stopped at:

```text
[runTurn] [SessionManager] ... turn>0 resuming from local session directory
```

No success, error, activity timeout, affinity release, or turn completion
followed for hours. Restarting the two workers holding the activities caused
Duroxide to reassign both `runTurn` activities. Each session hydrated the same
snapshot, completed `resumeSession()`, and resumed normal model/tool work.

The immediate platform defect is an unbounded await around the Copilot SDK's
`client.resumeSession(...)`. PilotSwarm's turn and inactivity watchdogs begin
only after `getOrCreate()` returns a `ManagedSession`, so they cannot recover a
resume RPC that never settles.

The two affected sessions have unusually large `events.jsonl` histories, which
made successful resume take about 3-10 seconds after restart. Size is useful
context but is not sufficient to reproduce the permanent hang. The original
Copilot CLI emitted no error-level log for the pending RPC, so whether the
trigger was connection loss, credential replacement, or another CLI failure
remains unconfirmed.

## Impact

- The session remains `running` but cannot process its current or queued turns.
- The portal says `rehydrating` even though storage hydration already finished.
- User messages and child updates continue to enqueue behind the stuck activity.
- Existing connection-closed retry and lossy-handoff recovery never runs because
  `resumeSession()` neither returns nor throws.
- Recovery requires external intervention to terminate the worker process that
   owns the unresolved RPC.

## Evidence

### Affected session footprints (context, not a proven trigger)

| Session | Turns | Snapshot bytes | Raw transcript bytes | Hydrated directory | `events.jsonl` | Event lines |
|---|---:|---:|---:|---:|---:|---:|
| R2D watcher | 940 | 18,458,684 | 417,976,320 | 399 MB | 397 MB | 48,814 |
| PilotSwarm Dev | 557 | 11,327,811 | 112,179,200 | 108 MB | 106 MB | 26,660 |
| Recovered comparison session | 78 | 1,937,620 | 16,087,040 | not measured | not measured | not measured |

Both affected footprints were assessed as degraded because of repeated
compaction generations and failed/stuck compactions. Context utilization itself
was low (about 12% and 22%); this is not a context-window exhaustion failure.
Both large snapshots resumed successfully after worker replacement.

### R2D timeline

```text
2026-07-26T09:47:26.092Z runTurn scheduled on worker ...-2cll6
2026-07-26T09:47:27.983Z versioned hydrate complete version=941
2026-07-26T09:47:28.060Z resume probe turnIndex=941 localExists=true storedExists=true inMemory=false
2026-07-26T09:47:28.060Z turn>0 resuming from local session directory
<no later runTurn log, completion, or error>
```

The orchestration remained in execution 491, activity 75. Two later messages
queued successfully while the activity remained stuck.

### PilotSwarm Dev timeline

```text
2026-07-26T16:34:40.480Z runTurn scheduled on worker ...-wgn6g
2026-07-26T16:34:41.335Z versioned hydrate complete version=553
2026-07-26T16:34:41.355Z resume probe turnIndex=558 localExists=true storedExists=true inMemory=false
2026-07-26T16:34:41.355Z turn>0 resuming from local session directory
<no later runTurn log, completion, or error>
```

The orchestration remained in execution 262, activity 32.

### Controlled worker restart recovery

At 2026-07-27T01:43Z, only the two owning worker pods were deleted. The
deployment returned to six ready workers with zero container restarts. Duroxide
reassigned both abandoned activities.

R2D resumed on replacement pod `...-fxpj9`:

```text
2026-07-27T01:44:32.255Z runTurn activity 75 reassigned to ...-fxpj9
2026-07-27T01:44:34Z     versioned hydrate complete version=941
2026-07-27T01:44:34.620Z resume probe localExists=true storedExists=true inMemory=false
2026-07-27T01:44:34.621Z turn>0 resuming from local session directory
2026-07-27T01:44:44.792Z invoking ManagedSession.runTurn
2026-07-27T01:47:50Z     active model and tool events continue
```

PilotSwarm Dev resumed on existing healthy pod `...-qdmgg`:

```text
2026-07-27T01:44:36.070Z runTurn activity 32 reassigned to ...-qdmgg
2026-07-27T01:44:36Z     versioned hydrate complete version=553
2026-07-27T01:44:36.992Z resume probe localExists=true storedExists=true inMemory=false
2026-07-27T01:44:36.992Z turn>0 resuming from local session directory
2026-07-27T01:44:39.779Z invoking ManagedSession.runTurn
2026-07-27T01:47:01Z     active model and tool events continue
```

This rules out corrupt or intrinsically unresumable snapshots. The defect is
specific to the original in-flight resume requests not settling when their
worker-side Copilot clients became unusable. Targeted worker replacement is a
successful recovery, but it should not be required.

### Snapshot integrity indicators

Both hydrated directories contained a current `.ps-snapshot-version` marker
whose version and content hash came from the completed hydrate. Neither
directory contained `.ps-turn-inprogress`, which is written only after
`getOrCreate()` returns. Therefore:

1. blob download/extraction completed;
2. the lifecycle preamble selected the hydrated snapshot;
3. on the original workers, the turn body did not start;
4. after worker replacement, resume returned and the turn body ran normally.

## Root Cause in PilotSwarm

The lifecycle activity in `packages/sdk/src/session-proxy.ts` performs:

1. `runTurnPreamble(lifecycle)`;
2. records `session.hydrated` when the preamble returns `kind: "hydrated"`;
3. calls `sessionManager.getOrCreate(...)`;
4. writes `.ps-turn-inprogress` only after `getOrCreate()` succeeds.

For an existing local directory, `packages/sdk/src/session-manager.ts` directly
awaits the Copilot SDK:

```ts
copilotSession = await client.resumeSession(sessionId, sessionConfig);
```

There is no timeout around this await. The Copilot SDK implementation sends the
`session.resume` RPC and awaits its response. Its startup and connection paths
have timeouts, but the individual resume request does not. If the RPC remains
pending rather than rejecting when its connection becomes unusable, the worker
activity has no way to make progress.

PilotSwarm's `DEFAULT_TURN_TIMEOUT_MS` and
`DEFAULT_TURN_INACTIVITY_TIMEOUT_MS` guards live in `ManagedSession.runTurn()`.
They are not active yet because no `ManagedSession` has been returned. As a
result, an unresolved resume RPC can hold the Duroxide activity forever.

## Why Other Sessions Recovered

During the same incident, smaller sessions reached ordinary
`Connection is closed` errors. The orchestration classified those as
recoverable transport loss, released affinity, and retried after the GitHub
Copilot credential was replaced.

These two sessions were already blocked inside `resumeSession()`. They never
returned an authentication or connection error to the orchestration, so they
could not enter that recovery path or re-resolve the changed per-user token.
Worker replacement created a fresh client, resolved the replacement credential,
and resumed both snapshots successfully.

## Expected Behavior

`getOrCreate()` must settle within a bounded time. If Copilot resume does not
complete, PilotSwarm should:

1. abandon and clean up the pending session handle;
2. recycle the affected Copilot client/connection so a late RPC response cannot
   mutate current state;
3. throw a typed recoverable resume-timeout error;
4. let durable orchestration release affinity and retry on another worker;
5. stop after the existing bounded retry policy and surface a terminal recovery
   action instead of looping forever.

## Suggested Fix

### 1. Add a bounded resume timeout

Wrap every worker-side `client.resumeSession()` call in a timeout owned by
`SessionManager`, including retry/dehydrate helper paths. Make the timeout
configurable, for example `PILOTSWARM_SESSION_RESUME_TIMEOUT_MS`, with a
conservative default such as 120 seconds.

The error should have a stable code such as
`PILOTSWARM_SESSION_RESUME_TIMEOUT`; do not rely only on message matching.

### 2. Recycle the client after timeout

Timing out only the JavaScript promise is insufficient because the RPC remains
in flight. Remove the provisional session and dispose/recreate the token-keyed
Copilot client connection before retrying. A late `session.resume` response must
not register stale state after recovery has moved elsewhere.

### 3. Start an activity-level watchdog before `getOrCreate()`

Defense in depth: the whole `runTurn` activity should have a watchdog covering
the lifecycle preamble, hydration bookkeeping, `getOrCreate()`, and the managed
turn. The existing managed-turn watchdog does not cover setup failures.

### 4. Improve lifecycle observability

Emit explicit events or traces for:

- `session.resume_started`;
- `session.resume_completed` with duration and hydrated event-log size;
- `session.resume_timeout` with worker, elapsed time, and retry disposition.

The UI should not continue to label a session `rehydrating` after hydration has
completed and resume has begun.

### 5. Measure and bound durable history growth

Context compaction does not shrink the restored Copilot `events.jsonl`. Add
resume-duration telemetry and consider a supported regeneration/archive path or
footprint threshold so long-lived cron sessions do not indefinitely replay
hundreds of megabytes of event history. This is defense in depth, not the primary
fix for the unresolved RPC.

## Regression Tests

1. Fake `CopilotClient.resumeSession()` with a promise that never settles;
   assert `getOrCreate()` rejects with the typed timeout within the configured
   bound.
2. Resolve the fake resume after timeout; assert the late result cannot enter
   `SessionManager.sessions` or mutate the active client.
3. Close or invalidate the fake client connection while resume is pending;
   assert the request rejects or times out rather than remaining unresolved.
4. Run a durable turn with hydrated state and a hung resume; assert the activity
   returns an error and orchestration executes bounded affinity-release retry.
5. Kill the assigned worker during resume and assert the re-leased activity
   completes on a replacement worker.
6. Exercise a large synthetic `events.jsonl` fixture and record resume duration
   so size-related regressions are visible.
7. Verify `session.hydrated` is followed by `session.resume_started` and exactly
   one of `session.resume_completed` or `session.resume_timeout`.

## Acceptance Criteria

- No Copilot resume RPC can hold a `runTurn` activity indefinitely.
- Worker restart causes bounded recovery or a clear terminal error.
- Retry resolves the latest per-user GitHub Copilot credential.
- The UI distinguishes hydration from Copilot resume.
- Late completion from a timed-out RPC cannot corrupt or replace current state.
- Large-session resume behavior is covered by an executable regression test.

## Current Workaround

A targeted restart of each worker holding an unresolved resume activity recovered
both affected sessions without resetting durable state. Until a bounded resume
path ships, identify the worker from the last `runTurn` trace and replace only
that worker. Repeated compaction failures and oversized histories should be
addressed separately through supported session regeneration when available.
