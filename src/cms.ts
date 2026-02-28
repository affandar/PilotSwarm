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
    createSession(sessionId: string, opts?: { model?: string }): Promise<void>;

    /** Update one or more fields on an existing session. */
    updateSession(sessionId: string, updates: SessionRowUpdates): Promise<void>;

    /** Soft-delete a session (set deleted_at). */
    softDeleteSession(sessionId: string): Promise<void>;

    // ── Reads (called from client) ───────────────────────────

    /** List all non-deleted sessions, newest first. */
    listSessions(): Promise<SessionRow[]>;

    /** Get a single session by ID (null if not found or deleted). */
    getSession(sessionId: string): Promise<SessionRow | null>;

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

const SCHEMA = "copilot_sessions";
const TABLE = `${SCHEMA}.sessions`;

const CREATE_SCHEMA_SQL = `CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`;

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
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
    last_error        TEXT
)`;

const EVENTS_TABLE = `${SCHEMA}.session_events`;

const CREATE_EVENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (
    seq           BIGSERIAL PRIMARY KEY,
    session_id    TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    data          JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

const CREATE_INDEXES_SQL = [
    `CREATE INDEX IF NOT EXISTS idx_sessions_state ON ${TABLE}(state) WHERE deleted_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_updated ON ${TABLE}(updated_at DESC) WHERE deleted_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_events_session_seq ON ${EVENTS_TABLE}(session_id, seq)`,
];

/**
 * PgSessionCatalogProvider — PostgreSQL implementation of SessionCatalogProvider.
 *
 * Uses the `pg` package (node-postgres) directly.
 * Must be created via the async `PgSessionCatalogProvider.create()` factory.
 */
export class PgSessionCatalogProvider implements SessionCatalogProvider {
    private pool: any;
    private initialized = false;

    private constructor(pool: any) {
        this.pool = pool;
    }

    /** Factory: create and connect a PgSessionCatalogProvider. */
    static async create(connectionString: string): Promise<PgSessionCatalogProvider> {
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
        return new PgSessionCatalogProvider(pool);
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        await this.pool.query(CREATE_SCHEMA_SQL);
        await this.pool.query(CREATE_TABLE_SQL);
        await this.pool.query(CREATE_EVENTS_TABLE_SQL);
        for (const idx of CREATE_INDEXES_SQL) {
            await this.pool.query(idx);
        }
        this.initialized = true;
    }

    // ── Writes ───────────────────────────────────────────────

    async createSession(sessionId: string, opts?: { model?: string }): Promise<void> {
        await this.pool.query(
            `INSERT INTO ${TABLE} (session_id, model)
             VALUES ($1, $2)
             ON CONFLICT (session_id) DO NOTHING`,
            [sessionId, opts?.model ?? null],
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

        if (values.length === 0) return; // nothing to update besides updated_at

        values.push(sessionId);
        await this.pool.query(
            `UPDATE ${TABLE} SET ${setClauses.join(", ")} WHERE session_id = $${idx}`,
            values,
        );
    }

    async softDeleteSession(sessionId: string): Promise<void> {
        await this.pool.query(
            `UPDATE ${TABLE} SET deleted_at = now(), updated_at = now() WHERE session_id = $1`,
            [sessionId],
        );
    }

    // ── Reads ────────────────────────────────────────────────

    async listSessions(): Promise<SessionRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${TABLE} WHERE deleted_at IS NULL ORDER BY updated_at DESC`,
        );
        return rows.map(rowToSessionRow);
    }

    async getSession(sessionId: string): Promise<SessionRow | null> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${TABLE} WHERE session_id = $1 AND deleted_at IS NULL`,
            [sessionId],
        );
        return rows.length > 0 ? rowToSessionRow(rows[0]) : null;
    }

    async getLastSessionId(): Promise<string | null> {
        const { rows } = await this.pool.query(
            `SELECT session_id FROM ${TABLE}
             WHERE deleted_at IS NULL
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
            `INSERT INTO ${EVENTS_TABLE} (session_id, event_type, data)
             VALUES ${valuePlaceholders.join(", ")}`,
            values,
        );
    }

    async getSessionEvents(sessionId: string, afterSeq?: number, limit?: number): Promise<SessionEvent[]> {
        const effectiveLimit = limit ?? 1000;
        let query: string;
        let params: unknown[];

        if (afterSeq != null && afterSeq > 0) {
            query = `SELECT * FROM ${EVENTS_TABLE}
                     WHERE session_id = $1 AND seq > $2
                     ORDER BY seq ASC LIMIT $3`;
            params = [sessionId, afterSeq, effectiveLimit];
        } else {
            // Return the most recent events (last N), in chronological order
            query = `SELECT * FROM (
                         SELECT * FROM ${EVENTS_TABLE}
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
