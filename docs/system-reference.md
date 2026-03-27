# PilotSwarm — System Reference

A complete source-level map of the PilotSwarm codebase. Complements `architecture.md` (conceptual design) with concrete file-by-file detail, dependency graphs, and operational reference.

---

## 1. Project Metadata

| Key | Value |
|-----|-------|
| **Package** | `pilotswarm` v0.1.0 |
| **Module system** | ESM (`.js` extensions in imports) |
| **Runtime** | Node.js 24+ |
| **Language** | TypeScript (src), plain JS (tests, examples, CLI) |
| **Build** | `tsc` → `dist/`, ES2022 target, NodeNext resolution |
| **Key deps** | `@github/copilot-sdk` v0.1.32, `duroxide` v0.1.14, `pg` v8.18, `@azure/storage-blob` v12.31 |

### Build & Run

```bash
npm run build          # TypeScript → dist/
npm test               # Integration tests (needs DB + GITHUB_TOKEN)
npm run db:reset       # Drop duroxide + CMS schemas
./run.sh               # Dev quick-start (local mode, remote PG)
./run.sh remote        # AKS client mode
```

---

## 2. Source File Map

### Core Runtime (`src/`)

| File | Responsibility | Key Exports |
|------|---------------|-------------|
| `index.ts` | Public API barrel | `PilotSwarmClient`, `PilotSwarmSession`, `PilotSwarmWorker`, `PilotSwarmManagementClient`, types |
| `types.ts` | All TypeScript interfaces | `TurnResult`, `OrchestrationInput`, `SubAgentEntry`, `SerializableSessionConfig`, `ManagedSessionConfig`, `PilotSwarmSessionStatus` |
| `client.ts` | Client-side session lifecycle | `PilotSwarmClient`, `PilotSwarmSession` |
| `worker.ts` | Worker runtime, activity registration | `PilotSwarmWorker` |
| `orchestration.ts` | Duroxide orchestration generator | `durableSessionOrchestration_1_0_29`, `CURRENT_ORCHESTRATION_VERSION` |
| `session-proxy.ts` | Activity definitions (680 lines) | `registerActivities()`, `createSessionProxy()`, `createSessionManagerProxy()` |
| `session-manager.ts` | CopilotSession lifecycle (warm cache) | `SessionManager` |
| `managed-session.ts` | Single-turn LLM execution | `ManagedSession` |
| `cms.ts` | PostgreSQL session catalog | `SessionCatalogProvider` interface, PG implementation |
| `blob-store.ts` | Azure Blob dehydration/hydration | `SessionBlobStore` |
| `management-client.ts` | Admin/TUI management API | `PilotSwarmManagementClient` |
| `model-providers.ts` | Multi-provider LLM registry | `ModelProviderRegistry`, `loadModelProviders()` |
| `agent-loader.ts` | `.agent.md` file parser | `loadAgentFiles()`, `systemAgentUUID()`, `systemChildAgentUUID()` |
| `skills.ts` | `SKILL.md` loader | `loadSkills()` |
| `mcp-loader.ts` | `.mcp.json` loader | `loadMcpConfig()` |
| `tools/sweeper.ts` | Sweeper agent tools | `createSweeperTools()` |
| `tools/resource-manager.ts` | Resource monitor tools | `createResourceManagerTools()` |
| `tools/artifacts.ts` | Agent artifact read/write | `createArtifactTools()` |

### CLI & TUI

| File | Responsibility |
|------|---------------|
| `bin/tui.js` | CLI entry point, argument parsing, env loading |
| `cli/tui.js` | Main TUI (2,000+ lines), neo-blessed UI, session management |

### Examples

| File | Purpose |
|------|---------|
| `examples/chat.js` | Interactive console chat with full orchestration |
| `examples/worker.js` | Headless K8s worker (standalone deployment) |
| `examples/test-models.js` | Batch model verification |
| `examples/tui.js` | Deprecated (superseded by `cli/tui.js`) |

### Tests

| File | Purpose |
|------|---------|
| `test/sdk.test.js` | Integration test suite (all test cases) |

### Scripts

| File | Purpose |
|------|---------|
| `scripts/db-reset.js` | Drop duroxide + CMS schemas |
| `scripts/postinstall.js` | Post-npm-install hook |
| `scripts/_debug_*.js` | Debug utilities (orchestrations, sessions, events) |
| `scripts/_test_local_400.js` | Stress test: 400 concurrent local sessions |
| `run.sh` | Dev quick-start launcher |
| `scripts/deploy-aks.sh` | AKS deployment (image build/push + K8s rollout + secret refresh) |

### Plugin System

| Path | Purpose |
|------|---------|
| `plugin/plugin.json` | Plugin metadata |
| `plugin/.mcp.json` | MCP server configuration |
| `plugin/agents/*.agent.md` | Agent definitions (YAML frontmatter + markdown) |
| `plugin/skills/*/SKILL.md` | Reusable knowledge modules |

---

## 3. Dependency Graph

```
PilotSwarmClient
  ├── duroxide.Client (CommonJS via createRequire)
  ├── SessionCatalogProvider (CMS)
  └── PilotSwarmSession (per-session handle)

PilotSwarmWorker
  ├── duroxide.Runtime (CommonJS via createRequire)
  ├── SessionManager
  │   ├── ManagedSession (per-session, wraps CopilotSession)
  │   ├── SessionBlobStore (optional)
  │   └── Tool Registry (Map<string, Tool>)
  ├── SessionCatalogProvider (CMS)
  ├── registerActivities() → 17 activities on Runtime
  ├── Plugin Loader
  │   ├── loadAgentFiles() → AgentConfig[]
  │   ├── loadSkills() → SkillConfig[]
  │   └── loadMcpConfig() → MCP server configs
  └── ModelProviderRegistry

PilotSwarmManagementClient
  ├── duroxide.Client
  └── SessionCatalogProvider (CMS)

Orchestration Generator
  ├── createSessionProxy() → 5 affinity-routed activities
  └── createSessionManagerProxy() → 12 global activities
```

---

## 4. Type System Reference

### TurnResult — What Activities Return to Orchestration

The orchestration's main loop dispatches on `result.type`:

| Type | Meaning | Orchestration Action |
|------|---------|---------------------|
| `completed` | LLM finished, has response | Go idle, or arm the active cron schedule before waiting |
| `wait` | LLM called `wait(seconds, reason, preserveWorkerAffinity?)` | One-shot durable wait; short waits may stay in-process |
| `cron` | LLM called `cron(seconds, reason)` or `cron(action="cancel")` | Set/update/cancel recurring durable wake-up owned by orchestration |
| `input_required` | LLM called `ask_user(question)` | Wait for user answer, race with grace period |
| `spawn_agent` | LLM called `spawn_agent(task)` | Create child session + orchestration |
| `message_agent` | LLM called `message_agent(id, msg)` | Forward to child orchestration |
| `check_agents` | LLM called `check_agents()` | Return sub-agent status JSON |
| `wait_for_agents` | LLM called `wait_for_agents(ids)` | Block on child completions |
| `complete_agent` | LLM called `complete_agent(id)` | Send `/done` to child |
| `cancel_agent` | LLM called `cancel_agent(id)` | Terminate child orchestration |
| `delete_agent` | LLM called `delete_agent(id)` | Cancel + remove from CMS |
| `list_sessions` | LLM called `list_sessions()` | Return all sessions from CMS |
| `cancelled` | Turn was aborted (cancellation) | Loop (retry) |
| `error` | LLM or runtime failure | Retry with backoff, or park in error state |

### OrchestrationInput — State That Survives `continueAsNew`

This is the full state carried across orchestration continuations. It survives crashes, worker restarts, and dehydration cycles.

Key fields:

| Field | Type | Purpose |
|-------|------|---------|
| `sessionId` | string | Session identifier |
| `config` | SerializableSessionConfig | Model, system message, tool names |
| `iteration` | number | Turn counter |
| `affinityKey` | string | Worker pinning (regenerated on dehydrate) |
| `needsHydration` | boolean | Session must be reloaded from blob |
| `blobEnabled` | boolean | Whether blob storage is configured |
| `subAgents` | SubAgentEntry[] | Tracked child sessions |
| `parentSessionId` | string? | If this is a sub-agent |
| `nestingLevel` | number | 0=root, 1=child, 2=grandchild (max 2) |
| `isSystem` | boolean | System agent (sweeper, resource-mgr) |
| `taskContext` | string? | Original prompt (survives truncation) |
| `dehydrateThreshold` | number | Seconds before long wait → dehydrate |
| `idleTimeout` | number | Auto-dehydrate after idle (-1 disables) |
| `inputGracePeriod` | number | Keep warm for user input |
| `checkpointInterval` | number | Periodic checkpoint (-1 disables) |
| `retryCount` | number | Activity failure retries (resets on success) |

Related session-view fields exposed through `PilotSwarmSessionInfo`, `PilotSwarmSessionView`, and orchestration custom status now include:

- `cronActive` / `cronInterval` / `cronReason`
- `contextUsage` (token limit, current tokens, utilization, and latest compaction snapshot)

### PilotSwarmSessionStatus — Session State Machine

```
pending → running → idle ⇄ running
                  → waiting → running (timer fires)
                  → input_required → running (user answers)
                  → completed
                  → failed
                  → error → running (retry)
```

---

## 5. Activity Reference

### Session-Scoped (Affinity-Key Routed)

These execute on the specific worker holding the session's in-memory state.

| Activity | Input | Output | What It Does |
|----------|-------|--------|--------------|
| `runTurn` | sessionId, prompt, config | TurnResult | Execute one LLM turn via ManagedSession |
| `hydrateSession` | sessionId | void | Download + extract tar from blob |
| `dehydrateSession` | sessionId, reason | void | Tar + upload to blob, destroy in-memory |
| `destroySession` | sessionId | void | Free in-memory CopilotSession |
| `checkpointSession` | sessionId | void | Upload to blob without destroying |

### Manager-Scoped (Global Dispatch)

These can run on any worker.

| Activity | Input | Output | What It Does |
|----------|-------|--------|--------------|
| `listModels` | {} | JSON string | List available LLM models via Copilot SDK |
| `summarizeSession` | sessionId | string | Generate 3-5 word title from recent events |
| `spawnChildSession` | parentSessionId, config, task, ... | string (childSessionId) | Create child session + orchestration |
| `resolveAgentConfig` | agentName | AgentConfig \| null | Lookup agent by name/id/title |
| `sendToSession` | sessionId, message | void | Enqueue message to orchestration |
| `sendCommandToSession` | sessionId, command | void | Enqueue raw command JSON |
| `getSessionStatus` | sessionId | JSON string | Read session metadata |
| `listSessions` | {} | JSON string | List all sessions from CMS |
| `notifyParent` | parentOrchId, ... | void | *(deprecated)* Send child update event |
| `getDescendantSessionIds` | sessionId | string[] | Get all children/grandchildren |
| `cancelSession` | sessionId, reason? | void | Terminate orchestration |
| `deleteSession` | sessionId, reason? | void | Cancel + remove from CMS |

---

## 6. System Tools (Injected into Every Session)

ManagedSession injects these tools into every `CopilotSession.send()` call. They intercept LLM tool calls and abort the turn when durable infrastructure is needed.

### Core Tools

| Tool | Parameters | Behavior |
|------|-----------|----------|
| `wait` | seconds: number, reason?: string, preserveWorkerAffinity?: boolean | If seconds ≤ waitThreshold: sleep in-process. Otherwise: **abort turn**, return `{ type: "wait" }` to orchestration for a one-shot durable timer. Long waits may resume on another worker unless worker affinity is preserved. |
| `wait_on_worker` | seconds: number, reason?: string | Durable one-shot wait that preserves the current worker affinity when possible. Equivalent to `wait(..., preserveWorkerAffinity=true)`. |
| `cron` | seconds: number, reason: string, action?: "cancel" | **Aborts turn.** Returns `{ type: "cron" }` so the orchestration owns a recurring schedule. Use for monitors, forever-loops, and periodic digests. |
| `ask_user` | question: string, choices?: string[], allowFreeform?: boolean | Always **aborts turn**, returns `{ type: "input_required" }`. Orchestration waits for user response. |
| `list_available_models` | — | Inline response (no abort). Returns model summary. |

### Sub-Agent Tools

| Tool | Parameters | Behavior |
|------|-----------|----------|
| `spawn_agent` | task: string, model?: string, system_message?: string, tool_names?: string[], agent_name?: string | **Aborts turn.** Returns `{ type: "spawn_agent" }`. Orchestration creates child. |
| `message_agent` | agent_id: string, message: string | **Aborts turn.** Returns `{ type: "message_agent" }`. |
| `check_agents` | — | **Aborts turn.** Returns `{ type: "check_agents" }`. |
| `wait_for_agents` | agent_ids?: string[] | **Aborts turn.** Returns `{ type: "wait_for_agents" }`. |
| `list_sessions` | — | **Aborts turn.** Returns `{ type: "list_sessions" }`. |
| `complete_agent` | agent_id: string | **Aborts turn.** Returns `{ type: "complete_agent" }`. |
| `cancel_agent` | agent_id: string | **Aborts turn.** Returns `{ type: "cancel_agent" }`. |
| `delete_agent` | agent_id: string | **Aborts turn.** Returns `{ type: "delete_agent" }`. |

---

## 7. Orchestration Lifecycle — Complete Yield Map

The orchestration generator (`durableSessionOrchestration_1_0_29`) is replayed from the beginning on every new event. Every `yield` is recorded in duroxide history and must be reproduced identically during replay.

### Main Loop Phases

```
┌──────────────────────────────────────────────────────────┐
│ INITIALIZATION                                            │
│  • Extract config, create proxies                         │
│  • Inject task context into system message                │
│  • Set up title summarization timer                       │
│  • Build continueAsNew helper                             │
└──────────────────┬───────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────┐
│ MAIN LOOP (while true)                                    │
│                                                           │
│  ① DEQUEUE — yield ctx.dequeueEvent("messages")          │
│     ├─ Parse: prompt | command | child_update             │
│     ├─ Commands: set_model, list_models, get_info, done   │
│     └─ /done: cascade to children, destroy, return        │
│                                                           │
│  ② HYDRATE — if needsHydration && blobEnabled             │
│     ├─ optionally keep or rotate affinity key             │
│     ├─ yield session.hydrate()                            │
│     └─ Retry up to 3x with exponential backoff            │
│                                                           │
│  ③ RUN TURN — yield session.runTurn(prompt)               │
│     └─ Retry up to 3x (15s/30s/60s backoff)              │
│                                                           │
│  ④ HANDLE RESULT — switch on result.type                  │
│     ├─ completed: idle, or arm active cron schedule       │
│     ├─ wait: durable timer, race with interrupts          │
│     ├─ cron: set/cancel recurring schedule                │
│     ├─ input_required: wait for answer, race grace period │
│     ├─ spawn_agent: create child, add to subAgents[]      │
│     ├─ message/check/wait_for/complete/cancel/delete      │
│     ├─ error: retry with backoff or park                  │
│     └─ cancelled: loop                                    │
│                                                           │
│  ⑤ CHECKPOINT / DEHYDRATE — if thresholds reached         │
│     ├─ yield session.dehydrate(reason)                    │
│     ├─ yield session.checkpoint()                         │
│     └─ continueAsNew with updated state                   │
│                                                           │
│  ⑥ TITLE SUMMARIZE — periodic (1min, then every 5min)     │
│     └─ yield manager.summarizeSession(sessionId)          │
│                                                           │
│  → Back to ①                                              │
└──────────────────────────────────────────────────────────┘
```

### Yield Categories

| Category | Example | Count | Replay-Critical? |
|----------|---------|-------|-------------------|
| Event dequeue | `yield ctx.dequeueEvent("messages")` | ~5 | Yes |
| Activity calls | `yield session.runTurn(prompt)` | ~20 | Yes |
| Timers | `yield ctx.scheduleTimer(ms)` | ~5 | Yes |
| Races | `yield ctx.race(task1, task2)` | ~4 | Yes |
| Utility | `yield ctx.utcNow()`, `yield ctx.newGuid()` | ~3 | Yes |
| ContinueAsNew | `yield versionedContinueAsNew(...)` | ~8 | Yes (terminal) |
| Status updates | `ctx.setCustomStatus(json)` | ~27 | Recorded (order matters) |

### Determinism Rules

**NEVER use in orchestration code:**
- `Date.now()` → use `yield ctx.utcNow()`
- `Math.random()` / `crypto.randomUUID()` → use `yield ctx.newGuid()`
- `setTimeout` / `setInterval` → use `yield ctx.scheduleTimer(ms)`
- Any I/O or network call → wrap in an activity
- Conditional yields based on wall-clock time

**Key principle:** Anything that changes the sequence of `yield` statements must itself be deterministic. `setCustomStatus()` is recorded — if the orchestration yields where replay expects a status update (or vice versa), duroxide throws a nondeterminism error.

---

## 8. CMS Schema

Two tables in the `copilot_sessions` schema:

### `sessions` Table

| Column | Type | Purpose |
|--------|------|---------|
| `session_id` | text PK | Session identifier |
| `orchestration_id` | text | Duroxide orchestration ID (`session-{uuid}`) |
| `title` | text | User-friendly name (auto-summarized) |
| `state` | text | Current status (pending/running/idle/waiting/...) |
| `model` | text | Current LLM model |
| `created_at` | timestamptz | Session creation time |
| `updated_at` | timestamptz | Last state change |
| `last_active_at` | timestamptz | Last activity execution |
| `current_iteration` | integer | Turn counter |
| `last_error` | text | Most recent error message |
| `parent_session_id` | text | Parent session (if sub-agent) |
| `is_system` | boolean | System agent flag |
| `agent_id` | text | Agent slug (for system agents) |
| `splash` | text | ASCII art banner |
| `deleted` | boolean | Soft-delete flag |
| `wait_reason` | text | Why the session is waiting |

### `session_events` Table

| Column | Type | Purpose |
|--------|------|---------|
| `seq` | serial PK | Auto-increment sequence |
| `session_id` | text FK | Parent session |
| `event_type` | text | Event type string |
| `data` | jsonb | Event payload |
| `created_at` | timestamptz | Event timestamp |

### Event Types

| Event | Source | Persisted? | Notes |
|-------|--------|-----------|-------|
| `user.message` | Activity (runTurn) | Yes | User prompt text |
| `assistant.message` | CopilotSession on() | Yes | Full LLM response |
| `assistant.message_delta` | CopilotSession on() | **No** (ephemeral) | Streaming chunks |
| `assistant.reasoning_delta` | CopilotSession on() | **No** (ephemeral) | Reasoning tokens |
| `tool.execution_start` | CopilotSession on() | Yes | Tool call begin |
| `tool.execution_end` | CopilotSession on() | Yes | Tool call result |
| `assistant.usage` | CopilotSession on() | Yes | Per-turn input/output/cache token usage |
| `session.usage_info` | CopilotSession on() | Yes | Current context-window usage snapshot |
| `session.compaction_start` | CopilotSession on() | Yes | Infinite-session compaction started |
| `session.compaction_complete` | CopilotSession on() | Yes | Compaction outcome and tokens/messages removed |

---

## 9. Blob Store Operations

Azure Blob Storage container: `copilot-sessions`

| Operation | Method | Blob Path | Effect |
|-----------|--------|-----------|--------|
| Dehydrate | `dehydrate(sessionId, reason)` | `{sessionId}.tar.gz` + `.meta.json` | Tar local dir → blob, delete local |
| Hydrate | `hydrate(sessionId)` | `{sessionId}.tar.gz` | Download → extract to local |
| Checkpoint | `checkpoint(sessionId)` | `{sessionId}.tar.gz` + `.meta.json` | Tar → blob (no delete) |
| Write artifact | `uploadArtifact(sessionId, file, content)` | `artifacts/{sessionId}/{file}` | Agent file to shared storage |
| Read artifact | `downloadArtifact(sessionId, file)` | `artifacts/{sessionId}/{file}` | Read shared file |
| List artifacts | `listArtifacts(sessionId)` | `artifacts/{sessionId}/` | List files |
| SAS URL | `generateArtifactSasUrl(sessionId, file)` | — | Time-limited download link |

### Metadata JSON

```json
{
  "sessionId": "abc-123",
  "size": 45678,
  "timestamp": "2026-03-10T01:00:00Z",
  "worker": "worker-pod-3",
  "reason": "idle_timeout"
}
```

---

## 10. Model Provider System

The checked-in `.model_providers.json` configures multi-provider LLM access. Providers whose credentials are absent from the environment are filtered out at runtime, so the visible selector catalog is environment-dependent.

```json
{
  "providers": [
    { "id": "github-copilot", "type": "github", "githubToken": "env:GITHUB_TOKEN", "models": [...] },
    { "id": "azure-openai", "type": "azure", "baseUrl": "...", "apiKey": "env:KEY", "models": [...] },
    { "id": "anthropic", "type": "anthropic", "apiKey": "env:KEY", "models": [...] },
    { "id": "ollama", "type": "ollama", "baseUrl": "http://localhost:11434", "models": [...] }
  ],
  "defaultModel": "azure-openai:gpt-5.4"
}
```

**Provider types:** `github`, `azure`, `openai`, `anthropic`, `ollama`

**Model reference format:** `{providerId}:{modelName}` (e.g., `azure-openai:gpt-5.4`)

**Resolution:** `ModelProviderRegistry.resolve(qualifiedName)` → returns endpoint, API key, and headers for the requested model.

**LLM-visible summary:** `getModelSummaryForLLM()` generates a human-readable table of available models that gets injected into `list_available_models` tool responses.

---

## 11. Plugin System

Plugins are directories loaded by `PilotSwarmWorker` on startup. Each directory may contain:

```
plugin/
  plugin.json           # { name, version, agents, skills }
  .mcp.json             # MCP server configurations
  agents/
    default.agent.md    # Base system instructions
    sweeper.agent.md    # Maintenance agent (system: true)
    resourcemgr.agent.md
    planner.agent.md
    monitor.agent.md
  skills/
    concise-assistant/SKILL.md
    durable-timers/SKILL.md
    sub-agents/SKILL.md
```

### Agent Definition Format (`.agent.md`)

```markdown
---
name: sweeper
description: Scans and cleans zombie sessions
system: true           # Auto-launched on worker start
id: sweeper            # Deterministic UUID seed
title: Sweeper Agent
tools:
  - scan_completed_sessions
  - delete_completed_sessions
initialPrompt: Scan for completed sessions...
parent: pilotswarm     # Parent agent ID (for sub-agents)
splash: |
  [bold cyan]Sweeper Agent[/]
---

You are a maintenance agent. Your job is to...
```

### System Agents

| Agent | Purpose | Tools | Behavior |
|-------|---------|-------|----------|
| `pilotswarm` | Master orchestrator | Cluster stats, facts, and sub-agent controls | Spawns `sweeper`, `resourcemgr`, and `facts-manager` on startup |
| `sweeper` | Session cleanup | scan/cleanup/prune tools | Permanent system agent. Uses `cron(seconds=60, ...)` |
| `resourcemgr` | Infrastructure monitor | compute/storage/database/runtime tools | Permanent system agent. Uses `cron(seconds=300, ...)` |
| `facts-manager` | Shared operational knowledge curator | facts + artifact tools | Permanent system agent. Uses `cron()` based on config facts |

### Skill Format (`SKILL.md`)

```markdown
---
name: Durable Timer Patterns
description: How to use wait() correctly
tags: [duroxide, timers, patterns]
---

## When to Use Durable Timers
...
```

Skills are loaded via `loadSkills()` and injected into CopilotSession system messages.

---

## 12. TUI Architecture

The TUI (`cli/tui.js`, 2,000+ lines) provides a terminal interface built with `neo-blessed`.

### Layout

```
┌──────────────────────────┬──────────────────────────────────┐
│  Sessions List (25%)     │  Right Panel (55%)                │
│  ├─ Parent sessions      │  Mode-dependent:                  │
│  │  └─ Child sessions    │   • workers: per-pod log panes   │
│  └─ Status icons         │   • orchestration: single log    │
│     ✓ idle               │   • sequence: swimlane diagram   │
│     * running            │   • nodemap: worker grid         │
│     ~ waiting            │                                   │
│     ? input_required     ├──────────────────────────────────┤
│     ! error              │  Activity Pane (sticky bottom)    │
│     z dehydrated         │  Tool calls, reasoning, events    │
├──────────────────────────┤                                   │
│  Chat Pane (75%)         │                                   │
│  Markdown-rendered       │                                   │
│  messages with artifact  │                                   │
│  links                   │                                   │
├──────────────────────────┤                                   │
│  Input Bar               │                                   │
│  Slash commands, prompts │                                   │
└──────────────────────────┴──────────────────────────────────┘
```

### Key Systems

| System | Mechanism |
|--------|-----------|
| **Session tracking** | `activeOrchId`, `orchIdOrder`, `sessionChatBuffers`, `orchHasChanges` |
| **Live status** | Async `waitForStatusChange()` loops per session |
| **Event streaming** | CMS poller via `session.on()` |
| **Context visibility** | Active-header context meter, session-list warning badges, compaction activity lines |
| **Rendering** | 100ms frame loop, coalesced via `_screenDirty` flag (10fps max) |
| **Tree collapse** | `collapsedParents`, `orchChildrenOf`, `orchChildToParent` |
| **Artifact system** | Detects `artifact://sessionId/filename` URIs, downloads to `~/pilotswarm-exports/` |
| **Markdown** | `marked` + `marked-terminal` with bright color theme |
| **Performance** | `dumps/perf-trace.jsonl` tracing, 30s memory summaries |

### Modes

| Mode | Key | Display |
|------|-----|---------|
| **workers** | `m` | Per-worker log panes, stacked vertically |
| **orchestration** | `m` | Single orchestration log, colored by source pod |
| **sequence** | `m` | Swimlane diagram (time + activity events) |
| **nodemap** | `m` | Worker nodes as columns, sessions per node |

### TUI Boundary Rule

The TUI interacts with PilotSwarm **exclusively through the public API** (`PilotSwarmClient`, `PilotSwarmWorker`, `PilotSwarmManagementClient`). It never imports internal modules directly. The only exception is logging (duroxide trace logs).

---

## 13. Deployment Architecture

### Local Mode

```
┌─────────────────────────────────────┐
│         Single Node.js Process       │
│                                      │
│  TUI ─── Client ──┐                 │
│                    ├── PostgreSQL     │
│  Workers (4) ──────┘                 │
│   └── SessionManager                │
│       └── CopilotSessions           │
└─────────────────────────────────────┘
```

### AKS (Remote) Mode

```
┌──────────────┐     ┌────────────────────────────────┐
│  Local TUI   │     │  AKS Cluster                    │
│              │     │                                  │
│  Client ─────┼─PG──┤  Worker Pod 1 ─── SessionMgr    │
│  Management  │     │  Worker Pod 2 ─── SessionMgr    │
│  Client      │     │  Worker Pod 3 ─── SessionMgr    │
│              │     │  Worker Pod 4 ─── SessionMgr    │
│              │     │  Worker Pod 5 ─── SessionMgr    │
│              │     │  Worker Pod 6 ─── SessionMgr    │
└──────────────┘     └────────────────────────────────┘
                           │              │
                           ▼              ▼
                      PostgreSQL    Azure Blob Storage
```

### Kubernetes Config

- **Deployment:** `copilot-runtime-worker`, namespace `copilot-runtime`, 6 replicas
- **Image:** `toygresaksacr.azurecr.io/copilot-runtime-worker:latest`
- **Tolerations:** Azure spot instances
- **Env:** `POD_NAME` from field ref, secrets from K8s Secret

### Docker

```dockerfile
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev --force
COPY dist/ ./dist/
COPY examples/worker.js plugin/ .model_providers.json* ./
USER node
ENTRYPOINT ["node", "examples/worker.js"]
```

---

## 14. Management Client API

`PilotSwarmManagementClient` provides admin operations for the TUI:

| Method | Purpose |
|--------|---------|
| `start()` | Initialize duroxide client + CMS |
| `listSessions()` | CMS-backed fleet view for the session tree |
| `getSession(id)` | Merged per-session CMS + orchestration view, including cron/context usage |
| `getSessionStatus(id)` | Raw live orchestration status + parsed custom status |
| `waitForStatusChange(id, afterVersion, ...)` | Block until custom status advances |
| `deleteSession(id)` | Soft-delete + cancel orchestration |
| `renameSession(id, title)` | Update session title in CMS |
| `listModels()` / `getModelsByProvider()` | List configured models after env filtering |
| `getDefaultModel()` | Read the configured default model |
| `cancelSession(id)` | Cancel orchestration (leave CMS intact) |
| `sendMessage(id, prompt)` / `sendAnswer(id, answer)` / `sendCommand(id, cmd)` | Drive a session administratively |
| `getLatestResponse(id)` / `getCommandResponse(id, cmdId)` | Read KV-backed orchestration outputs |
| `dumpSession(id)` | Export session transcript |

**`PilotSwarmSessionView`**: Merged view combining CMS metadata (title, model, events) with duroxide orchestration state (customStatus, runtime status), including cron metadata and the latest `contextUsage` snapshot when available.

---

## 15. Data Flow Traces

### Scenario A: User Sends Prompt → Gets Response

```
1. user calls session.sendAndWait("Fix this bug")
2. client writes CMS: state="running"
3. client enqueues duroxide event: { prompt: "Fix this bug" }
4. orchestration dequeues at yield ctx.dequeueEvent("messages")
5. orchestration calls yield session.runTurn(prompt)
   → dispatched to worker via affinity key
6. worker: sessionManager.getOrCreate(sessionId, config)
   → check memory cache → disk → blob → create new
7. managedSession.runTurn(prompt, { onEvent })
   → copilotSession.send(prompt)
   → LLM processes, returns response
   → events streamed to CMS via onEvent callback
8. activity returns { type: "completed", content: "Here's the fix..." }
9. orchestration sets customStatus { status: "idle", turnResult: {...} }
10. client polls waitForStatusChange, sees "idle"
11. client returns response to user
```

### Scenario B: LLM Calls `wait(300, "polling API")`

```
1-6. Same as Scenario A
7. LLM calls wait(300, "polling API")
   → 300 > waitThreshold (default 30)
   → abort CopilotSession
   → return { type: "wait", seconds: 300, reason: "polling API" }
8. orchestration: yield ctx.scheduleTimer(300_000)
   → durable timer persisted to PG
   → process can die, timer survives
9. orchestration: yield ctx.race(timer, interruptMsg)
   → if timer fires first: continueAsNew with resume prompt
   → if user sends message: continueAsNew with user message
10. next worker picks up → hydrate from blob → resume
```

If the wait depends on node-local state, the agent can instead call `wait_on_worker(300, ...)` or `wait(..., preserveWorkerAffinity: true)` so the orchestration preserves the affinity key when possible.

### Scenario C: Session Dehydration/Rehydration

```
1. orchestration idle timeout reached (30s default)
2. yield session.dehydrate("idle_timeout")
   → worker tars SESSION_STATE_DIR/{sessionId}/
   → uploads to Azure Blob: {sessionId}.tar.gz + .meta.json
   → deletes local files, frees CopilotSession from memory
3. yield ctx.newGuid() → new affinity key
4. continueAsNew with { needsHydration: true, affinityKey: newKey }
5. orchestration restarts (any worker can pick up)
6. [later] user sends new prompt
7. orchestration: needsHydration=true
8. yield session.hydrate()
   → download tar.gz → extract to local
   → sessionManager creates new CopilotSession from files
9. resume with prompt
```

### Scenario D: Recurring Cron Wake-Up

```
1. LLM calls cron(seconds: 60, reason: "refresh dashboard")
2. managedSession aborts, returns { type: "cron", action: "set", intervalSeconds: 60, reason }
3. orchestration stores cronSchedule in carried state
4. turn completes normally
5. orchestration enters waiting state and schedules a durable timer for 60s
6. if a user message arrives first, it interrupts the wait and is delivered immediately
7. if the timer fires, orchestration continueAsNew() with a synthetic system wake-up prompt
8. the next completed turn re-arms cron automatically until the agent calls cron(action="cancel")
```

### Scenario E: Sub-Agent Spawn

```
1. LLM calls spawn_agent(task: "Research the API", model: "gpt-4")
2. managedSession aborts, returns { type: "spawn_agent", task, model }
3. orchestration: yield manager.resolveAgentConfig(agentName) [if named]
4. orchestration: yield manager.spawnChildSession(parentId, config, task, nestingLevel+1)
   → activity creates PilotSwarmClient
   → creates child session in CMS
   → starts child orchestration
   → enqueues task as first prompt
5. parent adds { orchId, sessionId, task, status: "running" } to subAgents[]
6. parent continueAsNew → loops, waits for child updates
7. child orchestration runs independently on any worker
8. child completes → sends [CHILD_UPDATE] message to parent orchestration
9. parent dequeues child update, updates subAgents[] entry
10. parent's next runTurn sees updated agent status
```

---

## 16. Orchestration Version History

| Version | Orchestration Name | Notes |
|---------|-------------------|-------|
| 1.0.0 | `durable-session-v2` | Initial implementation |
| 1.0.1 | — | Bug fixes |
| 1.0.2 | — | Added dehydration |
| 1.0.3 | — | Timer race improvements |
| 1.0.4 | — | Sub-agent support |
| 1.0.5 | — | Input grace period |
| 1.0.6 | — | Checkpoint support |
| 1.0.7 | — | Task context preservation |
| 1.0.8 | — | Error retry improvements |
| 1.0.9 | — | Early stable orchestration line |
| 1.0.24 | — | Introduced cron scheduling primitives |
| 1.0.25 | — | System-agent cron adoption and prompt guidance |
| 1.0.26 | — | Cron waits reset affinity instead of pinning sessions |
| 1.0.27 | — | Compatibility freeze during SQL prompt rollback follow-up |
| 1.0.28 | — | Context-usage status plumbing prerequisites |
| **1.0.29** | — | **Current** — surfaces `contextUsage` and compaction state in status |

**Versioning rule:** Changing yield sequences requires a new version. Existing in-flight orchestrations replay against their recorded version. The database must be reset when deploying breaking orchestration changes.

---

## 17. Key Invariants

1. **CMS is source of truth for session lifecycle.** Duroxide state is eventually consistent.
2. **Client writes to CMS before duroxide.** Write-first ensures sessions exist before orchestrations start.
3. **Activities are thin.** They dispatch to SessionManager/ManagedSession — they don't implement logic.
4. **Orchestration is the sole durable coordinator.** Neither client nor activity makes durable decisions.
5. **`send()` + `on()` internally, never `sendAndWait()`.** Gives granular control over tool interception.
6. **Tool names travel as strings.** Workers resolve to Tool objects at runtime.
7. **Affinity keys pin sessions to workers.** Regenerated on dehydration for relocation.
8. **System tools are always injected.** `wait`, `wait_on_worker`, `cron`, `ask_user`, and sub-agent tools are available in every session.
9. **setCustomStatus order matters.** Recorded in history — must match between execution and replay.
10. **Sub-agents max nesting: 2.** Root (0) → child (1) → grandchild (2).
