# Session Affinity + Session Relocation

## Summary

Use duroxide 0.1.18's **Activity Session Affinity** to pin Copilot SDK sessions to specific worker nodes, and use **Azure Blob Storage** to relocate sessions between nodes when workers die, during long waits, or when user input is pending.

This proposal covers Phase 2 (multi-node affinity) and Phase 3 (dehydration/hydration) from `plan.md`, unified into a single design that leverages the new `scheduleActivityOnSession` API.

## Problem

Today, `runAgentTurn` activities can land on any worker. The `SessionManager` holds live `CopilotSession` objects in memory — if a different worker picks up the next turn, it must cold-start a new Copilot CLI subprocess and reconstruct state from `~/.copilot/session-state/{sessionId}/events.jsonl`. This is slow (~2-3s) and lossy if session files aren't on shared storage.

In a multi-node deployment:
1. **No affinity** — consecutive turns for the same conversation bounce between workers
2. **No portability** — session files live on local disk, invisible to other workers
3. **No resilience** — if a worker dies, the session is gone

## Design

### Part 1: Session Affinity via `scheduleActivityOnSession`

**One-line change in `orchestration.ts`:**

```typescript
// Before — any worker picks this up
const result = yield ctx.scheduleActivity("runAgentTurn", input);

// After — same worker handles all turns for this sessionId
const result = yield ctx.scheduleActivityOnSession(
    "runAgentTurn", input, input.sessionId
);
```

**How it works:**
- duroxide assigns `input.sessionId` as the session key
- All activities with the same session key route to the same worker node
- The `SessionManager.sessions` map stays warm — no cold starts between turns
- If max sessions are reached on a worker, duroxide picks a different worker and creates the session there

**Runtime configuration in `agent.ts`:**

```typescript
this.runtime = new Runtime(provider, {
    maxSessionsPerRuntime: 50,        // limit sessions per worker
    sessionIdleTimeoutMs: 300_000,    // 5 min idle → release session slot
    workerNodeId: os.hostname(),      // unique worker identity
});
```

**What this gives us:**
- ✅ Warm session reuse (no cold starts)
- ✅ Natural scale-out (sessions distributed across workers)
- ✅ No code changes for users of durable-copilot-sdk

### Part 2: Session Relocation via Azure Blob Storage

When a session needs to move between workers — long wait, user input pending, worker shutdown, or worker death — we **dehydrate** the session state to Azure Blob and **hydrate** it on the new worker.

#### Session State on Disk

A Copilot SDK session lives at `~/.copilot/session-state/{sessionId}/`:

```
{sessionId}/
├── events.jsonl          # Append-only conversation log (the critical file)
├── workspace.yaml        # Session metadata
├── session.db            # SQLite (agent todos/plans)
├── checkpoints/          # Context compaction summaries
│   └── index.md
├── plan.md               # Agent's working notes
└── files/                # Artifacts created by agent
```

Total size is typically 50KB–2MB per session (dominated by `events.jsonl`).

#### Dehydration (save to blob)

```
Worker A                          Azure Blob Storage
┌─────────────┐                   ┌──────────────────────────┐
│ SessionMgr  │                   │ copilot-sessions/        │
│  session X  │──tar + upload──►  │   {sessionId}.tar.gz     │
│  (warm)     │                   │   {sessionId}.meta.json  │
└─────────────┘                   └──────────────────────────┘
      │
      ▼
  rm local files
  release session slot
```

**`dehydrateSession` activity:**
1. Call `session.destroy()` to flush pending writes to `events.jsonl`
2. `tar czf` the `~/.copilot/session-state/{sessionId}/` directory
3. Upload `{sessionId}.tar.gz` to Azure Blob container
4. Upload `{sessionId}.meta.json` (timestamp, worker, iteration count, byte offset)
5. Remove local session directory
6. Remove from `SessionManager.sessions` map

#### Hydration (restore from blob)

```
Azure Blob Storage                Worker B (or same worker)
┌──────────────────────────┐      ┌─────────────────┐
│ copilot-sessions/        │      │ SessionMgr      │
│   {sessionId}.tar.gz     │──►   │  download + untar│
│   {sessionId}.meta.json  │      │  resumeSession() │
└──────────────────────────┘      └─────────────────┘
```

**`hydrateSession` activity:**
1. Download `{sessionId}.tar.gz` from Azure Blob
2. Extract to `~/.copilot/session-state/{sessionId}/`
3. Call `sessionManager.resumeSession(sessionId)` — Copilot CLI replays `events.jsonl`
4. Session is warm again, ready for next turn

#### When to Dehydrate

| Trigger | Mechanism | Notes |
|---------|-----------|-------|
| **Durable timer > 30s** | Orchestration schedules dehydrate before timer | Free up worker slot during long waits |
| **User input pending** | After `input_required` result, before `waitForEvent` | User might take minutes/hours to respond |
| **Worker graceful shutdown** | `runtime.shutdown()` hook iterates all active sessions | K8s pod termination, rolling deploys |
| **Periodic checkpoint** | Background timer in the activity, every N seconds | Limits data loss on crash (see Part 5a) |

> **Note on session idle timeout:** duroxide's `sessionIdleTimeoutMs` fires on the
> worker when a session has no work for the configured duration. However, the worker
> cannot predict *when* the timeout will fire — it's a runtime-level mechanism, not
> an orchestration-level one. In practice, this case is already covered: if no new
> activity arrives for 5 minutes, the orchestration has either completed, is waiting
> on a timer (already dehydrated), or is waiting on user input (already dehydrated).
> The only scenario where idle timeout fires without a prior dehydration is if the
> Copilot turn itself takes >5 minutes — which would mean the activity is still
> running, so the session is still active and idle timeout wouldn't fire. Therefore,
> **we don't rely on idle timeout as a dehydration trigger.** It serves only to
> release the session slot in duroxide's session table.

#### When to Hydrate

| Trigger | Mechanism | Notes |
|---------|-----------|-------|
| **Timer fires** | Orchestration schedules hydrate activity on any worker | Session relocates to available worker |
| **User input received** | Event arrives → orchestration schedules hydrate | May land on different worker |
| **`resumeSession()` called** | Client API hydrates if local files missing | Transparent to callers |

### Part 3: Updated Orchestration Flow

```typescript
function* durableTurnOrchestration(ctx, input) {
    let { prompt, iteration } = input;

    while (iteration < input.maxIterations) {
        // Hydrate if session was dehydrated (e.g., after timer/event)
        if (input.dehydrated) {
            yield ctx.scheduleActivity("hydrateSession", {
                sessionId: input.sessionId,
            });
        }

        // Run LLM turn — pinned to session-owning worker
        const result = yield ctx.scheduleActivityOnSession(
            "runAgentTurn", { ...input, prompt, iteration }, input.sessionId
        );

        switch (result.type) {
            case "completed":
                // Dehydrate final state for archival
                yield ctx.scheduleActivityOnSession(
                    "dehydrateSession",
                    { sessionId: input.sessionId, reason: "completed" },
                    input.sessionId
                );
                return result.content;

            case "wait":
                // Long wait → dehydrate → timer → hydrate on resume
                if (result.seconds > 30) {
                    yield ctx.scheduleActivityOnSession(
                        "dehydrateSession",
                        { sessionId: input.sessionId, reason: "timer" },
                        input.sessionId
                    );
                }

                yield ctx.scheduleTimer(result.seconds * 1000);

                yield ctx.continueAsNew({
                    ...input,
                    prompt: `The ${result.seconds}s wait is complete. Continue.`,
                    iteration: iteration + 1,
                    dehydrated: result.seconds > 30,
                });

            case "input_required":
                // Dehydrate while waiting for user
                yield ctx.scheduleActivityOnSession(
                    "dehydrateSession",
                    { sessionId: input.sessionId, reason: "input_required" },
                    input.sessionId
                );

                const eventData = yield ctx.waitForEvent("user-input");

                yield ctx.continueAsNew({
                    ...input,
                    prompt: `User answered: "${eventData.answer}"`,
                    iteration: iteration + 1,
                    dehydrated: true,
                });

            case "error":
                throw new Error(result.message);
        }
    }
}
```

### Part 4: Blob Store Implementation

**New file: `src/blob-store.ts`**

```typescript
import { BlobServiceClient } from "@azure/storage-blob";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SESSION_STATE_DIR = path.join(os.homedir(), ".copilot", "session-state");

export class SessionBlobStore {
    private containerClient;

    constructor(connectionString: string, containerName: string) {
        const blobService = BlobServiceClient.fromConnectionString(connectionString);
        this.containerClient = blobService.getContainerClient(containerName);
    }

    async dehydrate(sessionId: string, meta?: Record<string, unknown>): Promise<void> {
        const sessionDir = path.join(SESSION_STATE_DIR, sessionId);
        if (!fs.existsSync(sessionDir)) return;

        // Tar the session directory
        const tarPath = path.join(os.tmpdir(), `${sessionId}.tar.gz`);
        execSync(`tar czf ${tarPath} -C ${SESSION_STATE_DIR} ${sessionId}`);

        // Upload tar
        const tarBlob = this.containerClient.getBlockBlobClient(`${sessionId}.tar.gz`);
        await tarBlob.uploadFile(tarPath);

        // Upload metadata
        const metaBlob = this.containerClient.getBlockBlobClient(`${sessionId}.meta.json`);
        await metaBlob.upload(JSON.stringify({
            sessionId,
            dehydratedAt: new Date().toISOString(),
            worker: os.hostname(),
            sizeBytes: fs.statSync(tarPath).size,
            ...meta,
        }), 0);

        // Cleanup
        fs.unlinkSync(tarPath);
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    async hydrate(sessionId: string): Promise<void> {
        const sessionDir = path.join(SESSION_STATE_DIR, sessionId);
        if (fs.existsSync(sessionDir)) return; // already local

        const tarBlob = this.containerClient.getBlockBlobClient(`${sessionId}.tar.gz`);
        const tarPath = path.join(os.tmpdir(), `${sessionId}.tar.gz`);

        // Download and extract
        await tarBlob.downloadToFile(tarPath);
        fs.mkdirSync(SESSION_STATE_DIR, { recursive: true });
        execSync(`tar xzf ${tarPath} -C ${SESSION_STATE_DIR}`);
        fs.unlinkSync(tarPath);
    }

    async exists(sessionId: string): Promise<boolean> {
        const tarBlob = this.containerClient.getBlockBlobClient(`${sessionId}.tar.gz`);
        return tarBlob.exists();
    }

    async delete(sessionId: string): Promise<void> {
        await this.containerClient.getBlockBlobClient(`${sessionId}.tar.gz`).deleteIfExists();
        await this.containerClient.getBlockBlobClient(`${sessionId}.meta.json`).deleteIfExists();
    }
}
```

### Part 5: Configuration

**`DurableCopilotClientOptions` additions:**

```typescript
interface DurableCopilotClientOptions {
    // ... existing fields ...

    /** Azure Blob connection string for session storage */
    blobConnectionString?: string;

    /** Azure Blob container name (default: "copilot-sessions") */
    blobContainer?: string;

    /** Max sessions per worker (default: 50) */
    maxSessionsPerRuntime?: number;

    /** Session idle timeout in ms (default: 300_000 = 5 min) */
    sessionIdleTimeoutMs?: number;

    /** Dehydrate threshold in seconds (default: 30).
     *  Waits/timers longer than this trigger dehydration. */
    dehydrateThreshold?: number;

    /** Dehydrate on user input request (default: true).
     *  When true, sessions are saved to blob while waiting for user response. */
    dehydrateOnInputRequired?: boolean;

    /** Checkpoint frequency in ms (default: 60_000 = 60s).
     *  Background interval for saving session state to blob during active turns.
     *  Lower values = less data loss on crash, more blob I/O.
     *  Set to 0 to disable periodic checkpointing. */
    checkpointFrequencyMs?: number;
}
```

**`.env` additions:**

```env
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=adarpgsessions;...
AZURE_STORAGE_CONTAINER=copilot-sessions
```

### Part 5a: Periodic Checkpointing

The orchestration-level dehydration (Part 3) handles the **known pause points** — timers,
user input, completion. But the main resilience gap is **worker death during an active turn**.
A `runAgentTurn` activity can run for 30s–5min while the LLM thinks, calls tools, and
generates output. If the worker dies mid-turn, all progress since the last checkpoint is lost.

**Solution: periodic background checkpointing inside the activity.**

The `runAgentTurn` activity starts a background interval that snapshots session state to
blob storage at a configurable frequency (default: 60s). This is *not* a full dehydration —
the session stays alive and warm in memory. It's a **checkpoint**: upload the current
`events.jsonl` and metadata so that if the worker dies, a replacement worker can hydrate
from the last checkpoint instead of starting from scratch.

```typescript
// Inside runAgentTurn activity
const checkpointInterval = setInterval(async () => {
    try {
        await blobStore.checkpoint(input.sessionId);
    } catch (err) {
        activityCtx.traceWarn(`Checkpoint failed: ${err.message}`);
    }
}, checkpointFrequencyMs);

try {
    // ... run the LLM turn ...
} finally {
    clearInterval(checkpointInterval);
}
```

**`checkpoint()` vs `dehydrate()`:**

| | `checkpoint()` | `dehydrate()` |
|---|---|---|
| Session stays alive? | ✅ Yes (warm in memory) | ❌ No (destroyed, files removed) |
| Local files removed? | ❌ No | ✅ Yes |
| Blob updated? | ✅ Yes (tar overwrite) | ✅ Yes (tar + meta) |
| Session slot freed? | ❌ No | ✅ Yes |
| Use case | Background resilience | Intentional pause |

#### Data Loss Analysis

| Scenario | Last checkpoint age | Data lost | Recovery |
|----------|-------------------|-----------|----------|
| Worker dies mid-turn (checkpoint running) | 0–60s | Up to 60s of LLM output, tool calls | Hydrate from checkpoint, re-run activity (LLM sees last checkpoint state, continues) |
| Worker dies before first checkpoint | 60s (no checkpoint yet) | Entire turn's progress | Hydrate from last dehydration (pre-turn state), re-run activity from scratch |
| Worker dies during long tool execution | 0–60s | Tool may have side effects | **Idempotency required** — tools should be safe to re-run |
| Worker dies during checkpoint upload | 0–120s | Checkpoint partially uploaded | Previous checkpoint is still valid; new worker uses that |
| Worker dies, no blob state at all | N/A | All conversation history | Session starts fresh (worst case, only for brand-new sessions with no prior dehydration) |

**RPO (Recovery Point Objective):** `checkpointFrequencyMs` (default 60s). Conversations
with many short turns have lower effective RPO because each turn boundary is a natural
dehydration point.

**Key insight:** The orchestration handles the predictable pauses (timers, user input,
completion). Periodic checkpointing handles the unpredictable ones (crashes, OOM kills,
node failures). Together they provide a layered resilience model:

```
Orchestration-driven dehydration     Periodic checkpointing
(known pause points)                 (crash resilience)
        │                                    │
        ▼                                    ▼
   ┌─────────┐                         ┌──────────┐
   │ timer    │  ← RPO = 0             │ interval │  ← RPO = 60s
   │ input    │     (no data loss)      │ 60s      │     (up to 60s lost)
   │ complete │                         │ bg save  │
   │ shutdown │                         └──────────┘
   └─────────┘
```

### Part 6: Graceful Shutdown

```typescript
// In agent.ts start()
process.on("SIGTERM", async () => {
    // 1. Stop accepting new work
    await this.runtime.shutdown(30_000);

    // 2. Dehydrate all active sessions
    const activeIds = this.sessionManager.activeSessionIds();
    await Promise.all(
        activeIds.map(id => this.blobStore.dehydrate(id, { reason: "shutdown" }))
    );

    process.exit(0);
});
```

### Part 7: Failure Scenarios

| Scenario | What happens | Recovery | Data loss |
|----------|-------------|----------|-----------|
| Worker dies mid-turn | Activity times out, duroxide retries on another worker | New worker hydrates from last checkpoint | Up to `checkpointFrequencyMs` (default 60s) of turn progress |
| Worker dies between turns | Session was dehydrated at last orchestration pause point | New worker hydrates from dehydrated state | None (dehydration is at a clean boundary) |
| Worker dies before first checkpoint of first turn | No checkpoint or dehydration exists | Activity retries on new worker, starts session from scratch | Entire first turn (LLM will re-do the work) |
| Worker dies during checkpoint upload | Partial blob — previous checkpoint still valid | New worker hydrates from previous checkpoint | Up to 2× `checkpointFrequencyMs` |
| Worker dies during dehydration | Partial upload; previous checkpoint still valid | New worker hydrates from last good checkpoint | Minimal (dehydration happens at pause points where state is consistent) |
| Blob storage unavailable | Checkpoint/dehydrate fails → logged as warning | Session stays in memory; retried on next interval | None while worker is alive; full loss if worker also dies |
| Session files corrupted on disk | `resumeSession()` fails | Hydrate from blob overwrites local files | None if checkpoint exists |
| Two workers claim same session | Duroxide session lock prevents this | Only lock holder processes; loser's activity is rejected | None |
| LLM tool has side effects + worker dies | Tool ran but checkpoint didn't capture result | Tool re-runs on retry | **Idempotency required** — tools must be safe to re-run |

### Part 8: Future — Delta Checkpointing (Phase 4)

The dehydration approach uploads the full session tar each time. For large sessions (many turns), this becomes expensive. Delta checkpointing optimizes this:

1. Track byte offset in `events.jsonl` after each dehydration
2. On subsequent dehydrations, upload only the delta (new bytes)
3. Use Azure Append Blob for `{sessionId}.events.delta` — append-only, cheap
4. On hydration: download base tar + all deltas, replay in order
5. Periodic compaction: merge base + deltas into new base tar

This is Phase 4 and not needed for initial implementation.

## Implementation Order

1. **Add `scheduleActivityOnSession` to orchestration** — one-line change, immediate benefit
2. **Add `SessionBlobStore`** — new file, Azure SDK dependency
3. **Add `dehydrateSession` / `hydrateSession` activities** — registered alongside `runAgentTurn`
4. **Update orchestration** — dehydrate/hydrate around timers and user input
5. **Add graceful shutdown hook** — SIGTERM handler
6. **Add `blobConnectionString` to options** — wire through to `SessionBlobStore`
7. **Test locally** — SQLite + local blob emulator (Azurite) or real Azure
8. **Test on AKS** — multi-replica deployment, verify relocation works
9. **Update docs** — README, architecture.md

## Azure Resources

- **Storage Account**: `adarpgsessions` (eastus, Standard_LRS)
- **Container**: `copilot-sessions`
- **Resource Group**: `adar-pg`
- **Subscription**: Azure PostgreSQL AI Playground

Connection string is in `.env` as `AZURE_STORAGE_CONNECTION_STRING`.

## Dependencies to Add

```json
{
    "@azure/storage-blob": "^12.x",
    "duroxide": "^0.1.6"
}
```

`duroxide` is already at 0.1.6 (has `scheduleActivityOnSession`). Only `@azure/storage-blob` needs to be added.

## Open Questions

1. **Checkpoint frequency** — Default 60s. Should this be configurable per-session (some sessions are more valuable than others)? Or is a global setting sufficient?

2. **Session TTL** — How long should dehydrated sessions live in blob storage? Auto-delete after 7 days? 30 days?

3. **Encryption at rest** — Azure Blob has SSE by default. Do we need client-side encryption for `events.jsonl` (contains conversation content)?

4. **Blob lifecycle policy** — Move old sessions to cool/archive tier automatically?

5. **Hydration timeout** — Large sessions (many turns) may take 5-10s to hydrate. Should we show a "resuming session..." message to the user?

6. **Tool idempotency** — Should we document/enforce that user-provided tools must be idempotent? Or add a `{ idempotent: true }` marker to `defineTool()` so the framework can warn?

7. **Checkpoint during tool execution** — If a tool runs for 30s (e.g., a build), the checkpoint captures `events.jsonl` mid-tool. On replay, the Copilot CLI would re-invoke the tool. Is this safe for all tools, or do we need a "tool completed" fence before checkpointing?
