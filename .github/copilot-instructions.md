# Copilot Instructions for PilotSwarm

## **⚠️ NEVER commit, push, or deploy without explicit user permission. ALWAYS ask first.**

> **MANDATORY:** Do NOT run `git commit`, `git push`, `git tag`, deploy scripts, or any
> operation that modifies the repository history or remote state without the user
> explicitly saying "commit", "push", or "deploy". Stage files and describe what
> you'd commit, then ask. This applies to ALL agents including Squad members.

## Repo Scope Boundary

When the user asks for changes, releases, or deploys in this repository, operate on `pilotswarm` only unless they explicitly ask to update a downstream consumer as well.

- Do **not** propagate PilotSwarm changes into downstream app repos or vendored SDK mirrors by default.
- Do **not** deploy downstream projects as part of a PilotSwarm deploy unless the user explicitly asks for that separate rollout.
- If a downstream project is out of sync, call it out clearly instead of silently patching it.

## Bug Report Anonymization

When writing or updating files under `docs/bugreports/`, keep downstream deployments anonymous by default.

- Do **not** include downstream app names, customer/project names, proprietary agent names, cluster/context names, namespaces, hostnames, URLs, endpoints, email addresses, or other deployment-specific identifiers unless the user explicitly asks to preserve them.
- Replace live identifiers with clear placeholders such as `<downstream-app>`, `<cluster-context>`, `<namespace>`, `<session-id>`, or generic labels like "downstream app" / "named-agent session".
- Avoid pasting raw production session IDs, pod names, or copied prompt content that would reveal a downstream app's identity when a summarized or redacted example is sufficient.
- Before committing bug-report docs, scan them for identity leaks and redact anything that is not required to explain the bug.

## Sensitive Local Files

**Do NOT modify `.model_providers.json`, `.env`, or `.env.remote` without the user explicitly asking.** The real `.model_providers.json` is a local gitignored config file that may contain personal service URLs, while `.env` / `.env.remote` hold credentials. Never read env files to extract secrets, never commit the real `.model_providers.json`, and never overwrite local config with placeholder content unless the user asked for that exact reset.

When env or model-catalog shape changes, keep `.env.example` and `.model_providers.example.json` in sync with placeholder values. The checked-in `.model_providers.example.json` is the shareable template; the real `.model_providers.json` stays local and gitignored. Provider availability is still controlled by env-backed keys.

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
  cms.ts             — PostgreSQL session catalog (CMS) — calls stored procs
  cms-migrations.ts  — Versioned CMS schema migrations + stored procedure definitions
  cms-migrator.ts    — CMS migration runner (wraps pg-migrator)
  facts-store.ts     — PostgreSQL facts store — calls stored procs
  facts-migrations.ts — Versioned Facts schema migrations + stored procedure definitions
  facts-migrator.ts  — Facts migration runner (wraps pg-migrator)
  pg-migrator.ts     — Shared advisory-lock migration runner
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

### Docker / AKS Build Convention

The AKS cluster runs on AMD64 Linux nodes. **All Docker image builds must use `docker buildx build --platform linux/amd64`** — not plain `docker build` — because development happens on macOS ARM64 (Apple Silicon). Without the platform flag, the pushed image has the wrong architecture and pods fail with `ImagePullBackOff` / `no match for platform in manifest`.

Both `deploy-aks.sh` and `reset-local.sh remote` build and push images. Any script that builds Docker images for AKS must use `docker buildx build --platform linux/amd64`.

Checked-in instructions must never hard-code a cluster/context name, namespace, DNS label, or other deployment-specific identifier. Resolve the Kubernetes context and namespace from `.env.remote` via `K8S_CONTEXT` and `K8S_NAMESPACE` before running AKS deploy or reset commands.

## TUI Boundary Rule

The TUI (`packages/cli/`) must interact with PilotSwarm **exclusively through the public `PilotSwarmClient`, `PilotSwarmWorker`, and management APIs**. It must never import or call internal runtime modules (`session-manager.ts`, `managed-session.ts`, `cms.ts`, `session-proxy.ts`, `orchestration.ts`, etc.) directly. The only exception is logging/diagnostics (for example reading duroxide trace logs for display). If the TUI needs new data or capabilities, expose them through the client/worker API surface first.

## Portal Boundary Rule

The portal (`packages/portal/`) must interact with PilotSwarm **exclusively through the public `PilotSwarmClient`, `PilotSwarmWorker`, `PilotSwarmManagementClient`, and the CLI's `PortalRuntime` API**. It must never import or call internal SDK modules (`session-manager.ts`, `managed-session.ts`, `cms.ts`, `session-proxy.ts`, `orchestration.ts`, etc.) directly.

Portal auth is provider-based (`packages/portal/auth/`). Auth providers live in `auth/providers/`, token normalization in `auth/normalize/`, and authorization policy in `auth/authz/engine.js`. Configuration uses **canonical env vars only**: `PORTAL_AUTH_*` and `PORTAL_AUTHZ_*` — never legacy `ENTRA_*` aliases.

### TUI Keybindings

If you add or change a TUI keybinding, you must update all user-facing keybinding surfaces together:

- the actual binding in host input handling
- the contextual status hints that mention that key
- prompt placeholder or prompt-affordance copy when send/newline behavior changes
- modal, footer, detail, or inline pane-title copy that references that key
- the startup keybinding hint/splash content or help dialog/modal content, if that host has them

Do not change a TUI keybinding in code without keeping those surfaces in sync.

Current overlap to preserve unless intentionally changed:

- `n` opens a new-session flow; in apps with named creatable agents it should open the agent picker rather than blindly creating a generic session
- `Shift+N` opens the model picker, and model selection should flow into the same new-session/agent-picker path
- `f` in the sessions pane opens the session owner filter
- `t` in the sessions pane opens the rename-title dialog
- `t` in the logs inspector toggles log tailing
- `Ctrl+A` in the prompt opens the attach-file dialog
- `o` in the files inspector opens the selected file in the OS default app
- `f` in the logs inspector opens the log-filter dialog, `f` in the files inspector opens the files-filter dialog, and `f` in the stats inspector cycles between session, fleet, and users views

## TUI Maintenance

The shared terminal UI is a maintained product surface, not an experiment.

The native TUI and the browser portal are a single shared UX surface by default. When a change affects shared behavior, layout semantics, inspector behavior, themes, keybindings, prompt ergonomics, or visible help text, keep the TUI and portal in complete sync unless that is genuinely impossible or the user explicitly asks for a divergence.

If a change leaves the TUI and portal out of sync, say so explicitly in your response and note the reason for the mismatch rather than implying parity.

When you change the terminal/shared UI stack in:

- `packages/ui-core/`
- `packages/ui-react/`
- `packages/cli/`
- `packages/portal/`
- `run.sh`

you must also keep [`.github/skills/pilotswarm-tui/SKILL.md`](./skills/pilotswarm-tui/SKILL.md) current if the change affects architecture, layout, visual conventions, status semantics, prompt/question behavior, message-card behavior, or keybinding expectations.

For the native TUI files inspector, keep the standard outer inspector shell as the top-level pane chrome. Do not reintroduce a second files-specific top-level shell around the tab body.

Use the `pilotswarm-tui` agent/skill for TUI-specific work. Treat it as the canonical short-form memory for the current TUI design choices and maintenance preferences.

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

## Agent Prompt Tuning & Model Compatibility

When you change an agent prompt, tune timer interrupt wording, or test a new LLM model with PilotSwarm agents, update both:

- **`/memories/repo/agent-tuning-log.md`** — Copilot repo memory (read by the `pilotswarm-agent-tuner` agent)
- **`docs/agent-tuning-log.md`** — version-controlled copy for human reference

Record: the model tested, which agent type, observed behavior, expected behavior, and whether the change worked. Keep the model compatibility matrix current. Use the `pilotswarm-agent-tuner` agent for structured tuning workflows.

## Observability Surface for the Agent Tuner

The `agent-tuner` agent is the canonical investigator for reliability, cost,
performance, and correctness issues. Any new monitoring signal, metric,
aggregate, or diagnostic that is useful for those investigations **must
be reachable by the tuner through a tool**, not just through SQL or a dashboard.

When you add or change an observability surface, follow this checklist:

1. **Persist the signal durably.** Either as a column on
   `session_metric_summaries`, a row in `session_events` (preferred for
   per-event signals), or a counter in the relevant store schema (CMS or
   facts).
2. **Expose it through `PilotSwarmManagementClient`.** A typed read
   method on the management client is the canonical API surface — no
   tuner-only side channels, no raw SQL helpers in scripts.
3. **Wrap it as a tuner inspect-tool.** Add a `read_*` tool in
   [`packages/sdk/src/inspect-tools.ts`](../packages/sdk/src/inspect-tools.ts)
   inside the `if (!isTuner) return [readAgentEventsTool];` guard so it
   is registered only on tuner sessions. Mirror the existing patterns:
   `read_session_*` for per-session, `read_session_tree_*` for spawn
   trees, `read_fleet_*` for fleet-wide.
4. **Surface it in the TUI/portal stats pane** if it is operator-grade.
   Selectors live in [`packages/ui-core/src/selectors.js`](../packages/ui-core/src/selectors.js)
   and render in both the native TUI and the portal automatically.
5. **Test it.** A `*-stats.test.js` (or similar) under `test/local/` that
   seeds data and verifies the management API + the inspect-tool
   handler.

Examples already in the codebase to follow:

- `getSessionMetricSummary` / `read_session_metric_summary` (tokens,
  snapshot, hydration counters)
- `getSessionTreeStats` / `read_session_tree_stats` (spawn-tree roll-up)
- `getFleetStats` / `read_fleet_stats` (fleet-wide aggregates)
- `getSessionSkillUsage` / `read_session_skill_usage` (static + learned
  skill consumption)
- `getFleetSkillUsage` / `read_fleet_skill_usage` (skill usage across
  the fleet)
- Cache-hit ratio fields on every stats surface
  ([`computeCacheHitRatio`](../packages/sdk/src/cms.ts))

If a new signal is **not** wired through these layers, the tuner cannot
reason about it during incident investigations, and operators have to
fall back to ad-hoc SQL — which is the exact gap this rule exists to
prevent.

## Duroxide Bugs

When a bug is identified as originating in **duroxide** (the Rust-based durable orchestration runtime), do NOT attempt to work around it in the runtime or TUI layer. Instead:

1. Clearly explain the bug and its root cause in duroxide.
2. Insist on fixing the issue in the duroxide codebase itself.
3. Only implement a workaround if explicitly asked to by the user.

Duroxide is the foundational runtime — papering over its bugs at higher layers creates fragile, hard-to-maintain code.

For live runtime forensics — tracing orchestration/activity logs, session-affined `runTurn` placement, hydration/dehydration evidence, or crash-vs-affinity investigations — use [`.github/skills/investigate-duroxide-runtime/SKILL.md`](./skills/investigate-duroxide-runtime/SKILL.md).

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

**Default-model by default.** Tests should use the repo's configured default model unless the test is explicitly about model selection, multi-model behavior, cross-model behavior, or an intentional per-model compatibility sweep. Do not pin a specific model in ordinary behavior tests just to make them pass.

**No custom system prompts to compensate for product behavior.** Tests should use `client.createSession()` without overriding `systemMessage` unless the test is specifically testing custom system messages. The default agent prompt and tool schemas should be sufficient for the LLM to use tools correctly. If the LLM isn't calling a tool, that's a product bug in the default prompt or tool schema — fix it there, not in the test.

**Raise failures loudly.** When a test fails, investigate and report the root cause. Do not silence it. Flag the issue to the user.

## Database Schema & Stored Procedures

All PostgreSQL data access (reads and writes) in the CMS and Facts stores goes through **stored procedures**. No inline SQL in TypeScript — the provider methods call `SELECT schema.proc_name(...)`.

### Migration System

Both CMS (`copilot_sessions` schema) and Facts (`pilotswarm_facts` schema) use the same versioned migration runner (`pg-migrator.ts`) with PostgreSQL advisory locks for concurrent worker safety. Migrations are defined as TypeScript functions in `cms-migrations.ts` and `facts-migrations.ts`, applied automatically on `initialize()`.

### Schema Change Rules

1. **Never edit a previous migration.** Add a new one with `CREATE OR REPLACE FUNCTION`.
2. **Every migration needs a companion diff file** (`packages/sdk/src/migrations/NNNN_diff.md`). Git diffs for SQL-in-TypeScript only show new code, not the delta from the previous version. The diff file makes stored procedure changes reviewable.
3. **All new data-access queries must be stored procedures.** No new inline SQL in the provider classes.
4. **Migration SQL must be idempotent** — `IF NOT EXISTS`, `CREATE OR REPLACE`, etc.

Use the [`schema-migration` skill](./skills/schema-migration/SKILL.md) for the full step-by-step process.

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

### Updating Copilot SDK (`@github/copilot`, `@github/copilot-sdk`)

When a new version of the Copilot SDK is pulled in, run the tool-collision regression check **before** rolling the new version to production:

```bash
cd packages/sdk
npx vitest run test/local/tool-name-collisions.test.js
```

The Copilot SDK ships built-in tools through `cli.toolInit` (e.g. `bash`, `create`, `edit`, `task`, `list_agents` in 1.0.32+). It rejects any external tool whose name shadows a built-in unless that tool sets `overridesBuiltInTool: true`. Each new SDK release may add more built-ins.

When the regression test fails:

1. **Identify the new collision** — the assertion message names the colliding PilotSwarm tool(s).
2. **Decide rename vs. override**:
   - **Rename to `ps_<name>`** when PilotSwarm's tool has different semantics from the SDK's. This is the default. Update the live `orchestration.ts`, `managed-session.ts` tool descriptions, agent prompts under `packages/sdk/plugins/`, builder templates under `templates/builder-agents/`, the DevOps sample under `examples/devops-command-center/`, and the docs under `docs/`. **Do not modify frozen `orchestration_1_0_*.ts` files** — those are pinned to historical versions per the duroxide orchestration versioning skill.
   - **Set `overridesBuiltInTool: true`** when PilotSwarm's tool deliberately replaces the SDK's (e.g. `wait`, `ask_user` — durable-orchestration versions of the SDK primitives). Add a comment explaining why the override is intentional.
3. **Update `SDK_BUILT_IN_TOOL_NAMES`** in `test/local/tool-name-collisions.test.js` to include any newly-discovered SDK built-in names so future regressions stay caught.
4. **Re-run the test until it passes**, then run the full suite via `./scripts/run-tests.sh` before deploy.

### Adding a new command
1. Add the command case in the orchestration's cmd dispatch (`orchestration.ts`)
2. Add corresponding handling in `client.ts` `_waitForTurnResult()` if needed

### Adding a new event type
1. Fire it from `ManagedSession` via the `onEvent` callback
2. Persist it in CMS via `session-proxy.ts` event capture
3. Filter it in `PilotSwarmSession.on()` if it needs special handling
