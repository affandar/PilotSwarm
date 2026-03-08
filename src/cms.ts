/**
 * Session Catalog (CMS) — provider-based session metadata store.
 *
 * The client writes to CMS before making duroxide calls (write-first).
 * CMS is the source of truth for session lifecycle.
 * Duroxide state is eventually consistent with CMS.
 *
 * @module
 */

// ─── Types ───────────────────────────────────────────────────────

/** A persisted session event (non-ephemeral). */
export interface SessionEvent {
    seq: number;
    sessionId: string;
    eventType: string;
    data: unknown;
    createdAt: Date;
}

/** A row in the sessions table. */
export interface SessionRow {
    sessionId: string;
    orchestrationId: string | null;
    title: string | null;
    state: string;
    model: string | null;
    createdAt: Date;
    updatedAt: Date;
    lastActiveAt: Date | null;
    deletedAt: Date | null;
    currentIteration: number;
    lastError: string | null;
    /** Live wait reason (e.g. "waiting for build"). Synced from runTurn activity. */
    waitReason: string | null;
    /** If this session is a sub-agent, the parent session's ID. */
    parentSessionId: string | null;
    /** Whether this is a system session (e.g. Sweeper Agent). */
    isSystem: boolean;
    /** Agent definition ID (e.g. "sweeper"). Links session to its agent config. */
    agentId: string | null;
    /** Splash banner (blessed markup) from the agent definition. */
    splash: string | null;
}

/** Fields that can be updated on a session row. */
export interface SessionRowUpdates {
    orchestrationId?: string | null;
    title?: string | null;
    state?: string;
    model?: string | null;
    lastActiveAt?: Date;
    currentIteration?: number;
    lastError?: string | null;
    waitReason?: string | null;
    isSystem?: boolean;
    agentId?: string | null;
    splash?: string | null;
}

// ─── Provider Interface ──────────────────────────────────────────

/**
 * SessionCatalogProvider — abstraction over the CMS backing store.
 *
 * Initial implementation: PostgreSQL.
 * Future: CosmosDB, etc.
 */
export interface SessionCatalogProvider {
    /** Create schema and tables if they don't exist. */
    initialize(): Promise<void>;

    // ── Writes (called from client, before duroxide calls) ───

    /** Insert a new session. No-op if session already exists. */
    createSession(sessionId: string, opts?: { model?: string; parentSessionId?: string; isSystem?: boolean; agentId?: string; splash?: string }): Promise<void>;

    /** Update one or more fields on an existing session. */
    updateSession(sessionId: string, updates: SessionRowUpdates): Promise<void>;

    /** Soft-delete a session (set deleted_at). */
    softDeleteSession(sessionId: string): Promise<void>;

    // ── Reads (called from client) ───────────────────────────

    /** List all non-deleted sessions, newest first. */
    listSessions(): Promise<SessionRow[]>;

    /** Get a single session by ID (null if not found or deleted). */
    getSession(sessionId: string): Promise<SessionRow | null>;

    /** Get all descendant session IDs (children, grandchildren, etc.) of a given session. */
    getDescendantSessionIds(sessionId: string): Promise<string[]>;

    /** Get the most recently active session ID. */
    getLastSessionId(): Promise<string | null>;

    // ── Events (written from worker, read from client) ───────

    /** Record a batch of events for a session. */
    recordEvents(sessionId: string, events: { eventType: string; data: unknown }[]): Promise<void>;

    /** Get events for a session, optionally after a sequence number. */
    getSessionEvents(sessionId: string, afterSeq?: number, limit?: number): Promise<SessionEvent[]>;

    /** Cleanup / close connections. */
    close(): Promise<void>;
}

// ─── PostgreSQL Implementation ───────────────────────────────────

const DEFAULT_SCHEMA = "copilot_sessions";

/**
 * Build SQL strings for a given schema name.
 * Allows multiple deployments to coexist on the same database.
 */
function sqlForSchema(schema: string) {
    const table = `${schema}.sessions`;
    const eventsTable = `${schema}.session_events`;
    return {
        schema,
        table,
        eventsTable,
        createSchema: `CREATE SCHEMA IF NOT EXISTS ${schema}`,
        createTable: `
CREATE TABLE IF NOT EXISTS ${table} (
    session_id        TEXT PRIMARY KEY,
    orchestration_id  TEXT,
    title             TEXT,
    state             TEXT NOT NULL DEFAULT 'pending',
    model             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at    TIMESTAMPTZ,
    deleted_at        TIMESTAMPTZ,
    current_iteration INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT,
    parent_session_id TEXT,
    wait_reason       TEXT
)`,
        createEventsTable: `
CREATE TABLE IF NOT EXISTS ${eventsTable} (
    seq           BIGSERIAL PRIMARY KEY,
    session_id    TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    data          JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
        createIndexes: [
            `CREATE INDEX IF NOT EXISTS idx_${schema}_sessions_state ON ${table}(state) WHERE deleted_at IS NULL`,
            `CREATE INDEX IF NOT EXISTS idx_${schema}_sessions_updated ON ${table}(updated_at DESC) WHERE deleted_at IS NULL`,
            `CREATE INDEX IF NOT EXISTS idx_${schema}_events_session_seq ON ${eventsTable}(session_id, seq)`,
        ],
    };
}

/**
 * PgSessionCatalogProvider — PostgreSQL implementation of SessionCatalogProvider.
 *
 * Uses the `pg` package (node-postgres) directly.
 * Must be created via the async `PgSessionCatalogProvider.create()` factory.
 */
export class PgSessionCatalogProvider implements SessionCatalogProvider {
    private pool: any;
    private initialized = false;
    private sql: ReturnType<typeof sqlForSchema>;

    private constructor(pool: any, schema: string) {
        this.pool = pool;
        this.sql = sqlForSchema(schema);
    }

    /** Factory: create and connect a PgSessionCatalogProvider. */
    static async create(connectionString: string, schema?: string): Promise<PgSessionCatalogProvider> {
        const { default: pg } = await import("pg");

        // pg v8 treats sslmode=require as verify-full, which rejects Azure/self-signed
        // certs. Strip sslmode from URL and control SSL entirely via config object.
        const parsed = new URL(connectionString);
        const needsSsl = ["require", "prefer", "verify-ca", "verify-full"]
            .includes(parsed.searchParams.get("sslmode") ?? "");
        parsed.searchParams.delete("sslmode");

        const pool = new pg.Pool({
            connectionString: parsed.toString(),
            ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
        });

        // Handle idle client errors (e.g. EADDRNOTAVAIL when the network
        // drops). Without this, pg Pool emits an unhandled 'error' event
        // which crashes the Node.js process.
        pool.on('error', (err: Error) => {
            console.error('[cms] pool idle client error (non-fatal):', err.message);
        });

        return new PgSessionCatalogProvider(pool, schema ?? DEFAULT_SCHEMA);
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        await this.pool.query(this.sql.createSchema);
        await this.pool.query(this.sql.createTable);
        await this.pool.query(this.sql.createEventsTable);
        for (const idx of this.sql.createIndexes) {
            await this.pool.query(idx);
        }
        // Migration: add parent_session_id if missing (safe for existing DBs)
        try {
            await this.pool.query(
                `ALTER TABLE ${this.sql.table} ADD COLUMN IF NOT EXISTS parent_session_id TEXT`
            );
        } catch {}
        // Migration: add is_system column if missing
        try {
            await this.pool.query(
                `ALTER TABLE ${this.sql.table} ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE`
            );
        } catch {}
        // Migration: add wait_reason column if missing
        try {
            await this.pool.query(
                `ALTER TABLE ${this.sql.table} ADD COLUMN IF NOT EXISTS wait_reason TEXT`
            );
        } catch {}
        // Migration: add agent_id column if missing
        try {
            await this.pool.query(
                `ALTER TABLE ${this.sql.table} ADD COLUMN IF NOT EXISTS agent_id TEXT`
            );
        } catch {}
        // Migration: add splash column if missing
        try {
            await this.pool.query(
                `ALTER TABLE ${this.sql.table} ADD COLUMN IF NOT EXISTS splash TEXT`
            );
        } catch {}
        this.initialized = true;
    }

    // ── Writes ───────────────────────────────────────────────

    async createSession(sessionId: string, opts?: { model?: string; parentSessionId?: string; isSystem?: boolean; agentId?: string; splash?: string }): Promise<void> {
        await this.pool.query(
            `INSERT INTO ${this.sql.table} (session_id, model, parent_session_id, is_system, agent_id, splash)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (session_id) DO NOTHING`,
            [sessionId, opts?.model ?? null, opts?.parentSessionId ?? null, opts?.isSystem ?? false, opts?.agentId ?? null, opts?.splash ?? null],
        );
    }

    async updateSession(sessionId: string, updates: SessionRowUpdates): Promise<void> {
        const setClauses: string[] = ["updated_at = now()"];
        const values: unknown[] = [];
        let idx = 1;

        if (updates.orchestrationId !== undefined) {
            setClauses.push(`orchestration_id = $${idx++}`);
            values.push(updates.orchestrationId);
        }
        if (updates.title !== undefined) {
            setClauses.push(`title = $${idx++}`);
            values.push(updates.title);
        }
        if (updates.state !== undefined) {
            setClauses.push(`state = $${idx++}`);
            values.push(updates.state);
        }
        if (updates.model !== undefined) {
            setClauses.push(`model = $${idx++}`);
            values.push(updates.model);
        }
        if (updates.lastActiveAt !== undefined) {
            setClauses.push(`last_active_at = $${idx++}`);
            values.push(updates.lastActiveAt);
        }
        if (updates.currentIteration !== undefined) {
            setClauses.push(`current_iteration = $${idx++}`);
            values.push(updates.currentIteration);
        }
        if (updates.lastError !== undefined) {
            setClauses.push(`last_error = $${idx++}`);
            values.push(updates.lastError);
        }
        if (updates.waitReason !== undefined) {
            setClauses.push(`wait_reason = $${idx++}`);
            values.push(updates.waitReason);
        }
        if (updates.isSystem !== undefined) {
            setClauses.push(`is_system = $${idx++}`);
            values.push(updates.isSystem);
        }
        if (updates.agentId !== undefined) {
            setClauses.push(`agent_id = $${idx++}`);
            values.push(updates.agentId);
        }
        if (updates.splash !== undefined) {
            setClauses.push(`splash = $${idx++}`);
            values.push(updates.splash);
        }

        if (values.length === 0) return; // nothing to update besides updated_at

        values.push(sessionId);
        await this.pool.query(
            `UPDATE ${this.sql.table} SET ${setClauses.join(", ")} WHERE session_id = $${idx}`,
            values,
        );
    }

    async softDeleteSession(sessionId: string): Promise<void> {
        // Guard: refuse to delete system sessions
        const { rows } = await this.pool.query(
            `SELECT is_system FROM ${this.sql.table} WHERE session_id = $1`,
            [sessionId],
        );
        if (rows.length > 0 && rows[0].is_system) {
            throw new Error("Cannot delete system session");
        }
        await this.pool.query(
            `UPDATE ${this.sql.table} SET deleted_at = now(), updated_at = now() WHERE session_id = $1`,
            [sessionId],
        );
    }

    // ── Reads ────────────────────────────────────────────────

    async listSessions(): Promise<SessionRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.table} WHERE deleted_at IS NULL ORDER BY updated_at DESC`,
        );
        return rows.map(rowToSessionRow);
    }

    async getSession(sessionId: string): Promise<SessionRow | null> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.table} WHERE session_id = $1 AND deleted_at IS NULL`,
            [sessionId],
        );
        return rows.length > 0 ? rowToSessionRow(rows[0]) : null;
    }

    async getDescendantSessionIds(sessionId: string): Promise<string[]> {
        // Recursive CTE to find all descendants
        const { rows } = await this.pool.query(
            `WITH RECURSIVE descendants AS (
                SELECT session_id FROM ${this.sql.table}
                WHERE parent_session_id = $1 AND deleted_at IS NULL
                UNION ALL
                SELECT s.session_id FROM ${this.sql.table} s
                INNER JOIN descendants d ON s.parent_session_id = d.session_id
                WHERE s.deleted_at IS NULL
            )
            SELECT session_id FROM descendants`,
            [sessionId],
        );
        return rows.map((r: any) => r.session_id);
    }

    async getLastSessionId(): Promise<string | null> {
        const { rows } = await this.pool.query(
            `SELECT session_id FROM ${this.sql.table}
             WHERE deleted_at IS NULL AND is_system = FALSE
             ORDER BY last_active_at DESC NULLS LAST
             LIMIT 1`,
        );
        return rows.length > 0 ? rows[0].session_id : null;
    }

    // ── Events ───────────────────────────────────────────────

    async recordEvents(sessionId: string, events: { eventType: string; data: unknown }[]): Promise<void> {
        if (events.length === 0) return;

        // Batch insert with a single multi-row INSERT
        const valuePlaceholders: string[] = [];
        const values: unknown[] = [];
        let idx = 1;
        for (const evt of events) {
            valuePlaceholders.push(`($${idx++}, $${idx++}, $${idx++})`);
            values.push(sessionId, evt.eventType, JSON.stringify(evt.data));
        }

        await this.pool.query(
            `INSERT INTO ${this.sql.eventsTable} (session_id, event_type, data)
             VALUES ${valuePlaceholders.join(", ")}`,
            values,
        );
    }

    async getSessionEvents(sessionId: string, afterSeq?: number, limit?: number): Promise<SessionEvent[]> {
        const effectiveLimit = limit ?? 1000;
        let query: string;
        let params: unknown[];

        if (afterSeq != null && afterSeq > 0) {
            query = `SELECT * FROM ${this.sql.eventsTable}
                     WHERE session_id = $1 AND seq > $2
                     ORDER BY seq ASC LIMIT $3`;
            params = [sessionId, afterSeq, effectiveLimit];
        } else {
            // Return the most recent events (last N), in chronological order
            query = `SELECT * FROM (
                         SELECT * FROM ${this.sql.eventsTable}
                         WHERE session_id = $1
                         ORDER BY seq DESC LIMIT $2
                     ) t ORDER BY seq ASC`;
            params = [sessionId, effectiveLimit];
        }

        const { rows } = await this.pool.query(query, params);
        return rows.map(rowToSessionEvent);
    }

    async close(): Promise<void> {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
        }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Map a PG row (snake_case) to SessionRow (camelCase). */
function rowToSessionRow(row: any): SessionRow {
    return {
        sessionId: row.session_id,
        orchestrationId: row.orchestration_id ?? null,
        title: row.title ?? null,
        state: row.state,
        model: row.model ?? null,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
        lastActiveAt: row.last_active_at ? new Date(row.last_active_at) : null,
        deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
        currentIteration: row.current_iteration ?? 0,
        lastError: row.last_error ?? null,
        waitReason: row.wait_reason ?? null,
        parentSessionId: row.parent_session_id ?? null,
        isSystem: row.is_system ?? false,
        agentId: row.agent_id ?? null,
        splash: row.splash ?? null,
    };
}

/** Map a PG row to SessionEvent. */
function rowToSessionEvent(row: any): SessionEvent {
    return {
        seq: Number(row.seq),
        sessionId: row.session_id,
        eventType: row.event_type,
        data: row.data,
        createdAt: new Date(row.created_at),
    };
}
