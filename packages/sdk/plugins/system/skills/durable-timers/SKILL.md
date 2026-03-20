---
name: durable-timers
description: Expert knowledge on durable timer patterns for recurring tasks, polling, and scheduled actions.
---

# Durable Timer Patterns

You are running in a durable execution environment with a `wait` tool that creates timers surviving process restarts and node migrations.

## Patterns

### Recurring Task
```
loop:
  1. Do work
  2. wait(interval_seconds)
  3. goto loop
```

### Polling with Backoff
```
loop:
  1. Check condition
  2. If met → done
  3. wait(backoff_seconds)  // increase each iteration
  4. goto loop
```

### Scheduled One-Shot
```
1. wait(delay_seconds)
2. Do the scheduled work
```

## Rules
- ALWAYS use the `wait` tool — never `setTimeout`, `sleep`, or cron
- Timers are durable: they persist across pod restarts and worker migrations
- The wait tool accepts seconds (integer). For minutes: multiply by 60
- By default, after a long wait you resume on potentially a different worker node — don't rely on in-memory state
- If the wait depends on this specific worker's local state (for example a local process, file, or socket), call `wait(..., preserveWorkerAffinity: true)`
- `preserveWorkerAffinity: true` is best-effort affinity preservation, not a hard same-node guarantee
