# Bug: User sessions skip dehydrate/hydrate cycle → unrecoverable SESSION_STATE_MISSING

**Filed**: 2026-04-04  
**Updated**: 2026-04-04 (root cause confirmed via DB forensics)  
**Severity**: High — session becomes permanently dead  
**Component**: `durable-session-v2` orchestration (pilotswarm-sdk)  
**Observed in**: downstream remote deployment (AKS, 4 workers, duroxide v1.0.33 / orchestration v1.0.33)

---

## Summary

The `durable-session-v2` orchestration does **not** call `dehydrateSession`/`hydrateSession` for user-created (non-system) sessions. System agents (resourcemgr, sweeper, facts-manager, pilotswarm) dehydrate and rehydrate on every cron cycle, making them resilient to worker restarts, pod eviction, and memory pressure. User sessions (for example, a downstream named-agent session) run purely in-memory with no periodic state persistence. When the in-memory Copilot session is lost for any reason, the session dies with `SESSION_STATE_MISSING` and cannot recover.

## Confirmed Root Cause

Comparison of orchestration activity patterns across all sessions on the same cluster:

| Activity | resourcemgr (system, **working**) | downstream user session (**dead**) |
|---|---|---|
| `hydrateSession` | **79 calls** (every cron cycle) | **0** |
| `dehydrateSession` | **79 calls** (every cron cycle) | **0** |
| `runTurn` | 79 | 95 (before death) |
| `summarizeSession` | 0 | 1 (when going idle) |

The resourcemgr's per-cycle pattern: `loadKnowledgeIndex` → `hydrateSession` → `runTurn` → `dehydrateSession` → timer → repeat.

The downstream user session's per-cycle pattern: `loadKnowledgeIndex` → `runTurn` → `listChildSessions` → timer → repeat. **No hydrate. No dehydrate.**

The `dehydrateSession` activity persists the Copilot session blob to the DB. The `hydrateSession` activity reconstitutes the Copilot session from that blob on whatever worker picks up the next cycle. Without these calls, the Copilot session exists only in-memory on one worker — and when that worker loses it, the session is unrecoverable.

## Symptoms

### Variant A — Infinite retry loop (pre-fix, observed on session `<session-a>`)
- `runTurn` returns `type=error` "Session not found" 
- Duroxide retries forever (15s backoff, new execution each attempt)
- Execution IDs climb rapidly (38→63+ observed)
- Session never recovers

### Variant B — Fatal failure (post-fix, observed on session `<session-b>`)
- `runTurn` returns `type=error` with `SESSION_STATE_MISSING`
- Orchestration correctly classifies as fatal, sets `status=failed`, terminates
- Session dies cleanly but is permanently dead
- Error: "turn 95 expected resumable Copilot session state for `<session-b>`, but none was found in memory, on disk, or in the session store."

Both variants share the same root cause: no blob was ever persisted, so there's nothing to recover from.

## Evidence: System Agents Survive Because They Dehydrate

The resourcemgr system agent on the same cluster has been dehydrating/rehydrating successfully for hours. The TUI shows:

> SYSTEM: The session was dehydrated and has been rehydrated on a new worker. The LLM conversation history is preserved.

This happens every cron cycle (300s for resourcemgr, 60s for sweeper/facts-manager/pilotswarm). The `dehydrateSession` activity is called 79 times across 79 iterations — once per cycle, with `{"reason":"cron"}`.

The `ContinuedAsNew` execution boundaries (seen on pilotswarm, facts-manager, sweeper at ~2.5h intervals) are a separate duroxide mechanism for history compaction. Dehydration happens independently within a single execution.

## Root Cause Analysis

### Timeline (session `<session-a>`)

1. Session worked normally for ~48 turns (a downstream infrastructure-management agent performing multi-step work)
2. At turn 48, user sent a follow-up message
3. `runTurn` was dispatched to worker `work-1-<app>-worker-<affinity-pod>`
4. `ManagedSession.runTurn` completed in **2ms** with `type=error`
5. Error: `Request session.send failed with message: Session not found: <session-a>`
6. Duroxide retried with 15s backoff → new execution → same error
7. This continued for 25+ executions with no recovery

### Key observations

- **No dehydration event** in the logs. The session was continuously running — it was NOT dehydrated and rehydrated.
- **Worker affinity is sticky**: `runTurn` always routed to the same pod (`<affinity-pod>`) due to wait-affinity, even though other activities (`loadKnowledgeIndex`, `listChildSessions`) ran on different pods (`<worker-a>`, `<worker-b>`, `<worker-c>`).
- **The Copilot session object was lost** from that worker's in-memory session store. The in-memory `SessionManager` on `<affinity-pod>` no longer has session `<session-a>`, so every `runTurn` call fails instantly.
- **No blob=true in the retry orchestrations**: `hydrate=false blob=false` — the orchestration isn't attempting to rehydrate from persisted state because it doesn't think the session was dehydrated.

### Why it doesn't recover

1. Duroxide retries `runTurn` but keeps routing to the same worker (wait-affinity)
2. That worker's `SessionManager` doesn't have the Copilot session in memory
3. Since there was no dehydration, the session blob may not have been recently persisted
4. `ManagedSession` doesn't attempt to reconstitute the session from conversation history or blob store on "not found" — it just fails
5. The retry loop is infinite because the error is classified as transient (attempt 1/3 → new execution) but the underlying condition is permanent on that worker

## Log Evidence

```
# runTurn dispatched to <affinity-pod>, fails in 2ms
02:37:27.532 [runTurn] invoking ManagedSession.runTurn for <session-a> ... worker_id=work-1-...-<affinity-pod>
02:37:27.534 [runTurn] ManagedSession.runTurn completed for <session-a> type=error ... worker_id=work-1-...-<affinity-pod>

# Orchestration sees the error, retries
02:37:52.158 [orch] turn returned error (attempt 1/3): Request session.send failed with message: Session not found: <session-a>
02:37:52.158 [orch] retrying in 15s after turn error

# New execution, same result
02:37:47.799 [runTurn] session=<session-a> ... worker_id=work-1-...-<affinity-pod>
02:37:48.150 [runTurn] ManagedSession.runTurn completed for <session-a> type=error ... worker_id=work-1-...-<affinity-pod>

# Meanwhile, other activities run fine on other pods
02:37:49.293 [listChildSessions] parent=<session-a> ... worker_id=work-1-...-<affinity-pod>
02:38:07.480 [loadKnowledgeIndex] ... worker_id=work-0-...-<worker-c>
02:38:10.058 [listChildSessions] ... worker_id=work-0-...-<worker-b>
```

Pattern repeats through execution 63+ with no recovery.

## Suggested Fixes

### Fix 1 (Critical): Add dehydrate/hydrate to the cron path for ALL sessions

The `durable-session-v2` orchestration must call `dehydrateSession` after `runTurn` and `hydrateSession` before `runTurn` for **every** session, not just system agents. The per-cycle pattern should be:

```
loadKnowledgeIndex → hydrateSession → runTurn → dehydrateSession → listChildSessions → timer
```

This is the primary fix. Without it, any user session with a cron is vulnerable to unrecoverable state loss.

### Fix 2: Dehydrate on idle transition

When a session transitions to `idle` (no cron, waiting for user input), the orchestration should call `dehydrateSession` before entering the wait state. Currently it only calls `summarizeSession` (conversation summary, not state persistence). This ensures the session can survive worker restarts even when idle.

### Fix 3: Reset wait-affinity on "Session not found" (duroxide)

When `runTurn` returns `type=error` with "Session not found", duroxide should reset the activity's wait-affinity so the next retry dispatches to a **different** worker. The current worker clearly lost the session — retrying on the same one is futile. (This was the Variant A infinite loop issue, partially addressed by the `SESSION_STATE_MISSING` fatal classification.)

### Fix 4: ManagedSession should attempt reconstitution on "not found" (SDK)

When `ManagedSession.runTurn` is called for a session ID that doesn't exist in the local `SessionManager`, it should:

1. Check the blob store for a persisted session state (if dehydration was implemented)
2. If found, reconstitute and retry the turn
3. If not found, return `SESSION_STATE_MISSING` (already implemented in latest SDK)

### Fix 5: Dehydrate before `ContinuedAsNew` (defense in depth)

When the orchestration hits the `ContinuedAsNew` threshold, it should dehydrate the session before completing the current execution. This ensures the new execution can always rehydrate. (System agents may already do this — verify.)

## Impact

- Wasted compute: 25+ retry executions burning LLM tokens for `loadKnowledgeIndex` and orchestration overhead
- Session permanently stuck: user cannot interact with the session
- Orchestration history bloat: execution count climbs indefinitely
- No self-healing: requires external intervention (wipe DB or manual session termination)

## Workaround

Currently the only recovery is to wipe the duroxide schemas and restart workers, which destroys all sessions.

## Reproduction

1. Deploy a downstream app in remote mode (for example, 4 AKS workers)
2. Start a long-running named-agent session
3. Run enough turns to accumulate significant conversation history (~48 turns)
4. At some point, the in-memory Copilot session on the affinity worker gets evicted (memory pressure, token refresh, API error)
5. The session enters the infinite retry loop

The exact trigger for the in-memory session loss is unclear — it may be related to Copilot API token expiry, memory pressure on the worker, or a race condition in the session manager.
