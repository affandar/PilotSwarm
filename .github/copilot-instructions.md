# Copilot Instructions for PilotSwarm

## **⚠️ NEVER commit, push, or deploy without explicit user permission. ALWAYS ask first.**

> **MANDATORY:** Do NOT run `git commit`, `git push`, `git tag`, deploy scripts, or any
> operation that modifies the repository history or remote state without the user
> explicitly saying "commit", "push", or "deploy". Stage files and describe what
> you'd commit, then ask. This applies to ALL agents including Squad members.

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

### TUI Keybindings

If you add or change a TUI keybinding, you must update all user-facing keybinding surfaces together:

- the startup keybinding hint/splash content
- the help dialog/modal content
- any contextual status hints that mention that key

Do not change a TUI keybinding in code without keeping those surfaces in sync.

## Builder Agent Templates

This repo ships distributable builder-agent templates under `templates/builder-agents/`.

These are **not** active repo-local agents for this workspace. They are copyable templates intended to be installed into a user's repository under `.github/agents/` and `.github/skills/`.

If you add or change PilotSwarm features that affect app builders, keep the following in sync:

- `templates/builder-agents/agents/*.agent.md`
- `templates/builder-agents/skills/**/SKILL.md`
- `templates/builder-agents/README.md`
- [docs/builder-agents.md](../docs/builder-agents.md)
- the builder-facing CLI/SDK docs those templates reference

Treat these templates as a maintained product surface. Do not leave them stale when builder-relevant behavior changes.

## Significant Feature Rollouts

When you add or materially change a user-facing or builder-facing feature, update the surrounding surfaces in the same change whenever they are affected:

- the canonical docs in `docs/` for the relevant SDK, CLI, plugin, or packaging behavior
- the DevOps sample in `examples/devops-command-center/`
- the builder templates in `templates/builder-agents/`
- `.github/copilot-instructions.md` if the change affects contributor workflow or maintenance expectations
- package names, install examples, and CI publish/release wiring if the npm surface changes

Do not treat proposal docs as sufficient once behavior ships. If the product changed, the canonical docs, sample app, and builder templates should reflect it too.

## Duroxide Bugs

When a bug is identified as originating in **duroxide** (the Rust-based durable orchestration runtime), do NOT attempt to work around it in the runtime or TUI layer. Instead:

1. Clearly explain the bug and its root cause in duroxide.
2. Insist on fixing the issue in the duroxide codebase itself.
3. Only implement a workaround if explicitly asked to by the user.

Duroxide is the foundational runtime — papering over its bugs at higher layers creates fragile, hard-to-maintain code.

## Testing

### Running Tests

The local integration test suite requires a running PostgreSQL database and a GitHub token (in `.env`). Tests use **vitest** as the test runner with `describe`/`it` from `vitest`.

```bash
./scripts/run-tests.sh              # run all suites in parallel (default)
./scripts/run-tests.sh --parallel   # run all suites in parallel explicitly
./scripts/run-tests.sh --sequential # run all suites sequentially
./scripts/run-tests.sh --suite=smoke  # run only matching suite(s)
```

Individual suites can also be run directly:
```bash
cd packages/sdk
npx vitest run test/local/smoke-basic.test.js
npx vitest run test/local/smoke-basic.test.js -t "Send And Receive"  # filter by test name
```

### Test Suite Structure

Tests are organized by level in `packages/sdk/test/local/`:

| Level | File(s) | What it covers |
|-------|---------|---------------|
| 1 | `smoke-basic.test.js`, `smoke-api.test.js` | Basic session create/send/receive, CMS state, session info API |
| 2 | `durability.test.js` | Durable timers, orchestration replay |
| 3 | `multi-worker.test.js` | Worker restart, session handoff, multi-node |
| 4 | `commands-user.test.js` | Commands and events through orchestration |
| 4b | `management.test.js` | Management client: sendMessage, renameSession, cancelSession, session ops |
| 5 | `sub-agents/*.test.js` | Sub-agent spawning (custom, named, multiple), child metadata, model override, nested spawning (depth 2+), check_agents |
| 6 | `kv-transport.test.js` | KV-based response transport |
| 7 | `cms-events.test.js`, `cms-state.test.js` | CMS event consistency, state transitions, title rename, soft delete |
| 8 | `contracts.test.js` | API contract validation |
| 9 | `chaos.test.js` | Chaos/fault injection scenarios |
| 10 | `session-policy-guards.test.js`, `session-policy-behavior.test.js` | Session creation policy guards and behavior |
| — | `model-selection.test.js` | Model selection (explicit, default, multi-model), CMS model column |
| — | `reliability-crash.test.js`, `reliability-multi-crash.test.js` | Crash recovery, multi-crash scenarios |
| — | `system-agents.test.js` | PilotSwarm/Sweeper/ResourceMgr auto-start lifecycle |

Tests use a `withClient()` helper that spins up a co-located worker + client pair. Each test creates fresh sessions with isolated database schemas.

### Pre-Deploy Gate

**The deploy script (`./scripts/deploy-aks.sh`) runs the full test suite automatically before deploying.** If any suite fails, the deploy aborts. To skip (not recommended): `--skip-tests`.

### Updating the Test Suite

When adding a new feature, add or update tests following these rules:

1. **New tool or activity** → add a test in the appropriate level (usually L1 smoke or L5 sub-agents). Verify the tool is callable by the LLM and produces correct CMS state.

2. **New orchestration behavior** → add tests in L2 (durability) or L3 (multi-worker) depending on whether the behavior involves replay, timers, or worker handoff.

3. **New agent or agent parameter** → add a test in L5 (`sub-agents.test.js`) that spawns the agent and verifies CMS metadata (agentId, title, isSystem, splash, parent link). See `testSpawnNamedAgents` as the template.

4. **New CMS fields or state transitions** → add assertions in L7 (`cms-consistency.test.js`).

5. **Changed tool schema** → if you modify a tool's parameters (especially `spawn_agent`, `wait`, `ask_user`), verify both the stub schema (in `subAgentToolDefs()`) and the real handler schema (in `runTurn()`) are in sync. The "Spawn Named Agents" test catches stub/handler schema mismatches.

6. **New orchestration version** → freeze the current `orchestration.ts` to `orchestration_X_Y_Z.ts`, register in `orchestration-registry.ts`, then run the full suite. Multi-worker and chaos tests will catch replay/versioning issues.

7. **New test suite file** → add it to both the `SUITES` array in `scripts/run-tests.sh` and the `test:local` npm script in `packages/sdk/package.json`. Every test file in `test/local/` must be runnable via `./scripts/run-tests.sh`. Orphaned test files that only run manually are not acceptable.

Each test function should:
- Use `withClient(env, ...)` for setup/teardown
- Use assertion helpers from `test/helpers/assertions.js`
- Use `describe`/`it` from `vitest` (not `node:test`)
- Log key values with `console.log("  ...")` for debuggability

### Test Integrity Rules

**No retries.** Never add `retry` to test configurations (vitest `retry`, `retries`, or manual retry loops). If a test fails, it means the product has a bug or the test prompt is wrong — fix the root cause.

**No hacks.** Do not paper over product bugs by weakening assertions, adding arbitrary sleeps, or swallowing errors. Tests exist to catch real problems.

**No custom system prompts to compensate for product behavior.** Tests should use `client.createSession()` without overriding `systemMessage` unless the test is specifically testing custom system messages. The default agent prompt and tool schemas should be sufficient for the LLM to use tools correctly. If the LLM isn't calling a tool, that's a product bug in the default prompt or tool schema — fix it there, not in the test.

**Raise failures loudly.** When a test fails, investigate and report the root cause. Do not silence it. Flag the issue to the user.

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
