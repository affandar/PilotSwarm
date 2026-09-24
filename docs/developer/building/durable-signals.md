# Durable signals

Durable signals let an authorized caller resume a session waiting for an
external event, without polling or running model turns while it is parked.
They require orchestration **1.0.80 or later** and a signal-capable worker.

This is the durable-wait foundation of [#79](https://github.com/affandar/PilotSwarm/issues/79).
[Webhook ingress](webhooks.md) adds opt-in public capability URLs,
authenticated GitHub/ADO connectors and approved event-triggered templates.
Client signal APIs use normal Web API authentication; database-backed direct
mode remains a trusted-server interface.

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

Indefinite waits do not require a webhook subscription. An endpoint expiring,
being exhausted or being revoked does not cancel the wait: another authorized
producer can still raise the signal. The management UI shows unavailable
endpoints beside the active wait. Prefer an explicit timeout for CI/build work;
use Stop or session termination when the workflow itself should end.

A user message interrupts the wait for one turn. Afterwards the same wait ID,
names, and **original absolute deadline** are re-armed; time spent answering is
not added to the deadline. This survives continue-as-new and worker replacement.
Calling `wait_for_signal` with new names replaces the wait. Explicit cancellation
uses only:

```js
wait_for_signal({ action: "cancel" });
```

Another blocking tool (`wait`, `ask_user`, or `wait_for_agents`) replaces the
signal wait. A provider-budget refusal does not cancel it. A matching
`wake: true` signal can satisfy the saved wait during that budget pause; the
accepted user input stays attached to the next permitted turn. Nonmatching
signal bursts do not replace the budget retry timer. Recurring schedules remain
configured and resume when the signal wait ends, including after Stop.

Stop cancels a parked signal wait without deleting the session or its buffer.
The stop request targets the observed wait ID, so a stale request cannot cancel
a replacement wait. Stopping an interrupting model turn also cancels its pending
signal wait. Complete/cancel/delete retain their ordinary session lifecycle
behavior.

## Race signals against user input

Orchestration **1.0.80+** includes `wait_for_any` on the same capability-routed
`pilotswarm.signals.v1` turns as `wait_for_signal`. It accepts the same 1-8 names, optional timeout,
and reason as `wait_for_signal`, but the first winner ends the wait:

```js
wait_for_any({
    names: ["approval", "deployment-failed"],
    timeout_seconds: 3600,
    reason: "Wait for approval, user input, or expiry",
});
```

At a durable input boundary, precedence is Stop/graceful cancellation, accepted
user input, matching signal, then timeout. This is deterministic replay ordering,
not physical arrival-time ordering. The oldest matching buffered signal wins
among signals. If user input wins, the original race is not re-armed. Other
queued user messages keep their ordinary turns, and unconsumed signals remain
buffered; a losing timer is tombstoned by wait ID.

The tool acknowledges suspension in the current turn. A runnable winner is
presented in the resumed turn as a typed `WAIT_FOR_ANY RESULT`; Stop or
cancellation does not force a model turn just to report that it stopped.
`getSessionSignalState()` exposes the same metadata as `lastRaceOutcome`:
version, wait ID, completion time, wait duration, one `winner`, and `losers`
dispositions. Winner kinds are `signal`, `user`, `timeout`, `stop`, and `cancel`.
The signal winner references its signal ID/name, the user winner has an input
reference, and the timeout winner retains the absolute deadline. Inline payloads
do not enter that outcome or its audit event.

`session.signal_race_completed` is recorded once for each settled race and
appears in the shared Activity/sequence views. A provider-budget refusal of the
winning user turn preserves its accepted input without re-arming the race.
`wait_for_any({action: "cancel"})` cancels the pending wait; replacing it records
the cancellation disposition before starting the replacement.

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
MCP callers use `raise_signal`. External senders instead use the separately
authenticated, opt-in `/hooks` routes described in the webhook guide.

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
full loser-disposition contract are provided by `wait_for_any` on 1.0.80+.

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
session.signal_race_completed
```

Consumption records identify `mode: "wait" | "wake"` and, for a match, the wait
ID and duration. These events exclude inline payloads. Tuner sessions can use
`read_session_signals` and the existing event-inspection tool; operators can use
the corresponding management/Web API/MCP reads.

## Rollout and coverage

Main's non-signal 1.0.79 handler is frozen, alongside earlier versions. Older
executions keep their prior scheduling
behavior until their existing continue-as-new upgrade boundary; a raise to an
older decoder fails explicitly rather than disappearing into its queue.
Signal-aware run-turn and epoch-start activities require
`pilotswarm.signals.v1`, so an old worker cannot claim them. Older run-turn
activities retain their original names, payloads, and tool declarations.
All signals, explicit races and webhook prompt dispatch ship together in the
single new 1.0.80 handler under `orchestration/`. The only new frozen directory
is upstream's `orchestration_1_0_79/`; there is no intermediate signal-only
snapshot or separate race release.

Earlier unmerged drafts used 1.0.79 for signals, then signal-only 1.0.80 and a
separate 1.0.81 race handler. Those draft-test histories are not supported by
this consolidated release. Use a fresh isolated test database for the new
build; do not reset an ordinary upstream deployment or reuse the old draft lab.
Upstream's actual 1.0.79 histories remain supported by their unchanged freeze.

`durable-signals.test.js` covers envelopes, limits, FIFO, deduplication,
interrupt/re-arm, timeout and Stop/replacement semantics. The native-runtime
suite additionally exercises real Duroxide queues, replay, continue-as-new,
maximum-size buffered payloads, capability routing, and a replacement
worker/provider. Review regressions cover delayed timeout dispatch,
budget-interrupted wakes, recurring schedule restoration, first-turn tool
requirements, maximum-name inspection, and UI snapshot authority. These
fixtures do not call a real model or replace the
credentialed PostgreSQL/Copilot integration gate.
