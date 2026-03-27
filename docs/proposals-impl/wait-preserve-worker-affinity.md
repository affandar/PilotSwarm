# Proposal: Preserve Worker Affinity For Durable Waits

## Status

Implemented

## Problem

PilotSwarm's `wait` tool currently has one long-wait behavior:

- if the wait is short, it sleeps in-process
- if the wait is long, the orchestration dehydrates the session and resets its worker affinity

That default is correct for most durable tasks, but it breaks a useful class of workflows:

- a session starts long-running work on a specific worker
- the LLM wants to pause and come back later
- the next turn still needs access to worker-local state on that same worker

Examples:

- polling a local child process started on that worker
- waiting for a worker-local file or socket
- resuming work that depends on process-local caches or handles

Today the LLM is told that waits are durable and may resume on a different worker, but it has no way to opt into preserving the current worker affinity.

## Proposal

Extend the `wait` tool with an optional boolean flag:

```json
{
  "seconds": 300,
  "reason": "waiting for local build to finish",
  "preserveWorkerAffinity": true
}
```

Semantics:

- `preserveWorkerAffinity: false | omitted`
  - current behavior
  - long waits may rehydrate on a different worker
- `preserveWorkerAffinity: true`
  - long waits still dehydrate
  - but the orchestration preserves the current affinity key across the wait
  - the next hydrate/run should prefer the same worker affinity lane

This is a best-effort locality hint, not a hard physical-node guarantee.

## Behavioral Model

### Short wait

- still handled in-process
- flag has no practical effect

### Long wait without affinity preservation

1. session dehydrates
2. orchestration rotates affinity key
3. timer fires
4. next hydrate/run may land on a different worker

### Long wait with affinity preservation

1. session dehydrates
2. orchestration keeps the current affinity key
3. timer fires
4. next hydrate/run reuses that affinity key

## Prompting Contract

PilotSwarm's framework prompt and durable-timers skill should say:

- default long waits may resume on a different worker
- if the work depends on the same worker's local state, the agent must call `wait(..., preserveWorkerAffinity: true)`
- even with the flag, the agent should treat same-worker resume as best effort and be prepared to recover if the worker is unavailable

## Implementation Shape

### Tool contract

Add `preserveWorkerAffinity?: boolean` to:

- `wait` tool JSON schema
- pending turn action shape
- wait turn result shape

### Orchestration state

Add an orchestration-state flag that survives `continueAsNew`:

- `preserveAffinityOnHydrate?: boolean`

This indicates that the next hydration should keep the existing affinity key instead of rotating it.

### Orchestration logic

Split the current "dehydrate + reset affinity" helper into two paths:

- dehydrate and reset affinity
- dehydrate while preserving affinity

Long waits with `preserveWorkerAffinity: true` use the second path.

Hydration should only mint a new affinity key when `preserveAffinityOnHydrate` is not set.

## Testing Plan

Focused local coverage is enough:

1. long wait without the flag rotates affinity
2. long wait with the flag preserves affinity
3. short wait still runs in-process
4. framework prompt/skill text tells the LLM when to use the flag

The easiest observable signal is the existing `get_info` command response, which already exposes the orchestration affinity key.

## Notes

- This changes orchestration behavior and must ship as a new orchestration version.
- The public-facing promise should be "preserve worker affinity" rather than "guarantee same node".
