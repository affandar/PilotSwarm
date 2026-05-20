# Bug: No-op child watcher updates wake parent LLM during cron waits

**Status:** Open  
**Filed:** 2026-05-17  
**Component:** `@pilotswarm/sdk` durable orchestration / sub-agent parent notification / cron wait handling  
**Affected versions:** observed in live Waldemort worker on durable session orchestration `v1.0.52`; equivalent behavior is present in `packages/sdk/src/orchestration_1_0_51.ts` and earlier versioned orchestration files  
**Severity:** Medium — monitoring stays correct, but parent sessions can be woken repeatedly for no-op heartbeats, causing noisy LLM turns and confirmation repings without user input

---

## Summary

Recurring child watcher sessions send a `CHILD_UPDATE ... type=completed` message to their parent after every completed turn, even when the child result is only a no-op heartbeat such as "No change" or "No new reportable change".

The parent durable orchestration treats any buffered child update as work that should interrupt its active cron wait. It hydrates the parent session, runs a parent `runTurn`, and prompts the LLM with an internal system message saying child updates arrived while the recurring schedule was waiting.

When the parent has a user-confirmation-gated write bundle pending, those no-op child heartbeats cause repeated assistant messages such as:

```text
Awaiting confirmation for the displayed `5280429` rejection bundle. No ADO writes made.
```

The parent did go idle after each message; the issue is that no-op child updates kept waking it.

## Observed Production Trace

Live Waldemort session:

```text
parent session: b27bc130-549c-4010-affc-9669d21dcde0
agent: r2d-watcher
train: M62
model: github-copilot:gpt-5.5
orchestration_version: 1.0.52
```

The parent displayed a confirmed-write bundle for work item `5280429` and then went idle. Before the user confirmed, it emitted repeated reminders.

Parent `runTurn` map:

| Time | Trigger | Result |
|---|---|---|
| `14:42:00-14:42:25` | User prompt: reject item because basic R2D info is missing | Generated the rejection bundle and idled |
| `14:43:26-14:43:32` | Internal child-update wake | Repeated "Awaiting confirmation..." |
| `14:45:41-14:46:10` | Internal child-update wake | Repeated "Awaiting confirmation..." |
| `14:49:17-14:49:25` | Internal child-update wake | Repeated "Awaiting confirmation..." |
| `14:50:37-14:51:07` | Internal child-update wake after continue-as-new | Repeated "Awaiting confirmation..." |
| `14:51:46-14:52:41` | User prompt: `confirmed.` | Began applying the bundle |

The session transcript had `session.idle` and `session.turn_completed` after each reminder, so this was not one long LLM call and not the model waiting for minutes. It was multiple short parent turns caused by child update messages.

## Why It Looked Like Frequent Repinging

Each child was on a reasonable schedule, but there were several children and their cron offsets were staggered.

Direct child sessions under the parent at the time:

| Watcher | Cron interval | Last active |
|---|---:|---:|
| `5202494 / 5283628` | `900s` | `14:53:43` |
| `5116649 / 5283624` | `900s` | `14:54:01` |
| `5219314 / 5283792` | `900s` | `15:01:00` |
| `4722893 / 5283582` | `900s` | `15:03:52` |
| `5202956 action` | `900s` | `15:04:41` |
| `5281013 / 5283857` | `3600s` | `14:41:55` |
| `5280429 / 5283890` | `3600s` | `14:54:35` |

Five 15-minute child watchers staggered across the hour can produce an aggregate parent-visible update roughly every few minutes. The intervals are sane per child; the noisy behavior is the parent-visible notification policy.

Representative child turn completions:

| Time | Child | Result |
|---|---|---|
| `14:37:58` | `5202494 / 5283628` | No change |
| `14:38:23` | `5116649 / 5283624` | No drift |
| `14:41:59` | `5281013 / 5283857` | Cycle quiet |
| `14:44:36` | `5219314 / 5283792` | No new reportable change |
| `14:48:05` | `4722893 / 5283582` | No change |
| `14:48:45` | `5202956 action` | No change |
| `14:53:43` | `5202494 / 5283628` | No change |
| `14:54:01` | `5116649 / 5283624` | No drift |
| `14:54:35` | `5280429 / 5283890` | No change |

## Implementation Evidence

In `packages/sdk/src/orchestration_1_0_51.ts`, completed child turns always notify the parent if `parentSessionId` exists:

```ts
yield manager.sendToSession(parentSessionId,
    `[CHILD_UPDATE from=${input.sessionId} type=completed iter=${iteration}]\n${result.content.slice(0, 2000)}`);
```

The same file also notifies the parent when a child returns `wait`:

```ts
yield manager.sendToSession(parentSessionId,
    `[CHILD_UPDATE from=${input.sessionId} type=wait iter=${iteration}]\n${notifyContent}`);
```

The parent buffers child updates for only 30 seconds:

```ts
const CHILD_UPDATE_BATCH_MS = 30_000;
```

When buffered child updates arrive during the parent's cron wait, `processPendingChildDigest()` clears the active cron timer and calls `processPrompt(...)` with an internal system prompt:

```text
This is an internal orchestration wake-up caused by child session updates; the user did not send a new message.
Buffered child updates arrived while your recurring schedule was waiting for the next wake-up (...).
Review the updates and continue your task now.
```

This is a good behavior for material child results. It is too eager for recurring no-op watcher heartbeats.

## Actual Behavior

1. Parent has a cron wait active.
2. Child watcher wakes on its own 15-minute or 1-hour cron.
3. Child checks ADO state and finds no changes.
4. Child returns `completed` with content like "No change".
5. Runtime sends `CHILD_UPDATE ... type=completed` to the parent.
6. Parent cron wait is interrupted by the child digest.
7. Parent LLM runs even though there is no material change.
8. If a gated write bundle is pending, parent repeats an "awaiting confirmation" message.
9. Parent idles again, then repeats when another staggered child heartbeat arrives.

## Expected Behavior

No-op child watcher heartbeats should not wake the parent LLM by default.

The child should still persist its watch state/facts so the system can audit that it ran, but the parent should only receive a user-visible/wake-triggering child update when something material happened.

Examples of material child updates:

- watched ADO item `rev`, state, tags, or comments changed;
- required owner answer appeared;
- blocker/action Task changed state or became `Done`;
- tracker became malformed or compliance changed;
- child hit an error;
- parent explicitly called `check_agents` or `wait_for_agents` and requested a status/result.

Examples of non-material updates that should remain quiet by default:

- "No change";
- "No drift";
- "No new reportable change";
- cron heartbeat summaries where all tracked baselines still match.

## Likely Root Cause

The sub-agent notification channel currently has no notion of notification significance or parent wake policy. Any child `completed` or `wait` result becomes a parent message, and any parent child-digest message can interrupt cron waits.

This design works for short-lived analysis sub-agents where completion is always interesting. It does not work well for long-lived watcher children whose normal/healthy state is repeated no-op completion.

## Suggested Fixes

### Fix 1: Add child update significance / notification policy

Add a runtime-supported policy such as:

```ts
notifyParent: "always" | "on-change" | "on-error" | "never"
```

or a structured child result field such as:

```ts
parentNotification: {
  notify: boolean;
  significance: "heartbeat" | "changed" | "error" | "requires-parent";
  summary?: string;
}
```

Default long-lived watcher sessions to quiet heartbeat behavior.

### Fix 2: Do not interrupt parent cron waits for heartbeat-only child digests

If all pending child updates are heartbeat/no-op updates, keep the parent cron timer active and store the digest in orchestration state or facts instead of running parent `processPrompt(...)`.

### Fix 3: Preserve explicit synchronization semantics

If the parent called `wait_for_agents`, `check_agents`, or an explicit status tool, it should still see child completion/status information. The suppression should apply to autonomous parent wakeups, not explicit parent requests.

### Fix 4: Protect confirmation-gated write bundles

If the parent has a pending user-confirmation-gated write bundle, child updates should not wake the parent unless they invalidate that exact bundle or indicate an error. Otherwise, buffer the child update silently and wait for user input.

## Reproduction Sketch

1. Start a parent session with a recurring cron.
2. Spawn several child watcher sessions with `parentSessionId` set.
3. Give each child a 900-second cron and stagger the start times.
4. Have each child return `completed` with no-op content such as "No change".
5. Put the parent into a cron wait, ideally with a pending confirmation-gated action.
6. Observe that each no-op child completion sends `CHILD_UPDATE` to the parent and causes parent `runTurn` executions every few minutes.

## Acceptance Criteria

- No-op child watcher heartbeat cycles do not run the parent LLM while the parent is waiting on cron.
- Material child changes still wake the parent promptly.
- Explicit parent `check_agents` / `wait_for_agents` still returns child status/results.
- Confirmation-gated write bundles are not repinged by unrelated no-op child heartbeats.
- Child watcher audit/fact state still records no-op cycles for observability.

## Workaround

Reduce the number of live watcher children or cancel children that only report no-op status. This reduces aggregate wake frequency but does not fix the runtime behavior.

Application-level instructions can ask watcher children to report only material changes, but the current runtime still sends parent `CHILD_UPDATE` on any child `completed` result. A durable fix belongs in the PilotSwarm base orchestration layer.