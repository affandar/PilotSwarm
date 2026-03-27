# Cron Tool — Declarative Recurring Schedules

## Status

Implemented

## Problem

The current `wait()` tool is imperative — the LLM must call it at the end of every turn to keep a recurring loop alive. If the LLM forgets (common with gpt-5.4), the loop dies silently. We've added prompt hardening (rules 5-6), a forgotten-timer safety net (orchestration nudge), and child-update batching to work around this, but the root cause remains: the orchestration depends on the LLM remembering to call `wait()` every single turn.

## Solution

Add a `cron` tool that lets the LLM declare a recurring schedule once. The orchestration owns the timer loop — not the LLM.

## Tool API

### `cron(seconds, reason)` — Set or update a recurring schedule

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `seconds` | number | yes | Interval between wake-ups (minimum 15s) |
| `reason` | string | yes | What the LLM should do on each wake-up (e.g. "check sub-agents and summarize news") |

Returns: `{ status: "scheduled", interval: 45, reason: "..." }`

### `cron("cancel")` — Cancel the active schedule

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `"cancel"` | yes | Cancels the active cron |

Returns: `{ status: "cancelled" }`

### Design decisions

- **Simple interval, not cron syntax.** LLMs will butcher `*/5 * * * *`. Every real use case is "every N seconds."
- **One cron per session.** Calling `cron()` again replaces the current schedule. No multi-cron complexity.
- **Minimum 15s interval.** Prevents runaway wake-ups.
- **`reason` is mandatory.** It becomes the wake-up prompt, so the LLM knows what to do on resume.

## Orchestration Behavior

### When `cron()` is called (new `case "cron"` in result dispatch)

1. Store cron state: `{ intervalSeconds, reason }` in `OrchestrationInput.cronSchedule`.
2. Respond to the LLM: `"Recurring schedule set: every {N}s — {reason}"`
3. Continue the current turn (LLM may do more work before completing).

### When a turn completes (`case "completed"`) with an active cron

Instead of going idle or requiring the LLM to call `wait()`:

1. Publish status `"waiting"` (same as current wait behavior).
2. Schedule a durable timer for `cronSchedule.intervalSeconds * 1000` ms.
3. Race timer against inbound messages (same as current wait race pattern).
4. **Timer fires →** `continueAsNew` with prompt:
   ```
   [SYSTEM: Scheduled cron wake-up for: "{reason}". Resume your recurring task.]
   ```
5. **User message interrupts →** deliver user message to LLM (same as wait interrupt). Cron stays active — next completed turn will schedule again.
6. **Child update interrupts (<=60s remaining) →** absorb silently (same as current batching).

### When `cron("cancel")` is called

1. Clear `cronSchedule` from orchestration state.
2. Respond: `"Recurring schedule cancelled."`
3. Subsequent `case "completed"` goes to normal idle behavior.

### Cron + `wait()` interaction

They're independent. Within a cron cycle, the LLM can still call `wait()` for one-shot delays:

```
[cron fires] → LLM spawns sub-agents → calls wait(10) to poll → poll completes →
LLM summarizes → turn completes → orchestration auto-schedules next cron fire
```

If the LLM calls `wait()` while a cron is active, `wait()` takes precedence for that specific pause. After the wait completes, the turn continues. When the turn eventually completes, the cron timer fires.

### Cron + dehydration

Cron timer is handled identically to wait timer for dehydration:
- If `intervalSeconds * 1000 > dehydrateThreshold` → dehydrate, fire timer, rehydrate.
- `cronSchedule` state survives in `OrchestrationInput` across `continueAsNew`.

## State Changes

### `OrchestrationInput` (types.ts)

```typescript
/** Active recurring schedule set by the cron tool. */
cronSchedule?: {
    intervalSeconds: number;
    reason: string;
};
```

Carried across `continueAsNew` in `continueInput()`.

### `customStatus` (published to CMS)

Add `cronActive: boolean` and `cronInterval: number` to the custom status so the TUI can show cron state.

## Files to Modify

| File | Change |
|------|--------|
| `src/types.ts` | Add `cronSchedule` to `OrchestrationInput` |
| `src/managed-session.ts` | Add `cron` tool definition + result type |
| `src/orchestration.ts` | Add `case "cron"` handler + cron-aware idle logic in `case "completed"` |
| `plugins/system/agents/default.agent.md` | Add `cron` to tools list + update rules |
| `packages/cli/cli/tui.js` | Show cron state indicator in session list |

## Agent Prompt Changes

Rules 5-6 change from:

> 5. NEVER end a turn without calling `wait()` if you have pending recurring work...
> 6. Every turn that is part of a recurring loop MUST end with a `wait()` call...

To:

> 5. For recurring/periodic tasks (monitoring, polling loops, scheduled digests), use `cron(seconds, reason)` once. The orchestration handles the schedule — you do NOT need to call `wait()` at the end of each turn.
> 6. Use `wait(seconds)` only for one-shot delays within a turn (e.g. poll sub-agents, brief pause before retry). `wait()` is not needed for recurring loops if `cron` is active.
> 7. Use `cron("cancel")` to stop a recurring schedule.

The forgotten-timer safety net remains as a fallback but should rarely fire once `cron` is adopted.

## Example Flow

User: "Monitor news headlines every 45 seconds"

```
Turn 1: LLM calls spawn_agent(3 news agents), calls cron(45, "check sub-agents and summarize news"), outputs "Started monitoring."
         → orchestration stores cronSchedule, schedules 45s timer
         → [45s passes]
Turn 2: Orchestration wakes LLM with "[SYSTEM: Scheduled cron wake-up for: check sub-agents and summarize news]"
         → LLM calls check_agents, reads facts, outputs summary table
         → turn completes → orchestration auto-schedules next 45s timer
         → [45s passes]
Turn 3: Same pattern, indefinitely
         ...
User: "Stop monitoring"
Turn N: LLM calls cron("cancel"), outputs "Monitoring stopped."
         → turn completes → goes to normal idle (no more cron fires)
```
