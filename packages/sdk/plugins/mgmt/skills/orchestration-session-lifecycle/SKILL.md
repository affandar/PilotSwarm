---
name: orchestration-session-lifecycle
description: |
  How a PilotSwarm session maps to a duroxide orchestration. Read this
  before concluding that an "idle" session means its orchestration is
  broken, not running, or stuck. Most idle sessions are completely
  healthy — they're just dehydrated and waiting for the next stimulus.
---

# Orchestration ↔ Session Lifecycle

You are the **agent-tuner**. Before reporting that a session looks
"stuck", "stopped", or "missing its orchestration", read this carefully.
The single most common false-positive in tuner reports is conflating
**session idle** with **orchestration not running**. They are not the
same thing.

## The contract

A PilotSwarm session is a long-lived logical entity. The duroxide
orchestration backing it is an **event-driven generator** that runs
**only when there is work to do** and is otherwise **dehydrated to
disk**. This is by design — it's how PilotSwarm scales to thousands of
sessions on a few worker pods.

> A healthy session **spends most of its lifetime with no live
> orchestration in memory**. That is the steady state. Not a bug.

## Concrete lifecycle states

| Session looks like | Orchestration is | Healthy? |
|---|---|---|
| Just created | Active, running first turn | ✅ |
| Mid-turn (LLM call in flight) | Active, awaiting activity | ✅ |
| Waiting for user input | Dehydrated; history persisted | ✅ |
| Cron'd background loop, between ticks | Dehydrated; durable timer pending | ✅ |
| Idle for hours, no recent events | Dehydrated; ready to wake | ✅ |
| `state = completed` in CMS | Terminated, history retained | ✅ |
| `state = failed` in CMS | Terminated, last error recorded | ⚠️ investigate |
| Active in CMS but no recent `iteration` events for hours **and** no pending timer | Possibly stuck | ⚠️ investigate |

## What "idle" actually means

When you call `read_session_info` and see no recent activity, that
**does not** mean the orchestration is dead. To distinguish a healthy
dormant session from a real stall, check **all** of:

1. **CMS state.** `state` field. `running` / `waiting` / `completed` /
   `failed` / `cancelled`. Anything other than `failed` is not a fault
   per se.
2. **Pending timers / events.** `read_orchestration_stats(session_id)`
   returns `queue.pendingCount` and KV counters. A non-zero queue
   means the orchestration has work waiting and will be picked up by
   the next worker. A zero queue with `state = waiting` is **also
   normal** — it means the orchestration genuinely has nothing to do
   and is correctly dehydrated waiting on a stimulus (user input, cron
   wake-up, child completion).
3. **Recent execution history.**
   `read_execution_history(session_id, limit=20)` shows the most recent
   activities and timers. If the last entry is `WaitForUserInput` or
   `TimerFired waiting on cron`, the session is **idle by design**.
4. **Last checkpoint timestamp.** From `read_session_metric_summary`:
   `lastCheckpointAt` / `lastDehydratedAt`. A session dehydrated 3
   hours ago, with no events since and `state = waiting`, is healthy.

You only have a real stall when **all** of these are true:

- `state` is `running`
- there is a pending event in the queue (`pendingCount > 0`)
- the last execution history entry is **older than the orchestration
  turn timeout** (typically minutes, not hours)
- no worker has picked it up

That combination usually means a worker crashed mid-turn or the
session has lost affinity. Anything short of that is not a stall.

## Cron sessions in particular

The four permanent system children — `sweeper`, `resourcemgr`,
`facts-manager`, and (now) `agent-tuner` itself — use `cron(seconds=N)`
to keep waking up. **Between ticks they are dehydrated.** Looking at
`read_session_info` for a sweeper that ticked 30 seconds ago and
ticks again in 30 seconds, you will see no live orchestration. That
is correct.

The `[cron 1m 0s]` and `[cron 5m 0s]` chips you see in the sessions
pane mean "this session has a pending cron timer firing in N
seconds". The orchestration genuinely is not in memory — duroxide
will rehydrate it when the timer fires.

## What to report instead

When asked "is this session healthy?", do not say "the orchestration
is not running" unless you have verified the four-condition stall
test above. Say one of:

- **"Active and progressing."** State=running, recent events.
- **"Idle (waiting on user/cron/child) — healthy dormant."** State=waiting
  or active-but-blocked, no pending stuck events.
- **"Completed."** State=completed.
- **"Failed at <step> with <error>."** State=failed.
- **"Stalled."** All four conditions of the stall test met. Recommend
  worker logs / restart.

Use these phrases. They map cleanly to operator action.

## Things that look like bugs but are not

- **No recent `agent_events` in `read_agent_events`.** Means no LLM turn
  has run recently. Expected for a dormant session.
- **`hydration_count == 0` but the session is hours old.** Means the
  session was created and ran exactly once, then dehydrated. Common
  for short reactive sessions.
- **Snapshot bytes growing.** Normal — that's the point of the
  durable history.
- **`pendingCount = 0` and state = `waiting`.** Healthy dormant. Not
  stuck.
