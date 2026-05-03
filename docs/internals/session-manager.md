# Internals: SessionManager and ManagedSession

> Worker-side internals — interfaces and class skeletons that the
> [orchestration](../orchestration-design.md) calls into via the
> [SessionProxy](../architecture.md#311-activities-as-the-sessionproxy).

### 7.0 SessionManager and ManagedSession Interfaces

These are the core interfaces that live on the worker node. The orchestration calls into these via the `SessionProxy` (see §3.1.1).

```typescript
// ═══════════════════════════════════════════════════════
// SessionManager — singleton per worker node
// Owns session lifecycle, wraps CopilotClient.
// ═══════════════════════════════════════════════════════

interface SessionManager {
    // ─── Session access ──────────────────────────────

    /** Get existing session or create/resume one. */
    getOrCreate(sessionId: string, config: SessionConfig): Promise<ManagedSession>;

    /** Get session by ID (null if not in memory on this node). */
    get(sessionId: string): ManagedSession | null;

    // ─── Lifecycle ───────────────────────────────────

    /** Dehydrate: destroy in memory → tar → upload to blob → update CMS. */
    dehydrate(sessionId: string, reason: string): Promise<void>;

    /** Shutdown: destroy all sessions, stop CopilotClient. */
    shutdown(): Promise<void>;

    /** List all in-memory session IDs on this node. */
    activeSessionIds(): string[];
}

// ═══════════════════════════════════════════════════════
// ManagedSession — one per Copilot session
// Wraps CopilotSession, owns event handling and CMS writes.
// ═══════════════════════════════════════════════════════

interface ManagedSession {
    /** Session identity. */
    readonly sessionId: string;

    // ─── Turn execution ──────────────────────────────

    /**
     * Run one LLM turn.
     * Uses send() + on() internally — never sendAndWait().
     * Blocks until a yield-worthy event:
     *   - session.idle       → {type: "completed"}
     *   - wait tool fires    → {type: "wait"}
     *   - ask_user fires     → {type: "input_required"}
     *   - abort received     → {type: "cancelled"}
     *   - error              → {type: "error"}
     */
    runTurn(prompt: string, opts?: TurnOptions): Promise<TurnResult>;

    /**
     * Abort the current in-flight message.
     * Session remains alive for future runTurn() calls.
     */
    abort(): Promise<void>;

    // ─── Configuration (applied on next runTurn) ─────

    updateConfig(config: Partial<ManagedSessionConfig>): void;

    // ─── Cleanup ─────────────────────────────────────

    /**
     * Destroy: release resources, detach on() handler,
     * flush CopilotSession to disk, remove from SessionManager.
     */
    destroy(): Promise<void>;
}

// ─── Supporting types ────────────────────────────────

interface TurnOptions {
    onDelta?: (delta: string) => void;
    onToolStart?: (name: string, args: any) => void;
}

type TurnResult =
    | { type: "completed"; content: string }
    | { type: "wait"; seconds: number; reason: string; content?: string }
    | { type: "input_required"; question: string; choices?: string[]; allowFreeform?: boolean }
    | { type: "cancelled" }
    | { type: "error"; message: string };

interface SessionConfig {
    model?: string;
    systemMessage?: string | SystemMessageConfig;
    tools?: Tool[];
    workingDirectory?: string;
    hooks?: SessionHooks;
}
```

**Key design points:**

1. **`runTurn()` uses `send()` + per-turn `on()` subscriptions** — listeners are attached inside each turn to capture deltas, tool starts, terminal events, and full event traces.

2. **Event persistence is activity-driven** — `runTurn` activity passes an `onEvent` callback that records non-ephemeral events to CMS as they fire.

3. **`abort()` does not destroy the session** — it cancels the in-flight message. The session returns to idle and is ready for the next `runTurn()` call.

4. **Config updates apply on subsequent turns** — `SessionManager` can update warm-session config, and `ManagedSession.runTurn()` re-registers tools every turn.

5. **`destroy()` releases local session resources** — used before dehydration/shutdown and during explicit delete flows.


### 7.2 ManagedSession (Session Manager)

The `ManagedSession` wraps a `CopilotSession` and provides the interface that the orchestration calls into (via `SessionProxy`).

```typescript
import { CopilotClient, CopilotSession, type SessionEvent } from "@github/copilot-sdk";
import { Pool } from "pg";

interface TurnResult {
    type: "completed" | "wait" | "input_required" | "cancelled" | "error";
    content?: string;
    seconds?: number;
    reason?: string;
    question?: string;
    choices?: string[];
    message?: string;
}

class ManagedSession {
    readonly sessionId: string;
    private copilotSession: CopilotSession;
    private cmsPool: Pool;
    private eventCursor: number = 0;
    private unsubscribe: (() => void) | null = null;

    constructor(sessionId: string, copilotSession: CopilotSession, cmsPool: Pool) {
        this.sessionId = sessionId;
        this.copilotSession = copilotSession;
        this.cmsPool = cmsPool;

        // Attach event handler ONCE at creation — lives for the session's lifetime
        this.unsubscribe = this.copilotSession.on((event: SessionEvent) => {
            // 1. Trace ALL events (including ephemeral) for observability
            logger.info({ sessionId, event_type: event.type, ephemeral: event.ephemeral }, "[session-event]");

            // 2. Persist non-ephemeral events to CMS
            if (!event.ephemeral) {
                this.writeEventToCMS(event).catch(err => {
                    logger.error({ sessionId, err }, "Failed to write event to CMS");
                });
            }
        });
    }

    /**
     * Run one LLM turn.
     * Uses send() + on() — never sendAndWait().
     * Returns when the turn completes or a yield condition is detected.
     */
    async runTurn(prompt: string, config?: TurnConfig): Promise<TurnResult> {
        return new Promise<TurnResult>((resolve, reject) => {
            let content = "";
            let resolved = false;

            const turnUnsub = this.copilotSession.on((event: SessionEvent) => {
                if (resolved) return;

                switch (event.type) {
                    case "assistant.message":
                        content = event.data.content;
                        break;

                    case "assistant.message_delta":
                        // Notify any live listeners (for real-time streaming)
                        config?.onDelta?.(event.data.deltaContent);
                        break;

                    case "tool.execution_start":
                        // Intercept system tools BEFORE they execute
                        if (event.data.toolName === "wait") {
                            // The wait tool handler will abort — we detect it here
                            // and yield immediately with whatever content we have so far
                        }
                        config?.onToolStart?.(event.data.toolName, event.data.arguments);
                        break;

                    case "session.idle":
                        // Turn complete — session is idle
                        resolved = true;
                        turnUnsub();
                        resolve({ type: "completed", content });
                        break;

                    case "session.error":
                        resolved = true;
                        turnUnsub();
                        reject(new Error(event.data.message));
                        break;

                    case "abort":
                        resolved = true;
                        turnUnsub();
                        // Check if abort was from wait tool or user input
                        if (this.pendingWait) {
                            const wait = this.pendingWait;
                            this.pendingWait = null;
                            resolve({
                                type: "wait",
                                seconds: wait.seconds,
                                reason: wait.reason,
                                content, // content captured before abort
                            });
                        } else if (this.pendingInput) {
                            const input = this.pendingInput;
                            this.pendingInput = null;
                            resolve({
                                type: "input_required",
                                question: input.question,
                                choices: input.choices,
                            });
                        } else {
                            resolve({ type: "cancelled" });
                        }
                        break;
                }
            });

            // Send the message (non-blocking)
            this.copilotSession.send({ prompt }).catch(err => {
                if (!resolved) {
                    resolved = true;
                    turnUnsub();
                    reject(err);
                }
            });
        });
    }

    /**
     * Abort the current in-flight message.
     * Session remains alive for future runTurn() calls.
     */
    async abort(): Promise<void> {
        await this.copilotSession.abort();
    }

    /**
     * Destroy the session — release resources, flush to disk.
     */
    async destroy(): Promise<void> {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
        await this.copilotSession.destroy();
    }

    /**
     * Replay events from CMS since a given cursor.
     * Used when reconnecting to an existing session.
     */
    async replayEvents(afterSequence: number): Promise<SessionEvent[]> {
        const result = await this.cmsPool.query(
            `SELECT event_id, event_type, data, ephemeral, created_at
             FROM copilot_sessions.session_events
             WHERE session_id = $1 AND id > $2
             ORDER BY id ASC`,
            [this.sessionId, afterSequence]
        );
        return result.rows.map(row => ({
            id: row.event_id,
            type: row.event_type,
            data: row.data,
            ephemeral: row.ephemeral,
            timestamp: row.created_at.toISOString(),
            parentId: null,
        }));
    }

    // ─── Private ──────────────────────────────────────────

    private pendingWait: { seconds: number; reason: string } | null = null;
    private pendingInput: { question: string; choices?: string[] } | null = null;

    private async writeEventToCMS(event: SessionEvent): Promise<void> {
        await this.cmsPool.query(
            `INSERT INTO copilot_sessions.session_events
             (session_id, event_id, event_type, ephemeral, data, worker_node_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (session_id, event_id) DO NOTHING`,
            [
                this.sessionId,
                event.id,
                event.type,
                event.ephemeral ?? false,
                JSON.stringify(event.data),
                os.hostname(),
            ]
        );
    }
}
```

### 7.3 SessionManager

```typescript
class SessionManager {
    private client: CopilotClient;
    private sessions = new Map<string, ManagedSession>();
    private cmsPool: Pool;

    constructor(githubToken: string, cmsPool: Pool) {
        this.client = new CopilotClient({ githubToken, logLevel: "error" });
        this.cmsPool = cmsPool;
    }

    /**
     * Get an existing ManagedSession, or create/resume one.
     */
    async getOrCreate(sessionId: string, config: SessionConfig): Promise<ManagedSession> {
        // 1. Check if already in memory
        const existing = this.sessions.get(sessionId);
        if (existing) {
            return existing;
        }

        // 2. Check if local session files exist (post-hydration or same node)
        const sessionDir = `~/.copilot/session-state/${sessionId}`;
        let copilotSession: CopilotSession;
        if (fs.existsSync(sessionDir)) {
            copilotSession = await this.client.resumeSession(sessionId, config);
        } else {
            copilotSession = await this.client.createSession({ sessionId, ...config });
        }

        // 3. Wrap in ManagedSession (attaches on() → CMS writer)
        const managed = new ManagedSession(sessionId, copilotSession, this.cmsPool);
        this.sessions.set(sessionId, managed);

        // 4. Create/update CMS session record
        await this.cmsPool.query(
            `INSERT INTO copilot_sessions.sessions (session_id, orchestration_id, state, model, created_at, updated_at)
             VALUES ($1, $2, 'idle', $3, now(), now())
             ON CONFLICT (session_id) DO UPDATE SET state = 'idle', updated_at = now()`,
            [sessionId, `session-${sessionId}`, config.model]
        );

        return managed;
    }

    /**
     * Get a session by ID (null if not in memory on this node).
     */
    get(sessionId: string): ManagedSession | null {
        return this.sessions.get(sessionId) ?? null;
    }

    /**
     * Dehydrate a session: destroy in memory, upload to blob.
     */
    async dehydrate(sessionId: string, blobStore: SessionBlobStore, reason: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            await session.destroy();
            this.sessions.delete(sessionId);
        }
        await blobStore.dehydrate(sessionId, { reason });

        // Update CMS
        await this.cmsPool.query(
            `UPDATE copilot_sessions.sessions 
             SET state = 'dehydrated', is_dehydrated = true, updated_at = now()
             WHERE session_id = $1`,
            [sessionId]
        );
    }

    /**
     * List all in-memory session IDs on this node.
     */
    activeSessionIds(): string[] {
        return [...this.sessions.keys()];
    }

    /**
     * Shutdown: destroy all sessions, stop CopilotClient.
     */
    async shutdown(): Promise<void> {
        for (const [id, session] of this.sessions) {
            await session.destroy();
        }
        this.sessions.clear();
        await this.client.stop();
    }
}
```


### 7.6 Registration (in `PilotSwarmClient.start()`)

```typescript
async start(): Promise<void> {
    // 1. Create duroxide provider (PG)
    const provider = new PostgresProvider(this.config.store, {
        schema: "duroxide_copilot",
    });

    // 2. Initialize CMS schema (separate PG schema, same database)
    this.cms = new CMSClient(this.config.store);
    await this.cms.initialize();

    // 3. Create CMS PG pool for SessionManager
    this.cmsPool = new Pool({ connectionString: this.config.store });

    // 4. Create SessionManager (long-lived, owns ManagedSessions)
    this.sessionManager = new SessionManager(this.config.githubToken, this.cmsPool);

    // 5. Create blob store if configured
    if (this.config.blobConnectionString) {
        this.blobStore = new SessionBlobStore(this.config.blobConnectionString);
    }

    // 6. Create duroxide Runtime + register orchestration and
    //    SessionProxy activities (see §3.1.1 for the mapping)
    this.runtime = new Runtime(provider, {
        maxSessionsPerRuntime: this.config.maxSessionsPerRuntime ?? 50,
        sessionIdleTimeoutMs: this.config.sessionIdleTimeoutMs ?? 3_600_000,
        workerNodeId: this.config.workerNodeId,
        logLevel: this.config.logLevel ?? "error",
    });
    registerSessionProxyActivities(this.runtime, this.sessionManager, this.blobStore);
    this.runtime.registerOrchestration("durable-session", durableSessionOrchestration);

    // 7. Create duroxide client (for starting orchestrations, enqueuing events)
    this.duroxideClient = new Client(provider);

    // 8. Start runtime (non-blocking)
    this.runtime.start().catch(err => console.error("[runtime]", err));
    this.started = true;

    // 9. Graceful shutdown handler
    const shutdown = async () => { await this.stop(); process.exit(0); };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}
```

---

