# Main Orchestration Loop

This document explains the current `durable-session-v2` orchestration loop that drives every PilotSwarm session.

Primary source files:

- [`packages/sdk/src/orchestration.ts`](/Users/affandar/workshop/drox/pilotswarm/packages/sdk/src/orchestration.ts)
- [`packages/sdk/src/session-proxy.ts`](/Users/affandar/workshop/drox/pilotswarm/packages/sdk/src/session-proxy.ts)
- [`packages/sdk/src/session-manager.ts`](/Users/affandar/workshop/drox/pilotswarm/packages/sdk/src/session-manager.ts)

## What The Orchestration Owns

The orchestration is the durable coordinator for a session. It owns:

- dequeueing user/control events
- deciding when to run the LLM turn
- timers (`wait`, `cron`, idle, input grace periods)
- sub-agent bookkeeping
- hydration/dehydration decisions
- `continueAsNew` boundaries
- durable custom status for the live session view

It does **not** own tool implementations or Copilot SDK session logic. Those live in worker activities and the session manager.

## Mental Model

```text
client / child sessions / commands
              │
              ▼
      duroxide message queue
              │
              ▼
      main orchestration loop
              │
      ┌───────┼────────┬──────────────┐
      │       │        │              │
      ▼       ▼        ▼              ▼
   runTurn   timers  child state   continueAsNew
      │
      ▼
  session-proxy activity
      │
      ▼
  SessionManager / ManagedSession / CopilotSession
```

## The Core Loop

At a high level, each orchestration execution repeatedly does:

1. warm or hydrate the session if needed
2. drain immediate queued work
3. decide the next action
4. run a turn, arm a timer, or checkpoint
5. continue until it reaches a clean durable boundary

```text
┌──────────────────────────────────────────────────────────┐
│ start / replay                                           │
├──────────────────────────────────────────────────────────┤
│ restore orchestration state                              │
│ ensure session is warm or hydrate if required            │
├──────────────────────────────────────────────────────────┤
│ drain queued work                                        │
│  - user prompts                                          │
│  - answers                                               │
│  - commands                                              │
│  - child updates                                         │
├──────────────────────────────────────────────────────────┤
│ decide next step                                         │
│  - run a turn                                            │
│  - wait / cron / idle timer                              │
│  - input_required                                        │
│  - no work -> continueAsNew                              │
├──────────────────────────────────────────────────────────┤
│ publish custom status                                    │
│ loop or continueAsNew                                    │
└──────────────────────────────────────────────────────────┘
```

## State Carried Across Replays

The orchestration input/state carries the durable control state needed to replay safely:

- session id and config
- iteration / turn counters
- pending prompt/answer state
- wait and cron schedule state
- sub-agent table
- title/summary metadata
- hydration and recovery flags

The key rule is: if a future turn needs it after a crash or `continueAsNew`, it must be explicit state, not hidden in process memory.

## Turn Execution

When the loop decides a prompt should be handled, it calls the session-scoped activity:

```text
orchestration
  │
  └─ scheduleActivityOnSession("runTurn", …)
         │
         ▼
   session-proxy activity
         │
         ▼
   SessionManager.getOrCreate()
         │
         ▼
   ManagedSession.runTurn()
         │
         ▼
   Copilot SDK session
```

The orchestration then consumes the returned `TurnResult` and updates durable state.

## TurnResult Dispatch

The main result categories are:

- `completed`
- `wait`
- `cron`
- `input_required`
- `spawn_agent`
- `message_agent`
- `error` / fatal failure paths

Each one updates orchestration state and usually publishes a new custom status snapshot.

## Timers

Timers are how the orchestration sleeps durably without holding a process open.

### One-shot wait

```text
LLM returns wait(seconds, reason)
        │
        ▼
orchestration stores wait state
        │
        ▼
scheduleTimer()
        │
        ├─ timer fires -> resume the session
        └─ user/input event arrives first -> interrupt the wait
```

### Cron

```text
LLM sets cron(seconds, reason)
        │
        ▼
orchestration stores cron schedule
        │
        ▼
turn completes
        │
        ▼
scheduleTimer(next fire)
        │
        ▼
cron wake-up prompt re-enters the loop
```

### Idle/input grace periods

The loop also uses timers for:

- input grace windows
- idle checkpoint/dehydrate windows
- retry backoff

## Hydration And Dehydration

The orchestration delegates hydration work to activities. The loop decides **when** to do it.

```text
warm session in worker memory
        │
        ├─ durable wait / cron / idle boundary
        ▼
dehydrate activity
        │
        ▼
session state store
        │
        ▼
later execution decides it needs a warm session
        │
        ▼
hydrate activity
        │
        ▼
SessionManager resumes the session
```

The store implementation determines whether this is blob-backed, filesystem-backed, or a test-only no-op store. The orchestration just calls the activities and assumes the worker was configured correctly.

## Recovery Path For Lost Warm Sessions

If a worker reports that the live session is missing during `runTurn`:

1. the session-proxy invalidates the stale warm session handle
2. it re-runs `getOrCreate()` to resume or hydrate
3. it retries the turn once with a recovery notice
4. if state still cannot be resumed, it returns an unrecoverable failure
5. the orchestration marks the session failed instead of retrying forever

That keeps missing state from turning into an infinite retry loop.

## Sub-Agents

Sub-agents are also orchestration state, not just UI state.

```text
parent turn returns spawn_agent / message_agent
              │
              ▼
orchestration starts or signals child session
              │
              ▼
child session runs independently
              │
              ▼
child update is routed back to parent queue
              │
              ▼
parent loop drains update and refreshes child table
```

The parent loop is responsible for:

- tracking child ids and states
- deciding whether children are still pending
- surfacing child completion into the next parent turn

## Why `continueAsNew` Exists

Without `continueAsNew`, orchestration history would grow forever and replay would slow down.

The loop therefore periodically checkpoints its durable control state and re-enters as a fresh orchestration execution with the same logical session.

```text
execution history grows
        │
        ▼
safe checkpoint reached
        │
        ▼
continueAsNew(next input snapshot)
        │
        ▼
fresh replay horizon, same logical session
```

## Determinism Rules

The loop must remain replay-safe.

That means orchestration code must not use:

- `Date.now()`
- `Math.random()`
- non-deterministic branching before yields
- direct I/O

Instead it must use duroxide primitives and explicit carried state.

## Where To Read Next

- [Architecture](./architecture.md)
- [Component Interactions](./component-interactions.md)
- [System Reference](./system-reference.md)
- [Implemented proposal: orchestration flat event loop](./proposals-impl/orchestration-flat-event-loop.md)
