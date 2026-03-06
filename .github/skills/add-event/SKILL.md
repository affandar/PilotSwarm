---
name: add-event
description: Add a new event type that flows from the LLM session through to client subscribers. Covers firing the event from ManagedSession, persisting to CMS, and filtering in PilotSwarmSession.on().
---

# Add a New Event Type

Events flow from the Copilot SDK through ManagedSession, get persisted to CMS, and are delivered to client subscribers.

## Steps

1. **Fire the event from `ManagedSession`** in `src/managed-session.ts`:
   - Events are captured via the `onEvent` callback passed to `runTurn()`.
   - Inside the `copilotSession.on()` handler, events are captured as `CapturedEvent` objects:
     ```typescript
     const captured: CapturedEvent = {
         eventType: "my.event_type",
         data: eventData,
     };
     collectedEvents.push(captured);
     opts?.onEvent?.(captured);
     ```

2. **Persist to CMS** — events are automatically persisted by the activity in `src/session-proxy.ts` via the `onEvent` callback, which calls `catalog.recordEvents()`. No changes needed unless you want special handling.

3. **Filter in `PilotSwarmSession.on()`** — if the event needs special client-side filtering (e.g., excluding ephemeral events from persistence), add logic in `src/client.ts`:
   ```typescript
   session.on("my.event_type", (event) => { ... });
   ```

4. **Add a test** — verify the event appears in `session.getMessages()` and/or via `session.on()` polling.

## Event naming conventions

- Use dot-separated names: `category.action` (e.g., `assistant.message`, `tool.execution_start`).
- Ephemeral events (like `assistant.message_delta`) should NOT be persisted to CMS — they are filtered out in `session-proxy.ts`.

## Event flow

```
CopilotSession.on(event)           ← Copilot SDK fires event
  ↓
ManagedSession captures as CapturedEvent
  ↓
onEvent callback → session-proxy.ts → catalog.recordEvents()   ← persisted to CMS
  ↓
PilotSwarmSession.on() polls CMS → delivers to client subscribers
```

## Key files
- [src/managed-session.ts](../../../src/managed-session.ts) — event capture during `runTurn()`
- [src/session-proxy.ts](../../../src/session-proxy.ts) — event persistence to CMS
- [src/cms.ts](../../../src/cms.ts) — `recordEvents()` and `getSessionEvents()`
- [src/client.ts](../../../src/client.ts) — `PilotSwarmSession.on()` polling and dispatch
