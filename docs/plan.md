# durable-copilot-sdk — Implementation Plan

## Vision

A framework that makes Copilot SDK apps durable with minimal changes. Developers who know the Copilot SDK can make their agents async/durable by changing one import and adding a connection string. No duroxide knowledge required.

**Before → After:**
```typescript
// BEFORE: @github/copilot-sdk (ephemeral, single process)
import { CopilotClient, defineTool } from "@github/copilot-sdk";
const client = new CopilotClient({ githubToken: "..." });
const session = await client.createSession({ tools, systemMessage });
await session.sendAndWait({ prompt });

// AFTER: durable-copilot-sdk (durable, multi-node, crash-safe)
import { DurableAgent, defineTool } from "durable-copilot-sdk";
const agent = new DurableAgent({ githubToken: "...", tools, systemMessage, store: "postgres://..." });
const id = await agent.run(prompt);
```

## Phases

### Phase 1 — Single Node, Durable Timers
No duroxide changes. Single worker. Sessions stay alive locally.

**Goal:** Prove the agent loop works with duroxide + Copilot SDK. Durable waits, crash recovery via replay.

| Todo | Description |
|------|-------------|
| scaffold | ✅ Done — package.json, tsconfig, src/ structure |
| session-manager | CopilotClient lifecycle, in-memory Map, create/resume |
| tool-registry | System tools (wait, checkpoint) + user tool merging |
| agent-activity | `runAgentTurn` — sendAndWait, returns structured action |
| agent-orchestration | Outer loop with continue-as-new, timer/event handling |
| safety | Max iterations, error handling |
| demo + e2e | Demo tools, full lifecycle test with SQLite |
| docs | Phase 1 README |

### Phase 2 — Activity Tags + Multi-Node
Duroxide activity tags required. Workers never crash assumption.

| Todo | Description |
|------|-------------|
| activity-tags | Implement in duroxide core + provider |
| worker-identity | Workers report ID, activities return workerId |
| affinity-routing | `.with_tag(workerId)` for session-bound activities |
| session-broken | In-memory Map guard → SESSION_BROKEN error |
| AKS test | Deploy, verify affinity across nodes |

### Phase 3 — Dehydration / Hydration
Graceful shutdown assumed. Azure Blob for session files.

| Todo | Description |
|------|-------------|
| blob-store | Azure Blob client for session tar upload/download |
| dehydrate | Activity: tar session → blob → rm local |
| hydrate | Activity: download blob → untar to local |
| orchestration | Long wait → dehydrate → timer → hydrate on any node |
| graceful-shutdown | Worker shutdown hook dehydrates all sessions |
| ask-user | Dehydrate → wait_for_event → hydrate → resume |

### Phase 4 — Delta Checkpointing
Crash resilience. RPO = time since last checkpoint.

| Todo | Description |
|------|-------------|
| checkpoint-tool | Track events.jsonl offset, append delta to blob |
| prompt-guidance | System prompt instructs LLM to checkpoint |
| crash-recovery | Timeout → rehydrate from last checkpoint → resume |
| metrics | Checkpoint count, delta sizes, RPO |
| background-checkpoint | Optional periodic checkpoint timer |

## Project Structure

```
durable-copilot-sdk/
  src/
    index.ts            — Public exports
    types.ts            — DurableAgentConfig, AgentState, etc.
    agent.ts            — DurableAgent class (user-facing API)
    session-manager.ts  — CopilotClient + session lifecycle
    system-tools.ts     — Injected wait/checkpoint tools
    orchestration.ts    — (TODO) duroxide orchestration definition
    activities.ts       — (TODO) runAgentTurn, dehydrate, hydrate
  test/
    basic.test.js       — (TODO) basic lifecycle test
  docs/
    plan.md             — This file
  README.md
  package.json
  tsconfig.json
```

## Key Decisions

1. **Native SDK tool calling** — use `defineTool()` handlers, not system prompt JSON. Proven in copilot-sdk-test/.
2. **System tools injected** — `wait` and `checkpoint` are automatically added to every session.
3. **Wait threshold** — configurable (default 60s). Short waits sleep in-process, long waits become durable timers.
4. **Session affinity via return values** — activity returns workerId, orchestration routes with `.with_tag()`. No framework magic.
5. **Incremental checkpoints** — events.jsonl is append-only, track byte offset, upload deltas only.
6. **LLM-driven checkpointing** — the LLM decides when to checkpoint based on system prompt guidance.

## Proven via copilot-sdk-test/

- ✅ Basic session create/send/receive
- ✅ Tools called in parallel by LLM
- ✅ Session destroy → resume (full context preserved)
- ✅ File-based dehydrate/hydrate (copy files, resume on "different node")
- ✅ Wait tool (LLM calls wait(600) for "wait 10 minutes")
- ✅ Implicit waits (polling, rate-limiting, reminders)
- ✅ Checkpoint tool (LLM checkpoints after each significant step)
