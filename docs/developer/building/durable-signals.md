# Durable signals

Durable signals let an authorized caller resume a session waiting for an
external event, without polling or running model turns while it is parked.
They require orchestration **1.0.79 or later** and a signal-capable worker.

This is Phase 1 of [#79](https://github.com/affandar/PilotSwarm/issues/79).
It does **not** expose public webhook URLs, provider connectors, event-triggered
session templates, or `wait_for_any`. Use the normal authenticated Web API
client configuration; database-backed direct mode remains a trusted-server
interface.

## Wait from an agent

The worker supplies `wait_for_signal` to compatible durable sessions:

```js
wait_for_signal({
    names: ["build-finished", "build-failed"],
    reason: "Waiting for the build service",
    timeout_seconds: 3600,
});
```

Names must match `[a-z0-9_-]{1,64}`; provide 1-8 distinct names. A timeout is an
integer from 1 to 86,400 seconds. **Omit it for an indefinite wait.** This is a
turn-boundary tool: the model finishes its current reply, then the orchestration
parks. There is no polling turn, local sleep, or retained activity running the
wait. Long and indefinite waits release worker affinity using the ordinary
snapshot/hold/release protocol.

A user message interrupts the wait for one turn. Afterwards the same wait ID,
names, and **original absolute deadline** are re-armed; time spent answering is
not added to the deadline. This survives continue-as-new and worker replacement.
Calling `wait_for_signal` with new names replaces the wait. Explicit cancellation
uses only:

```js
wait_for_signal({ action: "cancel" });
```

Another blocking tool (`wait`, `ask_user`, or `wait_for_agents`) replaces the
signal wait. A provider-budget refusal does not cancel it. Recurring schedules
remain configured and resume when the signal wait ends.

Stop cancels a parked signal wait without deleting the session or its buffer.
The stop request targets the observed wait ID, so a stale request cannot cancel
a replacement wait. Stopping an interrupting model turn also cancels its pending
signal wait. Complete/cancel/delete retain their ordinary session lifecycle
behavior.

## Raise through a client

Given an initialized, authenticated `PilotSwarmClient`, a signal can arrive
before the agent starts waiting:

```ts
const session = await client.createSession(); // subject to session-creation policy

const receipt = await session.raiseSignal("build-finished", {
    signalId: "build-delivery-42",
    data: { buildId: "build-42", status: "succeeded" },
});
// receipt.status === "queued"; no model turn was started by this raise.

await session.sendAndWait(
    "Use wait_for_signal to wait for build-finished, then summarize the build result.",
);
```

For an existing authorized target, use
`management.raiseSignal(sessionId, name, options)` on
`PilotSwarmManagementClient`. The same method works in direct and Web API mode.
Both paths start an unstarted session through its persisted creation
configuration, without inventing a user prompt. They refuse terminal, deleted,
service, and unsupported old-orchestration targets.

The result is `{ signalId, name, raisedAt, status: "queued" }`.
**Queued is not consumed:** it confirms durable queue acceptance, not model
execution or even signal decoding. A duplicate can therefore return `queued`
and later produce `session.signal_duplicate`.

`PilotSwarmSession.sendEvent(eventName, data)` and `sendSessionEvent` retain their
signatures as compatibility wrappers. The event name now becomes a validated
signal name. Raw payloads are never interpreted as prompts, answers, or commands;
call the corresponding message/answer/control API for those operations.

The Web API and MCP equivalents are documented in the
[API reference](../../api/reference.md) and
[MCP reference](../../../packages/app/mcp/README.md).
MCP callers use `raise_signal`; there is no unauthenticated ingress in this phase.

## Buffering, identity, and payloads

Each version-1 envelope carries a server-stamped source and UTC timestamp, a
signal ID, name, optional JSON data or payload reference, and `wake`.

- The oldest matching buffered signal is consumed, across all requested names.
- `wake: false` is the default. Unmatched signals remain buffered even if an
  unrelated model turn runs; there is no implicit signal digest.
- `wake: true` requests an attributed wake turn at the next input boundary.
  A matching waiter consumes the signal instead of creating a second wake.
  A nonmatching wake interrupts a signal wait and then re-arms it.
- The buffer holds **32 signals**. Overflow drops the oldest with an explicit
  `session.signal_dropped` event and `policy: "drop_oldest"`.
- Duplicate IDs are suppressed while buffered and within the most recent
  **128 accepted unique IDs**, carried across continue-as-new. This is a bounded
  deduplication window, not indefinite exactly-once delivery. Producers must
  reuse their stable delivery ID on retries, rather than minting a new one.
- Inline data is limited to **32,768 UTF-8 bytes of serialized JSON**, nesting
  depth 16, and 4,096 JSON nodes. Non-JSON values, cycles, unsupported fields,
  and invalid names are rejected explicitly. Metadata has separate bounded
  encoded lengths.
- Upload larger data through the authorized artifact API and pass its opaque
  reference as `payloadRef`. The runtime does not fetch it or inline the body.

Signals accepted during model/tool work stay on the durable queue until a
supported boundary. They are not injected into an in-flight call. At dispatch,
queued interactive input precedes matching signals, and a matching signal is
checked before a queued timeout. Timeout records are bound to wait IDs so stale
timers cannot complete a replacement wait. The explicit typed race result and
full loser-disposition contract are deferred to `wait_for_any`.

Payload fields never choose the owner, destination session, agent, model,
provider, namespace, tools, or credentials. Signal turns are runtime-attributed,
not human-authored. Their JSON is framed as **untrusted data, not instructions**;
framing characters inside JSON strings are escaped without changing their
decoded values. Neither the model-facing delivery nor the UI auto-fetches links.

## Observe a wait or delivery

`management.getSessionSignalState(sessionId)` returns a version-1 snapshot with
`pendingWait`, `interrupted`, and buffered **metadata only**. The wait includes
`waitId`, `names`, `reason`, `startedAt`, and an optional `deadline`. Buffered
entries omit inline data and report `dataBytes` instead. Ordinary session/status
reads also expose `signalWait` and `signalWaitInterrupted`.

The TUI and portal show signal names and either a client-local deadline or
**no deadline**. Activity/sequence entries show receipt, buffering, consumption,
duplicate suppression, rejection, overflow, interruption, re-arm, cancellation,
and timeout. Lifecycle events are:

```text
session.signal_received           session.signal_buffered
session.signal_consumed           session.signal_duplicate
session.signal_dropped            session.signal_rejected
session.signal_wait_started       session.signal_wait_interrupted
session.signal_wait_resumed       session.signal_wait_cancelled
session.signal_wait_timeout
```

Consumption records identify `mode: "wait" | "wake"` and, for a match, the wait
ID and duration. These events exclude inline payloads. Tuner sessions can use
`read_session_signals` and the existing event-inspection tool; operators can use
the corresponding management/Web API/MCP reads.

## Rollout and coverage

The 1.0.78 handler is frozen. Older executions keep their prior scheduling
behavior until their existing continue-as-new upgrade boundary; a raise to an
older decoder fails explicitly rather than disappearing into its queue.
Signal-aware run-turn and epoch-start activities require
`pilotswarm.signals.v1`, so an old worker cannot claim them. Older run-turn
activities retain their original names, payloads, and tool declarations.

`durable-signals.test.js` covers envelopes, limits, FIFO, deduplication,
interrupt/re-arm, timeout and Stop/replacement semantics. The native-runtime
suite additionally exercises real Duroxide queues, replay, continue-as-new,
maximum-size buffered payloads, capability routing, and a replacement
worker/provider. These fixtures do not call a real model or replace the
credentialed PostgreSQL/Copilot integration gate.
