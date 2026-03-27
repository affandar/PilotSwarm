---
name: durable-timers
description: Expert knowledge on durable timer patterns for recurring tasks, polling, and scheduled actions.
---

# Durable Timer Patterns

You are running in a durable execution environment with `wait` and `cron` tools that survive process restarts and node migrations.

## Patterns

### Recurring Task
```
1. cron(interval_seconds, reason="...")
2. Do work
3. Finish the turn normally
4. The orchestration wakes you again on the next interval
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
- Use `cron` for recurring or periodic work
- Use `wait` for one-shot delays, polling backoff, or short pauses inside a turn
- NEVER use `setTimeout`, `sleep`, or other external timing mechanisms
- Both timer tools are durable: they persist across pod restarts and worker migrations
- The wait and cron tools accept seconds. For minutes: multiply by 60
- By default, after a long wait you resume on potentially a different worker node — don't rely on in-memory state
- If the wait depends on this specific worker's local state (for example a local process, file, or socket), call `wait(..., preserveWorkerAffinity: true)`
- `preserveWorkerAffinity: true` is best-effort affinity preservation, not a hard same-node guarantee
