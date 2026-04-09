# Proposal: Lossy Session Recovery After Worker Restart

> **Status:** Proposal
> **Date:** 2026-04-08
> **Goal:** Recover user sessions after worker crash/restart destroys live Copilot session state before a durable dehydrate can finish.

---

## Summary

PilotSwarm already supports durable handoff when a session is successfully dehydrated into a shared `SessionStateStore`.

The failure we are now hitting is a narrower but important gap:

- a turn reaches a durable boundary such as `wait`, `timer`, or `cron`
- the worker container restarts before the dehydrate can archive the local Copilot session files
- the orchestration still resumes on the same stable worker identity
- the restarted container no longer has `/home/node/.copilot/session-state/<sessionId>`
- there is no blob snapshot to hydrate from
- the next turn fails with missing resumable state

We should treat that as a recoverable, lossy handoff rather than a terminal orchestration failure.

The recovery plan in this proposal is:

1. detect the missing-local-state dehydrate failure
2. record a warning-grade `session.lossy_handoff` event with structured details
3. let the orchestration continue to the next turn boundary
4. when the next turn cannot find in-memory, local, or stored session state, recreate a fresh Copilot session with the same PilotSwarm session id
5. replay the turn prompt with a strong system note explaining possible partial execution and data loss
6. let the LLM continue carefully or ask the user how to proceed

This proposal deliberately excludes previous-worker rescue for the first implementation pass. That follow-up should be tracked separately.

---

## Problem

### What is happening

For sessions such as `5537c21e-fb25-4cb5-b3b7-919b5754115c`, we observed:

- the turn reached `wait`
- the owning worker pod identity stayed the same
- the container restarted before `dehydrateSession(reason=timer)` ran
- `dehydrateSession` ran in the fresh container under the same pod identity
- the local session directory was already gone
- no blob archive was written
- the orchestration later tried to continue the session and found no resumable state

The important detail is that this is not primarily a blob transport failure. The failing path never reached tar upload.

### Why the current behavior is too brittle

Today, this case becomes a hard failure:

- `dehydrateSession` throws when the local directory is missing
- the orchestration can fail before the next turn
- even if the orchestration reaches the next turn, `runTurn` can fail with `SESSION_STATE_MISSING`
- CMS records a fatal error even though the durable orchestration context still exists and can still drive a replay

This is the wrong behavior for user experience and cluster resilience. We still have:

- the durable orchestration history
- the durable CMS facts/events/messages
- the current prompt being processed

What we lost is the most recent live Copilot session state, not the entire PilotSwarm session.

---

## Goals

- keep the orchestration alive through worker-restart state loss when replay is still possible
- make the degraded recovery explicit in CMS and UI
- preserve the same PilotSwarm session id and orchestration lineage
- replay with a system note that warns about possible partial execution
- avoid silently pretending the session resumed perfectly

## Non-Goals

- implementing previous-worker rescue in this first pass
- guaranteeing zero data loss after a worker crash
- preventing the crash itself
- solving pod recreation or node eviction durability by itself

---

## Observed Runtime Model

### What survives a worker restart

- durable orchestration history in Duroxide/Postgres
- CMS rows and session events
- blob-backed session state only if a checkpoint/dehydrate completed before the crash
- the stable Duroxide `worker_node_id` if the same pod identity comes back

### What does not survive

- in-memory `ManagedSession`
- in-memory Copilot SDK session object
- local session files under `/home/node/.copilot/session-state/<sessionId>` when they are stored only on the container filesystem

### Why the same worker can still get the next activity

Duroxide uses the stable `worker_node_id` as the session owner identity. A restarted worker with the same node id can reclaim or continue owning the session without waiting for lock expiry. That means:

- routing can still be correct
- local Copilot session files can still be gone

So “same worker identity” is not the same thing as “same live session process”.

---

## Proposed Recovery Behavior

### Phase 1: Dehydrate failure becomes warning-grade lossy handoff

When `dehydrateSession` fails with “session state directory not ready during dehydrate”:

- do not mark the session terminally failed
- do not write `session.error` for this specific case
- record `session.lossy_handoff` with structured details
- log the failure clearly with `session=<id>` and the dehydrate reason
- return success from the activity so the orchestration can proceed to its next boundary

Structured event data should include at least:

- `reason`
- `cause: "missing_local_session_state_during_dehydrate"`
- `message`
- `detail`
- `error`
- `recoveryMode: "fresh_session_replay"`
- `nextStep: "recreate_copilot_session_on_next_turn"`

This event should render as a yellow warning in the activity log and sequence map.

### Phase 2: Missing resumable state becomes lossy replay

On the next turn, if `runTurn` cannot find:

- warm in-memory session
- local session directory
- persisted session-store snapshot

then the runtime should:

1. record a warning-grade recovery notice in CMS
2. recreate a fresh Copilot session with the same PilotSwarm session id
3. replay the pending prompt with a system note that explains:
   - live state was lost on a worker restart
   - some very recent work may be missing
   - the previous turn may have partially executed
   - destructive actions should not be repeated blindly
   - the model may stop and ask the user how to proceed if needed

This keeps the session moving while making the degraded recovery explicit.

### Phase 3: Unrecoverable replay still fails normally

If fresh-session replay also fails in a way that still indicates missing state or live-session loss, the runtime may still fail terminally.

The proposal does not hide real unrecoverable failures. It only replaces an avoidable immediate fatal with a best-effort replay path.

---

## Why replay is acceptable

Replay is lossy, but it is better than immediate failure because:

- PilotSwarm still has the durable conversation and orchestration context
- most user tasks can continue after re-reading the visible state
- the LLM can reconcile or ask the user for guidance
- the degraded state is visible in CMS and the UI

The important safeguard is honesty. The replay note must say that prior work may have partially executed.

---

## Future Improvement: Previous-Worker Rescue

The full recovery ladder should eventually be:

1. use the last known worker identity as a hint
2. probe that worker for a surviving local session directory
3. if not found, hydrate from blob
4. if no blob exists, fall back to fresh-session replay

This proposal intentionally ships step 4 first because it is the smallest reliable improvement and does not require new worker-targeted rescue activities.

---

## Observability

### CMS events

Use `session.lossy_handoff` for this warning state, with distinct causes such as:

- closed-connection exhaustion
- missing local session state during dehydrate
- missing resumable state before replay

This keeps the warning class consistent while letting the UI and debugging tools inspect the precise cause from `data.cause`.

### Logging

Logs should include:

- `session=<sessionId>`
- activity name
- recovery phase
- dehydrate reason
- whether replay is starting
- whether replay succeeded or failed

### UI treatment

`session.lossy_handoff` should render yellow rather than red in:

- activity history
- sequence map

Red should remain reserved for terminal failures.

---

## Interaction With Other Hardening Work

This proposal complements but does not replace:

- `emptyDir` for pod-scoped local session files
- higher worker memory limits to reduce OOMs
- stronger pre-wait checkpointing
- future previous-worker rescue

Those improvements reduce the frequency of lossy replay. This proposal improves the behavior when we still hit it.

---

## Rollout Plan

1. document the recovery contract and observability model
2. implement warning-grade lossy handoff on missing-local-state dehydrate
3. implement fresh-session replay when resumable state is missing
4. expose the warning in CMS/UI as yellow
5. validate on AKS with the existing stress prompts
6. after that, add `emptyDir` and memory bump to reduce the trigger rate

---

## Open Questions

- whether replay should also stamp a dedicated `system.message` into the session history for user-facing transparency
- whether some tool categories should automatically refuse replay unless the model explicitly confirms intent
- whether future CMS/session summaries should count lossy recoveries as warnings in top-level health metrics
