# Bug: Blank assistant message is replayed as null content after sub-agent wait

**Status:** Fixed in current branch  
**Filed:** 2026-05-17  
**Component:** `@pilotswarm/sdk` durable session replay / CMS event persistence / `wait_for_agents` resume path  
**Affected versions:** observed with orchestration `v1.0.28` / downstream package `pilotswarm-sdk@0.1.28`  
**Severity:** Medium-High — useful child work may complete, but the parent session can enter repeated invalid model-call retries and fail to produce a final synthesis

---

## Summary

After a parent session calls `wait_for_agents` and suspends until child sessions finish, the parent can persist an empty `assistant.message` event with zero streamed characters. On a later hydrate/replay attempt, that blank assistant event can be reconstructed into the model request as a chat message whose `content` is `null` instead of a string.

OpenAI-compatible providers reject the request with:

```text
400 Invalid value for 'content': expected a string, got null.
param: messages.[N].content
```

The parent orchestration then retries/dehydrates/rehydrates repeatedly, but each replay rebuilds the same invalid message array and hits the same deterministic request-validation error.

## Resolution

The SDK now guards this path in two places:

1. Empty `assistant.message` transcript events are ignored by `ManagedSession` and are not forwarded to normal CMS event persistence.
2. Before each `CopilotSession.send()`, replayed Copilot SDK message history is sanitized so blank assistant messages without tool calls are dropped, and null content on remaining replay messages is normalized to a string.

Regression coverage verifies both the wait-boundary capture case and the pre-send replay-history sanitizer.

## Symptom

The operator sees a session that appears to be waiting for child analysis, then repeatedly reports a warning like:

```text
Execution failed: 400 Invalid value for 'content': expected a string, got null.
retry 1/3 in 15s
```

The event stream shows:

1. parent starts a turn after a cron or resume;
2. parent detects a change and spawns two or more child agents;
3. parent calls `wait_for_agents`;
4. parent emits an `assistant.message` event with empty content and `streamingChars: 0`;
5. children finish successfully;
6. parent resumes and attempts to continue;
7. model calls fail with `messages.[N].content` equal to `null`;
8. orchestration dehydrates and retries, but the replayed transcript still contains the invalid null-content message.

## Representative Timeline

An anonymized production session showed this sequence:

| Time | Event | Notes |
|---|---|---|
| `T+00s` | `assistant.message` | Parent says it is resuming a watch cycle and reading current state. |
| `T+03s` | `assistant.message` | Parent detects a change and says it is spawning a cross-check pair. |
| `T+08s` | `session.agent_spawned` | First child spawned. |
| `T+09s` | `session.agent_spawned` | Second child spawned. |
| `T+10s` | `assistant.message` | Parent says it is waiting for both child analyses. |
| `T+10s` | `tool.execution_complete` | `wait_for_agents` acknowledged. |
| `T+11s` | `assistant.message` | Empty content, no streamed characters. |
| `T+11s` | `session.idle` / `session.turn_completed` | Parent is suspended at wait boundary. |
| `T+80s` | child sessions complete | Child sessions have usable conclusions. |
| `T+90s+` | `model.call_failure` | Repeated `400 Invalid value for 'content': expected a string, got null`, parameter `messages.[N].content`. |
| `T+90s+` | `session.dehydrated` | Orchestration retries and rehydrates, but replay continues to fail. |

The important clue is the empty `assistant.message` immediately after the `wait_for_agents` acknowledgement. The following resume/replay attempts failed before the parent could summarize the child results.

## Evidence Shape

The parent session contained repeated failures like:

```json
{
  "event_type": "model.call_failure",
  "data": {
    "model": "gpt-5.4-mini",
    "source": "top_level",
    "statusCode": 400,
    "errorMessage": "{\"message\":\"Invalid value for 'content': expected a string, got null.\",\"type\":\"invalid_request_error\",\"param\":\"messages.[26].content\",\"code\":null}"
  }
}
```

Immediately before the failure loop, the parent had persisted an empty assistant message:

```text
event_type: assistant.message
text: ""
turn_end: streamingChars=0, streamingDeltas=0
```

The child sessions themselves completed normally. The failure occurred in the parent when it attempted to resume and synthesize after the wait boundary.

## Likely Root Cause

There are two related issues:

1. PilotSwarm persists empty `assistant.message` events from the SDK event stream into CMS.
2. The transcript reconstruction / replay path converts at least one blank assistant event into a model message with `content: null` rather than omitting it or normalizing it to an empty string.

Once the invalid message is in the reconstructed request, retrying the same turn cannot help because the provider rejects the request before inference starts.

The local orchestration path around `wait_for_agents` can produce a turn with no user-visible assistant text after the wait tool acknowledgement. That zero-length assistant event is not useful as durable transcript content and should not be allowed to become an LLM chat message.

## Why This Matters

- Parent sessions can fail after expensive child work already completed.
- The user sees repeated retry warnings even though the underlying child analyses are done.
- Retries waste orchestration work and can make a healthy watch/monitor session look stuck.
- The parent may never emit the final synthesis unless an outer repair path notices the child results and writes a replacement baseline/state.

## Suggested Fixes

### Fix 1: Do not persist empty assistant transcript messages

When handling SDK `assistant.message` events, skip persistence if the normalized content is empty and the event does not contain tool-call, reasoning, or other meaningful structured data.

Empty assistant messages may still be useful as low-level debug telemetry, but they should not be stored as ordinary replayable transcript events.

### Fix 2: Harden transcript reconstruction

Before sending any reconstructed history to a model provider, validate every message:

```ts
if (message.content == null) dropOrNormalize(message);
if (Array.isArray(message.content)) validateContentParts(message.content);
if (typeof message.content !== "string" && !Array.isArray(message.content)) dropOrNormalize(message);
```

For plain chat messages, either omit null/empty assistant messages or normalize them to `""` only if the provider accepts empty strings for that role. Omission is likely safer for assistant messages with no semantic content.

### Fix 3: Add a replay invariant test

Add a regression test that constructs CMS history containing:

1. normal user prompt;
2. assistant text;
3. `wait_for_agents` tool result;
4. empty `assistant.message`;
5. resume/replay.

The replay builder must not produce any outbound model message with `content: null`.

### Fix 4: Classify provider request-validation failures as non-retryable when replay is unchanged

For errors like `Invalid value for 'content'`, retries with the same replay payload are deterministic. The orchestration should either repair/drop the malformed replay message or fail fast with a clear transcript-corruption error instead of repeatedly dehydrating and retrying.

## Workaround

If this happens in production, inspect child sessions and facts/artifacts directly. The useful child work may already be complete even though the parent failed to synthesize. A repair process can write the synthesis from child outputs and refresh the watch baseline/state.

This workaround does not fix the underlying replay bug; it only avoids losing the completed child analyses.

## Reproduction Sketch

1. Start a parent session that spawns child agents.
2. Have the parent call `wait_for_agents` and naturally end the turn at the wait boundary.
3. Ensure the parent emits no assistant text after the wait acknowledgement.
4. Let the children complete.
5. Resume/hydrate the parent.
6. Observe whether the reconstructed model request includes a message with `content: null` and fails before inference.

## Acceptance Criteria

- Empty assistant events after a wait boundary do not become replayable null-content messages.
- Rehydrating/resuming a parent after `wait_for_agents` never sends `messages[*].content = null` to a provider.
- Completed child results can be synthesized by the parent after resume.
- Provider 400s caused by malformed local replay payloads are repaired or fail fast without repeated identical retries.