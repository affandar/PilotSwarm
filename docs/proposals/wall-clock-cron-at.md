# Proposal: Wall-Clock Anchored Cron Schedules (`cron_at`)

> **Status:** Proposal
> **Date:** 2026-05-17
> **Issue:** https://github.com/affandar/PilotSwarm/issues/22
> **Goal:** Add a durable wall-clock scheduling primitive so agents can run at named calendar times without wake-and-check polling loops.

---

## Summary

PilotSwarm currently exposes `cron(seconds, reason)` for interval-based recurring work. That is the right primitive for "every N seconds/minutes" workloads, but it is inefficient and awkward for "run every day at 02:00 UTC" or "run Mondays at 09:00 America/New_York".

This proposal adds a sibling LLM tool, `cron_at`, that declares a wall-clock anchor once. The orchestration computes the next fire time, schedules a durable timer, and wakes the agent exactly at the next matching calendar instant. Existing interval `cron` remains unchanged.

The main intended outcome is cost control: a daily scheduled job should consume roughly one scheduled LLM turn per day, not 96 "wake every 15 minutes and check the clock" turns.

---

## Problem

Agents that need scheduled-at-time behavior currently have only interval timers:

- `wait(seconds, reason)` for one-shot delays
- `cron(seconds, reason)` for recurring fixed intervals

For wall-clock workloads, an agent must approximate calendar scheduling by waking frequently, reading the current time, deciding whether the target time has arrived, and sleeping again. That pattern has several problems:

- It burns LLM turns for no-op clock checks.
- It repeatedly re-serves system prompts, skills, and tool schemas.
- It scales poorly across tenants and per-customer agents.
- It invites prompt-level timer math instead of durable runtime-owned scheduling.
- It is error-prone around time zones, DST, and month boundaries.

Example: a nightly compliance agent that should run once at 02:00 UTC. With `cron(900)` plus a time-check guard, it wakes about 96 times per day for one useful run. With `cron_at`, it wakes once.

---

## Goals

- Add a first-class `cron_at` tool for wall-clock recurring schedules.
- Keep existing `cron(seconds, reason)` behavior unchanged.
- Make time zone choice explicit with a mandatory IANA `tz` field.
- Move next-fire computation into the runtime, not the LLM prompt.
- Handle hourly, daily, weekly, and monthly schedules with named fields.
- Support one-shot scheduled wall-clock actions via `max_fires: 1`.
- Persist enough schedule state for crash recovery, dehydration, and replay.
- Provide clear events/status so operators can inspect next fire time and schedule kind.
- Update durable timer skill docs to steer agents away from wake-and-check polling.

---

## Non-Goals

- Full cron-expression syntax such as `0 9 * * 1`.
- Multiple active schedules per session.
- Per-day distinct times, such as weekday 09:00 and weekend 11:00.
- Last-day-of-month or last-weekday semantics.
- Absolute `start_at` / `end_at` bounds. `max_fires` covers the v1 stop-after-N case.
- Changing interval `cron` semantics.

---

## User-Facing Tool API

### `cron_at(...)`

```ts
cron_at({
  minute: number,          // required, 0-59
  hour?: number,           // 0-23; omit for hourly recurrence
  day_of_week?: number,    // 0-6, Sunday = 0; weekly, requires hour
  day_of_month?: number,   // 1-31; monthly, requires hour
  tz: string,              // required IANA zone, e.g. "UTC" or "America/Los_Angeles"
  max_fires?: number,      // optional positive integer; omit means fire forever
  reason: string,          // required wake-up purpose
})
```

### Recurrence Inference

| Fields | Recurrence | Example |
|---|---|---|
| `minute` | hourly | `{ minute: 5, tz: "UTC" }` fires every hour at `HH:05` |
| `minute + hour` | daily | `{ minute: 0, hour: 2, tz: "UTC" }` fires daily at 02:00 UTC |
| `minute + hour + day_of_week` | weekly | `{ minute: 0, hour: 9, day_of_week: 1, tz: "America/New_York" }` fires Mondays at 09:00 ET |
| `minute + hour + day_of_month` | monthly | `{ minute: 0, hour: 4, day_of_month: 1, tz: "UTC" }` fires on the 1st at 04:00 UTC |

### Cancellation

PilotSwarm should continue to expose only one active recurring schedule per session. Setting `cron_at` replaces an active interval `cron`, and setting interval `cron` replaces an active `cron_at`.

Cancellation should be accepted in both places for LLM ergonomics:

```ts
cron({ action: "cancel" })
cron_at({ action: "cancel" })
```

Both clear the single active recurring schedule.

### Tool Result

On successful schedule creation:

```json
{
  "status": "scheduled",
  "kind": "wall-clock",
  "nextFireAt": "2026-05-18T02:00:00.000Z",
  "tz": "UTC",
  "reason": "run nightly compliance audit"
}
```

The tool result should include `nextFireAt` so the model can answer the user with a concrete confirmation without doing calendar math.

---

## Validation Rules

Reject at tool validation time:

- missing `minute` when setting a schedule
- `minute < 0 || minute > 59`
- `hour < 0 || hour > 23`
- `day_of_week < 0 || day_of_week > 6`
- `day_of_month < 1 || day_of_month > 31`
- both `day_of_week` and `day_of_month` set
- `day_of_week` or `day_of_month` set without `hour`
- missing or invalid `tz`
- missing or blank `reason`
- `max_fires <= 0`
- non-integer calendar fields or `max_fires`

Do not silently default `tz` to UTC. Cross-tenant agents must choose their intended wall-clock domain explicitly.

---

## Calendar Semantics

### Day of Month

`day_of_month: 31` skips months that do not have a 31st. "Last day of month" is out of scope for v1.

### DST Spring Forward

If the requested local time does not exist because clocks skip forward, skip that occurrence and schedule the next valid recurrence.

### DST Fall Back

If the requested local time occurs twice, fire once for that wall-clock occurrence. Store a local occurrence key so replay/next-fire calculation does not double-fire the same local label.

### Time Zone Data And Replay

Time zone calculations depend on IANA tzdata, which may change over time. To keep orchestration replay safe, next-fire calculation should be performed by a recorded activity rather than recomputed entirely inside the orchestration generator.

The orchestration should yield an activity such as:

```ts
computeCronAtNextFire({ schedule, afterUtcMs, lastOccurrenceKey })
```

The activity returns:

```ts
{
  nextFireAtMs: number,
  occurrenceKey: string,
  localTime: string,
  skippedOccurrences?: number
}
```

Because activity results are recorded in durable history, replay reuses the original next-fire result even if tzdata or helper implementation changes later.

---

## Runtime State Model

Keep interval cron state unchanged and add a separate wall-clock state field rather than changing the existing serialized `CronSchedule` shape.

```ts
export interface CronAtSchedule {
  minute: number;
  hour?: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  tz: string;
  reason: string;
  maxFires?: number;
  firesCompleted: number;
  lastOccurrenceKey?: string;
  nextFireAtMs?: number;
  nextOccurrenceKey?: string;
}

export interface OrchestrationInput {
  cronSchedule?: CronSchedule;       // existing interval schedule
  cronAtSchedule?: CronAtSchedule;   // new wall-clock schedule
}
```

At runtime, exactly one of `cronSchedule` or `cronAtSchedule` should be active. This avoids compatibility churn in existing interval cron state and keeps UI/management code able to distinguish schedule kind.

---

## Orchestration Behavior

### Setting `cron_at`

When `ManagedSession` returns a queued `cron_at` action:

1. Clear any active interval `cronSchedule`.
2. Store `cronAtSchedule` with `firesCompleted = 0`.
3. Ensure recurring task context is preserved, same as interval cron.
4. Call `computeCronAtNextFire` with deterministic `afterUtcMs` from `yield ctx.utcNow()`.
5. Store `nextFireAtMs` and `nextOccurrenceKey`.
6. Return a normal inline tool result so the model can continue the turn.

### Completed Turn With Active `cron_at`

When a turn completes and `cronAtSchedule` is active:

1. If `max_fires` is set and `firesCompleted >= max_fires`, clear the schedule and emit `session.cron_at_completed`.
2. If `nextFireAtMs` is missing or stale, compute the next fire via the activity.
3. Record `session.cron_at_started` with schedule metadata and `nextFireAtMs`.
4. Publish custom status `waiting` with `cronActive: true`, `cronKind: "wall-clock"`, and `cronNextFireAt`.
5. Schedule a durable timer for `max(0, nextFireAtMs - nowMs)`.
6. Keep existing dehydration/checkpoint behavior by passing the computed wait seconds through `planWaitHandling`.

### Timer Fired

When the active timer fires:

1. Record `session.cron_at_fired` with `scheduledAt`, `occurrenceKey`, `tz`, and recurrence fields.
2. Increment `firesCompleted` exactly once for that scheduled occurrence.
3. If this was the final allowed fire, clear `cronAtSchedule` before or immediately after dispatching the wake prompt, and record `session.cron_at_completed`.
4. Run the LLM with a system prompt such as:

```text
[SYSTEM: Scheduled wall-clock cron wake-up for "run nightly compliance audit".
Schedule: daily at 02:00 UTC. Scheduled fire: 2026-05-18T02:00:00.000Z.
Resume your recurring task now.]
```

5. After the turn completes, schedule the next wall-clock fire if still active.

### User Or Child Interrupts

For user messages and material child updates that arrive while `cron_at` is waiting:

- interrupt behavior should match interval `cron`
- preserve the pending wall-clock occurrence rather than recomputing from the end of the interrupting turn
- if the scheduled time passed while the interrupting turn ran, fire the missed occurrence immediately after the turn completes unless the schedule was cancelled

This preserves "run at 02:00" semantics even when a user asks a question at 01:59.

---

## Custom Status And Events

### Custom Status

Keep current fields for interval cron and add optional wall-clock fields:

```ts
{
  cronActive: true,
  cronKind: "wall-clock",
  cronReason: string,
  cronNextFireAt: number,
  cronTimezone: string,
  cronMaxFires?: number,
  cronFiresCompleted?: number
}
```

For interval cron, continue publishing the existing `cronInterval` field. UI code can use `cronKind` when present and fall back to interval behavior when absent.

### Events

Add events:

- `session.cron_at_scheduled`
- `session.cron_at_started`
- `session.cron_at_fired`
- `session.cron_at_completed`
- `session.cron_at_cancelled`

Existing interval events stay unchanged:

- `session.cron_started`
- `session.cron_fired`

---

## Implementation Plan

### 1. Add Types

Files:

- `packages/sdk/src/types.ts`
- `packages/sdk/src/orchestration/state.ts`

Add:

- `CronAtSchedule`
- `TurnAction` variant for `cron_at`
- `OrchestrationInput.cronAtSchedule?`
- runtime state copy/continue-as-new support

Use optional fields only so existing serialized orchestration inputs remain byte-compatible when the feature is unused.

### 2. Add Next-Fire Helper And Activity

Files:

- `packages/sdk/src/cron-at.ts` (new pure helper)
- `packages/sdk/src/session-proxy.ts` (new activity registration)

Recommended implementation:

- Use `Temporal` via `@js-temporal/polyfill` unless native `Temporal` is available and tested.
- Keep the helper deterministic for a fixed tzdata version.
- Record the result through the activity to protect replay from tzdata drift.

Activity:

```ts
computeCronAtNextFire(input: {
  schedule: CronAtSchedule;
  afterUtcMs: number;
  lastOccurrenceKey?: string;
}): Promise<{
  nextFireAtMs: number;
  occurrenceKey: string;
  localTime: string;
}>;
```

### 3. Add Tool Definition

File:

- `packages/sdk/src/managed-session.ts`

Add `cron_at` to both stub and live system tool definitions. It should be an inline scheduling/configuration tool like `cron`, not a turn-breaking tool.

### 4. Add Orchestration Handling

Files:

- `packages/sdk/src/orchestration/turn.ts`
- `packages/sdk/src/orchestration/lifecycle.ts`
- `packages/sdk/src/orchestration/queue.ts`
- `packages/sdk/src/orchestration/state.ts`

Add:

- `applyCronAtAction`
- schedule/cancel handling
- active timer type `cron_at`
- timer-fired handling
- interrupt/resume logic preserving `nextFireAtMs`
- status/event publication

### 5. Version The Orchestration

This changes orchestration helper behavior and timer branching, so it requires a new durable orchestration version.

Follow the repo's Duroxide orchestration versioning workflow:

- freeze the current latest orchestration/runtime version
- apply changes only to the new latest version
- register the new version in the orchestration registry
- do not modify frozen orchestration versions

### 6. Update Agent Prompt And Skills

Files:

- `packages/sdk/plugins/system/skills/durable-timers/SKILL.md`
- `packages/sdk/plugins/system/agents/default.agent.md`
- any builder templates that copy timer guidance
- docs that explain recurring timers

New guidance:

- Use `cron(seconds, reason)` for fixed intervals.
- Use `cron_at(...)` for wall-clock schedules.
- Do not implement wall-clock schedules by waking every N minutes to check the current time.
- Use `max_fires: 1` for one-shot scheduled-at-time actions.

### 7. Update UI/Management Read Surfaces

Files likely touched:

- `packages/sdk/src/management-client.ts`
- `packages/sdk/src/client.ts`
- `packages/ui-core/src/selectors.js`
- `packages/ui-react/src/web-app.js` if visible badges/tooltips need text
- native TUI surfaces if they render cron detail directly

Expose/read:

- schedule kind
- next fire time
- time zone
- fire count if capped

No user-facing write API should be added. Scheduling remains an LLM/runtime tool.

---

## Testing Plan

### Pure Helper Tests

New file suggestion:

- `packages/sdk/test/local/cron-at-schedule.test.js`

Cover:

- hourly next fire
- daily next fire
- weekly next fire
- monthly next fire
- `day_of_month: 31` skips short months
- rejects invalid field combinations
- rejects invalid timezone
- spring-forward nonexistent time skips occurrence
- fall-back duplicate wall time fires once
- `max_fires` validation

These should be deterministic and not require LLM calls.

### ManagedSession Tool Tests

Extend `packages/sdk/test/local/cron-tool.test.js`:

- `cron_at` queues an inline wall-clock schedule action without aborting the turn
- `cron_at(action="cancel")` queues cancellation
- `cron_at` and `wait` interaction mirrors interval cron: wait remains the primary blocking result, `cron_at` stays queued

### Orchestration Tests

Add or extend durability tests to cover:

- `cron_at` persists through continue-as-new
- dehydration/rehydration around long wall-clock waits
- timer fire produces `session.cron_at_fired`
- `max_fires: 1` fires once and then emits `session.cron_at_completed`
- user message interrupt before the scheduled instant preserves the pending scheduled fire

Use short computed delays by choosing an anchor just after the deterministic test start time when possible. For calendar edge cases, test the helper/activity directly rather than waiting in real time.

### Contract Tests

Update existing tool contract expectations:

- `cron_at` appears in always-on system tools
- tool schema has named calendar fields and no cron-expression parameter
- durable-timers skill contains the wall-clock pattern and forbids wake-and-check loops

---

## Risks And Mitigations

| Risk | Mitigation |
|---|---|
| Timezone calculations break replay after tzdata changes | Compute next fire in a recorded activity |
| LLM confuses interval `cron` and wall-clock `cron_at` | Update tool descriptions and durable-timers skill with clear decision rules |
| DST semantics surprise users | Lock spring-forward/fall-back behavior in tests and docs |
| Adding schedule fields breaks existing cron state | Use separate optional `cronAtSchedule` field; leave `cronSchedule` shape unchanged |
| Missed fire during user interrupt | Preserve pending `nextFireAtMs` and fire immediately after interrupting turn if overdue |
| UI assumes `cronInterval` always exists when `cronActive` | Add `cronKind`; preserve interval fields for interval cron and update selectors defensively |

---

## Acceptance Criteria

- Agents can call `cron_at({ minute, hour, tz, reason })` and receive a concrete next fire time.
- Daily/weekly/monthly wall-clock jobs do not require no-op clock-check LLM turns.
- Existing `cron(seconds, reason)` behavior and tests continue to pass unchanged.
- `max_fires: 1` performs a one-shot wall-clock scheduled action and then clears itself.
- DST and short-month behavior is covered by deterministic helper tests.
- Schedule state survives dehydration, worker restart, and continue-as-new.
- UI/management read surfaces show wall-clock cron status and next fire time.
- Durable timer skill docs teach `cron_at` and explicitly forbid wake-and-check polling for wall-clock schedules.

---

## Open Questions

1. Resolved: `cron_at` should support `action: "cancel"` in v1.
2. Resolved: the first fire may be scheduled at `now` if the anchor exactly equals the current minute.
3. Resolved: fall-back hourly schedules should fire once per repeated wall-clock label, not once per actual elapsed UTC instant.
4. Resolved: PilotSwarm should add a small wrapper around Temporal/time-zone scheduling so runtime code is insulated from native-vs-polyfill details.
