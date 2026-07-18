---
name: durable-timers
group: Durable execution
description: Expert knowledge on durable timer patterns for recurring tasks, polling, and scheduled actions.
---

# Durable Timer Patterns

You are running in a durable execution environment with `wait`, `cron`, and `cron_at` tools that survive process restarts and node migrations.

## Patterns

### Recurring Task
```
1. cron(interval_seconds, reason="...")
2. Do work
3. Finish the turn normally
4. The orchestration wakes you again on the next interval
5. On each wake-up, perform the scheduled work before responding
```

### Wall-Clock Schedule
```
1. cron_at(minute=M, hour=H, tz="Area/City", reason="...")
2. Finish the turn normally
3. The orchestration wakes you at the next matching calendar instant
4. On each wake-up, perform the scheduled work described by the reason before responding
```

Use `cron_at` for named calendar times such as daily at 02:00 UTC, hourly at HH:05, Mondays at 09:00 America/New_York, or monthly on day 1 at 04:00. Use `max_fires: 1` for a one-shot scheduled-at-time action.

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
- Use `cron_at` for wall-clock schedules; do not wake every N minutes just to check the current time
- When a cron or cron_at wake-up resumes you, do the scheduled work immediately; do not merely say the schedule is active or resumed
- Use `wait` for one-shot delays, polling backoff, or short pauses inside a turn
- NEVER use `setTimeout`, `sleep`, or other external timing mechanisms
- Timer tools are durable: they persist across pod restarts and worker migrations
- The wait and cron tools accept seconds. For minutes: multiply by 60. The cron_at tool accepts explicit calendar fields and a required IANA `tz`
- By default, after a long wait you resume on potentially a different worker node — don't rely on in-memory state
- If the wait depends on this specific worker's local state (for example a local process, file, or socket), call `wait(..., preserveWorkerAffinity: true)`
- `preserveWorkerAffinity: true` is best-effort affinity preservation, not a hard same-node guarantee
