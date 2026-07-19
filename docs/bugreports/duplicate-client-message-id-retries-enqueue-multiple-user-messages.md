# Bug: Retrying one client message ID enqueues duplicate durable user messages

**Status:** Fixed in v0.5.16
**Filed:** 2026-07-18
**Component:** browser/TUI shared outbox, Web API `sendMessage`, management client, durable orchestration message queue
**Affected versions:** observed through a PilotSwarm portal reporting `v0.5.15`; the relevant behavior is present in current `packages/app/ui/core/src/controller.js`, `packages/sdk/src/management-client.ts`, and `packages/sdk/src/orchestration/queue.ts`
**Severity:** High — one logical user submission can run multiple agent turns and repeat externally visible or mutating work

---

## Evaluation

The core bug is confirmed in the current implementation:

- the shared UI retries a transiently rejected enqueue with the same
  `clientMessageIds`;
- `PilotSwarmSession.send()` / management `sendMessage()` enqueue every request
  without an idempotency check;
- both orchestration intake sweeps check only cancellation tombstones before
  appending every prompt to the durable FIFO;
- each accepted FIFO prompt reaches a separate `runTurn` activity and records a
  separate `user.message` event.

The UI retry loop is stronger than a conventional bounded retry: after a
transient failure it restores the original pending items, and the `finally`
block schedules another dispatch about 10 ms later. There is currently no
backoff, retry ceiling, or event reconciliation before that retry.

The fix uses the identity the client already supplies. The orchestration keeps
the 20 most recently enqueued `clientMessageIds` in LRU order. If any ID on an
incoming prompt is already in that window, the prompt is an atomic duplicate
and is not appended to FIFO. Accepted IDs move to the newest end; the oldest ID
falls out when the window exceeds 20.

This is deliberately a bounded idempotency contract, not lifetime deduplication.
It covers normal HTTP retry windows without adding a new wire protocol or
database ledger.

---

## Summary

PilotSwarm assigns each local outbox item a stable `clientMessageId` and preserves
that ID when retrying a transiently failed `sendMessage` request. However, the Web
API and durable orchestration do not use `clientMessageIds` as idempotency keys.
Each retry is enqueued as a new durable `messages` event and later persisted as a
separate `user.message` event.

An observed portal submission was stored three times with the same exact message
content and the same client message ID. Each copy triggered a separate session
turn.

This is not merely a transcript-rendering issue. It is duplicate durable work.
For an agent that sends email, modifies external state, provisions resources, or
runs a costly workflow, one click can execute the requested operation more than
once.

## Observed Production Evidence

One logical user submission appeared as three distinct durable `user.message`
events:

| Event sequence | Time | Content hash | Client message ID |
|---:|---|---|---|
| `1654656` | `T+00.000s` | identical | `msg:<timestamp>:<nonce>` |
| `1654802` | `T+33.476s` | identical | same ID |
| `1654952` | `T+63.706s` | identical | same ID |

The raw data shape was identical for all three events:

```json
{
  "sender": {
    "kind": "user",
    "origin": "api",
    "provider": "entra",
    "relation": "owner"
  },
  "content": "<same user prompt>",
  "clientMessageIds": [
    "msg:<timestamp>:<nonce>"
  ]
}
```

Every duplicate was followed by a `session.turn_started` event. Therefore:

- the portal did not simply render one event three times;
- these were not three independent manual sends, because a new manual send would
  create a new outbox ID;
- one client outbox item was submitted repeatedly;
- the durable server path accepted every replay as new work.

The spacing was approximately 33 and 30 seconds. This is consistent with an
ambiguous transport outcome such as an edge/request timeout after durable enqueue
but before the browser received the successful response. The exact initiating
transport error was not available in portal logs, so that trigger remains an
inference. The duplicate durable persistence and identical client ID are directly
observed.

## Relevant Client Behavior

`PilotSwarmUiController.buildOutboxItem()` creates a stable ID:

```js
const id = `msg:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
return {
    id,
    text: String(prompt || ""),
    phase: normalizedPhase,
    clientMessageIds: [id],
};
```

`dispatchPendingOutbox()` submits that ID:

```js
await this.transport.sendMessage(sessionId, mergedItem.text, {
    enqueueOnly: true,
    clientMessageIds: mergedItem.clientMessageIds,
});
```

If `sendMessage()` rejects with anything other than an authorization refusal, the
controller restores the original pending items:

```js
const reverted = items.flatMap((item) => (
    item.id === mergedItem.id ? pendingItems : [item]
));
this.setSessionOutboxItems(sessionId, reverted);
```

The `finally` block immediately schedules another dispatch when pending items
remain. `scheduleOutboxDispatch()` uses an approximately 10 ms timer, and there
is no retry ceiling or backoff:

```js
this.outboxFlushPromises.delete(sessionId);
if (this.getPendingOutboxItems(sessionId).length > 0) {
    this.scheduleOutboxDispatch(sessionId);
}
```

The same outbox item, with the same `clientMessageIds`, is therefore retried after
an ambiguous failure. Preserving the ID is correct, provided the receiving side
is idempotent.

## Missing Server Idempotency

The Web API route delegates `sendMessage` directly to the runtime and waits for
it to return. No API-level idempotency receipt is recorded.

The management client validates the session, updates catalog state, and blindly
enqueues every request:

```ts
const payload: Record<string, unknown> = { prompt };
if (options?.clientMessageIds && options.clientMessageIds.length > 0) {
    payload.clientMessageIds = options.clientMessageIds;
}
await this._duroxideClient.enqueueEvent(
    orchId,
    "messages",
    JSON.stringify(payload),
);
```

`validClientMessageIds()` checks only type and non-emptiness:

```ts
export function validClientMessageIds(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((id): id is string => typeof id === "string" && Boolean(id))
        : [];
}
```

During queue drain, IDs are checked only against cancellation tombstones:

```ts
const incomingClientMessageIds = validClientMessageIds(msg.clientMessageIds);
if (promptIdsIntersectCancellation(runtime, incomingClientMessageIds)) {
    // drop cancelled prompt
}
stash.push({
    kind: "prompt",
    prompt: userPrompt,
    clientMessageIds: incomingClientMessageIds,
});
```

`appendToFifo()` appends every resulting prompt without deduplication.

The IDs currently support precise client acknowledgment and cancellation, but not
idempotent submission.

## Failure Sequence

1. User sends one prompt.
2. UI creates outbox item `M` with client ID `C`.
3. Portal calls `sendMessage(session, prompt, { clientMessageIds: [C] })`.
4. Server durably enqueues the prompt.
5. The client does not observe a successful HTTP response and treats the result
   as transient failure.
6. UI restores the same item `M` to `pending` and schedules another dispatch.
7. Server receives `[C]` again but has no accepted-ID check.
8. A second durable prompt enters FIFO.
9. The sequence repeats.
10. Orchestration processes every copy and records multiple `user.message` events
    carrying the same client ID.

## Expected Behavior

`clientMessageIds` define logical message identity within the orchestration's
20-ID dedupe window.

Submitting the same client ID again while it remains in the window must be
idempotent, regardless of whether the original prompt is:

- still in the external event queue;
- already in orchestration FIFO;
- currently running;
- already recorded as `user.message`;
- completed;
- replayed after worker restart or session hydration;
- carried through `continueAsNew`.

The repeated API call may continue to mean “submitted to the durable event
queue,” but orchestration intake must suppress it before FIFO append.

## Implemented Fix

Keep the existing wire shape and deduplicate at both orchestration intake paths:
normal drain and the pre-dispatch sweep.

### 1. Carry a 20-ID LRU window

Add `recentClientMessageIds?: string[]` to `OrchestrationInput` and
`DurableSessionState`. Store IDs oldest-to-newest, normalize duplicates on load,
cap the list at 20, and carry it through every `continueAsNew` input.

### 2. Suppress duplicates before FIFO append

For each incoming prompt:

```ts
const ids = validClientMessageIds(msg.clientMessageIds);
const duplicateIds = ids.filter((id) => recentClientMessageIds.includes(id));

if (duplicateIds.length > 0) {
    touchRecentIds(duplicateIds);
    recordDuplicateSuppressed(ids, duplicateIds);
    continue;
}

appendToFifo(prompt);
rememberRecentIds(ids, 20);
```

The cancellation tombstone check remains first. IDs are remembered only after
the prompt is accepted for FIFO append. Prompts without client IDs keep legacy
behavior and are never deduplicated.

Merged prompts are atomic. If an incoming merged prompt contains any recently
seen ID, suppress the whole prompt. The client is expected to retry the same
logical message IDs rather than reuse an ID for different content.

After its first send attempt, the client keeps that exact merged text/ID set as
an immutable attempted envelope. It retries alone and cannot absorb or be
edited into a newly submitted message. Fresh pending messages form separate
envelopes, preventing whole-prompt suppression from dropping new content.

### 3. Add duplicate diagnostics

Record a non-chat diagnostic event or metric when a duplicate is suppressed,
using the session-event naming convention:

```text
session.message_duplicate_suppressed
session_id=<id>
client_message_id=<id>
```

Do not create another `user.message` event for the duplicate. If this becomes
an operator-grade aggregate, expose it through `PilotSwarmManagementClient`, a
tuner `read_*` inspect tool, and the shared stats surface rather than leaving it
available only through raw SQL.

### 4. Version the orchestration change

Durable-session orchestration `1.0.62` is frozen and `1.0.63` implements the
LRU. `OrchestrationInput.recentClientMessageIds` carries the window through
versioned `continueAsNew`; `state.ts` normalizes/touches/caps it; both intake
paths in `queue.ts` suppress overlap before timer interruption or FIFO append.
Existing in-flight versions remain unchanged and upgrade through normal
versioned `continueAsNew`. No schema migration or data reset is required.

Focused coverage lives in `cancel-pending-orchestration.test.js`: duplicate
suppression, atomic merged overlap, active-wait preservation, no-ID legacy
behavior, 20-entry eviction/touch ordering, and continue-as-new carry-forward.
`session-refresh-ui.test.js` covers ambiguous transport failure, exact envelope
retry, edit prevention, and isolation of fresh messages.

## Why UI-Only or API-Memory Fixes Are Insufficient

- A response can be lost after the server commits.
- Browser refresh or reconnection can replay pending state.
- Portal replicas do not share in-memory maps.
- Process restarts erase local dedupe caches.
- Durable orchestration replay must remain deterministic.

The orchestration is the durable serialized boundary. The 20-ID window prevents
normal client retries from creating another turn. It does not guarantee
exactly-once external side effects inside a turn; mutating tools still need
their own idempotency contracts.

## Regression Tests

### Durable queue tests

1. Enqueue the same client message ID twice; assert one FIFO prompt, one turn,
  and one `user.message` event.
2. Retry the same ID after the first prompt starts and after it completes;
  assert no second turn.
3. Retry after worker restart and after `continueAsNew`; assert no second turn
  while the ID remains in the window.
4. Accept 20 unique IDs, then accept a 21st; assert the oldest is evicted and a
  later retry of that oldest ID is accepted as new work.
5. Reuse a recent ID and assert it moves to the newest LRU position.
6. Enqueue identical text with different IDs; assert two independent turns.
7. Enqueue a merged prompt with one seen and one unseen ID; assert the whole
  merged prompt is suppressed atomically.
8. Verify cancellation tombstones run before dedupe and cancelled prompts do not
  consume LRU slots.
9. Verify prompts without client IDs retain legacy behavior.

### UI retry tests

1. Make `transport.sendMessage()` durably accept the prompt and then reject the
  client promise; assert the retry reuses the same client ID and the
  orchestration suppresses duplicate work.
2. Verify authorization failures remain terminal and show the rejected state.
3. Verify separate sends in the same tick still merge while preserving all IDs.

### Web API tests

1. Submit the same `(sessionId, clientMessageId)` twice; assert one eventual
  durable prompt and turn.
2. Repeat after `continueAsNew`; assert the carried LRU suppresses the retry.

## Acceptance Criteria

- A client message ID can produce at most one durable user message and one agent
  turn while it remains in the 20-ID window.
- Lost or timed-out HTTP responses do not duplicate execution.
- Duplicate retries are harmless across process restarts, orchestration replay,
  hydration, and `continueAsNew` while the ID remains in the window.
- Identical text with different client IDs remains valid separate input.
- Any overlap with a recent ID suppresses the whole merged prompt atomically.
- Existing precise acknowledgment and cancellation behavior remains intact.
- Suppressed duplicates are observable through diagnostics without appearing in
  the user transcript.

## Workaround

There is no reliable application-level workaround because the user cannot know
whether an ambiguous send failure occurred before or after durable enqueue.

Avoid manually resubmitting while a message is still pending or queued, but note
that the current UI can automatically retry transient failures. Operators can
inspect durable events for repeated `clientMessageIds` and stop duplicate turns,
but this is reactive and may be too late for mutating tools.
