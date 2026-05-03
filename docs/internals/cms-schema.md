# Internals: CMS Schema and Client

> CMS (the session catalog) lives in PostgreSQL under the `copilot_sessions`
> schema. The client writes lifecycle metadata (create/update/soft-delete);
> the worker writes runtime events. See
> [Architecture §3.4](../architecture.md#34-session-catalog-cms) for the
> high-level write/read paths.

### 7.4 CMS Schema

```sql
-- ─────────────────────────────────────────────────────
-- Schema: copilot_sessions
-- Lives alongside duroxide's schema in the same PG database.
-- ─────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS copilot_sessions;

-- ─── Migration tracking ──────────────────────────────

CREATE TABLE IF NOT EXISTS copilot_sessions._migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Sessions (catalog) ──────────────────────────────

CREATE TABLE copilot_sessions.sessions (
    -- Identity
    session_id              TEXT PRIMARY KEY,
    orchestration_id        TEXT NOT NULL,               -- "session-{session_id}"

    -- User-facing metadata
    name                    TEXT,                         -- user-friendly name (nullable)
    summary                 TEXT,                         -- LLM-generated or user-set summary

    -- State (mirrors PilotSwarmSessionStatus)
    state                   TEXT NOT NULL DEFAULT 'pending',
        -- pending | running | idle | waiting | input_required | completed | failed | dehydrated

    -- Configuration
    model                   TEXT,                         -- current model ID
    system_message          TEXT,                         -- system message content
    tools                   JSONB,                        -- tool definitions (name + schema, not handlers)

    -- Worker affinity
    worker_node_id          TEXT,                         -- current/last worker node
    affinity_key            TEXT,                         -- duroxide affinity key

    -- Lifecycle
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at          TIMESTAMPTZ,                  -- last user message timestamp
    deleted_at              TIMESTAMPTZ,                  -- soft delete timestamp

    -- Duroxide cross-references
    current_iteration       INTEGER NOT NULL DEFAULT 0,
    is_dehydrated           BOOLEAN NOT NULL DEFAULT false,
    blob_key                TEXT,                          -- blob storage key if dehydrated

    -- Metrics
    total_turns             INTEGER NOT NULL DEFAULT 0,
    total_input_tokens      BIGINT NOT NULL DEFAULT 0,
    total_output_tokens     BIGINT NOT NULL DEFAULT 0,

    -- Error tracking
    last_error              TEXT,
    last_error_at           TIMESTAMPTZ
);

CREATE INDEX idx_sessions_state
    ON copilot_sessions.sessions(state) WHERE deleted_at IS NULL;
CREATE INDEX idx_sessions_updated
    ON copilot_sessions.sessions(updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_sessions_last_active
    ON copilot_sessions.sessions(last_active_at DESC NULLS LAST) WHERE deleted_at IS NULL;
CREATE INDEX idx_sessions_worker
    ON copilot_sessions.sessions(worker_node_id) WHERE deleted_at IS NULL;


-- ─── Session Events (append-only log) ────────────────

CREATE TABLE copilot_sessions.session_events (
    -- Sequence ID (the cursor)
    id                  BIGSERIAL PRIMARY KEY,

    -- Session reference
    session_id          TEXT NOT NULL REFERENCES copilot_sessions.sessions(session_id),

    -- Event identity (from Copilot SDK SessionEvent)
    event_id            TEXT NOT NULL,                    -- SDK event UUID
    parent_id           TEXT,                             -- SDK parent event UUID
    event_type          TEXT NOT NULL,                    -- "assistant.message", "tool.execution_start", etc.
    ephemeral           BOOLEAN NOT NULL DEFAULT false,   -- transient events (deltas, progress)

    -- Event payload (the SDK's event.data — schema varies by event_type)
    data                JSONB NOT NULL,

    -- Metadata
    iteration           INTEGER NOT NULL DEFAULT 0,       -- orchestration iteration when event was produced
    worker_node_id      TEXT,                              -- which worker node produced this event
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Deduplication: same event can't be written twice (activity retry safety)
    UNIQUE(session_id, event_id)
);

-- Cursor-based reads: "give me events for session X after sequence Y"
CREATE INDEX idx_events_cursor
    ON copilot_sessions.session_events(session_id, id);

-- Type-filtered reads: "give me all assistant.message events for session X"
CREATE INDEX idx_events_type
    ON copilot_sessions.session_events(session_id, event_type);


-- ─── Models Cache ────────────────────────────────────

CREATE TABLE copilot_sessions.models_cache (
    model_id            TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    capabilities        JSONB NOT NULL,                   -- {supports: {vision, reasoning}, limits: {...}}
    policy              JSONB,                            -- {state, terms}
    billing             JSONB,                            -- {multiplier}
    reasoning           JSONB,                            -- {supported: [...], default: "..."}
    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    worker_node_id      TEXT                              -- which worker fetched this
);

CREATE INDEX idx_models_fetched
    ON copilot_sessions.models_cache(fetched_at DESC);
```


### 7.5 CMS Client (for `PilotSwarmClient` reads)

```typescript
import { Pool } from "pg";

class CMSClient {
    private pool: Pool;

    constructor(connectionString: string) {
        this.pool = new Pool({ connectionString });
    }

    /**
     * Initialize schema and run migrations.
     */
    async initialize(): Promise<void> {
        await this.pool.query(`CREATE SCHEMA IF NOT EXISTS copilot_sessions`);
        // Run numbered migration files from migrations/cms/
        await this.runMigrations();
    }

    // ─── Session Catalog ──────────────────────────────

    async listSessions(): Promise<SessionInfo[]> {
        const result = await this.pool.query(
            `SELECT session_id, orchestration_id, name, summary, state, model,
                    worker_node_id, created_at, updated_at, last_active_at,
                    current_iteration, is_dehydrated, total_turns,
                    total_input_tokens, total_output_tokens
             FROM copilot_sessions.sessions
             WHERE deleted_at IS NULL
             ORDER BY COALESCE(last_active_at, updated_at) DESC`
        );
        return result.rows;
    }

    async getSession(sessionId: string): Promise<SessionInfo | null> {
        const result = await this.pool.query(
            `SELECT * FROM copilot_sessions.sessions WHERE session_id = $1`,
            [sessionId]
        );
        return result.rows[0] ?? null;
    }

    async getLastSessionId(): Promise<string | null> {
        const result = await this.pool.query(
            `SELECT session_id FROM copilot_sessions.sessions
             WHERE deleted_at IS NULL
             ORDER BY last_active_at DESC NULLS LAST
             LIMIT 1`
        );
        return result.rows[0]?.session_id ?? null;
    }

    async renameSession(sessionId: string, name: string): Promise<void> {
        await this.pool.query(
            `UPDATE copilot_sessions.sessions SET name = $2, updated_at = now() WHERE session_id = $1`,
            [sessionId, name]
        );
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.pool.query(
            `UPDATE copilot_sessions.sessions SET deleted_at = now(), state = 'deleted' WHERE session_id = $1`,
            [sessionId]
        );
    }

    // ─── Session Events ───────────────────────────────

    async getEvents(sessionId: string, options?: {
        after?: number;         // cursor: sequence ID to start after
        types?: string[];       // event type filter
        includeEphemeral?: boolean;
        limit?: number;
    }): Promise<{ events: SessionEvent[]; cursor: number }> {
        const after = options?.after ?? 0;
        const limit = options?.limit ?? 1000;
        const conditions = [`session_id = $1`, `id > $2`];
        const params: any[] = [sessionId, after];

        if (!options?.includeEphemeral) {
            conditions.push(`NOT ephemeral`);
        }
        if (options?.types?.length) {
            params.push(options.types);
            conditions.push(`event_type = ANY($${params.length})`);
        }

        const result = await this.pool.query(
            `SELECT id, event_id, parent_id, event_type, ephemeral, data, iteration, created_at
             FROM copilot_sessions.session_events
             WHERE ${conditions.join(" AND ")}
             ORDER BY id ASC
             LIMIT $${params.length + 1}`,
            [...params, limit]
        );

        const events = result.rows.map(row => ({
            id: row.event_id,
            type: row.event_type,
            data: row.data,
            ephemeral: row.ephemeral,
            timestamp: row.created_at.toISOString(),
            parentId: row.parent_id,
            _sequence: row.id, // internal cursor value
        }));

        const cursor = events.length > 0 ? events[events.length - 1]._sequence : after;
        return { events, cursor };
    }

    // ─── Models Cache ─────────────────────────────────

    async getModels(maxAgeSec = 300): Promise<ModelInfo[]> {
        const result = await this.pool.query(
            `SELECT * FROM copilot_sessions.models_cache
             WHERE fetched_at > now() - interval '1 second' * $1
             ORDER BY name ASC`,
            [maxAgeSec]
        );
        return result.rows;
    }

    // ─── Cleanup ──────────────────────────────────────

    async close(): Promise<void> {
        await this.pool.end();
    }
}
```

