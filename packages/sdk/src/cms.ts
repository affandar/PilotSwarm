/**
 * Session Catalog (CMS) — provider-based session metadata store.
 *
 * The client writes to CMS before making duroxide calls (write-first).
 * CMS is the source of truth for session lifecycle.
 * Duroxide state is eventually consistent with CMS.
 *
 * @module
 */

import { runCmsMigrations } from "./cms-migrator.js";

// ─── Types ───────────────────────────────────────────────────────

/** A persisted session event (non-ephemeral). */
export interface SessionEvent {
    seq: number;
    sessionId: string;
    eventType: string;
    data: unknown;
    createdAt: Date;
    workerNodeId?: string;
}

/** A row in the sessions table. */
export interface SessionRow {
    sessionId: string;
    orchestrationId: string | null;
    title: string | null;
    titleLocked: boolean;
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
    /** Splash banner (terminal markup) from the agent definition. */
    splash: string | null;
}

/** Fields that can be updated on a session row. */
export interface SessionRowUpdates {
    orchestrationId?: string | null;
    title?: string | null;
    titleLocked?: boolean;
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

// ─── Session Metric Summary Types ────────────────────────────────

/** Per-session metric summary — one row per session, updated in place. */
export interface SessionMetricSummary {
    sessionId: string;
    agentId: string | null;
    model: string | null;
    parentSessionId: string | null;
    snapshotSizeBytes: number;
    dehydrationCount: number;
    hydrationCount: number;
    lossyHandoffCount: number;
    lastDehydratedAt: number | null;
    lastHydratedAt: number | null;
    lastCheckpointAt: number | null;
    tokensInput: number;
    tokensOutput: number;
    tokensCacheRead: number;
    tokensCacheWrite: number;
    deletedAt: number | null;
    createdAt: number;
    updatedAt: number;
}

/** Fields for atomic upsert — increments are additive, absolutes are set. */
export interface SessionMetricSummaryUpsert {
    snapshotSizeBytes?: number;
    dehydrationCountIncrement?: number;
    hydrationCountIncrement?: number;
    lossyHandoffCountIncrement?: number;
    lastDehydratedAt?: boolean;
    lastHydratedAt?: boolean;
    lastCheckpointAt?: boolean;
    tokensInputIncrement?: number;
    tokensOutputIncrement?: number;
    tokensCacheReadIncrement?: number;
    tokensCacheWriteIncrement?: number;
}

/** Fleet-wide aggregate stats. */
export interface FleetStats {
    windowStart: number | null;
    earliestSessionCreatedAt: number | null;
    byAgent: Array<{
        agentId: string | null;
        model: string | null;
        sessionCount: number;
        totalSnapshotSizeBytes: number;
        totalDehydrationCount: number;
        totalHydrationCount: number;
        totalLossyHandoffCount: number;
        totalTokensInput: number;
        totalTokensOutput: number;
    }>;
    totals: {
        sessionCount: number;
        totalSnapshotSizeBytes: number;
        totalTokensInput: number;
        totalTokensOutput: number;
    };
}

/** Aggregate of a session and all its descendants. */
export interface SessionTreeStats {
    rootSessionId: string;
    self: SessionMetricSummary;
    tree: {
        sessionCount: number;
        totalTokensInput: number;
        totalTokensOutput: number;
        totalTokensCacheRead: number;
        totalTokensCacheWrite: number;
        totalDehydrationCount: number;
        totalHydrationCount: number;
        totalLossyHandoffCount: number;
        totalSnapshotSizeBytes: number;
    };
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
    recordEvents(sessionId: string, events: { eventType: string; data: unknown }[], workerNodeId?: string): Promise<void>;

    /** Get events for a session, optionally after a sequence number. */
    getSessionEvents(sessionId: string, afterSeq?: number, limit?: number): Promise<SessionEvent[]>;

    /** Get events before a sequence number, ordered ascending by seq. */
    getSessionEventsBefore(sessionId: string, beforeSeq: number, limit?: number): Promise<SessionEvent[]>;

    // ── Session Metric Summaries ──────────────────────────────

    /** Get the metric summary for a single session. */
    getSessionMetricSummary(sessionId: string): Promise<SessionMetricSummary | null>;

    /** Get a session's own stats plus rolled-up totals of all descendants. */
    getSessionTreeStats(sessionId: string): Promise<SessionTreeStats | null>;

    /** Get fleet-wide aggregate stats, optionally filtered. */
    getFleetStats(opts?: { includeDeleted?: boolean; since?: Date }): Promise<FleetStats>;

    /** Upsert a session metric summary with atomic increments. */
    upsertSessionMetricSummary(sessionId: string, updates: SessionMetricSummaryUpsert): Promise<void>;

    /** Hard-delete summary rows for sessions deleted before the cutoff. Returns count removed. */
    pruneDeletedSummaries(olderThan: Date): Promise<number>;

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
    const table = `"${schema}".sessions`;
    const eventsTable = `"${schema}".session_events`;
    const summaryTable = `"${schema}".session_metric_summaries`;
    return {
        schema,
        table,
        eventsTable,
        summaryTable,
        createSchema: `CREATE SCHEMA IF NOT EXISTS "${schema}"`,
        createTable: `
CREATE TABLE IF NOT EXISTS ${table} (
    session_id        TEXT PRIMARY KEY,
    orchestration_id  TEXT,
    title             TEXT,
    title_locked      BOOLEAN NOT NULL DEFAULT FALSE,
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
            max: 3,
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
        await runCmsMigrations(this.pool, this.sql.schema);
        this.initialized = true;
    }

    // ── Writes ───────────────────────────────────────────────

    async createSession(sessionId: string, opts?: { model?: string; parentSessionId?: string; isSystem?: boolean; agentId?: string; splash?: string }): Promise<void> {
        await this.pool.query(
            `INSERT INTO ${this.sql.table} (session_id, model, parent_session_id, is_system, agent_id, splash)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (session_id) DO UPDATE
             SET model = EXCLUDED.model,
                 parent_session_id = EXCLUDED.parent_session_id,
                 is_system = EXCLUDED.is_system,
                 agent_id = EXCLUDED.agent_id,
                 splash = EXCLUDED.splash,
                 deleted_at = NULL,
                 updated_at = now(),
                 state = 'pending',
                 orchestration_id = NULL,
                 last_error = NULL,
                 last_active_at = NULL,
                 current_iteration = 0,
                 wait_reason = NULL,
                 title_locked = FALSE
             WHERE ${this.sql.table}.deleted_at IS NOT NULL`,
            [sessionId, opts?.model ?? null, opts?.parentSessionId ?? null, opts?.isSystem ?? false, opts?.agentId ?? null, opts?.splash ?? null],
        );

        // Seed zeroed metric summary row
        await this.pool.query(
            `INSERT INTO ${this.sql.summaryTable} (session_id, agent_id, model, parent_session_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (session_id) DO NOTHING`,
            [sessionId, opts?.agentId ?? null, opts?.model ?? null, opts?.parentSessionId ?? null],
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
        if (updates.titleLocked !== undefined) {
            setClauses.push(`title_locked = $${idx++}`);
            values.push(updates.titleLocked);
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
        // Mirror soft-delete to summary row
        await this.pool.query(
            `UPDATE ${this.sql.summaryTable} SET deleted_at = now(), updated_at = now() WHERE session_id = $1`,
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

    async recordEvents(sessionId: string, events: { eventType: string; data: unknown }[], workerNodeId?: string): Promise<void> {
        if (events.length === 0) return;

        // Batch insert with a single multi-row INSERT
        const valuePlaceholders: string[] = [];
        const values: unknown[] = [];
        let idx = 1;
        for (const evt of events) {
            valuePlaceholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++})`);
            values.push(sessionId, evt.eventType, JSON.stringify(evt.data), workerNodeId ?? null);
        }

        await this.pool.query(
            `INSERT INTO ${this.sql.eventsTable} (session_id, event_type, data, worker_node_id)
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

    async getSessionEventsBefore(sessionId: string, beforeSeq: number, limit?: number): Promise<SessionEvent[]> {
        const effectiveLimit = limit ?? 1000;
        const query = `SELECT * FROM (
                           SELECT * FROM ${this.sql.eventsTable}
                           WHERE session_id = $1 AND seq < $2
                           ORDER BY seq DESC LIMIT $3
                       ) t ORDER BY seq ASC`;
        const params = [sessionId, beforeSeq, effectiveLimit];
        const { rows } = await this.pool.query(query, params);
        return rows.map(rowToSessionEvent);
    }

    // ── Session Metric Summaries ─────────────────────────────

    async getSessionMetricSummary(sessionId: string): Promise<SessionMetricSummary | null> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.summaryTable} WHERE session_id = $1`,
            [sessionId],
        );
        return rows.length > 0 ? rowToSessionMetricSummary(rows[0]) : null;
    }

    async getSessionTreeStats(sessionId: string): Promise<SessionTreeStats | null> {
        const self = await this.getSessionMetricSummary(sessionId);
        if (!self) return null;

        const { rows } = await this.pool.query(
            `WITH RECURSIVE tree AS (
                SELECT session_id FROM ${this.sql.summaryTable}
                WHERE session_id = $1
                UNION ALL
                SELECT m.session_id FROM ${this.sql.summaryTable} m
                INNER JOIN tree t ON m.parent_session_id = t.session_id
            )
            SELECT
                COUNT(*)::int                                    AS session_count,
                COALESCE(SUM(tokens_input), 0)::bigint           AS total_tokens_input,
                COALESCE(SUM(tokens_output), 0)::bigint          AS total_tokens_output,
                COALESCE(SUM(tokens_cache_read), 0)::bigint      AS total_tokens_cache_read,
                COALESCE(SUM(tokens_cache_write), 0)::bigint     AS total_tokens_cache_write,
                COALESCE(SUM(dehydration_count), 0)::int         AS total_dehydration_count,
                COALESCE(SUM(hydration_count), 0)::int           AS total_hydration_count,
                COALESCE(SUM(lossy_handoff_count), 0)::int       AS total_lossy_handoff_count,
                COALESCE(SUM(snapshot_size_bytes), 0)::bigint    AS total_snapshot_size_bytes
            FROM ${this.sql.summaryTable}
            WHERE session_id IN (SELECT session_id FROM tree)`,
            [sessionId],
        );

        const r = rows[0];
        return {
            rootSessionId: sessionId,
            self,
            tree: {
                sessionCount: Number(r.session_count) || 0,
                totalTokensInput: Number(r.total_tokens_input) || 0,
                totalTokensOutput: Number(r.total_tokens_output) || 0,
                totalTokensCacheRead: Number(r.total_tokens_cache_read) || 0,
                totalTokensCacheWrite: Number(r.total_tokens_cache_write) || 0,
                totalDehydrationCount: Number(r.total_dehydration_count) || 0,
                totalHydrationCount: Number(r.total_hydration_count) || 0,
                totalLossyHandoffCount: Number(r.total_lossy_handoff_count) || 0,
                totalSnapshotSizeBytes: Number(r.total_snapshot_size_bytes) || 0,
            },
        };
    }

    async getFleetStats(opts?: { includeDeleted?: boolean; since?: Date }): Promise<FleetStats> {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (!opts?.includeDeleted) {
            conditions.push("deleted_at IS NULL");
        }
        if (opts?.since) {
            conditions.push(`created_at >= $${idx++}`);
            params.push(opts.since);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

        // Per-group breakdown
        const { rows: groups } = await this.pool.query(
            `SELECT
                agent_id,
                model,
                COUNT(*)::int                                          AS session_count,
                COALESCE(SUM(snapshot_size_bytes), 0)::bigint          AS total_snapshot_size_bytes,
                COALESCE(SUM(dehydration_count), 0)::int               AS total_dehydration_count,
                COALESCE(SUM(hydration_count), 0)::int                 AS total_hydration_count,
                COALESCE(SUM(lossy_handoff_count), 0)::int             AS total_lossy_handoff_count,
                COALESCE(SUM(tokens_input), 0)::bigint                 AS total_tokens_input,
                COALESCE(SUM(tokens_output), 0)::bigint                AS total_tokens_output
            FROM ${this.sql.summaryTable}
            ${whereClause}
            GROUP BY agent_id, model`,
            params,
        );

        // Totals + earliest date
        const { rows: totalsRows } = await this.pool.query(
            `SELECT
                COUNT(*)::int                                          AS session_count,
                COALESCE(SUM(snapshot_size_bytes), 0)::bigint          AS total_snapshot_size_bytes,
                COALESCE(SUM(tokens_input), 0)::bigint                 AS total_tokens_input,
                COALESCE(SUM(tokens_output), 0)::bigint                AS total_tokens_output,
                MIN(created_at)                                        AS earliest_session_created_at
            FROM ${this.sql.summaryTable}
            ${whereClause}`,
            params,
        );

        const t = totalsRows[0];
        return {
            windowStart: opts?.since ? opts.since.getTime() : null,
            earliestSessionCreatedAt: t.earliest_session_created_at
                ? new Date(t.earliest_session_created_at).getTime()
                : null,
            byAgent: groups.map((g: any) => ({
                agentId: g.agent_id ?? null,
                model: g.model ?? null,
                sessionCount: Number(g.session_count) || 0,
                totalSnapshotSizeBytes: Number(g.total_snapshot_size_bytes) || 0,
                totalDehydrationCount: Number(g.total_dehydration_count) || 0,
                totalHydrationCount: Number(g.total_hydration_count) || 0,
                totalLossyHandoffCount: Number(g.total_lossy_handoff_count) || 0,
                totalTokensInput: Number(g.total_tokens_input) || 0,
                totalTokensOutput: Number(g.total_tokens_output) || 0,
            })),
            totals: {
                sessionCount: Number(t.session_count) || 0,
                totalSnapshotSizeBytes: Number(t.total_snapshot_size_bytes) || 0,
                totalTokensInput: Number(t.total_tokens_input) || 0,
                totalTokensOutput: Number(t.total_tokens_output) || 0,
            },
        };
    }

    async upsertSessionMetricSummary(sessionId: string, updates: SessionMetricSummaryUpsert): Promise<void> {
        const setClauses: string[] = ["updated_at = now()"];
        const insertCols: string[] = ["session_id"];
        const insertVals: string[] = ["$1"];
        const values: unknown[] = [sessionId];
        let idx = 2;

        if (updates.snapshotSizeBytes !== undefined) {
            setClauses.push(`snapshot_size_bytes = $${idx}`);
            insertCols.push("snapshot_size_bytes");
            insertVals.push(`$${idx}`);
            values.push(updates.snapshotSizeBytes);
            idx++;
        }
        if (updates.dehydrationCountIncrement) {
            setClauses.push(`dehydration_count = ${this.sql.summaryTable}.dehydration_count + $${idx}`);
            insertCols.push("dehydration_count");
            insertVals.push(`$${idx}`);
            values.push(updates.dehydrationCountIncrement);
            idx++;
        }
        if (updates.hydrationCountIncrement) {
            setClauses.push(`hydration_count = ${this.sql.summaryTable}.hydration_count + $${idx}`);
            insertCols.push("hydration_count");
            insertVals.push(`$${idx}`);
            values.push(updates.hydrationCountIncrement);
            idx++;
        }
        if (updates.lossyHandoffCountIncrement) {
            setClauses.push(`lossy_handoff_count = ${this.sql.summaryTable}.lossy_handoff_count + $${idx}`);
            insertCols.push("lossy_handoff_count");
            insertVals.push(`$${idx}`);
            values.push(updates.lossyHandoffCountIncrement);
            idx++;
        }
        if (updates.lastDehydratedAt) {
            setClauses.push("last_dehydrated_at = now()");
        }
        if (updates.lastHydratedAt) {
            setClauses.push("last_hydrated_at = now()");
        }
        if (updates.lastCheckpointAt) {
            setClauses.push("last_checkpoint_at = now()");
        }
        if (updates.tokensInputIncrement) {
            setClauses.push(`tokens_input = ${this.sql.summaryTable}.tokens_input + $${idx}`);
            insertCols.push("tokens_input");
            insertVals.push(`$${idx}`);
            values.push(updates.tokensInputIncrement);
            idx++;
        }
        if (updates.tokensOutputIncrement) {
            setClauses.push(`tokens_output = ${this.sql.summaryTable}.tokens_output + $${idx}`);
            insertCols.push("tokens_output");
            insertVals.push(`$${idx}`);
            values.push(updates.tokensOutputIncrement);
            idx++;
        }
        if (updates.tokensCacheReadIncrement) {
            setClauses.push(`tokens_cache_read = ${this.sql.summaryTable}.tokens_cache_read + $${idx}`);
            insertCols.push("tokens_cache_read");
            insertVals.push(`$${idx}`);
            values.push(updates.tokensCacheReadIncrement);
            idx++;
        }
        if (updates.tokensCacheWriteIncrement) {
            setClauses.push(`tokens_cache_write = ${this.sql.summaryTable}.tokens_cache_write + $${idx}`);
            insertCols.push("tokens_cache_write");
            insertVals.push(`$${idx}`);
            values.push(updates.tokensCacheWriteIncrement);
            idx++;
        }

        await this.pool.query(
            `INSERT INTO ${this.sql.summaryTable} (${insertCols.join(", ")})
             VALUES (${insertVals.join(", ")})
             ON CONFLICT (session_id) DO UPDATE SET ${setClauses.join(", ")}`,
            values,
        );
    }

    async pruneDeletedSummaries(olderThan: Date): Promise<number> {
        const { rowCount } = await this.pool.query(
            `DELETE FROM ${this.sql.summaryTable}
             WHERE deleted_at IS NOT NULL AND deleted_at < $1`,
            [olderThan],
        );
        return rowCount ?? 0;
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
        titleLocked: row.title_locked ?? false,
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
        workerNodeId: row.worker_node_id ?? undefined,
    };
}

/** Map a PG row to SessionMetricSummary. */
function rowToSessionMetricSummary(row: any): SessionMetricSummary {
    return {
        sessionId: row.session_id,
        agentId: row.agent_id ?? null,
        model: row.model ?? null,
        parentSessionId: row.parent_session_id ?? null,
        snapshotSizeBytes: Number(row.snapshot_size_bytes) || 0,
        dehydrationCount: Number(row.dehydration_count) || 0,
        hydrationCount: Number(row.hydration_count) || 0,
        lossyHandoffCount: Number(row.lossy_handoff_count) || 0,
        lastDehydratedAt: row.last_dehydrated_at ? new Date(row.last_dehydrated_at).getTime() : null,
        lastHydratedAt: row.last_hydrated_at ? new Date(row.last_hydrated_at).getTime() : null,
        lastCheckpointAt: row.last_checkpoint_at ? new Date(row.last_checkpoint_at).getTime() : null,
        tokensInput: Number(row.tokens_input) || 0,
        tokensOutput: Number(row.tokens_output) || 0,
        tokensCacheRead: Number(row.tokens_cache_read) || 0,
        tokensCacheWrite: Number(row.tokens_cache_write) || 0,
        deletedAt: row.deleted_at ? new Date(row.deleted_at).getTime() : null,
        createdAt: new Date(row.created_at).getTime(),
        updatedAt: new Date(row.updated_at).getTime(),
    };
}
