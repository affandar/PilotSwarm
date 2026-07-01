# Stop Button / Turn Abort Plan

## Goal

Add a user-visible `Stop` action that aborts the currently executing turn for a session without completing, cancelling, deleting, or resetting the session itself. The session should return to an idle/ready state and accept the next prompt normally.

## Current State

- `runTurn` is already executed as a session-affined activity through `packages/sdk/src/session-proxy.ts`.
- That activity polls `activityCtx.isCancelled()` and calls `session?.abort?.()` before returning `{ type: "cancelled" }` when the activity is cancelled.
- The missing product surface is a durable command path that targets only the active turn activity, not the whole orchestration/session.
- Existing session actions (`Complete`, `Cancel`, `Hard Delete`, system restart actions) are lifecycle actions and are too destructive for this UX.

## UX Contract

- Show a `Stop` button in the session action strip when the selected session is actively running a turn.
- Disable or hide `Stop` when the selected row is a group, completed/deleted session, or not currently running.
- Clicking `Stop` should:
  - immediately disable the button or show a stopping state to avoid duplicate clicks;
  - record a durable stop request;
  - abort the live Copilot turn cooperatively;
  - leave the session selected;
  - return the session to `idle` after the activity unwinds;
  - add a short transcript/system event such as `Turn stopped by user.`
- If the turn has already ended, the action should be idempotent and report `No active turn to stop` without changing session lifecycle state.

## Proposed Runtime Design

### 1. Add A Stop-Turn Client API

Add a public method on `PilotSwarmManagementClient` and the portal/TUI transport layer:

```ts
stopSessionTurn(sessionId: string, reason?: string): Promise<void>
```

The method should enqueue a command event to the session orchestration rather than directly manipulating worker memory. This keeps the action durable, remote-safe, and consistent across portal, native TUI, and management callers.

Likely touch points:

- `packages/sdk/src/client.ts`
- `packages/sdk/src/management-client.ts`
- `packages/sdk/src/types.ts`
- `packages/cli/src/node-sdk-transport.js`
- `packages/portal/src/runtime.js`
- `packages/portal/src/browser-transport.js`

### 2. Add A Durable Orchestration Command

Add a command payload, likely:

```json
{ "type": "cmd", "cmd": "stop_turn", "id": "...", "args": { "reason": "user" } }
```

The orchestration should handle this while a `runTurn` activity is in flight. The safest model is to race the current turn activity against command input, then cancel only the scheduled `runTurn` activity when `stop_turn` wins.

Important constraints:

- Do not cancel the entire session orchestration.
- Do not mark the session as `cancelled`.
- Do not delete state or blobs.
- Keep orchestration replay deterministic; any new command/yield sequence requires a new orchestration version.

Likely touch points:

- `packages/sdk/src/orchestration/runtime.ts`
- `packages/sdk/src/orchestration/index.ts`
- `packages/sdk/src/orchestration-registry.ts`
- frozen orchestration version file per `duroxide-orchestration-versioning`

### 3. Reuse Existing Activity Cancellation Hook

The current `runTurn` activity already has cooperative cancellation behavior:

- poll `activityCtx.isCancelled()`;
- call `session?.abort?.()`;
- return `{ type: "cancelled" }` after the SDK turn unwinds.

The Stop implementation should first try to reuse this instead of creating an unrelated worker-local abort registry. If the activity cancellation does not interrupt the underlying Copilot SDK promptly enough, add a small `ManagedSession.abortCurrentTurn(reason)` wrapper around the SDK session's abort mechanism and call it from the same activity cancellation path.

Likely touch points:

- `packages/sdk/src/session-proxy.ts`
- `packages/sdk/src/managed-session.ts`
- `packages/sdk/src/session-manager.ts` only if a direct activity is needed to find a warm session by id

### 4. Persist Events And State

Add explicit CMS events for observability and UI state reconciliation:

- `session.turn_stop_requested`
- `session.turn_stopped`
- optionally `session.turn_stop_noop`

After a successful stop, CMS session state should become `idle`, not `cancelled`. `session.turn_completed` should either carry a `resultType: "stopped"`/`"cancelled"` compatible marker or be paired with `session.turn_stopped` so selectors can distinguish user-stop from session cancellation.

Likely touch points:

- `packages/sdk/src/cms.ts`
- `packages/sdk/src/cms-migrations.ts` only if stored procedures need event/state enum support
- `packages/sdk/src/types.ts`
- `packages/ui-core/src/selectors.js`

### 5. Add Shared UI State And Commands

Add a shared UI command:

```js
UI_COMMANDS.STOP_TURN = "stopTurn"
```

Controller behavior:

- Find active session id.
- Reject groups/system containers without sending a transport call.
- Dispatch a transient `stopping` marker for the session/action button if needed.
- Call `transport.stopSessionTurn(sessionId, "Stopped by user")`.
- Refresh session detail/events after the request completes or after a short poll.

Likely touch points:

- `packages/ui-core/src/commands.js`
- `packages/ui-core/src/controller.js`
- `packages/ui-core/src/reducer.js`
- `packages/ui-core/src/selectors.js`

### 6. Portal And TUI Surfaces

Portal:

- Add `Stop` near the existing session action buttons.
- Show it only for the active top-level session when `state === "running"` or when selector state indicates an active turn.
- Keep it separate from `Terminate` to avoid accidental session cancellation.

Native TUI:

- Add a keybinding only if there is an obvious non-conflicting key. Otherwise start with the visible action in the session pane/help modal and keep keyboard follow-up separate.
- Update keybinding docs if a binding is added.

Likely touch points:

- `packages/ui-react/src/web-app.js`
- `packages/cli/src/app.js` if a keybinding is added
- `docs/keybindings.md` if a keybinding is added
- `.github/skills/pilotswarm-tui/SKILL.md`

## Tests

### SDK / Orchestration Integration

Add a local integration suite under `packages/sdk/test/local/`, for example `stop-turn.test.js`, and add it to:

- `scripts/run-tests.sh`
- `packages/sdk/package.json` `test:local` script

Suggested cases:

1. **Stops a running turn and leaves session reusable**
   - Create a session with a deterministic test tool that blocks until released.
   - Send a prompt that invokes the blocking tool.
   - Wait until CMS/session events show `session.turn_started` or tool execution start.
   - Call `management.stopSessionTurn(sessionId)`.
   - Assert the session becomes `idle`, not `cancelled`/`completed`/`failed`.
   - Send a second prompt and assert it completes normally.

2. **Stop is idempotent after turn completes**
   - Complete a simple turn.
   - Call `stopSessionTurn(sessionId)`.
   - Assert no lifecycle state regression and a no-op response/event.

3. **Stop persists observability events**
   - Assert `session.turn_stop_requested` and `session.turn_stopped` are in CMS events with increasing sequence numbers.
   - Assert `session.turn_completed` ordering remains after assistant/tool events, matching existing event ordering contracts.

4. **Stop does not kill child/session tree lifecycle**
   - If the stopped session has children, assert the parent session remains alive and child metadata is not deleted.
   - A deeper child-stop behavior can be a follow-up if recursive abort is desired.

### UI / Controller Tests

Add focused controller tests if the current UI test harness supports them:

- active running session exposes `Stop` action;
- idle session disables/hides `Stop`;
- clicking `Stop` calls `transport.stopSessionTurn(sessionId, reason)` once;
- failed stop request surfaces an error status without clearing the session.

If there is no existing controller harness for this action strip, add a minimal unit smoke around `PilotSwarmUiController.handleCommand(UI_COMMANDS.STOP_TURN)` with a fake transport.

### Portal Smoke

Manual or Playwright smoke after implementation:

- start local portal;
- trigger a long-running turn;
- click `Stop`;
- verify button disables while stopping;
- verify session returns to idle and chat remains usable.

## Rollout Notes

- Because orchestration command handling changes the yielded action sequence, create and register a new orchestration version.
- Existing live orchestrations may need a reset only if the deployed worker must replay old histories through the changed live orchestration path. If the version registry routes existing sessions to their frozen orchestration version correctly, new Stop support can apply to new-version sessions without wiping old state.
- Do not ship a UI-only Stop button until the management API and orchestration command path are implemented; otherwise it will create false confidence.

## Open Questions

- Should Stop apply only to the current selected session, or should parent sessions be able to stop a child/sub-agent turn through the session tree?
- Should Stop cancel in-flight tools such as shell commands, or only abort the LLM/Copilot turn after the active tool returns?
- Should stopped turns be summarized in the session summary, or only recorded as durable events?
- Should system sessions expose Stop, or should they only expose the existing restart dispositions?