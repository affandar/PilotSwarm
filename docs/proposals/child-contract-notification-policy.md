# Proposal: Child Contract Notification Policy

> **Status:** Proposal
> **Date:** 2026-05-17
> **Goal:** Let parents control when child sessions autonomously wake them, using a simple `wakeOn` field in the child contract.

---

## Summary

PilotSwarm child sessions currently notify their parent too eagerly. A long-running watcher child can complete a quiet cron cycle with text like "No change" and still send a parent-visible `CHILD_UPDATE`. If the parent is waiting on cron, that update can interrupt the wait and run the parent LLM even though nothing material happened.

This proposal extends the existing child contract mechanism with a single `wakeOn` field:

```ts
contract: {
  purpose: "Watch ADO item for material R2D changes",
  wakeOn: "material_change"
}
```

`wakeOn` controls autonomous parent wakeups. It does not hide child state from explicit parent tools such as `check_agents` or `wait_for_agents`.

Default `wakeOn` should be `material_change`. Tokens are expensive, and silent no-op cycles should be the default unless the parent asks for more chatty behavior.

---

## Problem

The current parent notification channel has no contract-level wake policy. Child completions and waits are treated as parent-visible work even when the child is a watcher whose normal state is repeated no-op heartbeats.

This causes:

- needless parent LLM turns
- repeated status or confirmation reminders
- token spend for no-op watcher cycles
- noisy transcripts
- worse scaling as each parent has more recurring children

The runtime needs a way for the parent to express its notification intent when delegating work.

---

## Design

Add a simple `wakeOn` field to child contracts.

```ts
export type ChildWakePolicy = "any" | "material_change" | "completion";

interface ChildSessionContract {
  purpose?: string;
  wakeOn?: ChildWakePolicy;
  // existing contract fields remain unchanged
}
```

### Policies

| Policy | Behavior | Good Fit |
|---|---|---|
| `any` | Wake the parent for any child update, including heartbeats and ordinary progress updates. | Short-lived children where every turn is likely useful to the parent. |
| `material_change` | Wake the parent when substantial progress has been made, progress is hampered, an important state changes, or the child errors/needs parent help. Suppress clear no-op heartbeats. | Long-running watchers that should still give summary updates when something meaningful happens. |
| `completion` | Wake the parent only when the objective is met, the child is fully blocked, or the child reaches terminal/error state. | Simple long-running tasks where interim updates are not useful. |

Default policy:

```ts
wakeOn: "material_change"
```

This default applies when a child has no explicit contract `wakeOn`. It may slightly quiet previously noisy flows, but it aligns with the product direction: autonomous parent wakeups should be meaningful by default.

---

## LLM Guidance

The runtime should not force agents into a rigid policy. Tool and prompt guidance should teach the parent to choose based on expected child behavior:

- Use `wakeOn: "any"` when the child is expected to be short-lived or every child turn is likely relevant.
- Use `wakeOn: "material_change"` when the child is a long-running watcher and the parent/user expects meaningful summary updates.
- Use `wakeOn: "completion"` when the child has a simple long-running objective and the parent only needs to know when it is done or blocked.

Examples:

```ts
spawn_agent({
  task: "Inspect these logs and report findings.",
  contract: {
    purpose: "Short investigation",
    wakeOn: "any"
  }
})
```

```ts
spawn_agent({
  task: "Watch this work item and report only meaningful changes.",
  contract: {
    purpose: "Long-running watcher",
    wakeOn: "material_change"
  }
})
```

```ts
spawn_agent({
  task: "Run this migration validation until it succeeds or is blocked.",
  contract: {
    purpose: "Completion-gated validation",
    wakeOn: "completion"
  }
})
```

---

## Changing Policy During A Session

Parents should be able to change the child notification setting while the child is running.

Use the existing `message_agent(..., contract_patch)` path:

```ts
message_agent({
  agent_id: "session-child",
  message: "For the next few cycles, report every check even if nothing changed.",
  contract_patch: {
    wakeOn: "any"
  }
})
```

Then quiet it again later:

```ts
message_agent({
  agent_id: "session-child",
  message: "Go quiet again unless there is a material change.",
  contract_patch: {
    wakeOn: "material_change"
  }
})
```

This keeps the tool surface small and reuses the contract revision history already created for child contracts.

A future `update_agent_contract` tool can be added if silent policy changes become common, but it is not needed for v1.

---

## Runtime Decision Model

The runtime decides whether to autonomously wake the parent from:

1. the child's current contract `wakeOn` policy;
2. the child turn type (`completed`, `wait`, `error`, terminal state);
3. the child result/outcome state when structured result data exists;
4. a conservative no-op classifier for clear heartbeat text.

The child does not need to specify which condition was met. It can return normal result content. The runtime owns the wake decision.

Pseudo-code:

```ts
function shouldWakeParent(update, contract) {
  const policy = normalizeWakeOn(contract?.wakeOn) ?? "material_change";

  if (policy === "any") return true;
  if (isErrorOrRequiresParent(update)) return true;
  if (isTerminalBlocked(update)) return true;

  if (policy === "completion") {
    return isObjectiveComplete(update) || isFullyBlocked(update);
  }

  // material_change
  if (isClearHeartbeat(update)) return false;
  return isMaterialChange(update) || isUnknown(update);
}
```

Conservative rule: if the runtime cannot confidently classify an update as a heartbeat/no-op under `material_change`, it should wake the parent. Do not hide potentially important work.

---

## Heartbeat Classification

The v1 classifier should be intentionally narrow. Suppress only clear no-op signals such as:

- `No change`
- `No drift`
- `No new reportable change`
- `Cycle quiet`
- structured result verdicts like `heartbeat`, `unchanged`, or `no_change` if present

Treat unknown natural-language summaries as material. This prevents accidental suppression of real progress.

---

## Parent Digest Behavior

Suppression should happen in both places:

1. before sending a child update to the parent when the child completes/waits;
2. when processing pending child digests on the parent.

The second guard is defense in depth. Older child paths or frozen orchestration versions may still send heartbeat updates. A heartbeat-only digest should not interrupt an active parent cron wait.

Mixed digests behave as material if any update is material.

---

## Explicit Synchronization Stays Complete

`wakeOn` only controls autonomous parent wakeups.

The parent must still see child status and results when it explicitly asks:

- `check_agents`
- `wait_for_agents`
- child outcome management reads
- UI/portal session detail views

A quiet heartbeat remains observable; it just does not spend a parent LLM turn.

---

## Confirmation-Gated Parent Work

If the parent is waiting for user confirmation, heartbeat/no-op child updates must not re-run the parent LLM. Material child updates can still wake the parent if they may invalidate the pending confirmation bundle or require user attention.

For v1, the practical rule is:

- heartbeat-only update + pending confirmation: stay quiet
- material update + pending confirmation: wake parent
- unknown update + pending confirmation: wake parent conservatively

---

## Implementation Plan

### 1. Extend Child Contract Shape

Files:

- `packages/sdk/src/types.ts`
- `packages/sdk/src/managed-session.ts`
- `packages/sdk/src/session-proxy.ts`

Add `wakeOn` to the documented contract schema for `spawn_agent.contract` and `message_agent.contract_patch`.

Valid values:

```ts
"any" | "material_change" | "completion"
```

Normalize invalid/missing values to `material_change` at decision time. Persist raw contract JSON as today so existing contract revision behavior remains simple.

### 2. Add Notification Decision Helper

New helper suggestion:

- `packages/sdk/src/child-notifications.ts`

Exports:

```ts
normalizeWakeOn(value: unknown): "any" | "material_change" | "completion";
classifyChildUpdate(update): "heartbeat" | "material" | "completion" | "error" | "unknown";
shouldWakeParentForChildUpdate(input): boolean;
```

Keep this helper pure and easy to unit test.

### 3. Apply Policy Before Parent Notification

Files likely touched:

- `packages/sdk/src/orchestration/turn.ts`
- `packages/sdk/src/orchestration/queue.ts`
- related orchestration runtime helpers

Before sending `CHILD_UPDATE` to a parent, load or carry the child's contract/outcome state and evaluate `shouldWakeParentForChildUpdate`.

If it returns false:

- record an internal event such as `session.child_update_suppressed`
- do not enqueue the parent wake message
- keep child outcome/fact/state persistence unchanged

### 4. Add Parent Digest Defense

When parent child-update digests are processed while a cron wait is active:

- material digest: interrupt cron and run parent prompt
- heartbeat-only digest: keep cron timer active and record suppression/audit event
- mixed digest: material

### 5. Update Tool Guidance

Files:

- `packages/sdk/plugins/system/agents/default.agent.md`
- builder-agent templates if they describe child contracts
- docs that mention `spawn_agent.contract`

Guidance should be loose and decision-oriented, not overly prescriptive:

- short-lived child: `wakeOn: "any"`
- long-running watcher with summary updates: `wakeOn: "material_change"`
- simple long-running task where only done/blocked matters: `wakeOn: "completion"`

### 6. Version The Orchestration

This changes parent wake behavior and durable timer interruption flow, so it requires a new orchestration version. Do not modify frozen orchestration versions.

---

## Testing Plan

### Contract/Tool Tests

- `spawn_agent.contract.wakeOn` appears in the tool schema and forwards through the inline bridge.
- `message_agent.contract_patch.wakeOn` updates the persisted child contract.
- Missing `wakeOn` defaults to `material_change` in the decision helper.

### Notification Helper Tests

- `any` wakes for heartbeat/no-op updates.
- `material_change` suppresses clear no-op heartbeats.
- `material_change` wakes for changed/error/blocked/unknown updates.
- `completion` suppresses ordinary progress/heartbeat updates.
- `completion` wakes for objective complete, fully blocked, terminal, and error updates.

### Orchestration Tests

- No-op watcher completion does not wake parent during parent cron wait by default.
- Material child completion wakes parent during parent cron wait.
- Mixed digest with one material update wakes parent.
- Heartbeat-only digest does not reping pending confirmation work.
- `check_agents` still returns quiet heartbeat child status.
- `wait_for_agents` still observes terminal child results even if autonomous wakes were suppressed.

---

## Acceptance Criteria

- Default child notification behavior is `material_change`.
- Parents can choose `wakeOn: "any"`, `"material_change"`, or `"completion"` at spawn time.
- Parents can change `wakeOn` with `message_agent(..., contract_patch)` while the child is running.
- No-op watcher heartbeats do not wake parent LLMs by default.
- Material changes, errors, blocked progress, and completions still wake according to policy.
- Explicit synchronization tools remain complete and truthful.
- Child audit/fact/outcome state still records quiet heartbeat cycles.

---

## Open Questions

1. Should suppressed heartbeat events be visible in the default transcript, or only in CMS events/inspect tools?
2. Should `wakeOn: "completion"` wake on every terminal state including normal cancellation, or only success/blocked/error?
