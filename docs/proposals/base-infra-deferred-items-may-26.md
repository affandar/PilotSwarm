# Proposal: Base Infrastructure Deferred Items - May 2026

> **Status:** Deferred proposal
> **Date:** 2026-05-16
> **Parent proposal:** [base-infra-improvements-may-26.md](./base-infra-improvements-may-26.md)
> **Goal:** Preserve the design detail for coordination work that is intentionally out of scope for the active May 2026 base-infrastructure proposal.

---

## Deferred Items

The active base-infrastructure proposal intentionally defers three ideas:

| Deferred item | Reason deferred |
|---|---|
| Event-driven parent waits | Changes orchestration wait/timer sequencing and needs its own versioned orchestration rollout. |
| Fan-out/fan-in helper | Depends on the child contract/result substrate being stable before adding batch delegation ergonomics. |
| Bounded polling primitive | Needs a separate policy discussion around timeout semantics, partial results, and UI exposure. |
| Owner-scoped cross-session messaging | Phase 1 allows fleet-wide messaging; owner/group/agent policy constraints should be added later once usage patterns are visible. |

These items should not add schema, queue messages, tools, prompt guidance, UI, or tests in the active base-infrastructure changelist unless the parent proposal is explicitly reopened.

---

## Cross-Cutting Rules

- Land each deferred item in a separate implementation changelist.
- Do not pre-update agent prompts or skills before the corresponding runtime/tool substrate exists.
- Prefer existing tool input/output tracing, durable queues, and KV state over new CMS events.
- Any orchestration yield-sequence change must use the Duroxide orchestration versioning workflow.
- Keep backward compatibility explicit: Phase 1 supports old behavior, Phase 2 can clean up once new sessions have migrated.

---

## Event-Driven Parent Waits

### Goal

A parent that is waiting only for child sessions should sleep until a child update arrives or a high safety TTL fires. The parent should not wake steadily just to poll child state.

### Current behavior

`wait_for_agents` remains the parent-facing wait tool. Current implementations may use fallback polling while children are still running. That behavior is acceptable for the active base-infrastructure proposal and should not be changed there.

### Proposed behavior

- Parent calls `wait_for_agents` with the same parent-facing semantics.
- Runtime records the child session IDs being waited on.
- Child completion, failure, cancellation, or relevant result update enqueues a parent wake message.
- Parent wakes, reads child outcomes, and returns the aggregate `wait_for_agents` result.
- A high safety TTL remains as a fallback in case a wake message is lost or a child state transition is missed.

### Tools

No new user-facing tool is required. `wait_for_agents` remains the API. Future optional `wait_for_agents` options may tune safety TTLs, but the first implementation should preserve existing tool signatures.

### Base Instructions And Skills

Do not change agent wait guidance until the runtime wake path exists. When it does, update default instructions and any coordination skill to say that child waits are durable and event-driven, while still advising agents to check child results before reporting completion.

### Base Infra And Orchestration Work

- Add a durable child-wait registration record in orchestration state or KV.
- Enqueue parent wake messages when child state or child outcome changes.
- Replace steady polling timers with child-update wake-ups plus a high safety TTL.
- Keep child result lookup table-backed through `session_child_outcomes` from the parent proposal.
- Do not add CMS events for child-wait progress.
- Version the orchestration because wait/timer yield sequencing will change.

### Tests

- Replay determinism test for the new wait sequence.
- Multi-worker test where a parent waits, a child completes on another worker, and the parent wakes.
- Child failure/cancel tests that wake the parent with structured result state.
- Safety TTL test where no child update arrives and the parent still wakes eventually.
- Backward compatibility test proving old orchestration versions continue using their original wait behavior.

### Backward Compatibility And Cleanup

Phase 1: keep fallback polling for current sessions and introduce event-driven waits only behind a new orchestration version.

Phase 2: make event-driven waits the default for new sessions after stability is proven.

Phase 3: remove prompt text and runtime branches that assume steady child polling once old orchestration versions are no longer relevant.

### Schema And Events

No CMS schema additions are expected beyond the parent proposal's `session_child_outcomes` table. Prefer KV or orchestration state for wait registration. Add no CMS event types in the first implementation.

---

## Fan-Out / Fan-In Helper

### Goal

Provide a convenient helper for workflows that spawn one child per target and then aggregate child results under a clear join policy.

### Current behavior

Agents can already spawn multiple children manually with `spawn_agent`, then call `wait_for_agents` and aggregate the results themselves. That remains the supported behavior in the active base-infrastructure proposal.

### Proposed behavior

A future helper could support:

```ts
spawnAgentBatch({
  parentSessionId,
  children: [
    { agentId, task, contract },
    { agentId, task, contract },
  ],
  joinPolicy: "all-settled" | "all-success" | "first-success",
  joinTimeoutMs: 1800000,
  onJoinTimeout: "wake_parent",
});
```

The paired aggregate result should include successful, partial, blocked, failed, cancelled, and missing-output children, plus a suggested parent next action.

`joinTimeoutMs` is a parent wake-up budget, not a child execution timeout. If the join policy is not satisfied by that deadline, the parent wakes with partial aggregate state and decides whether to keep waiting, message children, cancel stragglers, or report partial progress.

### Tools

Possible future surfaces:

- SDK helper: `spawnAgentBatch(...)`
- Optional in-session tool: `spawn_agent_batch(...)`
- No changes to `spawn_agent` or `wait_for_agents` are required for the active proposal beyond their contract/result extensions.

### Base Instructions And Skills

Only after the helper exists, teach agents to use batch fan-out when child tasks share one join policy and one parent-facing aggregate result. Keep manual spawn/wait guidance for custom orchestration patterns.

### Base Infra And Orchestration Work

Phase 1 can implement the SDK helper as a wrapper around existing spawn/wait flows. A dedicated orchestration helper should be added only if wrapper-based batching creates too much history, weak cancellation behavior, or confusing partial-result handling.

If a dedicated helper is needed later, it should reuse child contracts/results and avoid adding CMS events for every child state transition.

### Tests

- `all-settled` join with mixed success and partial results.
- `all-success` join that reports failed or missing outputs clearly.
- `first-success` join that wakes when the first successful child finishes.
- Join timeout that returns partial aggregate state.
- Cancellation behavior for pending batch children.
- Backward compatibility proving manual spawn/wait still works unchanged.

### Backward Compatibility And Cleanup

Phase 1: keep manual `spawn_agent` plus `wait_for_agents` as the primary pattern and add the helper as optional SDK ergonomics.

Phase 2: once stable, update base prompt/skill guidance to prefer the helper for straightforward batch delegation.

Phase 3: remove prompt fallbacks that tell agents to hand-roll aggregation for simple homogeneous fan-out workflows.

### Schema And Events

No CMS table is required for the wrapper implementation. A future dedicated orchestration helper may need KV state for batch join registration, but should not add high-frequency CMS events.

---

## Owner-Scoped Cross-Session Messaging

### Goal

Add policy constraints to cross-session discovery and messaging so ordinary task
agents can be limited by owner, group, agent role, or other deployment policy.

### Current behavior

The active base-infrastructure proposal starts with fleet-wide discovery and
messaging. That keeps the first implementation simple and makes it easier to
observe real coordination patterns before locking down policy.

### Proposed behavior

Future policy should be explicit and explainable. Possible default scopes after
lockdown:

- same owner, when owner metadata is visible,
- same session group,
- same spawn tree,
- explicitly allowed agent IDs or system roles,
- fleet-wide only when an agent/plugin policy grants it.

`list_sessions(filters?)` should only return sessions discoverable under the
effective policy, and `send_session_message` should re-check policy at send time
instead of trusting prior list results.

### Tools

No new user-facing tool is required. Add policy-aware filtering to
`list_sessions` and policy enforcement to `send_session_message`.

### Base Instructions And Skills

Update agent-tuner and system-agent guidance when policy lands so diagnostic
agents can distinguish `policy_denied`, missing sessions, and normal no-result
filters. Operator/system agents that need broader visibility should declare that
in agent policy, not rely on accidental fleet-wide access.

### Base Infra And Runtime Work

- Add a `SessionMessagingPolicy` shape on plugin/session/agent config.
- Resolve effective policy from explicit session policy, agent definition,
  plugin defaults, then runtime defaults.
- Enforce policy in both discovery and send paths.
- Return explicit `policy_denied` errors when sends are blocked.
- Keep request/response KV records auditable when a message is allowed.

### Tests

- Same-owner allowed and cross-owner denied.
- Same-group allowed if configured.
- System/agent role override allowed.
- Fleet-wide denied by default after policy lockdown.
- `send_session_message` denied even if the caller cached an older list result.
- Agent-tuner/system diagnostic behavior under broader explicit policy.

### Backward Compatibility And Cleanup

Phase 1: active proposal allows fleet-wide messaging and records enough metadata
to understand usage.

Phase 2: add owner/group/agent policy as opt-in enforcement with warning logs for
would-be denied messages.

Phase 3: make constrained policy the default for ordinary agents once operators
have had time to configure exceptions.

### Schema And Events

Prefer policy configuration in agent/plugin/session config, not CMS schema. Add
no new CMS event types for denied messages unless operator audit needs require a
low-frequency security/audit event later.

---

## Bounded Polling Primitive

### Goal

Give long-running polling sessions a first-class budget so they can end with a structured partial or timed-out result instead of running until an operator or parent cancels them.

### Current behavior

Polling agents usually implement budgets in prompts or ad hoc local state. Parents may cancel long-running children after too many cycles, but cancellation can lose partial-result semantics unless the child or parent records them manually.

### Proposed behavior

A future primitive could support:

```ts
interface PollBudget {
  maxIterations?: number;
  maxWallClockMs?: number;
  intervalMs?: number;
  partialResultFactKey?: string;
  onBudgetExhausted?: "complete_timed_out" | "ask_parent" | "cancel";
}
```

When the budget is exhausted, the runtime or tool layer should produce a structured `timed_out` or `partial` result with last-known state.

### Tools

Possible future surfaces:

- Optional polling helper tool for agents that perform repeated checks.
- Optional `wait_for_agents` / child contract integration for children with known polling budgets.
- No poll-budget tool, schema, or UI should be added in the active base-infrastructure proposal.

### Base Instructions And Skills

A future polling skill should teach agents to state the budget before entering a monitoring loop, refresh summary state before each long sleep, and publish partial results before timeout or cancellation.

### Base Infra And Orchestration Work

- Decide whether budget enforcement belongs in orchestration, tool handlers, or an agent-level helper.
- Persist last-known polling state enough to produce a useful partial result after worker handoff.
- Integrate budget exhaustion with child outcomes if the polling session is a child.
- Keep application-specific polling semantics out of the base runtime.

### Tests

- Max-iteration exhaustion produces a structured timed-out result.
- Max-wall-clock exhaustion is deterministic under orchestration replay.
- Partial result fact/artifact references are preserved.
- Parent sees timeout result through `wait_for_agents`.
- Cancellation without partial result still records a visible warning or violation for contracted children.

### Backward Compatibility And Cleanup

Phase 1: introduce the primitive as opt-in and keep existing polling prompts working.

Phase 2: update base prompts and skills to prefer explicit budgets for new long-running polling tasks.

Phase 3: remove or reduce legacy prompt language that relies on indefinite polling loops once the primitive is common.

### Schema And Events

This needs a separate schema decision. Possible options are extending `session_child_outcomes.result_json`, adding KV budget state, or adding a dedicated polling-budget table. The active base-infrastructure proposal should add none of these.

CMS events should stay minimal. If timeline visibility is needed later, add at most a low-frequency milestone such as `session.poll_budget_exhausted`; do not emit per-poll progress events.
