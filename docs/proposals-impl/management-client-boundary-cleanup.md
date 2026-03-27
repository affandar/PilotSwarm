# Proposal: Management Client and TUI Boundary Cleanup

## Status

Implemented

## Goal

Clean up the TUI/runtime boundary so the TUI interfaces with PilotSwarm only through:

- `PilotSwarmClient`
- `PilotSwarmWorker`
- plugins:
  - skills
  - agents
  - MCP servers
  - worker-registered tools

### Explicit exception

We will keep **`kubectl logs`-based log streaming** in the TUI for now.

That means:
- per-worker logs
- orchestration log backfill
- sequence-diagram log parsing

may remain operationally out-of-band.

Everything else should move behind supported PilotSwarm APIs.

---

## Problem

Today [packages/cli/cli/tui.js](../../packages/cli/cli/tui.js) is not just a UI.
It also acts as a:

- duroxide client
- CMS client
- orchestration status poller
- admin tool
- session metadata editor
- model registry reader
- runtime debugger

This creates several problems:

1. **Boundary leakage**
   - TUI depends on private client internals like `_getCatalog()` and `_getDuroxideClient()`.

2. **API confusion**
   - `PilotSwarmClient` is trying to be both a Copilot-SDK-like chat client and an admin/runtime client.

3. **Tight coupling to implementation details**
   - TUI understands duroxide instance state, CMS tables, custom status versions, and orchestration event semantics directly.

4. **Harder evolution**
   - Changing runtime internals risks breaking the TUI because the UI reaches through the abstraction boundary.

---

## Design Direction

Split responsibilities into two clients:

### 1. `PilotSwarmClient`

Keep this as close as possible to Copilot SDK session semantics.

It should own:

- `start()`
- `stop()`
- `createSession()`
- `resumeSession()`
- session send/event flows
- session-local history and info retrieval

This client should feel like the app-facing SDK.

### 2. `PilotSwarmManagementClient`

Add a new management/admin surface for runtime-wide operations.

It should own:

- session listing
- session rename/delete/cancel
- session inspection
- merged session view/status
- model listing
- session dumps
- system-session management
- later: diagnostics/traces/log APIs if we formalize them

This client should be what the TUI uses for management concerns.

---

## Boundary Rule

After this cleanup, the TUI should not directly use:

- private client methods
- raw duroxide client handles
- raw CMS catalog handles
- direct orchestration event queue operations
- direct CMS update/query helpers
- implementation-module imports for runtime data

### Allowed exceptions

The only intentional exception is **log streaming via `kubectl`**.

---

## What the TUI should use

### Chat/session interaction

Use `PilotSwarmClient` and session objects for:

- creating sessions
- resuming sessions
- sending prompts
- answering questions
- reading session-local message history
- receiving session events
- aborting/destroying a session from the session object API

### Runtime/session management

Use `PilotSwarmManagementClient` for:

- listing sessions
- session detail views
- rename/cancel/delete
- status watching
- model listing
- session dumps
- system session operations

---

## Current TUI Boundary Violations

### Private/internal access

The TUI currently reaches into private methods such as:

- `client._getDuroxideClient()`
- `client._getCatalog()`

These should be removed entirely.

### Direct duroxide operations

The TUI currently performs raw orchestration operations directly, including:

- listing instances
- getting orchestration info/status
- waiting for status changes
- enqueueing messages/events
- cancelling/deleting instances

These should move behind public client methods.

### Direct CMS usage

The TUI currently performs direct catalog work for things like:

- rename
- dump/export
- metadata access

These should be exposed as public management APIs.

### Direct model-registry access

The TUI currently reads model-provider state directly from implementation details.

Model listing/default-model lookup should come from a supported management API.

---

## Proposed Public API Split

## `PilotSwarmClient`

Suggested scope:

```ts
class PilotSwarmClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  createSession(config?): Promise<PilotSwarmSession>;
  resumeSession(sessionId: string): Promise<PilotSwarmSession>;
}

class PilotSwarmSession {
  send(prompt: string): Promise<void>;
  sendAndWait(prompt: string): Promise<any>;
  on(handler: (event) => void): () => void;
  abort(): Promise<void>;
  destroy(): Promise<void>;
  getMessages(limit?: number): Promise<SessionEvent[]>;
  getInfo(): Promise<PilotSwarmSessionInfo>;
}
```

## `PilotSwarmManagementClient`

Suggested initial scope:

```ts
class PilotSwarmManagementClient {
  start(): Promise<void>;
  stop(): Promise<void>;

  listSessions(): Promise<PilotSwarmSessionView[]>;
  getSession(sessionId: string): Promise<PilotSwarmSessionView | null>;

  renameSession(sessionId: string, title: string): Promise<void>;
  cancelSession(sessionId: string, reason?: string): Promise<void>;
  deleteSession(sessionId: string, reason?: string): Promise<void>;

  listModels(): Promise<ModelSummary[]>;
  dumpSession(sessionId: string): Promise<string>;
}
```

---

## Proposed `PilotSwarmSessionView`

The TUI should not merge CMS + orchestration data itself.
That merge should happen in the management client.

```ts
type PilotSwarmSessionView = {
  sessionId: string;
  title?: string;
  status: string;
  orchestrationStatus?: string;
  createdAt?: number;
  updatedAt?: number;
  iterations?: number;
  parentSessionId?: string;
  isSystem?: boolean;
  model?: string;
  error?: string;
  hasUnread?: boolean;
  waitReason?: string;
};
```

This becomes the rendering model for the session list.

---

## Migration Plan

## Phase 1 — Introduce `PilotSwarmManagementClient`

Add the new client with these methods first:

- `listSessions()`
- `getSession()`
- `renameSession()`
- `cancelSession()`
- `deleteSession()`
- `listModels()`
- `dumpSession()`

This enables immediate removal of the worst private/internal calls.

## Phase 2 — Move TUI admin actions to management API

Refactor TUI usages of:

- `_getCatalog()`
- `_getDuroxideClient()` for cancel/delete/list/status
- direct model-provider imports

Target result:
- no private client method access in the TUI

## Phase 3 — Move session-list aggregation into management API

Replace the large session-list merge logic in the TUI with:

- `mgmt.listSessions()` returning `PilotSwarmSessionView[]`

This removes direct TUI knowledge of:

- duroxide instance enumeration
- orchestration status joins
- CMS joins
- customStatusVersion bookkeeping

## Phase 4 — Replace raw event/status polling APIs in TUI

Add supported high-level methods for:

- status watching
- prompt sending
- answer sending
- command sending

Goal:
- remove direct `enqueueEvent()` and `waitForStatusChange()` from the TUI

## Phase 5 — Re-evaluate diagnostics/logging boundary

For now, keep:

- `kubectl logs`
- orchestration log backfill
- per-worker streaming panes
- sequence parsing from logs

These remain explicitly outside the clean app/runtime boundary.

Later we can decide whether to formalize them into a diagnostics API.

---

## Non-Goals

This proposal does **not** attempt to:

- remove `kubectl` log streaming right now
- redesign the TUI itself
- change plugin loading architecture
- change the durable orchestration model

The focus is strictly on **API boundary cleanup**.

---

## Success Criteria

We are done when:

1. The TUI no longer calls private methods like `_getCatalog()` or `_getDuroxideClient()`.
2. The TUI no longer performs direct duroxide admin operations.
3. The TUI no longer performs direct CMS mutations.
4. Session-list rendering uses a public management view model.
5. `PilotSwarmClient` remains close to Copilot SDK semantics.
6. Only log streaming remains intentionally out-of-band.

---

## Summary

The right architecture is:

- **`PilotSwarmClient`** → app/session-facing, Copilot-SDK-like
- **`PilotSwarmManagementClient`** → runtime/session fleet management
- **TUI** → uses only those public APIs plus plugins
- **Exception** → keep `kubectl` log streaming for now

This gives us a clean boundary without sacrificing current TUI observability.
