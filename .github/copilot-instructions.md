# Copilot Instructions for PilotSwarm

## **⚠️ NEVER commit, push, or deploy without explicit user permission. ALWAYS ask first.**

## Project Overview

pilotswarm is a durable execution runtime for [GitHub Copilot SDK](https://github.com/github/copilot-sdk) agents, powered by [duroxide](https://github.com/microsoft/duroxide) (a Rust-based durable orchestration engine). It provides **crash recovery, durable timers, session dehydration, and multi-node scaling**.

## Architecture

The runtime separates into two runtime components:

- **`PilotSwarmClient`** — manages sessions, sends prompts, subscribes to events. Lightweight, no GitHub token needed. Only handles serializable data.
- **`PilotSwarmWorker`** — runs LLM turns, executes tool handlers, manages the Copilot runtime. Requires a GitHub token. Tools are registered here.

Both connect to the same PostgreSQL (or SQLite) database. The orchestration layer (duroxide) coordinates between them.

### Key Data Flow

```
Client → duroxide orchestration → SessionProxy activity → SessionManager → ManagedSession → CopilotSession (Copilot SDK)
```

### Tool Registration

Tools contain handler functions (non-serializable). Two registration patterns:

1. **Worker-level registry** (`worker.registerTools([...])`) — tools available to all sessions. Clients reference by `toolNames: ["name"]` (serializable strings).
2. **Per-session** (`worker.setSessionConfig(id, { tools })`) — same-process mode only.

Tools are re-registered on the `CopilotSession` via `registerTools()` at every `runTurn()` call in `ManagedSession`.

## Project Structure

```
src/
  index.ts           — Public API exports
  client.ts          — PilotSwarmClient + PilotSwarmSession
  worker.ts          — PilotSwarmWorker (runtime, tool registry)
  orchestration.ts   — Duroxide orchestration generator function
  session-proxy.ts   — Activity definitions (runTurn, hydrate, dehydrate)
  session-manager.ts — SessionManager (CopilotSession lifecycle, tool resolution)
  managed-session.ts — ManagedSession (wraps CopilotSession, runTurn logic)
  cms.ts             — PostgreSQL session catalog (CMS)
  blob-store.ts      — Azure Blob session dehydration/hydration
  types.ts           — All TypeScript interfaces and types
test/
  sdk.test.js        — Integration test suite
examples/
  tui.js             — Terminal UI with sequence diagram visualization
  chat.js            — Simple CLI chat
  worker.js          — Standalone worker process
```

## Coding Conventions

- **TypeScript** for all source in `src/`. Tests and examples are plain `.js` (ESM).
- **ESM modules** — all imports use `.js` extensions (`from "./types.js"`).
- **duroxide is CommonJS** — use `createRequire(import.meta.url)` for duroxide imports.
- Internal classes/functions marked `@internal` are not part of the public API.
- Orchestration functions are generator functions (`function*`) that yield duroxide primitives.
- `ManagedSession.runTurn()` uses `send()` + `on()` internally, never `sendAndWait()`.

## Orchestration Determinism Rules

Orchestration generator functions are **replayed from the beginning** on every new event. The generator must produce the exact same sequence of yielded actions during replay as during original execution. Violating this causes `nondeterministic: custom status mismatch` errors.

### NEVER use in orchestration code:
- **`Date.now()`** — returns different values during replay. Use `yield ctx.utcNow()` instead.
- **`Math.random()`** — non-deterministic. Use `yield ctx.newGuid()` for unique IDs.
- **`crypto.randomUUID()`** — same issue, use `yield ctx.newGuid()`.
- **`setTimeout` / `setInterval`** — use `yield ctx.scheduleTimer(ms)` instead.
- **Any I/O or network call** — wrap in an activity.
- **Conditional yields based on wall-clock time** — the branch may differ during replay.

### ALWAYS use:
- `yield ctx.utcNow()` — deterministic timestamp (replay-safe)
- `yield ctx.newGuid()` — deterministic GUID
- `yield ctx.scheduleTimer(ms)` — durable timer
- `yield session.someActivity()` — durable activity
- `ctx.setCustomStatus(json)` — fire-and-forget (no yield), but order relative to yields matters

### Key principle:
Anything that **changes the sequence of `yield` statements** must itself be deterministic. Branching on non-deterministic values (like `Date.now()`) before a yield is the most common bug. `setCustomStatus()` is recorded in history — if the orchestration yields an activity where replay expects a `CustomStatusUpdated` (or vice versa), duroxide throws a nondeterminism error.

### Deployment note:
Changing the orchestration code (adding/removing/reordering yields) creates a new version. Existing in-flight orchestrations were recorded with the old yield sequence and will fail on replay. **Always reset the database before redeploying** with orchestration changes — use `./scripts/deploy-aks.sh` which handles this automatically.

## TUI Boundary Rule

The TUI (`cli/tui.js`) must interact with PilotSwarm **exclusively through the public `PilotSwarmClient` and `PilotSwarmWorker` APIs**. It must never import or call internal modules (`session-manager.ts`, `managed-session.ts`, `cms.ts`, `session-proxy.ts`, `orchestration.ts`, etc.) directly. The only exception is **logging** (e.g. reading duroxide trace logs for display). If the TUI needs new data or capabilities, expose them through the client/worker API surface first.

## Duroxide Bugs

When a bug is identified as originating in **duroxide** (the Rust-based durable orchestration runtime), do NOT attempt to work around it in the runtime or TUI layer. Instead:

1. Clearly explain the bug and its root cause in duroxide.
2. Insist on fixing the issue in the duroxide codebase itself.
3. Only implement a workaround if explicitly asked to by the user.

Duroxide is the foundational runtime — papering over its bugs at higher layers creates fragile, hard-to-maintain code.

## Testing

Tests are integration tests that require a running database and a GitHub token. Run with:
```bash
npm test                           # all tests
npm test -- --test=<filter>        # specific test by name
```

Tests use a `withClient()` helper that spins up a co-located worker + client pair. Each test creates fresh sessions.

## Common Patterns

### Adding a new activity
1. Define the activity function in `session-proxy.ts` → `registerActivities()`
2. Create a proxy function in `createSessionProxy()` or `createSessionManagerProxy()`
3. Call it from the orchestration generator in `orchestration.ts`

### Updating duroxide-node (npm) Dependency

When a new version of `duroxide` is published to npm (after the Node.js SDK is updated and published):

1. **Update package.json**: Run `npm update duroxide` or manually bump the version in `package.json`
2. **Check for API changes**: If the duroxide SDK added new `OrchestrationContext` methods, `Runtime` options, or `Client` APIs, update usage in:
   - `src/orchestration.ts` — orchestration generator function
   - `src/session-proxy.ts` — activity definitions
   - `src/worker.ts` — runtime initialization
3. **Build**: `npm run build` (TypeScript compilation)
4. **Test**: `npm test`
5. **Verify examples**: Run `node examples/chat.js` to smoke test

> ⚠️ **Never push without explicit user permission**

### Adding a new command
1. Add the command case in the orchestration's cmd dispatch (`orchestration.ts`)
2. Add corresponding handling in `client.ts` `_waitForTurnResult()` if needed

### Adding a new event type
1. Fire it from `ManagedSession` via the `onEvent` callback
2. Persist it in CMS via `session-proxy.ts` event capture
3. Filter it in `PilotSwarmSession.on()` if it needs special handling
